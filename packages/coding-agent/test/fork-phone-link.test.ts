// fork: /phone links a phone from the terminal, through the bundled phone server
// (fork/android/server), as "Link a phone" does in the window.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	codeLines,
	engineEnv,
	firewallLines,
	isTailscale,
	PhoneServer,
	remoteProgram,
	serviceUnit,
	unitPath,
} from "../src/fork/phone-link.ts";

const dirs: string[] = [];
let server: ChildProcess | undefined;
afterEach(() => {
	server?.kill();
	server = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "prism-phone-link-"));
	dirs.push(dir);
	return dir;
};

describe("/phone", () => {
	it("finds prism-remote from PRISM_REMOTE_BIN, beside the window, or on PATH", () => {
		const dir = temp();
		const program = join(dir, "prism-remote");
		writeFileSync(program, "#!/bin/sh\n");
		chmodSync(program, 0o755);
		expect(remoteProgram({ PRISM_REMOTE_BIN: program, PATH: "" }, join(dir, "nowhere"))).toBe(program);
		expect(remoteProgram({ PATH: dir }, join(dir, "nowhere"))).toBe(program);
		expect(remoteProgram({ PATH: "" }, join(dir, "a", "b", "c", "d"))).toBeUndefined();
	});

	it("reads the server's answers and says when none runs", () => {
		const fingerprint = "a".repeat(64);
		const calls: string[][] = [];
		const phone = new PhoneServer(
			"prism-remote",
			(_program, args) => {
				calls.push(args);
				if (args[0] === "status") return { ok: false, stdout: "", stderr: "no server" };
				if (args[0] === "devices") return { ok: true, stdout: `${fingerprint}\nnoise\n`, stderr: "" };
				return { ok: true, stdout: JSON.stringify({ error: "the code expired" }), stderr: "" };
			},
			"/srv",
		);
		expect(phone.status()).toBeUndefined();
		expect(phone.paired()).toEqual([fingerprint]);
		expect(() => phone.invite()).toThrow("the code expired");
		expect(calls[0]).toEqual(["status", "--dir", "/srv"]);
	});

	it("writes the window's service unit, with the engine of this Prism", () => {
		const unit = serviceUnit("/opt/prism/gui/prism-remote", engineEnv(["/opt/prism/prism"]), "/usr/bin:/a%b");
		expect(unit).toContain("ExecStart=/opt/prism/gui/prism-remote serve\n");
		expect(unit).toContain('Environment="PATH=/usr/bin:/a%%b"\n');
		expect(unit).toContain('Environment="PRISM_REMOTE_ENGINE=/opt/prism/prism"\n');
		expect(unit).not.toContain("PRISM_REMOTE_ENGINE_ARGS");
		expect(engineEnv(["/usr/bin/node", "--flag", "cli.ts"]).PRISM_REMOTE_ENGINE_ARGS).toBe('["--flag","cli.ts"]');
		expect(unitPath({ XDG_CONFIG_HOME: "/c" })).toBe("/c/systemd/user/prism-remote.service");
	});

	it("shows the QR code and says when Tailscale is not among the addresses", () => {
		const lines = codeLines({ code: "prism-pair:v1;x", qr: "█▀█\n█▄█", hosts: ["192.168.1.5"], port: 47392 });
		expect(lines).toContain("█▀█");
		expect(lines).toContain("prism-pair:v1;x");
		expect(lines.some((line) => line.includes("Tailscale"))).toBe(true);
		expect(isTailscale("100.101.2.3")).toBe(true);
		expect(isTailscale("100.20.2.3")).toBe(false);
		expect(
			codeLines({ code: "c", qr: "", hosts: ["100.101.2.3"], port: 1 }).some((line) => line.includes("Tailscale")),
		).toBe(false);
	});

	// Field report of 2026-11-24: ufw, on by default on CachyOS, dropped the phone at home and nothing said so.
	it("says which firewall blocks the port, and how to open it", () => {
		const firewall = { name: "ufw", certain: true, command: "sudo ufw allow 47392/tcp" };
		const lines = codeLines({ code: "c", qr: "", hosts: ["192.168.2.214"], port: 47392, firewall });
		expect(lines).toContain("  sudo ufw allow 47392/tcp");
		expect(lines.some((line) => line.includes("ufw") && line.includes("47392"))).toBe(true);
		expect(firewallLines({ ...firewall, certain: false }, 47392)[0]).toContain("may block");
		expect(codeLines({ code: "c", qr: "", hosts: ["192.168.2.214"], port: 47392, firewall: null })).not.toContain(
			"  sudo ufw allow 47392/tcp",
		);
	});

	// The real server, when this checkout has built it (fork/android/server: cargo build --release).
	const built = resolve(__dirname, "../../../fork/android/server/target/release/prism-remote");
	it.skipIf(!existsSync(built))("gets a pairing code with its QR from a running server", async () => {
		const dir = temp();
		server = spawn(built, ["serve", "--dir", dir, "--host", "127.0.0.1", "--port", "0"], { stdio: "ignore" });
		const phone = new PhoneServer(built, undefined, dir);
		const deadline = Date.now() + 10_000;
		while (!phone.status() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
		expect(phone.status()?.hosts).toEqual(["127.0.0.1"]);
		const invitation = phone.invite();
		expect(invitation.code.startsWith("prism-pair:")).toBe(true);
		expect(invitation.qr).toContain("█");
		expect(phone.paired()).toEqual([]);
	});
});
