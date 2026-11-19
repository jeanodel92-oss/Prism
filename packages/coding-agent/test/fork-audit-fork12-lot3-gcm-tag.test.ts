// fork.12 security audit, lot 3, AS-037: openBackup did not fix the GCM tag length, so Node checked a backup cut
// short against the shorter tag it held (4 bytes: 32 bits instead of 128). A backup shorter than header, IV and a
// full tag is now refused, and the tag length is fixed at 16 bytes.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openBackup, sealBackup } from "../src/fork/secrets/checkpoint-cipher.ts";

describe("AS-037: a backup with a truncated GCM tag is refused", () => {
	const key = randomBytes(32);
	const sealed = sealBackup(key, "name", Buffer.alloc(0)); // 8-byte header, 12-byte IV, 16-byte tag, no content

	it.each([0, 4, 8, 12, 15])("refuses a %i-byte tag", (tagBytes) => {
		expect(() => openBackup(sealed.subarray(0, 8 + 12 + tagBytes), "name", key)).toThrow("cannot be read");
	});

	it("still opens a whole backup", () => {
		expect(openBackup(sealed, "name", key)).toEqual(Buffer.alloc(0));
		const data = Buffer.from("secret = 1\n");
		expect(openBackup(sealBackup(key, "file", data), "file", key)).toEqual(data);
	});
});
