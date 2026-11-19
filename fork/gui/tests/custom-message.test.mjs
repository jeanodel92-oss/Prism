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
