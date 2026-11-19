/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { assertNotBinaryFile } from "../fork/binary-file.ts";
import { readBounded } from "../fork/bounded-read.ts";
import { documentTextForModel, IMAGE_LIMIT } from "../fork/document-preview.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		// fork: a FIFO or device is refused before anything opens it and waits.
		if (!stats.isFile()) {
			console.error(chalk.red(`Error: ${absolutePath} is not a regular file`));
			process.exit(1);
		}
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			// fork: no larger than an image `read` loads; a FIFO is refused, not waited on.
			let content: Buffer;
			try {
				content = await readBounded(absolutePath, IMAGE_LIMIT);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				// fork: a PDF, .docx or .odt gives its extracted text, as with `read`; another
				// binary file is refused instead of sent as noise. A FIFO or device is refused without blocking.
				const extracted = await documentTextForModel(absolutePath);
				if (extracted === undefined) await assertNotBinaryFile(absolutePath, absolutePath);
				const content =
					extracted ?? stripBom((await readBounded(absolutePath, Number.MAX_SAFE_INTEGER)).toString("utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
