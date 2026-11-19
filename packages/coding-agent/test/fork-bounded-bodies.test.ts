/**
 * fork: a search service's answer is read up to a limit, never past it,
 * and an error body only as an excerpt. Each service here answers with a body that never ends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectCapabilities, SERVER_INFO_MAX_BYTES } from "../src/fork/capabilities.ts";
import { listCompatibleServerModels } from "../src/fork/compatible-server.ts";
import { errorExcerpt, readLimited, SEARCH_MAX_BYTES } from "../src/fork/http-body-limit.ts";
import { checkPackage, REGISTRY_MAX_BYTES, resolveRegistry } from "../src/fork/npm-guard.ts";
import { searchProvider } from "../src/fork/web-search-providers.ts";

/**
 * A body that never ends, in 64 KiB chunks, after `first`. With `stopAt`, it ends past that many bytes instead: a
 * reader without a limit then finishes (on invalid JSON) rather than filling the test's memory.
 */
function endless(
	state: { pulled: number; cancelled: boolean },
	first = "",
	stopAt = Number.POSITIVE_INFINITY,
): ReadableStream<Uint8Array> {
	const chunk = new Uint8Array(64 * 1024).fill(0x20);
	let sentFirst = !first;
	return new ReadableStream({
		pull(controller) {
			if (state.pulled > stopAt) {
				controller.close();
				return;
			}
			const data = sentFirst ? chunk : new TextEncoder().encode(first);
			sentFirst = true;
			state.pulled += data.byteLength;
			controller.enqueue(data);
		},
		cancel() {
			state.cancelled = true;
		},
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("fork: bounded HTTP bodies", () => {
	it("readLimited stops at its limit and cancels the body", async () => {
		const state = { pulled: 0, cancelled: false };
		await expect(readLimited(new Response(endless(state)), 1000)).rejects.toThrow(/larger than 1000 bytes/);
		expect(state.cancelled).toBe(true);
		const cut = await readLimited(new Response(endless({ pulled: 0, cancelled: false }, "abc")), 2, "truncate");
		expect(new TextDecoder().decode(cut)).toBe("ab");
		expect(await errorExcerpt(new Response("short"))).toBe("short");
		expect(await errorExcerpt(new Response(endless({ pulled: 0, cancelled: false }, "x")), 4)).toBe("x   … (cut)");
	});

	it("a search service answering without end is refused, success or error", async () => {
		for (const status of [200, 500]) {
			const state = { pulled: 0, cancelled: false };
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(endless(state, status === 200 ? '{"results":[' : "busy"), {
						status,
						headers: { "content-type": "application/json" },
					}),
			);
			const error = await searchProvider("searxng", "q", 2, undefined, "https://search.example").catch(
				(caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
			);
			expect(error).toMatch(status === 200 ? /larger than 8388608 bytes/ : /^HTTP 500 busy/);
			expect(state.cancelled).toBe(true);
			expect(state.pulled).toBeLessThan(SEARCH_MAX_BYTES + 128 * 1024);
		}
	});

	// fork: the three other whole-body reads remarked in lot 7a.
	it("server detection, a server's model list and the npm registry read their answer up to a limit", async () => {
		const states: Array<{ pulled: number; cancelled: boolean }> = [];
		const serve = (first: string, stopAt: number) =>
			vi.stubGlobal("fetch", async () => {
				const state = { pulled: 0, cancelled: false };
				states.push(state);
				return new Response(endless(state, first, stopAt), { headers: { "content-type": "application/json" } });
			});
		const bounded = (max: number) => {
			expect(states.length).toBeGreaterThan(0);
			for (const state of states.splice(0)) {
				expect(state.cancelled).toBe(true);
				expect(state.pulled).toBeLessThan(max + 128 * 1024);
			}
		};

		serve('{"data":[', SERVER_INFO_MAX_BYTES * 2);
		await detectCapabilities("http://127.0.0.1:9/v1", ["m"]);
		bounded(SERVER_INFO_MAX_BYTES);

		serve('{"data":[', SERVER_INFO_MAX_BYTES * 2);
		await expect(listCompatibleServerModels("http://127.0.0.1:9/v1", undefined)).rejects.toThrow(
			/larger than 16777216 bytes/,
		);
		bounded(SERVER_INFO_MAX_BYTES);

		serve('{"time":{', REGISTRY_MAX_BYTES * 2);
		const check = await checkPackage("some-package", resolveRegistry("some-package"), {
			fetch: (url, init) => fetch(url, init),
			now: () => Date.UTC(2026, 10, 11),
		});
		expect(check.reasons.join(" ")).toContain("larger than 64 MiB");
		bounded(REGISTRY_MAX_BYTES);
	}, 60_000);
});
