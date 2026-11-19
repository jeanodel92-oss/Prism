/**
 * while the agent's desktop runs, graphical programs the agent starts outside the sandbox open there,
 * never on the user's desktop. Sandboxed commands cannot reach it: the sandbox refuses Unix sockets
 * , so the desktop tool's launch action starts programs outside it.
 */

let socket: string | undefined;

export function setDesktopSocket(path: string | undefined): void {
	socket = path;
}

/** Tests only. */
export function desktopSocket(): string | undefined {
	return socket;
}

/** The environment of a command outside the sandbox: the agent's desktop, or unchanged. */
export function withDesktopEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (!socket) return env;
	const { DISPLAY: _display, ...rest } = env;
	return { ...rest, WAYLAND_DISPLAY: socket, XDG_SESSION_TYPE: "wayland" };
}
