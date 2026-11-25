import assert from "node:assert/strict";
import { test } from "node:test";
import { customText } from "../ui/js/custom-message.js";
import { setLanguage } from "../ui/js/i18n.js";

test("a plan's title is shown in the window's language; the plan and other modules' messages stay as written", () => {
	globalThis.document = { documentElement: {} };
	try {
		const plan = { customType: "proposed-plan" };
		setLanguage("fr");
		assert.equal(customText(plan, "**Proposed Plan**\n\n1. Read"), "**Plan proposé**\n\n1. Read");
		assert.equal(customText(plan, "**Saved Plan**\n\nx"), "**Plan enregistré**\n\nx");
		assert.equal(customText(plan, "**Active Implementation Plan**\n\nx"), "**Plan en cours d'implémentation**\n\nx");
		assert.equal(customText(plan, "Steps:\n**Proposed Plan**"), "Steps:\n**Proposed Plan**");
		assert.equal(customText({ customType: "other" }, "**Proposed Plan**"), "**Proposed Plan**");
		setLanguage("en");
		assert.equal(customText(plan, "**Proposed Plan**\n\nx"), "**Proposed Plan**\n\nx");
	} finally {
		delete globalThis.document;
	}
});

test("an agent's answer that agent_wait returned is shown from the message's details", () => {
	globalThis.document = { documentElement: {} };
	try {
		setLanguage("en");
		const waited = { customType: "agent-answer", details: { answer: "The answer.\n\nSecond line." } };
		const text = "**Agent general answered (ag1)**\n\nIts answer was returned by agent_wait.";
		assert.equal(customText(waited, text), "**general answered (ag1)**\n\nThe answer.\n\nSecond line.");
		// An older message without the answer in its details keeps its text.
		assert.equal(
			customText({ customType: "agent-answer" }, text),
			"**general answered (ag1)**\n\nIts answer was returned by agent_wait.",
		);
	} finally {
		delete globalThis.document;
	}
});

// the line telling the model a run was the user's is not shown to the user.
test("an agent's answer hides the line that tells the model the user started the run", () => {
	globalThis.document = { documentElement: {} };
	try {
		setLanguage("en");
		const origin = '[Started by the user, not by you: they ran general (ag4) with the task "fourth"]\n\n';
		assert.equal(
			customText({ customType: "agent-answer" }, `**Agent general answered (ag4)**\n\n${origin}Done.`),
			"**general answered (ag4)**\n\nDone.",
		);
		assert.equal(
			customText({ customType: "agent-answer" }, `**Agent general stopped (ag4)**\n\n${origin}The user stopped this agent before it answered.`),
			"**general stopped (ag4)**\n\nThe user stopped this agent before it answered.",
		);
		assert.equal(
			customText({ customType: "agent-answer", details: { answer: "A." } }, `**Agent general answered (ag4)**\n\n${origin}Its answer was returned by agent_wait.`),
			"**general answered (ag4)**\n\nA.",
		);
	} finally {
		delete globalThis.document;
	}
});
