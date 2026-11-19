// fork: the container that hosts the editor and, in its place, the menus (selectors and
// extension dialogs). When a render hook frames the menu, mouse rows are mapped back to the
// menu's own rows. Replaces the Prism pack's method swap on interactive mode's container.
import { Container, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { keyboardListMouse } from "./keyboard-list-mouse.ts";
import { type DialogFrame, renderHooks } from "./render-hooks.ts";

const CTRL_C = "\x03";

export class EditorSlot extends Container {
	private framed?: { child: Container["children"][number]; frame: DialogFrame };

	override render(width: number): string[] {
		const child = this.children.length === 1 ? this.children[0] : undefined;
		const frame = child ? renderHooks.dialogFrame?.(child, width) : undefined;
		if (!child || !frame) {
			this.framed = undefined;
			return super.render(width);
		}
		this.framed = { child, frame };
		this.setMouseLayout({ width: frame.innerWidth, children: [{ component: child, height: frame.innerHeight }] });
		return frame.lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const framed = this.framed;
		if (!framed || this.children[0] !== framed.child) return this.dispatch(event, event);
		const { frame } = framed;
		const close = frame.close;
		if (close && event.button === "left" && event.y === close.row && event.x >= close.from && event.x < close.to) {
			if (event.type === "click") framed.child.handleInput?.(CTRL_C);
			return { handled: true, target: this.target(event) };
		}
		const y = frame.rows[event.y];
		if (y === undefined || y < 0) return undefined;
		return this.dispatch(event, {
			...event,
			x: event.x - frame.offsetX,
			y,
			width: frame.innerWidth,
			height: frame.innerHeight,
		});
	}

	/**
	 * fork: a menu without mouse support of its own gets keys from the mouse
	 * (keyboard-list-mouse.ts). This slot stays the target, so the click after a press comes back here.
	 */
	private dispatch(event: TuiMouseEvent, inner: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const menu = this.children.length === 1 ? this.children[0] : undefined;
		if (!menu || menu.handleMouse) return super.handleMouse(inner);
		const result = keyboardListMouse(menu, inner);
		if (!result) return undefined;
		return { ...result, handled: true, target: this.target(event) };
	}

	/** This slot as the mouse target, so the click after a press comes back here. */
	private target(event: TuiMouseEvent) {
		return {
			component: this,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		};
	}
}
