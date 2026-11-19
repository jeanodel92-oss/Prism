/**
 * fork: the file that keeps the full output of a command the user runs (`!cmd`,
 * RPC `bash`), whose path the model is given. The bash tool's output is masked as it streams (`withoutSecrets`,
 * secrets/env.ts); the user's commands' was not, so past 50 KiB the file kept a key in clear, and the model's grep could
 * guess it one character at a time. Here the known secrets are replaced by their label as the output comes, as the
 * bash tool does. The file stays 0600 (capped-log.ts).
 */

import { CappedLog } from "./capped-log.ts";
import { knownSecrets } from "./secrets/env.ts";
import { maskingStream, type Secrets } from "./secrets/mask.ts";

class MaskedLog extends CappedLog {
	private readonly masker: ReturnType<typeof maskingStream>;

	constructor(path: string, secrets: Secrets) {
		super(path);
		this.masker = maskingStream(secrets, (data) => super.write(data));
	}

	override write(data: Buffer | string): void {
		this.masker.write(typeof data === "string" ? Buffer.from(data) : data);
	}

	override end(): Promise<void> {
		this.masker.end();
		return super.end();
	}
}

/** A command's full-output file, with the known secrets masked. */
export function fullOutputLog(path: string): CappedLog {
	const secrets = knownSecrets();
	return secrets.size > 0 ? new MaskedLog(path, secrets) : new CappedLog(path);
}
