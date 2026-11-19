import { join } from "node:path";
import { vi } from "vitest";

/**
 * Stubs HOME and the XDG base folders under `home`. HOME alone is not enough: a session that sets XDG_CONFIG_HOME,
 * XDG_DATA_HOME, XDG_CACHE_HOME or XDG_STATE_HOME keeps programs writing there
 * . Undone by `vi.unstubAllEnvs()`.
 */
export function stubThrowawayHome(home: string): void {
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
	vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
	vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
	vi.stubEnv("XDG_STATE_HOME", join(home, ".local", "state"));
}
