/**
 * fork: a script's output is bounded, in characters and in items. Past
 * either, the script stops and fails with what it output so far.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";
import { MAX_OUTPUT_ITEMS, MAX_OUTPUT_LENGTH } from "../src/runtime/protocol.ts";

const sandboxes: CodemodeSandbox[] = [];
afterEach(async () => {
	await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
});

describe("fork: bounded codemode output", () => {
	it("stops a script that outputs a large string forever", async () => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 60_000 });
		sandboxes.push(sandbox);
		const result = await sandbox.execute('const s = "x".repeat(1024 * 1024); for (;;) text(s);');
		expect(result).toMatchObject({ ok: false, error: { kind: "script", name: "RangeError" } });
		expect(result.ok ? "" : result.error.message).toMatch(/Output exceeds/);
		const total = result.output.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0);
		expect(total).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
	});

	it("stops a script that outputs small items forever", async () => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 60_000 });
		sandboxes.push(sandbox);
		const result = await sandbox.execute("for (;;) text(1);");
		expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
		expect(result.output.length).toBe(MAX_OUTPUT_ITEMS);
	});

	it("keeps output within the limits whole", async () => {
		const sandbox = new CodemodeSandbox({ timeoutMs: 60_000 });
		sandboxes.push(sandbox);
		const result = await sandbox.execute("for (let i = 0; i < 100; i++) text(i); return 'done';");
		expect(result).toMatchObject({ ok: true, value: "done" });
		expect(result.output).toHaveLength(100);
	});
});
