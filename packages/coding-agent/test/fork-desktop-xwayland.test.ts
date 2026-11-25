/**
 * fork: the agent typed garbage into X11 programs (OnlyOffice,
 * Wine's notepad). Xwayland drops a keymap that binds no virtual modifier and keeps its default one, so it read the
 * helper's codes in a US layout: "hello world ABC 123 ok" arrived as "122345362748904-43". A real headless labwc with
 * Xwayland, the real helper, and a Tk window (X11) that writes down what it receives. Skipped without labwc,
 * Xwayland, Python's tkinter or the helper's build tools.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function which(command: string): string | undefined {
	try {
		return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function hasTkinter(): boolean {
	try {
		execFileSync("python3", ["-I", "-c", "import tkinter"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const labwc = which("labwc");
const ready = Boolean(labwc && which("Xwayland") && which("gcc") && which("wayland-scanner") && hasTkinter());
const buildScript = fileURLToPath(new URL("../../../fork/desktop-helper/build.sh", import.meta.url));

// Writes what the focused text field received once it ends with "!", then quits.
const TK_WINDOW = `import sys, tkinter
root = tkinter.Tk(className="prismx11test")
root.geometry("1200x650+0+0")
text = tkinter.Text(root)
text.pack(fill="both", expand=True)
text.focus_set()
def check():
    typed = text.get("1.0", "end-1c")
    if typed.endswith("!"):
        open(sys.argv[1], "w", encoding="utf-8").write(typed)
        root.destroy()
    else:
        root.after(100, check)
root.after(100, check)
root.after(15000, root.destroy)
root.mainloop()
`;

let dir: string;
let helper: string | undefined;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-xwayland-"));
	if (!ready) return;
	try {
		execFileSync(buildScript, [join(dir, "build")], { stdio: "pipe" });
		helper = join(dir, "build", "prism-desktop-helper");
	} catch {
		helper = undefined;
	}
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function waitFor(check: () => boolean, ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe.skipIf(!ready)("typing into an X11 window (Xwayland)", () => {
	it("arrives as the text the agent typed, whatever the layout", async () => {
		expect(helper).toBeDefined();
		const runtime = join(dir, "run");
		const config = join(dir, "labwc");
		mkdirSync(runtime, { mode: 0o700 });
		mkdirSync(config);
		writeFileSync(join(config, "rc.xml"), '<?xml version="1.0"?><labwc_config></labwc_config>\n');
		writeFileSync(join(config, "autostart"), `echo "$DISPLAY" > ${join(runtime, "display")}\n`);
		const window = join(dir, "window.py");
		writeFileSync(window, TK_WINDOW);
		const out = join(dir, "typed.txt");
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: dir,
			LANG: "C.UTF-8",
			XDG_RUNTIME_DIR: runtime,
			WLR_BACKENDS: "headless",
			WLR_LIBINPUT_NO_DEVICES: "1",
			WLR_RENDERER: "pixman",
			// The user's layout in the report; the agent's keys must not depend on it.
			XKB_DEFAULT_LAYOUT: "ca",
			XKB_DEFAULT_VARIANT: "multix",
		};
		const children: ChildProcess[] = [];
		try {
			children.push(spawn(labwc!, ["-C", config], { env, stdio: "ignore" }));
			const displayFile = join(runtime, "display");
			await waitFor(() => existsSync(displayFile) && readFileSync(displayFile, "utf8").trim() !== "", 10_000);
			const display = readFileSync(displayFile, "utf8").trim();
			const socket = readdirSync(runtime).find((name) => /^wayland-\d+$/.test(name))!;

			const helperProcess = spawn(helper!, [], { env: { ...env, WAYLAND_DISPLAY: socket }, stdio: "pipe" });
			children.push(helperProcess);
			const answers: string[] = [];
			createInterface({ input: helperProcess.stdout! }).on("line", (line) => answers.push(line));
			const request = async (command: string): Promise<string> => {
				const before = answers.length;
				helperProcess.stdin!.write(`${command}\n`);
				await waitFor(() => answers.length > before, 10_000);
				return answers[before]!;
			};
			await waitFor(() => answers.length > 0, 10_000);

			const tk = spawn("python3", ["-I", window, out], { env: { ...env, DISPLAY: display }, stdio: "ignore" });
			children.push(tk);
			// The window maps, then takes the focus on a click.
			await new Promise((resolve) => setTimeout(resolve, 2000));
			expect(await request("click 300 100 left 1")).toBe("ok");
			const sent = "hello world ABC 123 éà€!";
			const keysyms = [...sent].map((c) => {
				const code = c.codePointAt(0)!;
				return (code < 0x100 ? code : 0x1000000 + code).toString(16);
			});
			expect(await request(`keys 0 ${keysyms.join(" ")}`)).toBe("ok");
			await waitFor(() => tk.exitCode !== null, 15_000);
			expect(readFileSync(out, "utf8")).toBe(sent);
		} finally {
			for (const child of children.reverse()) child.kill();
		}
	}, 60_000);
});
