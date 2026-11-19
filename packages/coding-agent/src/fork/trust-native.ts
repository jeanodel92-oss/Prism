// `/trust` as a native screen in the Prism window: the options of `getProjectTrustOptions`, worded
// and marked as TrustSelectorComponent shows them. The caller keeps saving the choice in the trust store.
import type { ExtensionContext } from "../core/extensions/types.ts";
import { getProjectTrustOptions, type ProjectTrustStoreEntry } from "../core/trust-manager.ts";
import type { TrustSelection } from "../modes/interactive/components/trust-selector.ts";
import { fill, t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";

/** As TrustSelectorComponent's formatDecision. */
function decisionText(trustPath: string | undefined, decision: ProjectTrustStoreEntry | null): string {
	if (decision === null) return t("none");
	const label = decision.decision ? t("trusted") : t("untrusted");
	if (trustPath !== undefined && decision.path !== trustPath)
		return fill("{0} (inherited from {1})", label, decision.path);
	return `${label} (${decision.path})`;
}

export interface TrustScreen {
	cwd: string;
	savedDecision: ProjectTrustStoreEntry | null;
	projectTrusted: boolean;
}

export class NativeTrustView extends NativeFlow {
	private readonly trust: TrustScreen;

	constructor(changed: () => void, trust: TrustScreen) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Project trust"), busy: true });
		this.trust = trust;
	}

	/** The option chosen, or undefined when the panel is closed. */
	run(): Promise<TrustSelection | undefined> {
		return this.wait<TrustSelection>((finish) => {
			const { cwd, savedDecision, projectTrusted } = this.trust;
			const options = getProjectTrustOptions(cwd);
			const prefix = this.nextPrefix();
			const id = (index: number) => `${prefix}${index}`;
			const saved = options.findIndex(
				(option) =>
					option.savedPath !== undefined &&
					savedDecision?.decision === option.trusted &&
					savedDecision.path === option.savedPath,
			);
			this.show(
				{
					screenId: "trust",
					kind: "choice",
					title: t("Project trust"),
					lines: [
						cwd,
						fill("Saved decision: {0}", decisionText(options[0]?.savedPath, savedDecision)),
						fill("Current session: {0}", projectTrusted ? t("trusted") : t("untrusted")),
					],
					hint: "close",
					items: options.map((option, index) => ({
						id: id(index),
						label:
							option.savedPath && option.label.startsWith("Trust parent folder (")
								? fill("Trust parent folder ({0})", option.savedPath)
								: t(option.label),
					})),
					...(saved >= 0 ? { currentItemId: id(saved), initialItemId: id(saved) } : {}),
				},
				(action) => {
					if (action.kind === "back") {
						finish(undefined);
						return true;
					}
					const index = options.findIndex((_, candidate) => id(candidate) === action.itemId);
					if (action.kind !== "activate" || index < 0) return false;
					const option = options[index]!;
					finish({ trusted: option.trusted, updates: option.updates });
					return true;
				},
			);
			return () => {};
		});
	}
}

/** `/trust`'s choice, asked in the window. */
export async function chooseTrustNative(
	ctx: ExtensionContext,
	trust: TrustScreen,
): Promise<TrustSelection | undefined> {
	let result: TrustSelection | undefined;
	await showNativeFlow<NativeTrustView>(
		ctx,
		(changed) => new NativeTrustView(changed, trust),
		async (view) => {
			result = await view.run();
		},
	);
	return result;
}
