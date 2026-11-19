/**
 * fork: /undo's backups must give the file back exactly, a known secret included, so
 * they are encrypted instead of masked. AES-256-GCM, with the backup's name as authenticated data: a backup changed or
 * moved to another name is refused, never restored. Every backup is encrypted, whatever it holds: no detection to keep.
 *
 * The key is in `checkpoint.key` (0600) in the agent folder, outside `checkpoints/`, reserved as auth.json is: the
 * model cannot read it, and a copy of the backups alone gives nothing. A program of the same account that reads the
 * agent folder reads it, as it reads auth.json; no keyring, by the maintainer's choice. Backups written in clear before this lot
 * are no longer restored: /undo names them as not restored, and they go with their session's folder.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const CHECKPOINT_KEY_FILE = "checkpoint.key";

/** The start of an encrypted backup, which tells it from one written in clear before. */
const MAGIC = Buffer.from("PRISMCK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const keys = new Map<string, Promise<Buffer>>();

function decodeKey(text: string | undefined): Buffer | undefined {
	const key = text === undefined ? undefined : Buffer.from(text.trim(), "base64");
	return key?.length === KEY_BYTES ? key : undefined;
}

function readKeyFile(path: string): Buffer | undefined {
	try {
		return decodeKey(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Reads the key, or creates it; used at once by the seal of a session's permissions (perm-seal.ts). */
export function loadKeySync(agentDir: string): Buffer {
	const path = join(agentDir, CHECKPOINT_KEY_FILE);
	const inFile = readKeyFile(path);
	if (inFile) return inFile;
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, `${randomBytes(KEY_BYTES).toString("base64")}\n`);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		// Another Prism wrote it first: its key is the one.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const key = readKeyFile(path);
	if (!key) throw new Error(`${path} does not hold a backup key`);
	return key;
}

/** The key of the backups of this agent folder, read or created once per process. */
export function checkpointKey(agentDir: string): Promise<Buffer> {
	let key = keys.get(agentDir);
	if (!key) {
		key = (async () => loadKeySync(agentDir))();
		keys.set(agentDir, key);
		key.catch(() => keys.delete(agentDir));
	}
	return key;
}

/** The encrypted backup of `data`, bound to `name`. */
export function sealBackup(key: Buffer, name: string, data: Buffer): Buffer {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(name));
	const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
	return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), sealed]);
}

export function isSealed(blob: Buffer): boolean {
	return blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/** The file a backup holds. Throws when it cannot be read, or is in clear. */
export function openBackup(blob: Buffer, name: string, key: Buffer | undefined): Buffer {
	// fork: a backup in clear is refused. Nothing records which
	// backups were encrypted that a writer of checkpoints/ could not rewrite too, so restoring the ones in clear
	// restored any file put in place of a backup, without the key.
	if (!isSealed(blob))
		throw new Error("the backup is not encrypted: written before Prism encrypted backups, or replaced");
	if (!key) throw new Error("the backup is encrypted and its key cannot be read");
	// fork: without a fixed tag length, Node takes a shorter tag from a shorter file
	// (4 bytes: 2^32 tries to forge a backup instead of 2^128).
	if (blob.length < MAGIC.length + IV_BYTES + TAG_BYTES)
		throw new Error("the backup cannot be read: it was changed, or another key encrypted it");
	const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
	const tag = blob.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(Buffer.from(name));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
	} catch {
		throw new Error("the backup cannot be read: it was changed, or another key encrypted it");
	}
}
