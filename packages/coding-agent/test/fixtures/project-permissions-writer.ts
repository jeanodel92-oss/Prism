// fork: another Prism process changing project-permissions.json, for fork-project-permissions and
// fork-sandbox. Usage: <agentDir> <cwd> add-rules <prefix> <count> <start at, epoch ms> | remove-host <host> <rule>
import { addProjectRule, removeProjectHost } from "../../src/fork/project-permissions.ts";

const [agentDir, cwd, action, ...args] = process.argv.slice(2);
if (!agentDir || !cwd) throw new Error("Expected an agent dir and a project folder");
if (action === "add-rules") {
	// All writers start together, so their writes overlap.
	const wait = Number(args[2]) - Date.now();
	if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
	for (let n = 0; n < Number(args[1]); n++) {
		// A writer kept out past the lock's 2 s budget is refused (ELOCKED), visibly: the user tries again. On a disk
		// with slow fsync, four writers at once can starve one; the
		// test is about losing no change, so a refused write is retried, a few times at most.
		for (let attempt = 1; ; attempt++) {
			try {
				await addProjectRule(cwd, `bash(${args[0]}-${n}*)`, "allow", agentDir);
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "ELOCKED" || attempt === 5) throw error;
			}
		}
	}
} else if (action === "remove-host") {
	await removeProjectHost(cwd, { host: args[0]!, rule: args[1]! }, agentDir);
} else {
	throw new Error(`Unknown action: ${action}`);
}
