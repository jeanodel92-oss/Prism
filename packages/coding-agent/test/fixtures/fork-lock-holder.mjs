import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { lockForkFile } from "../../src/fork/file-lock.ts";

const [path, kind] = process.argv.slice(2);
if (kind === "writer") {
	process.send("ready");
	await once(process, "message");
	await lockForkFile(path, async () => {
		const before = Number(readFileSync(path, "utf8"));
		await pause(50);
		writeFileSync(path, String(before + 1));
	});
	process.send("written");
	process.disconnect();
} else {
	if (kind === "file") writeFileSync(path, "another process", { flag: "wx" });
	else mkdirSync(path);
	process.send("held");
	setTimeout(() => {
		rmSync(path, { recursive: true });
		process.disconnect();
	}, 2000);
}
