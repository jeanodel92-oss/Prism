// /tutorial in the window ("/tutorial is still the same thing as in the TUI"). The nine modules and their
// exercises come from the engine as data (tutorial.ts, tutorial_get), in the language and with the keys of the engine; the
// exercises run here as in the terminal: nothing calls the model and nothing real changes. Progress is the terminal's.

import { ListBox, Panel } from "./components.js";
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";
import { matches } from "./keys.js";

const WORD_MS = 120;

export async function tutorialScreen(view) {
	const { state } = await view.engine.request({ type: "tutorial_get" });
	if (!state) {
		view.app.toast(t("tutorialNone"), "warning");
		return;
	}
	const { modules, labels, interrupt } = state;
	const panel = new Panel({ title: t("tutorialTitle"), kind: "report tutorial" });
	const content = h("div", { class: "tutorial-content" });
	let progress = state.progress;
	const finished = (id) => progress.done.includes(id) || progress.skipped.includes(id);
	let module = Math.max(0, modules.findIndex((entry) => !finished(entry.id)));
	let page = 0;
	// The exercise on screen: what was asked, the answer written so far, the note, the simulated menu.
	let typed = "";
	let asked;
	let words = [];
	let shown = 0;
	let timer;
	let note;
	let presses = 0;
	let picked;
	let menu = false;
	let answerEl;

	const current = () => modules[module];
	const onExercise = () => page === current().pages.length;
	const lastPage = () => current().pages.length - (current().exercise ? 0 : 1);
	const isDone = () => progress.done.includes(current().id);
	const stopDemo = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const reset = () => {
		stopDemo();
		typed = "";
		asked = undefined;
		words = [];
		shown = 0;
		note = undefined;
		presses = 0;
		picked = undefined;
		menu = false;
	};
	const save = () => {
		view.engine.request({ type: "tutorial_progress", ...progress }).catch(() => {});
	};
	const complete = () => {
		const { id } = current();
		if (!progress.done.includes(id)) progress.done = [...progress.done, id];
		progress.skipped = progress.skipped.filter((other) => other !== id);
		save();
		drawList();
	};
	// As in the terminal (TutorialView.goTo): a module without an exercise is done once its last page is shown
	//.
	const reached = () => {
		if (!current().exercise && page === lastPage() && !isDone()) complete();
	};
	const go = (nextModule, nextPage = 0) => {
		reset();
		module = nextModule;
		page = nextPage;
		reached();
		drawList();
		draw(true);
	};

	const list = new ListBox({ items: [], onChoose: (item) => go(item.value) });
	const drawList = () => {
		list.setItems(
			modules.map((entry, index) => ({
				label: `${index + 1}. ${entry.title}`,
				meta: progress.done.includes(entry.id) ? "✓" : progress.skipped.includes(entry.id) ? "–" : "",
				value: index,
				className: index === module ? "tutorial-here" : undefined,
			})),
			module,
		);
		panel.setTitle(t("tutorialTitle"), t("tutorialProgress", progress.done.length, modules.length));
	};

	const written = () => words.slice(0, shown).join(" ") + (timer ? " ▍" : "");
	const tick = () => {
		shown++;
		if (shown >= words.length) {
			stopDemo();
			note = { text: current().exercise.notes.complete, kind: "muted" };
			draw();
			return;
		}
		if (answerEl) answerEl.textContent = written();
	};

	const submit = () => {
		const exercise = current().exercise;
		const value = typed.trim();
		// Sent, as from the composer: the line is cleared whatever the result.
		typed = "";
		if (exercise.kind === "interrupt") {
			if (!value) {
				if (!timer) note = { text: exercise.notes.typeRequest, kind: "warning" };
			} else {
				stopDemo();
				asked = value;
				words = exercise.answer.split(" ");
				shown = 0;
				note = undefined;
				timer = setInterval(tick, WORD_MS);
			}
		} else if (exercise.kind === "file") {
			const file = /@(\S+)/.exec(value)?.[1];
			if (!file) note = { text: exercise.notes.noFile, kind: "warning" };
			else {
				asked = value;
				words = exercise.answer.replace("{0}", file).split(" ");
				shown = words.length;
				note = { text: exercise.notes.done, kind: "success" };
				complete();
			}
		} else if (value !== exercise.command && !value.startsWith(`${exercise.command} `)) {
			note = { text: exercise.notes.typeExactly, kind: "warning" };
		} else if (exercise.items) {
			// Done once a line of the simulated menu is picked.
			menu = true;
			picked = undefined;
			note = { text: exercise.notes.open, kind: "muted" };
		} else {
			note = { text: exercise.notes.done, kind: "success" };
			complete();
		}
		draw(true);
	};

	const press = (exercise) => {
		presses++;
		const on = presses % 2 === 1;
		if (exercise.mock === "plan" && on) note = { text: exercise.notes.planOn, kind: "muted" };
		else if (exercise.mock === "tool" && !on) note = { text: exercise.notes.hidden, kind: "muted" };
		else {
			note = { text: exercise.notes[exercise.mock === "plan" ? "planOff" : exercise.mock === "tool" ? "toolDone" : "filesDone"], kind: "success" };
			complete();
		}
		draw();
	};

	const practiceLine = (exercise) =>
		h(
			"div",
			{ class: "tutorial-practice" },
			h("span", { class: "tutorial-prompt", "aria-hidden": "true", text: "›" }),
			h("input", {
				class: "field",
				type: "text",
				value: typed,
				spellcheck: "false",
				autocomplete: "off",
				placeholder: exercise.command ?? "",
				"aria-label": exercise.text,
				dataset: { place: "practice" },
				oninput: (event) => {
					typed = event.target.value;
				},
				onkeydown: (event) => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					submit();
				},
			}),
		);

	const simulatedMenu = (exercise) => {
		const menuList = new ListBox({
			items: exercise.items.map((item, index) => ({
				label: item.text,
				indent: item.indent,
				current: picked === index,
				className: item.answer ? "tutorial-answer-line" : undefined,
				value: index,
			})),
			selected: picked ?? 0,
			onChoose: (item) => {
				picked = item.value;
				note = { text: exercise.notes.picked.replace("{0}", exercise.items[item.value].text), kind: "success" };
				complete();
				draw(true);
			},
		});
		menuList.list.dataset.place = "menu";
		return menuList.el;
	};

	const keyMock = (exercise) => {
		const on = presses % 2 === 1;
		if (exercise.mock === "tool")
			return h(
				"div",
				{ class: "tutorial-mock" },
				h("div", { text: `● ${exercise.tool.label}` }),
				on && h("pre", { class: "tutorial-output", text: exercise.tool.output.join("\n") }),
			);
		if (exercise.mock === "plan")
			return h("div", { class: "tutorial-mock", dataset: { on: String(on) } }, h("span", { text: `${on ? "●" : "○"} ${labels.planMode}` }), h("span", { class: "muted", text: on ? labels.on : labels.off }));
		return presses > 0 ? h("p", { class: "panel-text muted", text: exercise.notes.filesOpen }) : undefined;
	};

	const exerciseBlock = (exercise) => {
		answerEl = undefined;
		const parts = [h("p", { class: "tutorial-task", text: exercise.text })];
		if (exercise.demo) parts.push(h("p", { class: "panel-text muted", text: exercise.demo }));
		if (exercise.kind === "key") {
			parts.push(h("p", { class: "panel-text" }, h("kbd", { text: exercise.key.label })), keyMock(exercise));
		} else {
			parts.push(practiceLine(exercise));
			if (menu && exercise.items) parts.push(simulatedMenu(exercise));
		}
		if (asked !== undefined) {
			answerEl = h("p", { class: "tutorial-answer", text: written() });
			parts.push(h("p", { class: "panel-text muted", text: `› ${asked}` }), answerEl);
		}
		if (timer) parts.push(h("button", { type: "button", dataset: { place: "stop" }, text: `${t("tutorialStop")} (${interrupt.label})`, onclick: stop }));
		if (note) parts.push(h("p", { class: `panel-text tutorial-note ${note.kind}`, role: "status", text: note.text }));
		return h("div", { class: "tutorial-exercise" }, parts.filter(Boolean));
	};

	const stop = () => {
		stopDemo();
		note = { text: current().exercise.notes.stopped, kind: "success" };
		complete();
		draw(true);
	};

	const button = (place, text, onclick, attrs = {}) => h("button", { type: "button", dataset: { place }, text, onclick, ...attrs });
	const buttons = () => {
		const last = page === lastPage();
		const more = page < lastPage() || module < modules.length - 1;
		const skipped = progress.skipped.includes(current().id);
		return [
			button("back", `‹ ${labels.back}`, () => go(module, page - 1), { disabled: page === 0, class: "ghost" }),
			!isDone() && !skipped
				? button("skip", labels.skip, () => {
						progress.skipped = [...progress.skipped, current().id];
						save();
						if (module < modules.length - 1) go(module + 1);
						else {
							drawList();
							draw();
						}
					}, { class: "ghost" })
				: button("restart", labels.restart, () => {
						const { id } = current();
						progress.done = progress.done.filter((other) => other !== id);
						progress.skipped = progress.skipped.filter((other) => other !== id);
						save();
						go(module);
					}, { class: "ghost" }),
			button("docs", `${labels.docs} ›`, () => panel.done(`/docs ${current().doc}`), { class: "ghost" }),
			onExercise() && isDone() && current().tryIt && button("try", `${labels.try} ›`, () => panel.done(current().tryIt)),
			more && button("next", `${last ? labels.nextModule : labels.next} ›`, () => (last ? go(module + 1) : go(module, page + 1)), { class: "primary" }),
		];
	};

	/** `moved`: the page changed, the place to type in takes the focus; otherwise the focus stays where it was. */
	const draw = (moved = false) => {
		const place = document.activeElement?.dataset?.place;
		const entry = current();
		clear(content);
		content.append(h("h3", { class: "tutorial-title", text: entry.title }));
		if (onExercise()) content.append(exerciseBlock(entry.exercise));
		else content.append(...entry.pages[page].map((text) => h("p", { class: "panel-text", text })));
		content.scrollTop = 0;
		panel.setActions(buttons());
		const target =
			(moved && (panel.el.querySelector('[data-place="menu"]') ?? panel.el.querySelector('[data-place="practice"]'))) ||
			(place && panel.el.querySelector(`[data-place="${place}"]`));
		if (target) target.focus({ preventScroll: true });
		else if (panel.el.isConnected && (moved || !panel.el.contains(document.activeElement))) panel.el.focus({ preventScroll: true });
	};

	// Before the panel's Esc: the demo answer's interrupt key stops it, and an exercise's key is the exercise.
	panel.el.addEventListener(
		"keydown",
		(event) => {
			const exercise = onExercise() ? current().exercise : undefined;
			let act;
			if (timer && interrupt.ids.some((id) => matches(event, id))) act = stop;
			else if (exercise?.kind === "key" && exercise.key.ids.some((id) => matches(event, id))) act = () => press(exercise);
			if (!act) return;
			event.preventDefault();
			event.stopPropagation();
			act();
		},
		true,
	);

	panel.setBody(h("div", { class: "tutorial-layout" }, list.el, content));
	reached();
	drawList();
	draw();
	const line = await view.showPanel("tutorial", panel);
	stopDemo();
	// The next command waits for this one to end; awaiting it here creates a three-second cycle.
	if (line) view.prompt(line).catch((error) => view.toast(String(error?.message ?? error), "error"));
}
