/**
 * fork: an HTTP body read up to a limit, never past it. `response.json()` and
 * `response.text()` read the whole body first, however large, before any check can apply: a search service
 * that answers with an endless body filled the engine's memory. Here the body is read chunk by chunk and cancelled as
 * soon as it passes `max`.
 */

/** A body larger than its limit. */
export class BodyTooLarge extends Error {
	constructor(max: number) {
		super(`the response is larger than ${max} bytes`);
		this.name = "BodyTooLarge";
	}
}

/**
 * At most `max` bytes of `response`'s body. Above: "throw" (default) cancels the body and throws {@link BodyTooLarge};
 * "truncate" cancels it and returns the first `max` bytes (a diagnostic's excerpt).
 */
export async function readLimited(
	response: Response,
	max: number,
	over: "throw" | "truncate" = "throw",
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > max) {
				await reader.cancel().catch(() => {});
				if (over === "throw") throw new BodyTooLarge(max);
				chunks.push(value.subarray(0, max - total));
				total = max;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}

/** {@link readLimited} parsed as JSON; a body over the limit is refused, never parsed cut. */
export async function readLimitedJson(response: Response, max: number): Promise<unknown> {
	return JSON.parse(new TextDecoder().decode(await readLimited(response, max)));
}

/** The most a search service's answer may hold: far above a page of results, far below what fills the engine. */
export const SEARCH_MAX_BYTES = 8 * 1024 * 1024;

/** A failed response's body as a short diagnostic: its first `max` bytes, marked when cut. */
export async function errorExcerpt(response: Response, max = 4096): Promise<string> {
	try {
		const bytes = await readLimited(response, max + 1, "truncate");
		const text = new TextDecoder().decode(bytes.subarray(0, max));
		return bytes.byteLength > max ? `${text}… (cut)` : text;
	} catch {
		return "";
	}
}
