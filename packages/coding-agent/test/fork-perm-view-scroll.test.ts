/**
 * fork: with a few dozen permissions in effect, /perm returned every
 * permission line, so on a 24-row terminal the last ones and the buttons below them were cut off with no way to
 * scroll to them.
 */
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { type GrantView, PermView } from "../src/fork/perm-view.ts";
import { type Mode, modePolicy, POLICY_ROWS } from "../src/fork/permissions.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;:]*m/g, ""));
const DOWN = "\x1b[B";
const UP = "\x1b[A";

function setup(count: number, height: number) {
	const grants: GrantView[] = Array.from({ length: count }, (_, i) => ({
		effect: "allow",
		what: `cmd${i}!`,
		scope: "this session",
		left: "",
	}));
	const revoked: string[] = [];
	const mode: Mode = "ask";
	const view = new PermView({
		mode: () => mode,
		defaultMode: () => "ask",
		verdict: modePolicy,
		rows: POLICY_ROWS,
		grants: () => grants,
		savedRules: () => 0,
		height: () => height,
		onMode: () => {},
		onRevoke: (_index, shown) => {
			if (shown) revoked.push(shown.what);
		},
		onAction: () => {},
		onClose: () => {},
	});
	return { view, grants, revoked };
}

const click = (x: number, y: number): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width: 100,
	height: 24,
	shift: false,
	alt: false,
	ctrl: false,
});

describe("fork: /perm with many permissions on a short terminal", () => {
	beforeEach(() => initTheme("dark"));

	it("keeps the window within the terminal, the buttons in view and the selected permission shown", () => {
		for (const width of [100, 40]) {
			const { view } = setup(30, 24);
			let lines = plain(view.render(width));
			expect(lines.length).toBeLessThanOrEqual(24);
			expect(lines.join("\n")).toContain("Keep this mode as default");
			expect(lines.join("\n")).toMatch(/Current permissions \(1–\d+ of 30\)/);
			for (let i = 0; i < 30; i++) view.handleInput(DOWN);
			lines = plain(view.render(width));
			expect(lines.length).toBeLessThanOrEqual(24);
			expect(lines.join("\n")).toContain("cmd29!");
			expect(lines.join("\n")).toContain("Keep this mode as default");
			// Going back up scrolls back to the first one.
			for (let i = 0; i < 29; i++) view.handleInput(UP);
			lines = plain(view.render(width));
			expect(lines.join("\n")).toContain("cmd0!");
		}
	});

	it("revokes the permission clicked on, after scrolling to the end", () => {
		const { view, revoked } = setup(30, 24);
		for (let i = 0; i < 30; i++) view.handleInput(DOWN);
		const lines = plain(view.render(100));
		const y = lines.findIndex((l) => l.includes("cmd29!"));
		const x = lines[y]!.indexOf("Revoke");
		view.handleMouse(click(x, y));
		expect(revoked).toEqual(["cmd29!"]);
	});
});
