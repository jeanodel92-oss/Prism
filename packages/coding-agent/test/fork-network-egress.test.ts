/**
 * fork: the site promises no telemetry and, with a local model, no host
 * contacted but your server. Every other test runs with PI_OFFLINE=1, so a new connection made by default would fail
 * no test. This one runs Prism from the sources in print mode, network allowed, against a local model server, records
 * every TCP connection the process opens (a preload wraps net.Socket#connect), and expects only that server.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolverUrl = pathToFileURL(join(packageDir, "src/experimental/source-resolver.ts")).href;
const cliUrl = pathToFileURL(join(packageDir, "src/cli.ts")).href;

/** Appends "host:port" (or "unix:path") for each socket the process connects, to the file named by the env. */
const PRELOAD = `
import net from "node:net";
import { appendFileSync } from "node:fs";
const log = process.env.PRISM_EGRESS_LOG;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = args[0];
	const options = Array.isArray(first) ? first[0] : first;
	let target;
	if (typeof options === "object" && options !== null) {
		target = options.path ? "unix:" + options.path : (options.host ?? "localhost") + ":" + options.port;
	} else if (typeof options === "string" && Number.isNaN(Number(options))) {
		target = "unix:" + options;
	} else {
		target = (typeof args[1] === "string" ? args[1] : "localhost") + ":" + options;
	}
	try { appendFileSync(log, target + "\\n"); } catch {}
	return connect.apply(this, args);
};
`;

function sseServer(): Promise<{ server: Server; port: number; requests: string[] }> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		request.resume();
		request.on("end", () => {
			if (request.url?.endsWith("/chat/completions")) {
				response.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (delta: object, finish: string | null) =>
					`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "local-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				response.write(chunk({ role: "assistant", content: "ok" }, null));
				response.write(chunk({}, "stop"));
				response.end("data: [DONE]\n\n");
				return;
			}
			response.writeHead(404).end();
		});
	});
	return new Promise((resolveServer) =>
		server.listen(0, "127.0.0.1", () =>
			resolveServer({ server, port: (server.address() as AddressInfo).port, requests }),
		),
	);
}

describe("fork: network egress with a local model (TESTS-04)", () => {
	const cleanup: Array<() => void> = [];
	afterEach(() => {
		for (const step of cleanup.splice(0)) step();
	});

	it("connects to the local model server and nowhere else", async () => {
		const { server, port, requests } = await sseServer();
		cleanup.push(() => server.close());
		const root = mkdtempSync(join(tmpdir(), "prism-egress-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const home = join(root, "home");
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		const packageRoot = join(root, "package");
		for (const dir of [home, cwd, agentDir, join(packageRoot, "bin")]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ type: "module", piConfig: { name: "prism", configDir: ".prism" } }),
		);
		for (const name of ["src", "docs", "examples", "vendor"]) {
			symlinkSync(join(packageDir, name), join(packageRoot, name), "dir");
		}
		const prism = join(packageRoot, "bin", "prism");
		writeFileSync(prism, `import ${JSON.stringify(cliUrl)};\n`);
		const preload = join(root, "egress.mjs");
		writeFileSync(preload, PRELOAD);
		const log = join(root, "egress.log");
		writeFileSync(log, "");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "none",
						models: [
							{
								id: "local-model",
								name: "Local",
								reasoning: false,
								input: ["text"],
								contextWindow: 32000,
								maxTokens: 1000,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "local-model" }),
		);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_DATA_HOME: join(home, ".local/share"),
			PI_PACKAGE_DIR: packageRoot,
			PRISM_CODING_AGENT_DIR: agentDir,
			PRISM_EGRESS_LOG: log,
		};
		delete env.PI_OFFLINE;
		delete env.PRISM_OFFLINE;
		const child = spawn(
			process.execPath,
			["--import", pathToFileURL(preload).href, "--import", resolverUrl, prism, "-p", "hello"],
			{
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode));

		expect(output, output).toContain("ok");
		expect(code).toBe(0);
		expect(requests).toContain("POST /v1/chat/completions");
		const targets = [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))];
		const network = targets.filter((target) => !target.startsWith("unix:"));
		expect(network).toEqual([`127.0.0.1:${port}`]);
	}, 60_000);
});
