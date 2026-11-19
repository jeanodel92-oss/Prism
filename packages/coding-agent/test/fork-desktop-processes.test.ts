/**
 * fork: the agent desktop's processes. A helper that stops answering is bounded
 * and a cancelled action stops waiting for it; programs started with launch are held by their process group
 * until it is empty; a desktop whose helper stopped is stopped before another replaces it. A fake
 * helper stands for prism-desktop-helper; the last two run a real headless labwc, and are skipped without it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import desktopExtension from "../src/fork/desktop/index.ts";
import { HelperDesktop } from "../src/fork/desktop/session.ts";
import { createHarness, getMessageText, getToolResult } from "./suite/harness.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

function which(command: string): string | undefined {
	try {
		return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

const labwc = which("labwc");

/**
 * Answers as the helper does on a 4x2 screen and logs its commands, its pid and its runtime folder. FAKE_MODE mute:
 * a capture is never answered; slow: answered after half a second.
 */
function fakeHelper(dir: string): string {
	const path = join(dir, "prism-desktop-helper");
	writeFileSync(
		path,
		`#!/bin/sh
echo $$ >> '${dir}/helper-pids'
echo "$XDG_RUNTIME_DIR" >> '${dir}/runtimes'
echo "ok 4 2"
while read -r line; do
	echo "$line" >> '${dir}/commands'
	case "$line" in
		capture*)
			[ "$FAKE_MODE" = mute ] && exec sleep 61.53
			[ "$FAKE_MODE" = slow ] && sleep 0.5
			head -c 32 /dev/zero > "\${line#capture }"; echo "ok 4 2" ;;
		*) echo ok ;;
	esac
done
`,
		{ mode: 0o755 },
	);
	return path;
}

/** A helper desktop without a compositor: only the helper's channel. */
class ChannelDesktop extends HelperDesktop {
	static async open(helper: string, dir: string, mode: string): Promise<ChannelDesktop> {
		const desktop = new ChannelDesktop(dir);
		await desktop.startHelper(helper, { PATH: process.env.PATH, FAKE_MODE: mode }, 5000);
		return desktop;
	}

	close(): void {
		this.helper?.kill("SIGKILL");
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Pids whose command line holds `marker`. */
function running(marker: string): number[] {
	return readdirSync("/proc")
		.filter((entry) => /^\d+$/.test(entry))
		.filter((entry) => {
			try {
				return readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").includes(marker);
			} catch {
				return false;
			}
		})
		.map(Number);
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prism-desk-proc-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const marker of ["sleep 63.17", "sleep 63.18", "sleep 61.53", `${dir}/`]) {
		for (const pid of running(marker)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("fork: the desktop helper's channel", () => {
	it("stops a helper that does not answer, failing the command and those behind it", async () => {
		const desktop = await ChannelDesktop.open(fakeHelper(dir), dir, "mute");
		try {
			desktop.requestTimeoutMs = 300;
			const shot = desktop.capture();
			const next = desktop.move(1, 1);
			await expect(shot).rejects.toThrow("did not answer within 0.3 s");
			await expect(next).rejects.toThrow("did not answer within 0.3 s");
			expect(desktop.running).toBe(false);
			const helper = Number(readFileSync(join(dir, "helper-pids"), "utf8").trim());
			await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 2000 });
		} finally {
			desktop.close();
		}
	});

	it("stops waiting when cancelled, drops the late answer and never sends a command cancelled before its turn", async () => {
		const desktop = await ChannelDesktop.open(fakeHelper(dir), dir, "slow");
		try {
			const controller = new AbortController();
			const startedAt = Date.now();
			const shot = desktop.capture(controller.signal);
			setTimeout(() => controller.abort(), 50);
			await expect(shot).rejects.toThrow("Cancelled.");
			expect(Date.now() - startedAt).toBeLessThan(400);
			await expect(desktop.click(1, 1, "left", 1, AbortSignal.abort())).rejects.toThrow("Cancelled.");
			// The capture's answer ("ok 4 2") comes first and goes to the capture, not to this move ("ok").
			await expect(desktop.move(1, 1)).resolves.toEqual([]);
			expect(readFileSync(join(dir, "commands"), "utf8").trim().split("\n")).toEqual([
				expect.stringMatching(/^capture /),
				"move 1 1",
			]);
			expect(desktop.running).toBe(true);
		} finally {
			desktop.close();
		}
	});
});

describe.skipIf(!labwc)("fork: the agent desktop's processes", () => {
	async function session() {
		stubThrowawayHome(join(dir, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(dir, "agent"));
		vi.stubEnv("TMPDIR", dir);
		vi.stubEnv("PRISM_DESKTOP_HELPER", fakeHelper(dir));
		const harness = await createHarness({ extensionFactories: [{ name: "desktop", factory: desktopExtension }] });
		const call = async (input: JsonObject) => {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("desktop", input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, "desktop");
		};
		return { harness, call };
	}

	it("stops what a launch left running after its shell ended, before or after the launch wait", async () => {
		const { harness, call } = await session();
		try {
			const quick = await call({ action: "launch", command: "sleep 63.17 & echo started" });
			expect(getMessageText(quick)).toContain("exited with code 0");
			// Ends after the 1.5 s the launch waits for.
			await call({ action: "launch", command: "sleep 63.18 & sleep 2" });
			await new Promise((resolve) => setTimeout(resolve, 2500));
			expect(running("sleep 63.17")).toHaveLength(1);
			expect(running("sleep 63.18")).toHaveLength(1);
			expect(getMessageText(await call({ action: "stop" }))).toBe("Desktop stopped.");
			await vi.waitFor(
				() => {
					expect(running("sleep 63.17")).toEqual([]);
					expect(running("sleep 63.18")).toEqual([]);
				},
				{ timeout: 5000 },
			);
		} finally {
			harness.cleanup();
		}
	}, 20_000);

	it("stops the desktop whose helper stopped before starting another", async () => {
		const { harness, call } = await session();
		try {
			expect(getMessageText(await call({ action: "start" }))).toContain("Your desktop started.");
			const [helper] = readFileSync(join(dir, "helper-pids"), "utf8").trim().split("\n").map(Number);
			const [first] = readFileSync(join(dir, "runtimes"), "utf8").trim().split("\n");
			const firstCompositor = running(`${first}/labwc`);
			expect(firstCompositor).toHaveLength(1);
			process.kill(helper as number, "SIGKILL");
			await vi.waitFor(() => expect(alive(helper as number)).toBe(false));
			expect(getMessageText(await call({ action: "start" }))).toContain("Your desktop started.");
			const runtimes = readFileSync(join(dir, "runtimes"), "utf8").trim().split("\n");
			expect(runtimes).toHaveLength(2);
			await vi.waitFor(() => expect(running(`${first}/labwc`)).toEqual([]), { timeout: 3000 });
			expect(existsSync(first as string)).toBe(false);
			expect(running(`${runtimes[1]}/labwc`)).toHaveLength(1);
			await call({ action: "stop" });
		} finally {
			harness.cleanup();
		}
	}, 20_000);
});
