// The pointer's light on the edge of the glass (da.css): the composer and the open panels know where it is. One write
// per frame on those few elements, never on the root, which would restyle the whole page.

export function followPointer() {
	let x = 0;
	let y = 0;
	let scheduled = false;
	const place = () => {
		scheduled = false;
		for (const el of document.querySelectorAll(".composer, .surface > .panel")) {
			const box = el.getBoundingClientRect();
			el.style.setProperty("--lx", `${x - box.left}px`);
			el.style.setProperty("--ly", `${y - box.top}px`);
		}
	};
	window.addEventListener(
		"pointermove",
		(event) => {
			x = event.clientX;
			y = event.clientY;
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(place);
		},
		{ passive: true },
	);
}
