// fork: the permissions a session file gives back. Only a state this installation
// sealed widens anything; one from elsewhere, edited, or written before the seal gives back only what narrows.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { permStateSealed, sealPermState } from "../src/fork/perm-seal.ts";
import permissionsExtension, { permissionsPanel } from "../src/fork/permissions.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

describe("fork: the permissions a session file gives back", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-perm-seal-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { modes: { broad: false } } }));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** A session whose file already holds `saved`, opened with `mode` configured. */
	async function resumed(saved: Record<string, unknown>, mode = "ask") {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode }));
		const harness = await createHarness({
			extensionFactories: [{ name: "permissions", factory: permissionsExtension }],
		});
		harnesses.push(harness);
		harness.session.sessionManager.appendCustomEntry("perm-state", saved);
		const warnings: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message: string, level?: string) => {
					if (level === "warning") warnings.push(message);
				},
			}),
		});
		const snapshot = permissionsPanel(harness.session.extensionRunner.createContext())!.snapshot();
		return { mode: snapshot.mode, rules: snapshot.sessionRules, grants: snapshot.grants, warnings };
	}

	const wide = () => ({
		mode: "broad",
		allow: ["bash(*)"],
		deny: ["bash(rm *)"],
		timed: [
			{ rule: "write(**)", effect: "allow", until: Date.now() + 60_000 },
			{ rule: "bash(curl *)", effect: "deny", until: Date.now() + 60_000 },
		],
	});

	it("gives back the whole state this installation sealed", async () => {
		const state = wide();
		const seal = sealPermState(agentDir, state);
		expect(seal).toMatch(/^[0-9a-f]{64}$/);
		const session = await resumed({ ...state, seal });
		expect(session.mode).toBe("broad");
		expect(session.rules).toEqual({ allow: ["bash(*)"], deny: ["bash(rm *)"] });
		expect(session.grants.some((grant) => grant.effect === "allow")).toBe(true);
		expect(session.warnings).toEqual([]);
	});

	it("gives back only what narrows from a state without the seal, and says so", async () => {
		const session = await resumed(wide());
		expect(session.mode).toBe("ask");
		expect(session.rules).toEqual({ allow: [], deny: ["bash(rm *)"] });
		expect(session.grants.length).toBeGreaterThan(0);
		expect(session.grants.every((grant) => grant.effect === "deny")).toBe(true);
		expect(session.warnings).toHaveLength(1);
		expect(session.warnings[0]).toContain("were not given back");
	});

	it("refuses a sealed state that was changed, or sealed by another installation", async () => {
		const state = wide();
		const seal = sealPermState(agentDir, state);
		const changed = await resumed({ ...state, allow: ["bash(*)", "write(**)"], seal });
		expect(changed.mode).toBe("ask");
		expect(changed.rules.allow).toEqual([]);

		const other = mkdtempSync(join(tmpdir(), "prism-perm-seal-other-"));
		try {
			mkdirSync(other, { recursive: true });
			const foreign = { ...state, seal: sealPermState(other, state) };
			expect(permStateSealed(other, foreign)).toBe(true);
			expect(permStateSealed(agentDir, foreign)).toBe(false);
			expect((await resumed(foreign)).mode).toBe("ask");
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("keeps an unsealed mode that is no wider than the configured one, without a warning", async () => {
		const session = await resumed({ mode: "safe", allow: [], deny: [], timed: [] }, "broad");
		expect(session.mode).toBe("safe");
		expect(session.warnings).toEqual([]);
	});
});
