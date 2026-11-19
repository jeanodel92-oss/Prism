/**
 * fork: the binaries Prism downloads itself (fd and ripgrep, when they are not on PATH) are
 * pinned to one release and checked against the SHA-256 of each archive before anything is extracted. A
 * tampered or swapped archive is refused and deleted. Upstream took the latest release, which no checksum can
 * cover. The sums come from the GitHub release assets; bumping a version means updating them here.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface PinnedRelease {
	version: string;
	sha256: Record<string, string>;
}

const PINNED: Record<"fd" | "rg", PinnedRelease> = {
	fd: {
		version: "10.5.0",
		sha256: {
			"fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz":
				"761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
			"fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz":
				"d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4",
			"fd-v10.5.0-aarch64-apple-darwin.tar.gz": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
			"fd-v10.5.0-x86_64-pc-windows-msvc.zip": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
			"fd-v10.5.0-aarch64-pc-windows-msvc.zip": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
			// darwin/x64 stays on the release upstream pins it to.
			"fd-v10.3.0-x86_64-apple-darwin.tar.gz": "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
		},
	},
	rg: {
		version: "15.2.0",
		sha256: {
			"ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz":
				"33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
			"ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz":
				"800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
			"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz":
				"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
			"ripgrep-15.2.0-aarch64-apple-darwin.tar.gz":
				"3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
			"ripgrep-15.2.0-x86_64-pc-windows-msvc.zip":
				"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
			"ripgrep-15.2.0-aarch64-pc-windows-msvc.zip":
				"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
		},
	},
};

/** The release Prism downloads for `tool`. */
export const pinnedVersion = (tool: "fd" | "rg"): string => PINNED[tool].version;

/** Throws, naming the archive, unless the file at `path` is the archive `assetName` that was pinned. */
export function verifyPinnedDownload(tool: "fd" | "rg", assetName: string, path: string): void {
	const expected = PINNED[tool].sha256[assetName];
	if (!expected) throw new Error(`${assetName} has no known checksum; Prism does not install it`);
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (actual !== expected) {
		throw new Error(`${assetName} does not match its known checksum (it may have been altered); it was deleted`);
	}
}
