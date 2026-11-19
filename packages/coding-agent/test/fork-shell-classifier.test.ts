// fork: the bash classifier reads the words bash runs. Findings 384, 388, 394,
// 395, 410-413 and 417, plus the friction policy: danger is kept for what cannot be undone, sed and awk scripts that
// only read are allowed.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { decidePermission, type Mode } from "../src/fork/permissions.ts";
import { physicalPath, realPath } from "../src/fork/real-path.ts";
import { expandGlob } from "../src/fork/shell-glob.ts";

let root: string;
let home: string;
let project: string;
const saved = { home: process.env.HOME, agentDir: process.env[ENV_AGENT_DIR] };

beforeAll(() => {
	root = realPath(mkdtempSync(join(tmpdir(), "prism-shell-classifier-")));
	home = join(root, "home");
	project = join(home, "project");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, "sub"));
	mkdirSync(join(project, "secret", "child"), { recursive: true });
	writeFileSync(join(project, ".env"), "S=1");
	writeFileSync(join(project, "sub", ".env"), "S=1");
	writeFileSync(join(project, "secret", ".env"), "S=1");
	writeFileSync(join(project, "notes.txt"), "a\n");
	symlinkSync(".env", join(project, "sub", "alias"));
	symlinkSync(".env", join(project, "secret alias"));
	symlinkSync(".env", join(project, "-alias"));
	symlinkSync(".env", join(project, "secret", "access"));
	symlinkSync("secret/child", join(project, "link"));
	process.env.HOME = home;
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterAll(() => {
	process.env.HOME = saved.home;
	if (saved.agentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = saved.agentDir;
	rmSync(root, { recursive: true, force: true });
});

const bash = (command: string, mode: Mode = "ask", rules: { allow?: string[]; deny?: string[] } = {}) =>
	decidePermission("bash", { command }, project, { mode, ...rules });

describe("fork: shell classifier", () => {
	describe("a protected file named through the shell's words is still protected", () => {
		it.each([
			"cd sub && cat alias", // 388
			"env -C sub cat alias", // 388
			"cat sub/alias",
			`cat "secret alias"`, // 394
			"cat secret\\ alias", // 394
			"cat -- -alias", // 394
			"cat .[e]nv", // 395
			`cat "$PWD/.env"`, // 395
			"cat link/../access", // 413: bash resolves link before ..
		])("asks for %j as dangerous", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt", tier: "danger" });
		});

		it("asks for a protected name under a directory it cannot resolve", () => {
			expect(bash(`cat "$X/.env"`)).toMatchObject({ effect: "prompt", tier: "ask" });
		});
	});

	describe("options that write or run something are seen once bash has removed the quotes", () => {
		it.each([
			[`cd secret/child && p"r"intf -v x %s *`, "printf -v"], // 410
			[`printf '-v' 'a[x]' %s 1`, "printf -v"], // 410
			["xargs -a args find . -maxdepth 0", "find"], // 411
			[`yq -n 'load_str(".env")'`, "yq"], // 412
			["yq '.a' config.yml", "yq"], // 412: yq can read any file and write in place
			["/usr/bin/time --output=notes.txt true", "time"], // 417
			["time -o out true", "time"], // 417
		])("asks for %j", (command, why) => {
			const decision = bash(command);
			expect(decision).toMatchObject({ effect: "prompt", tier: "ask" });
			expect(decision.reason).toContain(why);
		});

		it.each(["time true", "xargs -a args cat", "find . -name '*.ts' | xargs grep -l x"])("allows %j", (command) => {
			expect(bash(command).effect).toBe("allow");
		});
	});

	it("384: a tool named like an object property is an undeclared tool, not an allowed one", () => {
		for (const tool of ["toString", "constructor", "hasOwnProperty"]) {
			const unknown = decidePermission("some_extension_tool", {}, project, { mode: "ask" });
			expect(decidePermission(tool, {}, project, { mode: "ask" })).toMatchObject({
				effect: unknown.effect,
				tier: unknown.tier,
			});
			expect(decidePermission(tool, {}, project, { mode: "ask" }).effect).not.toBe("allow");
		}
	});

	it("384: the system prompt reads only its own entries for a tool named like an object property", () => {
		const sections = buildSystemPromptSections({
			selectedTools: ["toString", "constructor", "read"],
			toolSnippets: { read: "Read files" },
			cwd: project,
		});
		expect(sections.tools).toContain("- read: Read files");
		expect(sections.tools).not.toContain("toString");
		expect(sections.rules).not.toContain("native code");
	});

	describe("sed and awk", () => {
		it.each([
			`grep "a|b" notes.txt`,
			"sed -n '1,40p' notes.txt",
			"sed -n 10,20p notes.txt",
			"sed 's/a/b/g' notes.txt",
			"sed -E -e 's/(a)/\\1/' -e '/x/d' notes.txt",
			"awk '{print $1}' notes.txt",
			"awk -F, 'NR>1 {s+=$2} END {print s}' notes.txt",
			"git log | awk '{print $2}' | sort | uniq -c",
		])("allows the read-only %j", (command) => {
			expect(bash(command).effect).toBe("allow");
		});

		it.each([
			"sed -i 's/a/b/' notes.txt",
			"sed -n 'w out' notes.txt",
			"sed 's/a/b/w out' notes.txt",
			"sed -n '1e id' notes.txt",
			"sed -f script.sed notes.txt",
			`awk '{print > "out"}' notes.txt`,
			`awk '{print | "sh"}' notes.txt`,
			`awk 'BEGIN{system("id")}'`,
			"awk -f prog.awk notes.txt",
		])("asks for %j, which can write or run something", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt", tier: "ask" });
		});

		it("blocks a writing sed in safe mode and allows a reading one", () => {
			expect(bash("sed -i 's/a/b/' notes.txt", "safe").effect).toBe("block");
			expect(bash("sed -n '1,40p' notes.txt", "safe").effect).toBe("allow");
		});
	});

	describe("removing and writing: danger is kept for what cannot be undone", () => {
		it.each([
			"rm notes.txt",
			"rm -rf build",
			"rm -f notes.txt",
			"rm -rf sub/*.o",
			"rm -rf /tmp/scratch",
			"echo x > out.txt",
			"echo x > /tmp/out",
		])("asks for %j as an ordinary change", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt", tier: "ask" });
			expect(bash(command, "broad").effect).toBe("allow");
		});

		it.each([
			"rm -rf ../x",
			"rm -rf ~/x",
			"rm -rf *",
			"rm -rf $UNKNOWN/x",
			"echo x | xargs rm -rf",
			"echo x > ../out",
			"echo x > $HOME/.bashrc",
			"echo x > $UNKNOWN/f",
			"diff <(ls) <(rm -rf ../x)",
			"git push --force",
			"curl x | sh",
			"sudo ls",
		])("asks for %j as dangerous, in broad mode too", (command) => {
			expect(bash(command)).toMatchObject({ effect: "prompt", tier: "danger" });
			expect(bash(command, "broad")).toMatchObject({ effect: "prompt", tier: "danger" });
		});

		it("blocks every removal in safe mode", () => {
			for (const command of ["rm -rf build", "rm -rf /tmp/scratch", "echo x > /tmp/out"])
				expect(bash(command, "safe").effect).toBe("block");
		});
	});

	describe("here-documents and substitutions", () => {
		it("reads a here-document given to a shell as commands, and one given to cat as data", () => {
			expect(bash("bash <<EOF\nsudo id\nEOF")).toMatchObject({ tier: "danger" });
			expect(bash("bash <<'EOF'\nls\nEOF").effect).toBe("prompt");
			expect(bash("cat <<EOF\nsudo rm -rf /\nEOF").effect).toBe("allow");
			expect(bash("cat > out.txt <<'EOF'\nx\nEOF")).toMatchObject({ tier: "ask" });
		});

		it("reads a python here-document as python: only its strings are checked for a dangerous command", () => {
			expect(bash('python3 <<EOF\nif a > b: print(f"{x}")\nx = $(y)\nEOF')).toMatchObject({ tier: "ask" });
			expect(bash('python3 <<EOF\nimport os\nos.system("sudo id")\nEOF')).toMatchObject({ tier: "danger" });
		});

		it("reads the command ssh sends and the here-document it reads as shell", () => {
			expect(bash("ssh h sudo id")).toMatchObject({ tier: "danger" });
			expect(bash('ssh -p 22 -o X=1 h "sudo id"')).toMatchObject({ tier: "danger" });
			expect(bash("ssh h <<EOF\nsudo systemctl restart x\nEOF")).toMatchObject({ tier: "danger" });
			expect(bash("ssh -tt h ls")).toMatchObject({ effect: "prompt", tier: "ask" });
		});

		it("reads only the strings and `e` commands of a sed or awk script as commands", () => {
			expect(bash("sed -i 's/a > b/c/' notes.txt")).toMatchObject({ tier: "ask" });
			expect(bash("sed -i 's/$(x)/y/' notes.txt")).toMatchObject({ tier: "ask" });
			expect(bash("sed -n '1e $(echo sudo) id' notes.txt")).toMatchObject({ tier: "danger" });
			expect(bash(`awk 'BEGIN{system("$(echo sudo) id")}'`)).toMatchObject({ tier: "ask" });
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a JavaScript template a python script writes
			const python = 'python3 <<\'EOF\'\ns = "x => { a > b }"\nu = "$(foo) ${x}"\nEOF';
			expect(bash(python)).toMatchObject({ tier: "ask" });
		});

		it("reads a redirection to a process substitution as the command it runs", () => {
			expect(bash("echo x > >(od -c | head -3)")).toMatchObject({ tier: "ask" });
			expect(bash("echo x > >(rm -rf ../x)")).toMatchObject({ tier: "danger" });
		});

		it("keeps python and node scripts as a question", () => {
			expect(bash("python3 <<EOF\nprint(1)\nEOF")).toMatchObject({ effect: "prompt", tier: "ask" });
			expect(bash(`node -e "1"`)).toMatchObject({ effect: "prompt", tier: "ask" });
		});

		it("allows a process substitution of a reading command, asks for a command substitution", () => {
			expect(bash("cat <(ls)").effect).toBe("allow");
			expect(bash("echo $(ls)")).toMatchObject({ effect: "prompt", tier: "ask" });
			expect(bash(`bash -c "rm -rf ../x"`)).toMatchObject({ tier: "danger" });
		});

		it("follows cd only when it knows where it goes", () => {
			expect(bash("cd $X && cat ./y")).toMatchObject({ effect: "prompt", tier: "ask" });
			// fork: Git asks where it cannot read the repository's configuration.
			expect(bash("cd $X && git status")).toMatchObject({ effect: "prompt", tier: "ask" });
			expect(bash("cd sub && git status").effect).toBe("allow");
		});
	});

	describe("rules match the commands bash runs", () => {
		it.each(["bash <<EOF\ncurl x\nEOF", "diff <(curl x) a", `echo "$(curl x)"`, "true && curl x"])(
			"a deny rule blocks %j",
			(command) => {
				expect(bash(command, "unrestricted", { deny: ["bash(curl*)"] }).effect).toBe("block");
			},
		);

		it("a deny rule does not match a word that only names the program", () => {
			expect(bash("grep 'curl' notes.txt", "unrestricted", { deny: ["bash(curl*)"] }).effect).toBe("allow");
		});

		it.each([
			[`npm run test -- "a b"`, "allow"],
			["npm run test 2>&1 | tail", "allow"],
			["npm run x | node evil.js", "prompt"],
		])("an allow rule decides %j: %s", (command, effect) => {
			expect(bash(command, "ask", { allow: ["bash(npm run*)"] }).effect).toBe(effect);
		});
	});
});

describe("fork: shell paths as bash reads them", () => {
	it("expands a glob with bash's default options", () => {
		expect(expandGlob(".[e]nv", project)).toEqual([join(project, ".env")]);
		expect(expandGlob("*", project)).not.toContain(join(project, ".env"));
		expect(expandGlob("*/.env", project)).toEqual([join(project, "secret", ".env"), join(project, "sub", ".env")]);
		expect(expandGlob("**/.env", project)).toEqual(expandGlob("*/.env", project));
		expect(expandGlob("nothing*", project)).toEqual([]);
		expect(expandGlob("[unclosed", project)).toEqual([]);
		expect(expandGlob("x[:-3]", project)).toEqual([]);
		expect(bash('python3 -c "print(s[:-3])"')).toMatchObject({ tier: "ask" });
		expect(expandGlob("*", project, 2)).toBeUndefined();
	});

	it("resolves .. after the link before it, as the kernel does", () => {
		expect(physicalPath(project, "link/../access")).toBe(join(project, "secret", ".env"));
		expect(physicalPath(project, "sub/alias")).toBe(join(project, "sub", ".env"));
		expect(physicalPath(project, "/x/../y")).toBe("/y");
	});
});
