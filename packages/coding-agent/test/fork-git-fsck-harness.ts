import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PackSandbox } from "../src/fork/sandbox/git-packs.ts";

/** Real Git in disposable repositories; only the bubblewrap transport is stubbed for restricted CI hosts. */
export function gitFsckTransport(root: string, maxInputSize?: number): PackSandbox {
	const bwrap = join(root, "bwrap-test.mjs");
	const seccomp = join(root, "seccomp-test");
	writeFileSync(seccomp, "");
	writeFileSync(
		bwrap,
		`#!${process.execPath}
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const mounts = [];
for (let i = 0; i < args.indexOf("--"); i++) {
  if (["--bind", "--ro-bind"].includes(args[i])) {
    const from = args[++i];
    const to = args[++i];
    if (to === "/work" || to.startsWith("/stores/")) mounts.push([from, to]);
  }
}
const command = args.slice(args.indexOf("--") + 1);
const translated = command.map(arg => {
  for (const [from, to] of mounts) arg = arg.replaceAll(to, from);
  if (${maxInputSize !== undefined}) arg = arg.replace(/--max-input-size=[0-9]+/, "--max-input-size=${maxInputSize}");
  return arg;
});
const child = spawn(translated[0], translated.slice(1), { stdio: "inherit", env: process.env });
child.on("error", () => process.exit(1));
child.on("close", status => process.exit(status ?? 1));
`,
		{ mode: 0o700 },
	);
	return { bwrap, seccomp };
}
