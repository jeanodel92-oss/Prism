import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overrideSshFiles, sandboxWrites, sshPlan } from "../src/fork/sandbox/ssh-provenance.ts";

// fork: ssh follows the user's configuration, but nothing it reads may come from the sandbox.
describe("fork: provenance of Prism's ssh configuration", () => {
	let root: string;
	let home: string;
	let project: string;
	let bin: string;
	let writes: (path: string) => boolean;
	const env = () => ({ PATH: `${bin}:/usr/bin`, SHELL: "/bin/sh", PROJECT: project });
	const config = (text: string) => writeFileSync(join(home, ".ssh", "config"), text);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prism-ssh-provenance-"));
		home = join(root, "home");
		project = join(root, "project");
		bin = join(root, "bin");
		for (const dir of [join(home, ".ssh"), project, bin]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(bin, "ssh"), "#!/bin/sh\n", { mode: 0o755 });
		overrideSshFiles({ home, system: join(root, "ssh_config") });
		// The project is writable, and ~/.ssh hidden, as in the sandbox.
		writes = sandboxWrites({ writable: [project, home], readOnly: [], hidden: [join(home, ".ssh")] });
	});
	afterEach(() => {
		overrideSshFiles(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps an ordinary configuration: aliases, keys, jump hosts and the user's own commands", () => {
		mkdirSync(join(home, ".ssh", "config.d"));
		writeFileSync(join(home, ".ssh", "config.d", "work.conf"), "Host work\n  HostName git.work.example\n");
		config(
			[
				"Include config.d/*.conf",
				"Host gh",
				"  HostName github.com",
				"  IdentityFile ~/.ssh/id_gh",
				"  UserKnownHostsFile ~/.ssh/known_hosts ~/.ssh/known_hosts2",
				"Host inner",
				"  ProxyJump bastion",
				"Host proxied",
				"  ProxyCommand /usr/bin/nc %h %p",
				'Match exec "test -n %h"',
				"  ControlPath ~/.ssh/cm-%C",
			].join("\n"),
		);
		expect(sshPlan(writes, "ssh", env())).toEqual({ program: join(bin, "ssh"), options: [] });
	});

	it("refuses when a file ssh reads, or could read, is one the sandbox can change", () => {
		const cases: [string, string, (() => void)?][] = [
			// A planted Match exec would run on the host at the next Git over SSH.
			[`Include ${project}/ssh.conf`, "Include"],
			// Nothing there yet: the sandbox can still create a matching file.
			[`Include ${project}/conf.d/*.conf`, "Include"],
			// biome-ignore lint/suspicious/noTemplateCurlyInString: ssh's own ${VAR} expansion
			["Include ${PROJECT}/ssh.conf", "Include"],
			["Include %d/project/ssh.conf", "Include"],
			// A file outside the project that links into it.
			[
				`Include ${root}/linked.conf`,
				"Include",
				() => {
					writeFileSync(join(project, "real.conf"), "");
					symlinkSync(join(project, "real.conf"), join(root, "linked.conf"));
				},
			],
			[`Host *\n  ProxyCommand ${project}/proxy.sh %h %p`, "ProxyCommand"],
			['Match exec "~/project/check %h"', "Match exec"],
			['Match host x !exec "$HOME/project/check"', "Match exec"],
			[`Host *\n  KnownHostsCommand ${project}/kh %H`, "KnownHostsCommand"],
			[`Host *\n  PKCS11Provider ${project}/p11.so`, "PKCS11Provider"],
			[`Host *\n  IdentityFile ${project}/key`, "IdentityFile"],
			[`Host *\n  UserKnownHostsFile ~/.ssh/known_hosts ${project}/kh`, "UserKnownHostsFile"],
		];
		for (const [text, what, prepare] of cases) {
			prepare?.();
			config(text);
			const plan = sshPlan(writes, "ssh", env());
			expect(typeof plan, text).toBe("string");
			expect(plan, text).toContain(what);
		}
	});

	it("follows includes of included files, relative to ~/.ssh", () => {
		writeFileSync(join(home, ".ssh", "a.conf"), "Include b.conf\n");
		writeFileSync(join(home, ".ssh", "b.conf"), `Host *\n  ProxyCommand ${project}/p\n`);
		config("Include a.conf\n");
		expect(sshPlan(writes, "ssh", env())).toContain(`${join(home, ".ssh", "b.conf")} line 2 (ProxyCommand)`);
	});

	it("turns multiplexing off when the control sockets live where the sandbox writes", () => {
		// A link planted there would carry the connection through another session's master, to another host.
		config(`Host *\n  ControlMaster auto\n  ControlPath ${project}/.cm-%C\n`);
		expect(sshPlan(writes, "ssh", env())).toEqual({ program: join(bin, "ssh"), options: ["-S", "none"] });
	});

	it("refuses an ssh, a shell or a PATH folder the sandbox can change", () => {
		writeFileSync(join(project, "ssh"), "#!/bin/sh\n", { mode: 0o755 });
		expect(sshPlan(writes, "ssh", { ...env(), PATH: `${project}:/usr/bin` })).toContain("ssh would run");
		// The user's commands run through the shell and PATH: both must stay out of the sandbox's reach.
		config("Host *\n  ProxyCommand nc %h %p\n");
		expect(sshPlan(writes, "ssh", { ...env(), PATH: `${bin}:${project}` })).toContain("on PATH is writable");
		expect(sshPlan(writes, "ssh", { ...env(), SHELL: join(project, "sh") })).toContain("with ");
		// Without commands found on PATH, PATH only matters for ssh itself.
		config("Host gh\n  HostName github.com\nHost unix/*\n  ProxyCommand /usr/lib/systemd/systemd-ssh-proxy %h %p\n");
		expect(sshPlan(writes, "ssh", { ...env(), PATH: `${bin}:${project}` })).toEqual({
			program: join(bin, "ssh"),
			options: [],
		});
	});

	it("accepts this machine's own system configuration", () => {
		overrideSshFiles({ home });
		config("");
		expect(typeof sshPlan(writes, "ssh", env())).toBe("object");
	});

	it("refuses when ~/.ssh itself is writable from the sandbox", () => {
		const open = sandboxWrites({ writable: [home], readOnly: [], hidden: [] });
		expect(sshPlan(open, "ssh", env())).toContain(".ssh");
	});
});
