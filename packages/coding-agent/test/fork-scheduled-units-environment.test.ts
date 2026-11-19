// fork: systemd expands no variable in `Environment=`, so the agent dir's `$`
// must not be doubled there as it is in ExecStart (checked with a transient user unit, systemd 259: `$$` stays `$$`).
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type ScheduledTask, scheduledUnits } from "../src/fork/scheduled-tasks.ts";

const task: ScheduledTask = {
	version: 1,
	id: "nightly",
	prompt: "Run the tests",
	cwd: "/home/u/project",
	onCalendar: "*-*-* 03:00",
	operations: [{ what: "Change the project's files", commands: [], writes: ["**"], hosts: [] }],
	budget: { minutes: 20, tools: 50 },
	catchUp: "report",
	createdAt: "2026-10-28T00:00:00.000Z",
};

describe("scheduled task unit environment", () => {
	it("passes an agent dir holding $ as it is", () => {
		const { service } = scheduledUnits(
			task,
			{ command: "/usr/bin/node", args: ["/opt/$prism/cli.js"] },
			'/home/u/prism$work "50%"\\x',
		);
		expect(service).toContain(`Environment="${ENV_AGENT_DIR}=/home/u/prism$work \\"50%%\\"\\\\x"`);
		// ExecStart, where systemd expands variables, keeps its own escape.
		expect(service).toContain('ExecStart="/usr/bin/node" "/opt/$$prism/cli.js"');
	});
});
