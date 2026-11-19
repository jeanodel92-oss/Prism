import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	rebuildCargoConfig,
	rebuildNpmrc,
	rebuildPipConf,
	rebuildUvToml,
	rebuiltSettingsCopies,
} from "../src/fork/sandbox/tool-settings.ts";

describe("settings rebuilt without credentials", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps npm's allowed fields only", () => {
		const text = [
			"; a comment",
			"registry=https://registry.example/",
			"//registry.example/:_authToken=npm_SECRET1",
			"_auth=SECRET2",
			"_password=SECRET3",
			"email=me@example.com",
			"always-auth=true",
			"@corp:registry=https://user:SECRET4@corp.example/",
			"@open:registry = https://open.example/",
			"@open:_authToken=SECRET6",
			"prefix=~/.local/npm",
			"ca=-----BEGIN CERTIFICATE-----SECRET5",
			"cafile=/etc/corp.pem",
			"strict-ssl=false",
			"[section]",
			"registry=https://in-a-section.example/",
		].join("\n");
		expect(rebuildNpmrc(text)).toBe(
			[
				"registry=https://registry.example/",
				"@open:registry=https://open.example/",
				"prefix=~/.local/npm",
				"cafile=/etc/corp.pem",
				"strict-ssl=false",
				"",
			].join("\n"),
		);
		expect(rebuildNpmrc("//r/:_authToken=x\n")).toBe("");
	});

	it("keeps pip's allowed fields, a value over several lines whole or not at all", () => {
		const text = [
			"[global]",
			"index-url = https://user:SECRET1@pypi.corp.example/simple",
			"timeout = 30",
			"extra-index-url =",
			"    https://mirror.example/simple",
			"    https://token:SECRET2@other.example/simple",
			"trusted-host =",
			"    mirror.example",
			"cert = /home/me/client.pem",
			"client-cert = /home/me/key.pem",
			"[install]",
			"user = true",
			"[download]",
			"index_url = https://open.example/simple",
		].join("\n");
		expect(rebuildPipConf(text)).toBe(
			[
				"[global]",
				"timeout = 30",
				"trusted-host =",
				"    mirror.example",
				"[download]",
				"index_url = https://open.example/simple",
				"",
			].join("\n"),
		);
	});

	it("keeps uv's index fields, not its [[index]] tables", () => {
		const text = [
			'index-url = "https://open.example/simple"',
			'extra-index-url = ["https://a.example/simple", "https://u:SECRET1@b.example/simple"]',
			"[[index]]",
			'url = "https://open.example/simple"',
			'name = "corp"',
			"[pip]",
			"http-timeout = 30",
			"extra-index-url = [",
			'  "https://c.example/simple",',
			"]",
			'index-url = "https://d.example/simple"',
		].join("\n");
		expect(rebuildUvToml(text)).toBe(
			[
				'index-url = "https://open.example/simple"',
				"[pip]",
				"http-timeout = 30",
				'index-url = "https://d.example/simple"',
				"",
			].join("\n"),
		);
	});

	it("keeps Cargo's build, target, net and source tables and a registry's index, not its token", () => {
		const text = [
			"[build]",
			'rustflags = ["-C", "target-cpu=native"]',
			"jobs = 4",
			"[registry]",
			'token = "cio_SECRET1"',
			"[registries.corp]",
			'index = "sparse+https://corp.example/index/"',
			'token = "SECRET2"',
			'credential-provider = "cargo:token"',
			"[registries.leaky]",
			'index = "https://user:SECRET3@leaky.example/index"',
			"[source.crates-io]",
			'replace-with = "corp"',
			"[target.x86_64-unknown-linux-gnu]",
			'linker = "clang"',
			"rustflags = [",
			'  "-C", "link-arg=-fuse-ld=mold",',
			"]",
			"[net]",
			"git-fetch-with-cli = true",
			"[http]",
			'proxy = "http://user:SECRET4@proxy:3128"',
			"[alias]",
			'b = "build"',
			'registries.corp.token = "SECRET5"',
			"[env]",
			'description = """',
			'index = "SECRET6"',
			'"""',
		].join("\n");
		const rebuilt = rebuildCargoConfig(text);
		expect(rebuilt).toBe(
			[
				"[build]",
				'rustflags = ["-C", "target-cpu=native"]',
				"jobs = 4",
				"[registries.corp]",
				'index = "sparse+https://corp.example/index/"',
				"[source.crates-io]",
				'replace-with = "corp"',
				"[target.x86_64-unknown-linux-gnu]",
				'linker = "clang"',
				"[net]",
				"git-fetch-with-cli = true",
				"",
			].join("\n"),
		);
		expect(rebuilt).not.toContain("SECRET");
	});

	it("writes a copy of each settings file that is a regular file, not of a link", () => {
		const home = mkdtempSync(join(tmpdir(), "prism-settings-home-"));
		const dir = mkdtempSync(join(tmpdir(), "prism-settings-copies-"));
		dirs.push(home, dir);
		writeFileSync(join(home, ".npmrc"), "registry=https://r.example/\n//r.example/:_authToken=SECRET\n");
		mkdirSync(join(home, ".cargo"));
		writeFileSync(join(home, "elsewhere.toml"), '[registry]\ntoken = "SECRET"\n');
		symlinkSync(join(home, "elsewhere.toml"), join(home, ".cargo", "config.toml"));
		const copies = rebuiltSettingsCopies(dir, [join(home, ".npmrc"), join(home, ".cargo", "config.toml")]);
		expect(copies.map(([, original]) => original)).toEqual([join(home, ".npmrc")]);
		expect(readFileSync(copies[0]![0], "utf8")).toBe("registry=https://r.example/\n");
	});
});
