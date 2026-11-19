import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedIdent, signingPlan } from "../src/fork/sandbox/git-sign.ts";

const ID = "a".repeat(40);
const commit = (committer = "T <t@example.com> 1792734178 +0000") =>
	`tree ${ID}\nparent ${ID}\nauthor T <t@example.com> 1792734178 +0000\ncommitter ${committer}\n\nmessage\n`;

// fork: Prism signs Git's objects with the user's key, from the user's configuration only.
describe("fork: Git signing from the sandbox", () => {
	let root: string;
	let project: string;
	let config: string;
	const writes = (path: string) => path === project || path.startsWith(`${project}/`);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-git-sign-"));
		project = join(root, "project");
		mkdirSync(project);
		config = join(root, "gitconfig");
		vi.stubEnv("GIT_CONFIG_GLOBAL", config);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("signs only commits and tags, for their committer or tagger", () => {
		expect(signedIdent(commit())).toBe("T <t@example.com>");
		expect(signedIdent(`object ${ID}\ntype commit\ntag v1\ntagger T <t@example.com> 1 +0100\n\nv1\n`)).toBe(
			"T <t@example.com>",
		);
		// Anything else the key could vouch for: a file, an SSH login, a push certificate.
		for (const other of ["hello", "\0\0\0\x14SSH-userauth", `certificate version 0.1\npusher T <t@e> 1 +0000\n`]) {
			expect(signedIdent(other)).toBeUndefined();
		}
		// An identity that would read as an option is no key.
		expect(signedIdent(commit("--export-secret-keys <a@b> 1 +0000"))).toBe("");
	});

	it("follows the user's configuration: program, key and format", () => {
		writeFileSync(config, "[user]\n\tsigningkey = ABCD\n");
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toMatchObject({
			args: ["--status-fd=2", "-bsau", "ABCD"],
		});
		writeFileSync(config, "");
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toMatchObject({
			args: ["--status-fd=2", "-bsau", "T <t@example.com>"],
		});
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit("-x <a@b> 1 +0000"), writes)).toContain(
			"no signing key",
		);
		expect(signingPlan({ format: "openpgp", cwd: "/" }, "hello", writes)).toContain("only Git commits and tags");
		writeFileSync(config, "[gpg]\n\tformat = ssh\n");
		expect(signingPlan({ format: "ssh", cwd: "/" }, commit(), writes)).toContain("set user.signingkey");
		writeFileSync(config, "[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = key::ssh-ed25519 AAAA t\n");
		expect(signingPlan({ format: "ssh", cwd: "/" }, commit(), writes)).toMatchObject({
			args: ["-Y", "sign", "-n", "git", "-f", "", "-U"],
			key: "ssh-ed25519 AAAA t",
		});
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toContain("signs with ssh");
	});

	it("refuses a key, a program or a configuration file the sandbox can change", () => {
		writeFileSync(config, `[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${project}/key\n`);
		writeFileSync(join(project, "key"), "");
		expect(signingPlan({ format: "ssh", cwd: "/" }, commit(), writes)).toContain(`your signing key ${project}/key`);
		writeFileSync(config, `[gpg]\n\tprogram = ${project}/gpg\n`);
		writeFileSync(join(project, "gpg"), "#!/bin/sh\n", { mode: 0o755 });
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toContain(`${project}/gpg signs`);
		// a relative key or program names no one place (Git's, Prism's and `/` differ).
		writeFileSync(config, "[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = keys/id\n");
		expect(signingPlan({ format: "ssh", cwd: "/" }, commit(), writes)).toContain("relative path");
		writeFileSync(config, "[gpg]\n\tprogram = bin/gpg\n");
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toContain("relative path");
		// The repository's own configuration, written in the sandbox, from any of its folders.
		writeFileSync(config, "");
		execFileSync("git", ["init", "-q", project]);
		execFileSync("git", ["-C", project, "config", "user.signingkey", "ABCD"]);
		mkdirSync(join(project, "sub"));
		expect(signingPlan({ format: "openpgp", cwd: join(project, "sub") }, commit(), writes)).toContain(
			`${project}/.git/config sets user.signingkey`,
		);
		// And the user's: an include of a file in the project counts as that file.
		writeFileSync(join(project, "inc"), "[user]\n\tsigningkey = EFGH\n");
		writeFileSync(config, `[include]\n\tpath = ${project}/inc\n`);
		expect(signingPlan({ format: "openpgp", cwd: "/" }, commit(), writes)).toContain(`${project}/inc sets`);
	});
});
