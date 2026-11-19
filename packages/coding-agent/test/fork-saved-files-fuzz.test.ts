// fork: fuzz targets for files Prism writes and reads back later: session transcripts (session search) and
// the checkpoint index (/undo, /checkpoints). A damaged or foreign line must be skipped, never fail every search or
// make /undo restore the wrong content. Replay with PI_FUZZ_SEED.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import checkpoints, { checkpointDir } from "../src/fork/checkpoints.ts";
import sessionSearch from "../src/fork/session-search.ts";

function makeRandom(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const seed = Number(process.env.PI_FUZZ_SEED ?? 7_720);
const JUNK: unknown[] = [null, true, 0, 5, -1, 1.5, "", "x", [], [null], {}, { type: 5 }, { toString: 1 }];

type Handler = (event: unknown, ctx: unknown) => unknown;
type Registered = { handler?: Handler; execute?: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };

/** Loads an extension against a recording API: its event handlers, commands and tools. */
function load(extension: (pi: ExtensionAPI) => void) {
	const handlers = new Map<string, Handler>();
	const registered = new Map<string, Registered>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, definition: Registered) => registered.set(name, definition),
		registerTool: (definition: Registered & { name: string }) => registered.set(definition.name, definition),
	};
	extension(pi as unknown as ExtensionAPI);
	return { handlers, registered };
}

let tempDir: string;
const previousAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prism-saved-files-"));
	process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("fork: files Prism reads back", () => {
	it("finds every saved message whatever else the session files hold", async () => {
		const random = makeRandom(seed);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		const { registered } = load(sessionSearch);
		const tool = registered.get("session_search")!;
		const sessions = join(tempDir, "agent", "sessions", "project");
		for (let round = 0; round < 150; round++) {
			rmSync(sessions, { recursive: true, force: true });
			mkdirSync(sessions, { recursive: true });
			const needle = `needle${round}`;
			let expected = 0;
			for (let fileIndex = 0; fileIndex < 3; fileIndex++) {
				const header =
					random() < 0.7
						? {
								type: "session",
								cwd: random() < 0.8 ? "/work" : pick(JUNK),
								timestamp: pick(["2026-01-01T00:00:00Z", ...JUNK]),
							}
						: pick(JUNK);
				const lines = [JSON.stringify(header)];
				for (let count = Math.floor(random() * 8); count > 0; count--) {
					const roll = random();
					if (roll < 0.3) {
						lines.push(
							JSON.stringify({ type: "message", message: { role: "user", content: `${needle} ${expected}` } }),
						);
						expected++;
					} else if (roll < 0.5) {
						const content = [pick(JUNK), { type: "text", text: pick(JUNK) }];
						lines.push(JSON.stringify({ type: "message", message: { role: pick(JUNK), content } }));
					} else if (roll < 0.8) {
						lines.push(JSON.stringify(pick(JUNK)));
					} else {
						lines.push(pick(['{"type":"message"', "\u0000", "{]", `${needle}`]));
					}
				}
				writeFileSync(join(sessions, `${fileIndex}.jsonl`), `${lines.join("\n")}\n`);
			}
			const label = `seed=${seed} round=${round}`;
			// A local model in a saved session: the excerpts are sent without asking.
			const result = await tool.execute!("call", { query: needle, scope: "all", limit: 25 }, undefined, undefined, {
				cwd: "/work",
				sessionManager: { getSessionFile: () => join(tempDir, "current.jsonl") },
				model: { baseUrl: "http://localhost:8080/v1" },
			});
			const text = result.content[0]!.text;
			// Each saved message is found once, whatever the rest of its file looks like.
			const found = text.split("\n").filter((line) => line.startsWith(`${needle} `));
			expect(found.sort(), label).toEqual(
				Array.from({ length: expected }, (_, index) => `${needle} ${index}`).sort(),
			);
			if (expected === 0) expect(text, label).toMatch(/^No matches/);
		}
	});

	// Each round saves checkpoints as /undo does, 12 fsyncs: 0.3 s in all on a tmpfs, 31 s alone on the CI runner's
	// disk, more under the full suite.
	it("undoes the last turn to each file's own content whatever the stored index holds", async () => {
		const random = makeRandom(seed + 1);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
		const work = join(tempDir, "work");
		mkdirSync(work, { recursive: true });
		const valid = () => ({
			seq: 1 + Math.floor(random() * 40),
			turn: 1 + Math.floor(random() * 5),
			path: join(work, "old.txt"),
			blob: random() < 0.5 ? null : "00001.snap",
			tool: "write",
			ts: "2026-01-01T00:00:00.000Z",
		});
		const damage = (entry: Record<string, unknown>) => {
			const key = pick(Object.keys(entry));
			if (random() < 0.3) delete entry[key];
			else entry[key] = pick(JUNK);
			return entry;
		};
		for (let round = 0; round < 300; round++) {
			const sessionId = `session-${round}`;
			const sessionManager = { getSessionId: () => sessionId };
			const directory = checkpointDir(sessionManager)!;
			mkdirSync(directory, { recursive: true });
			const entries = Array.from({ length: Math.floor(random() * 4) }, () =>
				random() < 0.5 ? valid() : random() < 0.8 ? damage(valid()) : pick(JUNK),
			);
			const stored =
				random() < 0.85 ? JSON.stringify(entries) : pick(["", "[", '{"seq":1}', JSON.stringify(pick(JUNK))]);
			writeFileSync(join(directory, "index.json"), stored);
			const label = `seed=${seed + 1} round=${round} ${stored}`;

			const { handlers, registered } = load(checkpoints);
			const notes: string[] = [];
			const ctx = {
				sessionManager,
				cwd: work,
				// /checkpoints and /undo refuse during a turn; none runs here.
				isIdle: () => true,
				ui: {
					notify: (message: string) => notes.push(message),
					confirm: async () => true,
					select: async (_title: string, options: string[]) => options.at(-1),
				},
			};
			await handlers.get("session_start")!({}, ctx);
			// One turn writes two files; their snapshots must not share a blob.
			const files = ["a.txt", "b.txt"].map((name) => join(work, name));
			for (const [index, file] of files.entries()) writeFileSync(file, `before ${index} ${round}`);
			await handlers.get("turn_start")!({}, ctx);
			for (const file of files) await handlers.get("tool_call")!({ toolName: "write", input: { path: file } }, ctx);
			for (const file of files) writeFileSync(file, "after");

			await registered.get("checkpoints")!.handler!("", ctx);
			await registered.get("undo")!.handler!("", ctx);
			for (const [index, file] of files.entries()) {
				expect(readFileSync(file, "utf8"), label).toBe(`before ${index} ${round}`);
			}
			expect(notes.join("\n"), label).not.toMatch(/failed/);
		}
	}, 150_000);
});
