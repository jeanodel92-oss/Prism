/**
 * fork: a task scope of twenty operations was drawn whole, so on a
 * 24-row terminal its last operations and its Approve and Cancel lines were cut off.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseProposal, type ScopeApproval, ScopeView } from "../src/fork/task-scope.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m|\x1b_[^\x07]*\x07/g, "");
const DOWN = "\x1b[B";
const ENTER = "\r";

function setup(height: number | undefined) {
	const operations = Array.from({ length: 20 }, (_, i) => ({
		what: `Step ${i + 1}`,
		commands: [`npm run step${i + 1}`],
	}));
	const proposal = parseProposal({ operations, minutes: 60 });
	if (proposal instanceof Error) throw proposal;
	const result: { approval?: ScopeApproval } = {};
	const view = new ScopeView(
		proposal,
		(approval) => {
			result.approval = approval;
		},
		false,
		undefined,
		() => height,
	);
	return { view, result };
}

describe("fork: a long task scope on a short terminal", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps its title and its actions in view, and scrolls the operations to the selected one", () => {
		for (const width of [100, 40]) {
			const { view } = setup(24);
			let lines = view.render(width).map(strip);
			expect(lines.length).toBeLessThanOrEqual(24);
			const text = () => lines.join("\n");
			expect(text()).toContain("Task scope proposed by the agent");
			expect(text()).toContain("Approve");
			expect(text()).toContain("Cancel");
			expect(text()).toMatch(/1–\d+ of 20/);
			for (let i = 0; i < 19; i++) view.handleInput(DOWN);
			lines = view.render(width).map(strip);
			expect(lines.length).toBeLessThanOrEqual(24);
			expect(text()).toContain("Step 20");
			expect(text()).toContain("Approve");
		}
	});

	it("approves without an operation that was out of view when the scope opened", () => {
		const { view, result } = setup(24);
		expect(view.render(100).map(strip).join("\n")).not.toContain("Step 20");
		for (let i = 0; i < 19; i++) view.handleInput(DOWN);
		view.handleInput(ENTER);
		expect(view.render(100).map(strip).join("\n")).toContain("[ ] Step 20");
		for (const key of [DOWN, DOWN, DOWN, ENTER]) view.handleInput(key);
		expect(result.approval?.operations.map((operation) => operation.what)).toEqual(
			Array.from({ length: 19 }, (_, i) => `Step ${i + 1}`),
		);
	});

	it("draws every operation when the height is not known", () => {
		const lines = setup(undefined).view.render(100).map(strip);
		expect(lines.join("\n")).toContain("Step 20");
	});
});
