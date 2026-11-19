/**
 * fork: sandboxed commands see the user's
 * containers without changing them. The relay serves the Docker API on the sandbox's loopback (`DOCKER_HOST`,
 * `CONTAINER_HOST`) and passes each request to Prism, which asks the user's Docker or Podman socket only what the
 * listing commands need (`docker ps`, `docker images`, `podman --remote ps`), and returns only the fields those
 * show. Inspecting a container, its logs, its environment, its command line and its labels, and every write,
 * are refused: reading APIs expose secrets too.
 */

import { statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import type { CommandNetwork } from "./proxy.ts";

/** The proxy request method that opens a container API connection from the relay. */
export const CONTAINERS_METHOD = "PRISM-CONTAINERS";

const MAX_REQUEST_HEAD = 16 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
/** fork: a container service silent this long is given up. */
const ANSWER_TIMEOUT_MS = 30_000;

type Filter = (body: unknown) => unknown;

/** Keeps the listed fields of each object of a JSON array. */
const fields =
	(...names: string[]): Filter =>
	(body) =>
		Array.isArray(body)
			? body.map((item: Record<string, unknown>) =>
					Object.fromEntries(names.filter((name) => name in item).map((name) => [name, item[name]])),
				)
			: body;

const CONTAINER_FIELDS = fields(
	"Id",
	"Names",
	"Image",
	"ImageID",
	"Created",
	"CreatedAt",
	"State",
	"Status",
	"Ports",
	"Exited",
	"ExitCode",
	"ExitedAt",
	"StartedAt",
	"Pod",
	"PodName",
	"IsInfra",
	"AutoRemove",
	"Size",
	"SizeRw",
	"SizeRootFs",
);
const IMAGE_FIELDS = fields("Id", "ParentId", "RepoTags", "RepoDigests", "Created", "Size", "SharedSize", "Containers");

/**
 * The `filters` a listing accepts: those on what it shows. A filter on hidden fields (labels, environment, volumes)
 * would answer whether a guessed value is there.
 */
const CONTAINER_FILTERS = [
	"id",
	"name",
	"status",
	"ancestor",
	"before",
	"since",
	"exited",
	"health",
	"pod",
	"publish",
	"expose",
	"is-task",
	"isolation",
];
const IMAGE_FILTERS = ["dangling", "reference", "before", "since", "until"];

interface Route {
	filter?: Filter;
	/** The query parameters passed on; any other is refused, so that a listing never answers another question. */
	query: string[];
	filters?: string[];
}

/** What passes, by path without its API version. */
const ROUTES = new Map<string, Route>([
	["/_ping", { query: [] }],
	["/version", { query: [] }],
	[
		"/containers/json",
		{ filter: CONTAINER_FIELDS, query: ["all", "limit", "size", "filters"], filters: CONTAINER_FILTERS },
	],
	[
		"/images/json",
		{
			filter: IMAGE_FIELDS,
			query: ["all", "filters", "digests", "shared-size", "manifests"],
			filters: IMAGE_FILTERS,
		},
	],
	["/libpod/_ping", { query: [] }],
	["/libpod/version", { query: [] }],
	[
		"/libpod/containers/json",
		{
			filter: CONTAINER_FIELDS,
			query: ["all", "limit", "last", "size", "filters", "sync", "external", "namespace", "pod"],
			filters: CONTAINER_FILTERS,
		},
	],
	["/libpod/images/json", { filter: IMAGE_FIELDS, query: ["all", "filters"], filters: IMAGE_FILTERS }],
]);

/** Response headers the clients read: API version negotiation. */
const KEPT_HEADERS = new Set([
	"api-version",
	"libpod-api-version",
	"libpod-buildah-version",
	"docker-experimental",
	"ostype",
	"builder-version",
	"content-type",
	"server",
]);

const isSocketPath = (path: string) => {
	try {
		return statSync(path).isSocket();
	} catch {
		return false;
	}
};

/** The user's container socket, or why there is none. `isSocket` stands in for the file system in tests. */
export function containerSocket(
	env: NodeJS.ProcessEnv = process.env,
	isSocket: (path: string) => boolean = isSocketPath,
): string | { error: string } {
	const configured = env.DOCKER_HOST ?? env.CONTAINER_HOST;
	if (configured) {
		if (!configured.startsWith("unix://")) {
			return { error: `Prism reaches local container services only, and DOCKER_HOST is ${configured}` };
		}
		return configured.slice("unix://".length);
	}
	const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
	for (const path of [`${runtime}/docker.sock`, `${runtime}/podman/podman.sock`, "/var/run/docker.sock"]) {
		if (isSocket(path)) return path;
	}
	return {
		error: "no Docker or Podman service is running for the user (for Podman: systemctl --user start podman.socket)",
	};
}

/** The request Prism passes to the socket for `target`, or why it is refused. */
export function containerRoute(method: string, target: string): { path: string; filter?: Filter } | string {
	if (method !== "GET" && method !== "HEAD") return "commands in the sandbox only see containers, never change them";
	let url: URL;
	try {
		url = new URL(target, "http://containers");
	} catch {
		return "malformed request";
	}
	if (!target.startsWith("/")) return "malformed request";
	const version = /^\/v\d+(?:\.\d+){0,2}(?=\/)/.exec(url.pathname)?.[0] ?? "";
	const route = ROUTES.get(url.pathname.slice(version.length));
	if (!route) {
		return `only the container and image lists are shown to commands in the sandbox (${url.pathname} is not)`;
	}
	for (const [name, value] of url.searchParams) {
		if (!route.query.includes(name)) return `the container lists of the sandbox do not take ${name}`;
		if (name !== "filters") continue;
		let filters: unknown;
		try {
			filters = JSON.parse(value);
		} catch {
			return "malformed filters";
		}
		if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return "malformed filters";
		const hidden = Object.keys(filters).find((key) => !route.filters?.includes(key));
		if (hidden !== undefined)
			return `the container lists of the sandbox cannot filter on ${hidden}, which they do not show`;
	}
	return { path: `${url.pathname}${url.search}`, filter: route.filter };
}

function respond(stream: Duplex, status: number, reason: string, headers: [string, string][], body: Buffer): void {
	const lines = [...headers, ["Content-Length", String(body.length)]].map(([name, value]) => `${name}: ${value}`);
	stream.write(`HTTP/1.1 ${status} ${reason}\r\n${lines.join("\r\n")}\r\n\r\n`, "latin1");
	stream.write(body);
}

/** A refusal both Docker's and Podman's clients print. */
function refuse(stream: Duplex, status: number, message: string, close = false): void {
	const text = `Prism's sandbox: ${message}`;
	const body = Buffer.from(JSON.stringify({ message: text, cause: text, response: status }));
	const headers: [string, string][] = [["Content-Type", "application/json"]];
	if (close) headers.push(["Connection", "close"]);
	respond(stream, status, status === 403 ? "Forbidden" : "Bad Gateway", headers, body);
}

/** Asks the socket, and returns its answer filtered. `signal` cancels the request (its connection closed). */
function forward(
	socket: string,
	method: string,
	route: { path: string; filter?: Filter },
	signal: AbortSignal,
): Promise<{ status: number; reason: string; headers: [string, string][]; body: Buffer } | string> {
	return new Promise((resolve) => {
		const outgoing = httpRequest(
			{ socketPath: socket, method, path: route.path, headers: { Host: "d" }, signal },
			(incoming) => {
				const chunks: Buffer[] = [];
				let size = 0;
				incoming.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_RESPONSE) incoming.destroy(new Error("answer too large"));
					else chunks.push(chunk);
				});
				incoming.on("error", (error) => resolve(error.message));
				incoming.on("end", () => {
					let body = Buffer.concat(chunks);
					const type = String(incoming.headers["content-type"] ?? "");
					if (route.filter && incoming.statusCode === 200) {
						if (!type.includes("json")) return resolve("the container service did not answer in JSON");
						try {
							body = Buffer.from(JSON.stringify(route.filter(JSON.parse(body.toString("utf8")))));
						} catch {
							return resolve("the container service did not answer in JSON");
						}
					}
					const headers: [string, string][] = [];
					for (const [name, value] of Object.entries(incoming.headers)) {
						if (KEPT_HEADERS.has(name) && typeof value === "string") headers.push([name, value]);
					}
					resolve({ status: incoming.statusCode ?? 502, reason: incoming.statusMessage ?? "", headers, body });
				});
			},
		);
		outgoing.on("error", (error) => resolve(error.message));
		outgoing.setTimeout(ANSWER_TIMEOUT_MS, () =>
			outgoing.destroy(new Error("the container service did not answer in time")),
		);
		outgoing.end();
	});
}

/** Serves one connection of the sandbox's container API: one request after another, as the clients send them. */
export function serveContainers(stream: Duplex, rest: Buffer, network: CommandNetwork): void {
	let buffered = rest;
	let busy = false;
	// fork: while a request waits for the service, the next ones wait in the stream
	// (paused, so the sandbox's writer is held back), and the service's request ends with the connection.
	const closed = new AbortController();
	stream.once("close", () => closed.abort());
	const next = async () => {
		if (busy) return;
		const end = buffered.indexOf("\r\n\r\n");
		if (end < 0) {
			if (buffered.length > MAX_REQUEST_HEAD) stream.destroy();
			return;
		}
		busy = true;
		stream.pause();
		const [requestLine = "", ...headerLines] = buffered.subarray(0, end).toString("latin1").split("\r\n");
		buffered = buffered.subarray(end + 4);
		const [method = "", target = ""] = requestLine.split(" ");
		const length = Number(/^content-length:\s*(\d+)$/im.exec(headerLines.join("\n"))?.[1] ?? 0);
		const chunked = headerLines.some((line) => /^transfer-encoding:/i.test(line));
		if (!network.containers) {
			refuse(
				stream,
				403,
				"commands do not see the user's containers. Ask the user to turn on « Commands see my containers » in /settings > Permissions & sandbox.",
			);
		} else if (length > 0 || chunked) {
			// A request with a body changes something: refused, and the connection with it.
			refuse(stream, 403, "commands in the sandbox only see containers, never change them", true);
			stream.end();
			return;
		} else {
			const route = containerRoute(method, target);
			const socket = containerSocket();
			if (typeof route === "string") refuse(stream, 403, route);
			else if (typeof socket !== "string") refuse(stream, 502, socket.error);
			else if (network.sandboxWrites?.(socket) !== false) {
				refuse(stream, 403, `${socket} is a path commands in the sandbox can change`);
			} else {
				const answer = await forward(socket, method, route, closed.signal);
				if (stream.destroyed) return;
				if (typeof answer === "string") refuse(stream, 502, answer);
				else
					respond(
						stream,
						answer.status,
						answer.reason,
						answer.headers,
						method === "HEAD" ? Buffer.alloc(0) : answer.body,
					);
			}
		}
		busy = false;
		stream.resume();
		void next();
	};
	stream.on("data", (chunk: Buffer) => {
		// While a request waits, a chunk read before the pause took effect is kept, but never more than a head's worth.
		if (busy && buffered.length + chunk.length > MAX_REQUEST_HEAD) {
			stream.destroy();
			return;
		}
		buffered = Buffer.concat([buffered, chunk]);
		void next();
	});
	stream.on("error", () => stream.destroy());
	stream.resume();
	void next();
}
