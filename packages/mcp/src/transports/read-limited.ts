/**
 * fork: an HTTP body read up to a limit, never past it.
 * `response.json()` and `response.text()` read the whole body before any limit applies, so a server answering with a
 * huge JSON body or an endless error body filled the client's memory. Here the body is read chunk by chunk and
 * cancelled as soon as it passes `max`, or when `signal` aborts (a request its caller gave up on).
 */

/** At most `max` bytes of `response`'s body; above, the body is cancelled and `onOver` decides: cut, or throw. */
export async function readLimited(
	response: Response,
	max: number,
	onOver: "truncate" | (() => Error),
	signal?: AbortSignal,
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const cancel = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			if (total + value.byteLength > max) {
				cancel();
				if (onOver !== "truncate") throw onOver();
				chunks.push(value.subarray(0, max - total));
				total = max;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
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
