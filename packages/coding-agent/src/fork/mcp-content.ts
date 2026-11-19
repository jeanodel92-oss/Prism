/**
 * fork: model-facing content of one block of an MCP result, whatever shape the server sent.
 *
 * pi-mcp checks that a result has a `content` array, not what the blocks in it look like. A text block
 * whose `text` is not a string was stored as is in the tool result, then made the transcript's renderer
 * and its fallback throw, and a provider that sanitizes each text block (Anthropic, with an image in the
 * same result) failed every later request of the session. A block that cannot be converted, or converts
 * to something that is not text or an image, becomes a short placeholder; the other blocks are kept.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type Content = TextContent | ImageContent;

function wellFormed(block: unknown): block is Content {
	if (typeof block !== "object" || block === null) return false;
	const { type, text, data, mimeType } = block as Record<string, unknown>;
	if (type === "text") return typeof text === "string";
	return type === "image" && typeof data === "string" && typeof mimeType === "string";
}

/** Runs `convert` on one block and keeps its output only when every part of it is well formed. */
export async function guardMcpBlock(block: unknown, convert: () => Promise<Content[]> | Content[]): Promise<Content[]> {
	const type = typeof block === "object" && block !== null ? (block as { type?: unknown }).type : undefined;
	const name = typeof type === "string" ? `"${type.slice(0, 40)}" ` : "";
	let converted: Content[];
	try {
		converted = await convert();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return [{ type: "text", text: `[Invalid MCP ${name}content block: ${reason.slice(0, 200)}]` }];
	}
	if (converted.every(wellFormed)) return converted;
	return [{ type: "text", text: `[Invalid MCP ${name}content block: a field has the wrong type]` }];
}
