// fork: a saved compaction threshold too low for the model is reported at startup.
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getCompactionThresholdStartupDiagnostic } from "../../../src/fork/compaction-threshold-warning.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

describe("fork: low compaction threshold warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the low compaction threshold startup diagnostic", async () => {
		const harness = await createHarness({
			models: [{ id: "small-context", contextWindow: 32000, maxTokens: 4096 }],
			settings: { compaction: { thresholdPercent: 50 } },
		});
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const chatContainer = new Container();
			const startupDiagnostics = getCompactionThresholdStartupDiagnostic(
				harness.settingsManager,
				harness.session.model,
			);
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				expect(render(chatContainer)).toContain("starts at 16k tokens and keeps the last 20k");
			});
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			harness.cleanup();
		}
	});
});
