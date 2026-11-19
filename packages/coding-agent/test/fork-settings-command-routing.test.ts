import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// fork: a command chosen in /settings ran through session.prompt(), which only knows
// extension commands, so "/scoped-models" reached the model as a user message.

type Context = {
	session: {
		extensionRunner: {
			getCommand: (name: string) => unknown;
			getExtensionPaths: () => string[];
			getAllRegisteredTools: () => unknown[];
		};
		promptTemplates: unknown[];
		model: undefined;
		sessionManager: { getCwd: () => string };
		isCompacting: boolean;
		isStreaming: boolean;
		prompt: ReturnType<typeof vi.fn>;
	};
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: {
		text: string;
		getText: () => string;
		setText: (text: string) => void;
		addToHistory: (text: string) => void;
	};
	showWarning: ReturnType<typeof vi.fn>;
	showModelsSelector: ReturnType<typeof vi.fn>;
	handleLoginCommand: ReturnType<typeof vi.fn>;
	showTrustSelector: ReturnType<typeof vi.fn>;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type KeyContext = {
	session: { extensionRunner: { getCommand: (name: string) => unknown }; prompt: ReturnType<typeof vi.fn> };
	defaultEditor: { onAction: (action: string, run: () => void) => void };
	ui: Record<string, unknown>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
};

type Prototype = {
	setupEditorSubmitHandler(this: Context): void;
	submitCommandLine(this: Context, line: string): Promise<void>;
	setupKeyHandlers(this: KeyContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function context(extensionCommands: string[] = []): Context {
	const editor: Context["editor"] = {
		text: "",
		getText: () => editor.text,
		setText: (text) => {
			editor.text = text;
		},
		addToHistory: () => {},
	};
	const ctx: Context = {
		session: {
			extensionRunner: {
				getCommand: (name) => (extensionCommands.includes(name) ? { name } : undefined),
				getExtensionPaths: () => [],
				getAllRegisteredTools: () => [],
			},
			promptTemplates: [],
			model: undefined,
			sessionManager: { getCwd: () => process.cwd() },
			isCompacting: false,
			isStreaming: false,
			prompt: vi.fn(async () => {}),
		},
		defaultEditor: {},
		editor,
		showWarning: vi.fn(),
		showModelsSelector: vi.fn(async () => {}),
		handleLoginCommand: vi.fn(async () => {}),
		showTrustSelector: vi.fn(),
		flushPendingBashComponents: () => {},
		pendingUserInputs: [],
	};
	prototype.setupEditorSubmitHandler.call(ctx);
	return ctx;
}

describe("commands run from a menu", () => {
	it("open the built-in commands of /settings without sending anything to the model", async () => {
		const ctx = context();
		await prototype.submitCommandLine.call(ctx, "/scoped-models");
		await prototype.submitCommandLine.call(ctx, "/login");
		await prototype.submitCommandLine.call(ctx, "/trust");
		expect(ctx.showModelsSelector).toHaveBeenCalledTimes(1);
		expect(ctx.handleLoginCommand).toHaveBeenCalledTimes(1);
		expect(ctx.showTrustSelector).toHaveBeenCalledTimes(1);
		expect(ctx.session.prompt).not.toHaveBeenCalled();
		expect(ctx.pendingUserInputs).toEqual([]);
	});

	it("give the draft back once a built-in command has cleared the composer", async () => {
		const ctx = context();
		ctx.editor.setText("half-written request");
		await prototype.submitCommandLine.call(ctx, "/scoped-models");
		expect(ctx.showModelsSelector).toHaveBeenCalledTimes(1);
		expect(ctx.editor.getText()).toBe("half-written request");
	});

	it("still hand an extension command to the session as a command", async () => {
		const ctx = context(["budget"]);
		const input = vi.fn();
		ctx.onInputCallback = input;
		await prototype.submitCommandLine.call(ctx, "/budget");
		expect(input).toHaveBeenCalledWith("/budget");
		expect(ctx.showModelsSelector).not.toHaveBeenCalled();
	});
});

describe("command keys", () => {
	function keys(extensionCommands: string[]) {
		const actions = new Map<string, () => void>();
		const ctx: KeyContext = {
			session: {
				extensionRunner: { getCommand: (name) => (extensionCommands.includes(name) ? { name } : undefined) },
				prompt: vi.fn(async () => {}),
			},
			defaultEditor: { onAction: (action, run) => actions.set(action, run) },
			ui: {},
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		prototype.setupKeyHandlers.call(ctx);
		return { ctx, press: (action: string) => actions.get(action)?.() };
	}

	it("do not send /bg to the model when the background module is off", () => {
		const { ctx, press } = keys([]);
		press("app.background.tasks");
		expect(ctx.session.prompt).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("/bg is not available in this session.");
	});

	it("open /bg when the background module is on", () => {
		const { ctx, press } = keys(["bg"]);
		press("app.background.tasks");
		expect(ctx.session.prompt).toHaveBeenCalledWith("/bg");
		expect(ctx.showStatus).not.toHaveBeenCalled();
	});
});
