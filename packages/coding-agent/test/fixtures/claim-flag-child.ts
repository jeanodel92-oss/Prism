// Child of the first-start race test in fork-browser.test.ts: waits for a shared start time, then runs the
// offer-once check the way the browser module did before the fix ("read") or after it ("claim"); prints 1 when it
// would have opened the setup.
import { claimGlobalFlag, readGlobalSetting, saveGlobalSetting } from "../../src/fork/global-settings.ts";

const [mode, agentDir, startAt] = process.argv.slice(2) as [string, string, string];
while (Date.now() < Number(startAt)) {
	// Busy wait: all the children start their check within the same millisecond.
}
let opens = false;
if (mode === "claim") {
	// A child that outwaits the lock's retries wrote nothing: it does not open.
	try {
		opens = claimGlobalFlag("browserSetupOffered", agentDir);
	} catch (error) {
		if ((error as { code?: string }).code !== "ELOCKED") throw error;
	}
} else if (readGlobalSetting("browserSetupOffered", agentDir) !== true) {
	// The decision is made by the read. Eight children saving at once can outwait the settings lock's retries on a
	// loaded machine, which says nothing about what they read.
	opens = true;
	try {
		saveGlobalSetting(["browserSetupOffered"], true, agentDir);
	} catch {}
}
process.stdout.write(opens ? "1" : "0");
