import { constants, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A private snapshot outside the command's mounts: validation and publication read these same bytes. */
export interface GitFile {
	file: string;
	size: number;
}

export function gitFileStream(content: GitFile) {
	return Readable.from(
		(async function* () {
			const input = await open(content.file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				yield* input.createReadStream();
			} finally {
				await input.close();
			}
		})(),
	);
}

/** Copies a snapshot without holding a pack or loose object in memory. */
export async function writeGitFile(path: string, content: Buffer | GitFile): Promise<void> {
	const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
	if (Buffer.isBuffer(content)) {
		await pipeline([content], output);
	} else {
		await pipeline(gitFileStream(content), output);
	}
}
