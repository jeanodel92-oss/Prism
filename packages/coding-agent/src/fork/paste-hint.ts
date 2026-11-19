/**
 * fork: what the paste key pastes. Files can only be pasted on macOS; the fork targets Linux, where
 * "paste files on macOS" was shown anyway.
 */
export function pasteTargets(platform: NodeJS.Platform = process.platform): string {
	return platform === "darwin" ? "files on macOS, images, or text" : "images or text";
}
