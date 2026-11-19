/**
 * fork: a codemode script without `timeout_ms` had no deadline, so
 * a script that never ended held the session until someone pressed Escape. It now stops after 10 minutes by default.
 */
import type * as Codemode from "@earendil-works/pi-codemode";
import { describe, expect, it, vi } from "vitest";
import { CODEMODE_DEFAULT_TIMEOUT_MS, executeCodemode } from "../src/extensions/codemode/execute.ts";

const deadlines = vi.hoisted(() => [] as Array<number | undefined>);
vi.mock("@earendil-works/pi-codemode", async (importOriginal) => {
	const real = await importOriginal<typeof Codemode>();
	class RecordingSandbox extends real.CodemodeSandbox {
		constructor(options: ConstructorParameters<typeof real.CodemodeSandbox>[0]) {
			deadlines.push(options?.timeoutMs);
			super(options);
		}
	}
	return { ...real, CodemodeSandbox: RecordingSandbox };
});

describe("fork: codemode's default deadline", () => {
	it("gives a script without timeout_ms 10 minutes, and keeps the one a script asks for", async () => {
		expect(CODEMODE_DEFAULT_TIMEOUT_MS).toBe(600_000);
		await executeCodemode("a", { code: "return 1;" }, undefined, undefined, undefined);
		await executeCodemode(
			"b",
			{ code: '// @options: {"timeout_ms": 1200000}\nreturn 1;' },
			undefined,
			undefined,
			undefined,
		);
		expect(deadlines).toEqual([600_000, 1_200_000]);
	});
});
