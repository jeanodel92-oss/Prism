// fork: two credential stores of one process (two agent dirs) holding a keyring
// key for the same provider: both keys are secrets to mask, not only the one read last.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storedSecrets } from "../src/fork/secrets/env.ts";
import { forgetKeyringCredentials, keyringCredentials, noteMoved } from "../src/fork/secrets/keyring.ts";

describe("keyring credentials of several stores", () => {
	const dirs: string[] = [];
	afterEach(() => {
		forgetKeyringCredentials();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps both stores' keys for the same provider", () => {
		const first = mkdtempSync(join(tmpdir(), "prism-keyring-a-"));
		const second = mkdtempSync(join(tmpdir(), "prism-keyring-b-"));
		dirs.push(first, second);
		noteMoved(join(first, "auth.json"), [["acme", { type: "api_key", key: "first-store-key-0001" }, "r1"]]);
		noteMoved(join(second, "auth.json"), [["acme", { type: "api_key", key: "second-store-key-0002" }, "r2"]]);
		const secrets = storedSecrets(first);
		expect(secrets.has("first-store-key-0001")).toBe(true);
		expect(secrets.has("second-store-key-0002")).toBe(true);
		expect([...keyringCredentials()]).toHaveLength(2);
	});
});
