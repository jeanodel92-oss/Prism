/**
 * what the browser tool opens on this
 * machine. A file of the project (`file://…`, or its path) is served by Prism on 127.0.0.1, on a port of the session
 * and behind a secret that only the browser tool's first request carries: the user's browser cannot open `file://`
 * for an extension, and it must not read files the agent may not read. A server of the session (`localhost:<port>`)
 * is relayed from the session's loopback (`session-ports.ts`); in a session without a network of its own, a server of
 * a running background task is opened where it listens, on the machine's loopback (`task-ports.ts`). The pages
 * themselves are not filtered: maintainer's decision of 2026-11-24, as a browser the agent opens on the desktop.
 */

import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionBackgroundTasks } from "../background.ts";
import { existingSessionTmpDir } from "../sandbox/runtime.ts";
import { sessionNetPrefix } from "../sandbox/session-net.ts";
import { relaysTo, sessionPort } from "../sandbox/session-ports.ts";
import { protectedSearch } from "../search-protected.ts";
import { type TaskPort, taskPort } from "./task-ports.ts";

const TOKEN_PARAM = "prism-preview";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".wasm": "application/wasm",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".pdf": "application/pdf",
	".xml": "application/xml",
};

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The project files of one session, served to the user's browser. */
class FileServer {
	readonly token = randomBytes(24).toString("hex");
	readonly root: string;
	private readonly server: Server;
	private readonly ready: Promise<number>;

	constructor(root: string) {
		this.root = root;
		this.server = createServer((request, response) => this.answer(request, response));
		this.server.unref();
		this.ready = new Promise((done, failed) => {
			this.server.once("error", failed);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.off("error", failed);
				this.server.on("error", () => {});
				const address = this.server.address();
				done(typeof address === "object" && address ? address.port : 0);
			});
		});
	}

	port(): Promise<number> {
		return this.ready;
	}

	close(): void {
		this.server.close();
	}

	/** Why the browser may not see `file` (outside the project, protected), or undefined. */
	refusal(file: string): string | undefined {
		if (!within(this.root, file))
			return `Prism shows the browser the files of the project folder (${this.root}) only. Copy the page into it, or start a server and open http://localhost:<port>.`;
		const reason = protectedSearch(this.root, this.root)?.(file);
		return reason ? `${file} is protected (${reason}): Prism does not show it to the browser.` : undefined;
	}

	private answer(request: IncomingMessage, response: ServerResponse) {
		const send = (status: number, text: string, headers: Record<string, string> = {}) => {
			response.writeHead(status, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				...headers,
			});
			response.end(text);
		};
		if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed");
		const port = (this.server.address() as { port: number }).port;
		const cookie = `prism_preview_${port}`;
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		// The tool's URL carries the secret once; the browser then keeps it in a cookie of this port only.
		if (url.searchParams.get(TOKEN_PARAM) === this.token) {
			url.searchParams.delete(TOKEN_PARAM);
			return send(303, "", {
				location: url.pathname + url.search,
				"set-cookie": `${cookie}=${this.token}; Path=/; HttpOnly; SameSite=Strict`,
			});
		}
		const cookies = (request.headers.cookie ?? "").split(/;\s*/);
		if (!cookies.includes(`${cookie}=${this.token}`)) return send(403, "Forbidden: open this page through Prism.");
		let file: string;
		try {
			file = realpathSync(resolve(this.root, `.${decodeURIComponent(url.pathname)}`));
			if (statSync(file).isDirectory()) file = realpathSync(join(file, "index.html"));
		} catch {
			return send(404, "Not found");
		}
		const refused = this.refusal(file);
		if (refused) return send(403, refused);
		response.writeHead(200, {
			"content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
			"content-length": String(statSync(file).size),
			"cache-control": "no-store",
		});
		if (request.method === "HEAD") return void response.end();
		createReadStream(file)
			.on("error", () => response.destroy())
			.pipe(response);
	}
}

/** What the browser tool opens instead of the URL it was given; undefined when the URL is not local. */
export type LocalPage = { url: URL } | { error: string };

/** By session id. */
const servers = new Map<string, FileServer>();
/** The origins of a session's local pages, which a redirect may lead to. */
const origins = new Map<string, Set<string>>();

const remember = (session: string, url: URL) => {
	const known = origins.get(session) ?? new Set<string>();
	known.add(url.origin);
	origins.set(session, known);
};

const MACHINE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** A path or file URL the model gave, as an absolute path; undefined when it is neither. */
function localFile(text: string, cwd: string): string | undefined {
	if (text.startsWith("file:")) {
		try {
			return fileURLToPath(text);
		} catch {
			return undefined;
		}
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return undefined;
	const path = isAbsolute(text) ? text : resolve(cwd, text);
	try {
		statSync(path);
		return path;
	} catch {
		return isAbsolute(text) ? path : undefined;
	}
}

/**
 * The page the browser tool opens for `text`: a project file served by Prism, or a server of the session relayed to
 * the machine; undefined for any other URL, which the host rule judges as before.
 */
export async function localPage(session: string, cwd: string, text: string): Promise<LocalPage | undefined> {
	const path = localFile(text, cwd);
	if (path !== undefined) {
		let real: string;
		try {
			real = realpathSync(path);
		} catch {
			return { error: `No such file: ${path}` };
		}
		let server = servers.get(session);
		if (!server || server.root !== realpathSync(cwd)) {
			server?.close();
			server = new FileServer(realpathSync(cwd));
			servers.set(session, server);
		}
		const refused = server.refusal(real);
		if (refused) return { error: refused };
		const port = await server.port();
		const rel = relative(server.root, real).split(sep).map(encodeURIComponent).join("/");
		const hash = text.startsWith("file:") ? new URL(text).hash : "";
		const url = new URL(`http://127.0.0.1:${port}/${rel}?${TOKEN_PARAM}=${server.token}${hash}`);
		remember(session, url);
		return { url };
	}
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" || !MACHINE_HOSTS.has(url.hostname)) return undefined;
	const tmp = existingSessionTmpDir(session);
	if (!tmp || sessionNetPrefix(tmp).length === 0) {
		// without a network of its own, the session's tasks listen on the
		// machine's loopback, where the browser reaches them as they are.
		const served = machineTaskPort(session, url);
		if (!served) return undefined;
		const direct = new URL(url.href);
		direct.hostname = served.hosts[0]!;
		remember(session, direct);
		return { url: direct };
	}
	const hostPort = await sessionPort(tmp, Number(url.port) || 80);
	if (hostPort === undefined) return undefined;
	// The relay listens on 127.0.0.1 only: `localhost` could reach another server of the machine on [::1].
	const relayed = new URL(url.href);
	relayed.hostname = "127.0.0.1";
	relayed.port = String(hostPort);
	remember(session, relayed);
	return { url: relayed };
}

/**
 * Where a running background task listens on `url`'s port of the machine's loopback; undefined when none does. The
 * process of a task without a sandbox leads its process group (`launch`), which its children join.
 */
function machineTaskPort(session: string, url: URL): TaskPort | undefined {
	// The session's own tasks only: another session of the same process may run servers too.
	const pids = sessionBackgroundTasks(session).flatMap((task) =>
		task.status === "running" && task.pid !== undefined ? [task.pid] : [],
	);
	return taskPort(Number(url.port) || 80, pids);
}

/** Whether `url` is one of the session's local pages (or a relayed port), which needs no host rule. */
export function isLocalPage(session: string, url: URL): boolean {
	if (origins.get(session)?.has(url.origin)) return true;
	if (url.protocol !== "http:") return false;
	const tmp = existingSessionTmpDir(session);
	if (tmp && sessionNetPrefix(tmp).length > 0)
		return url.hostname === "127.0.0.1" && relaysTo(tmp, Number(url.port) || 80);
	if (!MACHINE_HOSTS.has(url.hostname)) return false;
	const served = machineTaskPort(session, url);
	if (!served) return false;
	// `localhost` and 0.0.0.0 may reach either family: only when nothing else listens on that port.
	return (
		served.hosts.includes(url.hostname) ||
		(!served.shared && (url.hostname === "localhost" || url.hostname === "0.0.0.0"))
	);
}

/** Closes the session's file server, when the session ends. */
export function closeLocalPages(session: string): void {
	servers.get(session)?.close();
	servers.delete(session);
	origins.delete(session);
}

/** A refusal of `url` by the host rule, with what the model can do when `url` names this machine. */
export function localHint(refusal: string, url: URL): string {
	if (!MACHINE_HOSTS.has(url.hostname)) return refusal;
	const port = Number(url.port) || 80;
	return `${refusal} No server started by this session listens on port ${port}: start it (a background task) and open this URL again, and Prism shows it to the browser. A project file opens by its path or a file:// URL.`;
}
