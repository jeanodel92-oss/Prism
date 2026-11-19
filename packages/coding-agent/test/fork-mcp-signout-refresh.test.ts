/**
 * fork: signing out of an MCP server while a token refresh waits for the
 * server leaves no credentials behind. The refresh used to save the new tokens into the store the sign-out had emptied.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./suite/mcp-oauth-server.ts";

describe("fork: an MCP sign-out during a refresh", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("stays signed out when the refresh answers after the sign-out in another process", async () => {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const lockDir = mkdtempSync(join(tmpdir(), "prism-mcp-signout-"));
		cleanups.push(() => rmSync(lockDir, { recursive: true, force: true }));
		// Two stores sharing the credential file and lock directory stand in for two processes.
		const backend = new InMemoryAuthStorageBackend();
		const credentials = () => new McpOAuthCredentialStore(backend, lockDir);
		await signInMcpServer({
			serverUrl: server.url,
			store: credentials().forServer("test", server.url),
			settings: {},
			prompt: {
				showAuthorizationUrl: (url) => void fetch(url),
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
			},
		});
		server.expireAccessTokens();
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store: credentials().forServer("test", server.url),
			settings: () => ({}),
			onChallenge: () => {},
		});
		let reachedServer: () => void = () => {};
		const atServer = new Promise<void>((resolve) => {
			reachedServer = resolve;
		});
		let answer: () => void = () => {};
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		// The token endpoint answers only once the other process has signed out.
		const held: typeof fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (new URL(String(input instanceof Request ? input.url : input)).pathname === "/token") {
				reachedServer();
				await answered;
			}
			return response;
		};
		const refresh = provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			fetch: held,
			token: "access-1",
		});
		await atServer;
		expect(credentials().remove("test", server.url)).toBe(true);
		answer();
		await refresh?.catch(() => undefined);
		expect(server.log.filter((entry) => entry === "token refresh")).toHaveLength(1);
		expect(credentials().tokens("test", server.url)).toBeUndefined();
	});
});
