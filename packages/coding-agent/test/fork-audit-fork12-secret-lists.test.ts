// fork: the lists that keep secrets from the model.
// the project's secret files the gate protects; the home folder's credentials hidden when commands
// read everything; jq and awk programs that read the whole environment.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { realPath } from "../src/fork/real-path.ts";
import { buildLayout, DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../src/fork/sandbox/layout.ts";
import { findRepositories } from "../src/fork/sandbox/nested-git.ts";
import { within } from "../src/fork/sandbox/path-within.ts";

describe("fork: secret lists of the fork.12 security audit", () => {
	let root: string;
	let home: string;
	let agentDir: string;
	let project: string;
	const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };
	const put = (path: string, content = "SECRET=canary\n") => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};

	beforeEach(() => {
		root = realPath(mkdtempSync(join(tmpdir(), "prism-secret-lists-")));
		home = join(root, "home");
		agentDir = join(home, ".pi", "agent");
		project = join(home, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".git"), { recursive: true });
		put(join(project, "README.md"), "# readme\n");
		put(join(project, "data.json"), '{"foo": 1, "env": "dev"}\n');
		put(join(project, "notes.txt"), "a b\nc d\n");
		process.env.HOME = home;
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		process.env.HOME = saved.home;
		if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = saved.agentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const decide = (tool: string, input: Record<string, unknown>, mode: Mode = "ask") =>
		decidePermission(tool, input, project, { mode });
	const bash = (command: string, mode: Mode = "ask") => decide("bash", { command }, mode);

	describe("AS-020: the project's secret files", () => {
		const SECRET_FILES = [
			".envrc",
			".env~",
			".dev.vars",
			".npmrc",
			".pypirc",
			".git-credentials",
			".htpasswd",
			"credentials.json",
			"service-account.json",
			"secrets.json",
			"secrets.yaml",
			"config/secrets.yml",
			".aws/credentials",
			".docker/config.json",
			"kubeconfig",
			".kube/config",
			"terraform.tfstate",
			"terraform.tfstate.backup",
			"terraform.tfvars",
			"prod.tfvars.json",
			"cert.p12",
			"cert.pfx",
			"keystore.jks",
			"release.keystore",
			"wp-config.php",
			"config/database.yml",
			"local.settings.json",
			"id_ecdsa",
			"id_ed25519_sk",
			"id_dsa",
		];

		it.each(SECRET_FILES)(
			"%s: the read tool and cat ask as dangerous, and neither reads it without a question in safe mode",
			(file) => {
				put(join(project, file));
				expect(decide("read", { path: file }).tier).toBe("danger");
				expect(bash(`cat ${file}`).tier).toBe("danger");
				expect(decide("read", { path: file }, "safe").effect).not.toBe("allow");
				expect(bash(`cat ${file}`, "safe").effect).not.toBe("allow");
			},
		);

		it("leaves ordinary files alone", () => {
			for (const file of ["package.json", "src/secrets.ts", "config/app.yml", "docker-compose.yml", "main.tf"]) {
				put(join(project, file), "x\n");
				expect(decide("read", { path: file }).effect, file).toBe("allow");
				expect(bash(`cat ${file}`).effect, file).toBe("allow");
			}
		});
	});

	describe("AS-012: the home folder's credentials when commands read everything", () => {
		const CREDENTIALS = [
			".config/git/credentials",
			".npmrc",
			".pypirc",
			".cargo/credentials.toml",
			".cargo/credentials",
			".config/gcloud/credentials.db",
			".azure/msal_token_cache.json",
			".claude/.credentials.json",
			".codex/auth.json",
			".config/github-copilot/apps.json",
			".config/Code/User/globalStorage/state.vscdb",
			".config/rclone/rclone.conf",
			".config/sops/age/keys.txt",
			".password-store/x.gpg",
			".pgpass",
			".vault-token",
			".local/share/kwalletd/kdewallet.kwl",
			".config/microsoft-edge/Default/Cookies",
			".config/vivaldi/Default/Cookies",
			".librewolf/p/cookies.sqlite",
			".zen/p/cookies.sqlite",
			".var/app/app.zen_browser.zen/.zen/p/cookies.sqlite",
			".thunderbird/p/key4.db",
			".bash_history",
			".zsh_history",
			".env",
		];
		const ORDINARY = [
			".gitconfig",
			".bashrc",
			".claude/settings.json",
			".codex/config.toml",
			".config/Code/User/settings.json",
		];
		const everything: SandboxSettings = {
			...DEFAULT_SANDBOX_SETTINGS,
			read: { limit: "all", allow: [], toolsOff: [] },
		};
		const limited: SandboxSettings = {
			...DEFAULT_SANDBOX_SETTINGS,
			read: { limit: "project", allow: [], toolsOff: [] },
		};
		const layout = (settings: SandboxSettings) =>
			buildLayout({ cwd: project, home, agentDir, settings, env: { PATH: "/usr/bin" } });

		it("hides each of them from commands, and not the files around them", () => {
			for (const file of [...CREDENTIALS, ...ORDINARY]) put(join(home, file));
			const { hidden } = layout(everything);
			const covered = (file: string) => hidden.some((path) => within(join(home, file), path));
			expect(CREDENTIALS.filter((file) => !covered(file))).toEqual([]);
			expect(ORDINARY.filter(covered)).toEqual([]);
		});

		it("makes the read tool ask for each of them as dangerous", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sandbox: { read: { limit: "all" } } }));
			for (const file of [...CREDENTIALS, ...ORDINARY]) put(join(home, file));
			for (const file of CREDENTIALS) {
				expect(decide("read", { path: `~/${file}` }, "broad").tier, file).toBe("danger");
			}
			for (const file of ORDINARY) expect(decide("read", { path: `~/${file}` }, "broad").tier, file).toBe("allow");
		});

		it("with reading limited to the project, still shows ~/.npmrc rebuilt and lets the user open a history", () => {
			put(
				join(home, ".npmrc"),
				"registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=x\n",
			);
			put(join(home, ".bash_history"));
			expect(layout(limited).home?.settings).toContain(join(home, ".npmrc"));
			const allowed = layout({ ...limited, read: { ...limited.read, allow: ["~/.bash_history"] } });
			expect(allowed.home?.read).toContain(join(home, ".bash_history"));
			expect(allowed.hidden).not.toContain(join(home, ".bash_history"));
		});
	});

	describe("AS-009: programs that read the whole environment", () => {
		it.each([
			"jq -n env",
			"jq -n 'env.HOME'",
			"jq -rn '[env[]] | join(\" \")'",
			"jq -n '$ENV'",
			"jq -n '$ENV.PATH'",
			"jq -n '\"\\(env)\"'",
			"jq -n --arg a b env",
			"jq -n -- env",
			"jq -n -L . 'include \"m\"; f'",
			"jq -n 'import \"m\" as m; m::f'",
			"jq -n -f prog.jq",
			"jq -nf prog.jq",
			"jq --from-file prog.jq data.json",
			'F=env; jq -n "$F"',
			`awk 'BEGIN{ print SYMTAB["ENV" "IRON"]["HOME"] }'`,
			`gawk 'BEGIN{ print SYMTAB["ENVIRON"]["HOME"] }'`,
			`awk 'BEGIN{ for (k in ENVIRON) print k, ENVIRON[k] }'`,
		])("%s asks", (command) => {
			expect(bash(command).tier).not.toBe("allow");
		});

		it.each([
			"jq '.foo' data.json",
			"jq .env data.json",
			"jq -r '.items[]?.name' data.json",
			"jq --arg env x '.foo' data.json",
			"jq -n '1 + 1'",
			"awk '{print $1}' notes.txt",
			"awk -F: '{print $2}' notes.txt",
			`awk 'BEGIN{ x["SYM"] = 1; print x["SYM"] }'`,
		])("%s does not ask", (command) => {
			expect(bash(command)).toMatchObject({ tier: "allow", effect: "allow" });
		});
	});
	// Safe mode hides the project's secret files from commands by name (nested-git.ts): the same names as the gate.
	it("safe mode hides the new names from commands too (grep -r)", () => {
		const names = [".npmrc", ".envrc", "credentials.json", "kubeconfig", "prod.tfstate", "store.p12", "id_ecdsa"];
		for (const name of [...names, "README.md", "config.yml"]) put(join(project, "sub", name));
		const found = findRepositories([project]).secrets.map((path) => path.slice(project.length + 1));
		expect(found.sort()).toEqual(names.map((name) => `sub/${name}`).sort());
	});
});
