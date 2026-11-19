// fork: the browser's host question. It is asked in broad mode too,
// offers every site for the session, and says in red what a page reaches without another question. "Every site" is
// the browser's alone: not another network tool's, not a port of this machine, not a blocked host; /perm takes it back.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { EventBus } from "../src/core/event-bus.ts";
import type { ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import permissionsExtension, {
	exportSessionGrants,
	importSessionGrants,
	permissionsPanel,
} from "../src/fork/permissions.ts";
import { toolNetworkGate } from "../src/fork/sandbox/tool-network.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const EVERY_SITE = "Allow every site in this session (browser only)";
const EVERY_SITE_REQUEST = "Allow every site for this request (browser only)";
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

describe("fork: the browser's host question", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prism-browser-hosts-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ mode: "broad" }));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ sandbox: { modes: { broad: false }, network: { deny: ["blocked.example"] } } }),
		);
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function engine(answer: (options: string[]) => string | undefined) {
		let events: EventBus | undefined;
		const harness = await createHarness({
			extensionFactories: [
				{ name: "permissions", factory: permissionsExtension },
				{
					name: "probe",
					factory: (pi) => {
						events = pi.events;
					},
				},
			],
		});
		harnesses.push(harness);
		const asked: Array<{ title: string; options: string[]; opts?: ExtensionUIDialogOptions }> = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options, opts) => {
					asked.push({ title, options, opts });
					return answer(options);
				},
			}),
		});
		let calls = 0;
		/** One tool call's check of one URL: undefined when the call may reach it, the refusal otherwise. */
		const reach = async (url: string, browser = true) => {
			const gate = toolNetworkGate(
				events!,
				`call-${++calls}`,
				`${browser ? "browser open" : "web_fetch"} ${url}`,
				browser,
			);
			try {
				return await gate!.destination(new URL(url), PUBLIC);
			} finally {
				gate!.close();
			}
		};
		return { harness, asked, reach };
	}

	it("asks in broad mode, warns in red, and one answer opens every site to the browser for the session", async () => {
		const { harness, asked, reach } = await engine((options) => options.find((option) => option === EVERY_SITE));
		expect(await reach("https://one.example/")).toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0]!.options.slice(0, 4)).toEqual([
			"Allow one.example for this request",
			"Allow one.example in this session",
			EVERY_SITE_REQUEST,
			EVERY_SITE,
		]);
		expect(asked[0]!.options.at(-1)).toBe("Block for this command");
		expect(asked[0]!.opts?.warning).toContain("links and the scripts the agent runs in it reach other sites");
		expect(asked[0]!.title).toContain("your own browser");
		// The next sites pass without a question.
		expect(await reach("https://two.example/path")).toBeUndefined();
		expect(asked).toHaveLength(1);
		// The window keeps the answer while the engine sleeps.
		expect(exportSessionGrants(harness.session.sessionManager)?.browserEverySite).toBe(true);
	});

	// "this time" asked again at each action of a web search on the same site, and
	// refusing every site for the session meant a question per action. A site, or every site, for the request.
	it("keeps a site, or every site, for the request, and asks again once the agent has answered", async () => {
		let pick = "Allow one.example for this request";
		const { harness, asked, reach } = await engine((options) => options.find((option) => option === pick));
		expect(await reach("https://one.example/")).toBeUndefined();
		expect(await reach("https://one.example/results")).toBeUndefined();
		expect(asked).toHaveLength(1);
		// Another site still asks.
		pick = EVERY_SITE_REQUEST;
		expect(await reach("https://two.example/")).toBeUndefined();
		expect(await reach("https://three.example/")).toBeUndefined();
		expect(asked).toHaveLength(2);
		// The agent answers: the request is over, its grants with it.
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("thanks");
		pick = "Allow three.example for this request";
		expect(await reach("https://three.example/")).toBeUndefined();
		expect(asked).toHaveLength(3);
		expect(asked[2]!.title).toContain("three.example");
		// Not kept for the session: the window does not carry it over.
		expect(exportSessionGrants(harness.session.sessionManager)?.browserEverySite).toBeUndefined();
	});

	it("keeps every site to the browser: another tool, a port of this machine and a blocked host are not covered", async () => {
		const { asked, reach } = await engine((options) => options.find((option) => option === EVERY_SITE));
		expect(await reach("https://one.example/")).toBeUndefined();
		// Another network tool asks its own question, without the browser's choice or warning.
		expect(await reach("https://three.example/", false)).toContain("Nothing was sent");
		expect(asked).toHaveLength(2);
		expect(asked[1]!.options).not.toContain(EVERY_SITE);
		expect(asked[1]!.opts?.warning).toBeUndefined();
		// A port of this machine keeps its own question, which never offers every site.
		expect(await reach("http://localhost:4321/")).toContain("port 4321 of this machine");
		expect(asked).toHaveLength(3);
		expect(asked[2]!.options).not.toContain(EVERY_SITE);
		// A blocked host stays blocked, without a question.
		expect(await reach("https://blocked.example/")).toContain("Nothing was sent");
		expect(asked).toHaveLength(3);
	});

	it("is listed in /perm and taken back there; an engine that was not given it asks again", async () => {
		const first = await engine((options) => options.find((option) => option === EVERY_SITE));
		expect(await first.reach("https://one.example/")).toBeUndefined();
		const context = () => first.harness.session.extensionRunner.createContext();
		const grant = permissionsPanel(context())!
			.snapshot()
			.grants.find((entry) => entry.what === "Open any site in the browser");
		expect(grant).toMatchObject({ effect: "allow", scope: "this session" });
		const kept = exportSessionGrants(first.harness.session.sessionManager);
		expect(permissionsPanel(context())!.revoke(grant!.index, grant!.what)).toBe(true);
		expect(await first.reach("https://two.example/")).toBeUndefined();
		expect(first.asked).toHaveLength(2);

		const fresh = await engine(() => undefined);
		expect(await fresh.reach("https://two.example/")).toContain("Nothing was sent");
		expect(fresh.asked).toHaveLength(1);
		expect(importSessionGrants(fresh.harness.session.sessionManager, kept)).toBe(true);
		expect(await fresh.reach("https://four.example/")).toBeUndefined();
		expect(fresh.asked).toHaveLength(1);
	});
});

describe("fork: a question's warning in the terminal", () => {
	it("shows the risk in red under the title, and nothing without one", () => {
		initTheme("dark");
		const render = (warning?: string) =>
			new ExtensionSelectorComponent("Let the agent in?", ["Yes", "No"], vi.fn(), vi.fn(), { warning })
				.render(64)
				.join("\n");
		const warned = render("It can run commands.");
		expect(warned).toContain(theme.fg("error", theme.bold("It can run commands.")));
		const lines = stripAnsi(warned).split("\n");
		expect(lines.findIndex((line) => line.includes("It can run commands."))).toBeGreaterThan(
			lines.findIndex((line) => line.includes("Let the agent in?")),
		);
		expect(stripAnsi(render())).not.toContain("It can run commands.");
	});
});
