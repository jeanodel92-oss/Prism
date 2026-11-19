/**
 * fork: on a desktop without buses of its own (no accessibility registry, or the
 * buses failed to start), programs started with launch kept the user's session and accessibility bus addresses, so
 * they reached the user's keyring, notifications and portals. They now get a session bus address that leads nowhere
 * and no accessibility bus. Synthetic user addresses; no bus is reached. Throwaway HOME and agent dir.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { launchOnDesktop, NO_SESSION_BUS } from "../src/fork/desktop/index.ts";
import { stubThrowawayHome } from "./suite/throwaway-home.ts";

const PRINT =
	'printf "session=%s a11y=%s\\n" "$DBUS_SESSION_BUS_ADDRESS" "$(printenv AT_SPI_BUS_ADDRESS || echo unset)"';
const BRIDGE =
	'printf "session=%s a11y=%s bridge=%s\\n" "$DBUS_SESSION_BUS_ADDRESS" "$(printenv AT_SPI_BUS_ADDRESS || echo unset)" "$(printenv NO_AT_BRIDGE || echo on)"';

describe("programs on a desktop without its own buses", () => {
	let base: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "prism-no-buses-"));
		mkdirSync(join(base, "home"));
		stubThrowawayHome(join(base, "home"));
		vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
		vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/4242/bus");
		vi.stubEnv("AT_SPI_BUS_ADDRESS", "unix:path=/run/user/4242/at-spi/bus_0");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(base, { recursive: true, force: true });
	});

	it("never get the user's session or accessibility bus", async () => {
		const launched = await launchOnDesktop(PRINT, base, join(base, "launch.log"), {});
		await launched.group.ended;
		expect(launched.output.trim()).toBe(`session=${NO_SESSION_BUS} a11y=unset`);
	});

	// Owner, 2026-11-12: without the accessibility registry, the desktop still has a session bus of its own.
	it("keep the desktop's session bus without its accessibility bus", async () => {
		const own = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/desk/bus" };
		const launched = await launchOnDesktop(BRIDGE, base, join(base, "launch.log"), own);
		await launched.group.ended;
		expect(launched.output.trim()).toBe("session=unix:path=/tmp/desk/bus a11y=unset bridge=1");
	});

	it("get the desktop's own buses when it has them", async () => {
		const own = {
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/desk/bus",
			AT_SPI_BUS_ADDRESS: "unix:path=/tmp/desk/a11y",
		};
		const launched = await launchOnDesktop(PRINT, base, join(base, "launch.log"), own);
		await launched.group.ended;
		expect(launched.output.trim()).toBe("session=unix:path=/tmp/desk/bus a11y=unix:path=/tmp/desk/a11y");
	});
});
