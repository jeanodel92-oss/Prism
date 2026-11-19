// fork: the phone link's folder (`~/.prism/remote`: the PC's key, the paired phones,
// the sockets that give pairing codes and serve the phones) is beside the agent folder, so the rules that reserve
// the agent folder never covered it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { configPathKind, phoneLinkPath, shellConfigWrite } from "../src/fork/config-policy.ts";

describe("fork: the phone link's folder is reserved to the user", () => {
	let home: string;
	let remote: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "prism-phone-link-"));
		remote = join(home, ".prism", "remote");
		mkdirSync(remote, { recursive: true });
		mkdirSync(join(home, ".prism", "agent"));
		mkdirSync(join(home, "project"));
		vi.stubEnv("HOME", home);
		vi.stubEnv(ENV_AGENT_DIR, join(home, ".prism", "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("classes its files as security settings, from any project", () => {
		const cwd = join(home, "project");
		for (const name of ["paired", "key.der", "control", "hub.sock", "new-file"]) {
			expect(configPathKind(join(remote, name), cwd), name).toBe("security");
		}
		expect(configPathKind(remote, cwd)).toBe("security");
		expect(phoneLinkPath(join(home, ".prism", "remote-notes.txt"))).toBe(false);
		expect(configPathKind(join(home, "project", "remote", "paired"), cwd)).toBeUndefined();
		expect(shellConfigWrite(`echo abc >> ${join(remote, "paired")}`, cwd)).toBe("security");
		expect(shellConfigWrite("echo abc >> ~/.prism/remote/paired", cwd)).toBe("security");
	});

	it("follows PRISM_REMOTE_DIR, the folder the server was told to use", () => {
		const elsewhere = join(home, "link");
		mkdirSync(elsewhere);
		expect(configPathKind(join(elsewhere, "paired"), join(home, "project"))).toBeUndefined();
		vi.stubEnv("PRISM_REMOTE_DIR", elsewhere);
		expect(configPathKind(join(elsewhere, "paired"), join(home, "project"))).toBe("security");
	});
});
