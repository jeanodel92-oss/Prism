/**
 * fork: the resource listing tools.
 * - a resource or template carrying its own `server` field replaced the server the harness tags it with.
 * - the cursor was trimmed before going back to the server, so " page-2 " came back as "page-2" and a cursor
 *   of spaces asked for the first page again.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "../src/extensions/mcp/resources.ts";

type Listing = { structuredContent: Record<string, unknown> & { nextCursor?: string } };

function fakeServer(name: string, cursors: (string | undefined)[]): McpResourceServer {
	const resource = { uri: "file:///a", name: "a", server: "other" };
	const template = { uriTemplate: "file:///{x}", name: "t", server: "other" };
	return {
		name,
		timeoutMs: 1000,
		resourcesPage: async (cursor: string | undefined) => {
			cursors.push(cursor);
			return { resources: [resource], nextCursor: cursor === undefined ? " page-2 " : undefined };
		},
		resourceTemplatesPage: async (cursor: string | undefined) => {
			cursors.push(cursor);
			return { resourceTemplates: [template] };
		},
		allResources: async () => [resource],
		allResourceTemplates: async () => [template],
	} as unknown as McpResourceServer;
}

describe("fork: MCP resource listings", () => {
	const call = async (tool: ReturnType<typeof createMcpResourceToolDefinitions>[number], params: object) =>
		(await tool.execute("call", params, undefined, undefined, {} as ExtensionToolContext)) as unknown as Listing;

	it("tags every resource and template with the server that listed it", async () => {
		const [resources, templates] = createMcpResourceToolDefinitions({
			exposure: "direct",
			servers: () => [fakeServer("docs", [])],
		});
		for (const params of [{}, { server: "docs" }]) {
			const listed = await call(resources!, params);
			expect(listed.structuredContent.resources).toEqual([{ server: "docs", uri: "file:///a", name: "a" }]);
			const listedTemplates = await call(templates!, params);
			expect(listedTemplates.structuredContent.resourceTemplates).toEqual([
				{ server: "docs", uriTemplate: "file:///{x}", name: "t" },
			]);
		}
	});

	it("sends a cursor back exactly as the server gave it", async () => {
		const cursors: (string | undefined)[] = [];
		const [resources, templates] = createMcpResourceToolDefinitions({
			exposure: "direct",
			servers: () => [fakeServer("docs", cursors)],
		});
		const first = await call(resources!, { server: "docs" });
		expect(first.structuredContent.nextCursor).toBe(" page-2 ");
		await call(resources!, { server: "docs", cursor: first.structuredContent.nextCursor });
		await call(templates!, { server: "docs", cursor: "   " });
		expect(cursors).toEqual([undefined, " page-2 ", "   "]);
		// The server name is still trimmed.
		await call(resources!, { server: " docs " });
		expect(cursors.at(-1)).toBeUndefined();
	});
});
