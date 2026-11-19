import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containerRoute, containerSocket, serveContainers } from "../src/fork/sandbox/containers.ts";
import type { CommandNetwork } from "../src/fork/sandbox/proxy.ts";

// fork: the sandbox sees the user's containers listed, never inspected or changed.
describe("fork: the user's containers from the sandbox", () => {
	it("passes the listings only, with their own parameters", () => {
		for (const target of [
			"/_ping",
			"/v1.41/containers/json?all=1",
			"/containers/json",
			"/v1.41/images/json",
			"/v5.8.7/libpod/containers/json?all=true&external=false&filters=%7B%7D&last=-1&namespace=false&size=false&sync=false",
			"/v5.8.7/libpod/images/json?all=false&filters=%7B%7D",
		]) {
			expect(containerRoute("GET", target), target).toMatchObject({ path: target });
		}
		for (const method of ["POST", "PUT", "DELETE", "CONNECT"]) {
			expect(containerRoute(method, "/v1.41/containers/json")).toContain("never change them");
		}
		for (const target of [
			"/v1.41/containers/c1/json",
			"/v1.41/containers/c1/logs",
			"/v1.41/containers/c1/archive?path=/",
			"/v1.41/events",
			"/v1.41/info",
			"/v1.41/containers/json/../c1/json",
			"/v1.41/containers%2Fc1%2Fjson",
			"/v5.8.7/libpod/containers/c1/json",
			"http://elsewhere/v1.41/containers/json",
		]) {
			expect(typeof containerRoute("GET", target), target).toBe("string");
		}
	});

	it("filters on what the listings show, nothing else", () => {
		const filters = (value: object) => `/v1.41/containers/json?filters=${encodeURIComponent(JSON.stringify(value))}`;
		expect(containerRoute("GET", filters({ name: ["web"], status: ["running"] }))).toMatchObject({});
		expect(typeof containerRoute("GET", filters({ name: ["web"] }))).toBe("object");
		// A label, an environment or a volume filter would answer whether a guessed value is there.
		for (const hidden of [{ label: ["token=x"] }, { volume: ["/secret"] }, { name: ["a"], env: ["A=1"] }]) {
			expect(containerRoute("GET", filters(hidden))).toContain("cannot filter on");
		}
		expect(containerRoute("GET", "/v1.41/containers/json?filters=nope")).toBe("malformed filters");
		expect(containerRoute("GET", "/v1.41/containers/json?filters=%5B%5D")).toBe("malformed filters");
		expect(
			containerRoute("GET", "/v1.41/containers/json?all=1&filters=%7B%7D&filters=%7B%22label%22%3A%5B%5D%7D"),
		).toContain("cannot filter on label");
		expect(containerRoute("GET", "/v1.41/images/json?filters=%7B%22label%22%3A%5B%5D%7D")).toContain("cannot filter");
		expect(containerRoute("GET", "/v1.41/containers/json?other=1")).toContain("do not take other");
	});

	it("finds the user's local socket, and no remote service", () => {
		expect(containerSocket({ DOCKER_HOST: "unix:///run/d.sock" })).toBe("/run/d.sock");
		expect(containerSocket({ CONTAINER_HOST: "unix:///run/p.sock" })).toBe("/run/p.sock");
		expect(containerSocket({ DOCKER_HOST: "tcp://10.0.0.2:2375" })).toMatchObject({
			error: expect.stringContaining("local"),
		});
		expect(containerSocket({ DOCKER_HOST: "ssh://host" })).toMatchObject({ error: expect.any(String) });
		// The host's sockets are not the test's: a runner or a desktop may have /var/run/docker.sock.
		const sockets =
			(...present: string[]) =>
			(path: string) =>
				present.includes(path);
		expect(containerSocket({ XDG_RUNTIME_DIR: "/run/user/7" }, sockets())).toMatchObject({
			error: expect.any(String),
		});
		expect(containerSocket({ XDG_RUNTIME_DIR: "/run/user/7" }, sockets("/var/run/docker.sock"))).toBe(
			"/var/run/docker.sock",
		);
		expect(
			containerSocket(
				{ XDG_RUNTIME_DIR: "/run/user/7" },
				sockets("/var/run/docker.sock", "/run/user/7/podman/podman.sock"),
			),
		).toBe("/run/user/7/podman/podman.sock");
		expect(containerSocket({ DOCKER_HOST: "unix:///run/d.sock" }, sockets())).toBe("/run/d.sock");
	});

	describe("serving the sandbox's requests", () => {
		let root: string;
		let docker: Server;
		let relay: NetServer;
		let port: number;
		let seen: string[];
		let network: Pick<CommandNetwork, "containers" | "sandboxWrites">;

		beforeEach(async () => {
			root = mkdtempSync(join(tmpdir(), "prism-containers-"));
			seen = [];
			docker = createHttpServer((incoming, outgoing) => {
				seen.push(`${incoming.method} ${incoming.url}`);
				outgoing.setHeader("Content-Type", "application/json");
				outgoing.setHeader("Api-Version", "1.41");
				outgoing.setHeader("X-Other", "dropped");
				outgoing.end(
					JSON.stringify([
						{
							Id: "c1",
							Names: ["/web"],
							Image: "img",
							State: "running",
							Labels: { token: "label-canary" },
							Command: "run --password=cmd-canary",
							Mounts: [{ Source: "/home/u/secret" }],
							Env: ["SECRET=env-canary"],
						},
					]),
				);
			});
			const socket = join(root, "docker.sock");
			await new Promise<void>((done) => docker.listen(socket, done));
			vi.stubEnv("DOCKER_HOST", `unix://${socket}`);
			network = { containers: true, sandboxWrites: () => false };
			relay = createServer((stream) => serveContainers(stream, Buffer.alloc(0), network as CommandNetwork));
			await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
			port = (relay.address() as { port: number }).port;
		});
		afterEach(() => {
			vi.unstubAllEnvs();
			docker.close();
			relay.close();
			rmSync(root, { recursive: true, force: true });
		});

		const get = (path: string, method = "GET", body?: string) =>
			new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
				const outgoing = request(
					// Node sends a GET's body without saying so: a client that means it says how long it is.
					{
						host: "127.0.0.1",
						port,
						path,
						method,
						headers: body ? { "Content-Length": Buffer.byteLength(body) } : {},
					},
					(incoming) => {
						let text = "";
						incoming.on("data", (chunk) => {
							text += chunk;
						});
						incoming.on("end", () =>
							done({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: text }),
						);
					},
				);
				outgoing.on("error", fail);
				outgoing.end(body);
			});

		it("answers a listing without what the containers hold", async () => {
			const answer = await get("/v1.41/containers/json?all=1");
			expect(answer.status).toBe(200);
			expect(JSON.parse(answer.body)).toEqual([{ Id: "c1", Names: ["/web"], Image: "img", State: "running" }]);
			expect(answer.body).not.toContain("canary");
			expect(answer.headers["api-version"]).toBe("1.41");
			expect(answer.headers["x-other"]).toBeUndefined();
			expect(seen).toEqual(["GET /v1.41/containers/json?all=1"]);
		});

		it("refuses while the setting is off, a request with a body, and a socket the sandbox can change", async () => {
			network.containers = false;
			const off = await get("/v1.41/containers/json");
			expect(off.status).toBe(403);
			expect(off.body).toContain("Commands see my containers");
			network.containers = true;
			const create = await get("/v1.41/containers/json", "GET", "{}");
			expect(create.status).toBe(403);
			expect(create.body).toContain("never change them");
			network.sandboxWrites = (path) => path.startsWith(root);
			const writable = await get("/v1.41/containers/json");
			expect(writable.status).toBe(403);
			expect(writable.body).toContain("commands in the sandbox can change");
			expect(seen).toEqual([]);
		});
	});
});
