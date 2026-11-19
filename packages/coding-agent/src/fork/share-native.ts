// `/share`'s progress as a native panel of the Prism window. The upload stays the terminal's
// (session-share.ts); the panel stands for its loader: its stop button and closing the panel cancel the upload,
// as the terminal's cancel key does.
import type { ExtensionContext } from "../core/extensions/types.ts";
import type { ShareLoader } from "../modes/interactive/session-share.ts";
import { t } from "./i18n/index.ts";
import { NativeFlow, showNativeFlow } from "./native-flow.ts";

type CancellableLoader = ShareLoader & { cancel(): void };

export class NativeShareView extends NativeFlow {
	private loader: CancellableLoader | undefined;
	private cancelled: (() => void) | undefined;
	/** Resolves when the upload is cancelled: the terminal gives the editor back then, without waiting for it to end. */
	readonly whenCancelled = new Promise<void>((resolve) => {
		this.cancelled = resolve;
	});

	constructor(changed: () => void) {
		super(changed, { screenId: "loading", kind: "detail", title: t("Share"), busy: true });
	}

	/** The loader the upload shows while it runs. */
	createLoader(message: string): ShareLoader {
		const controller = new AbortController();
		const loader: CancellableLoader = {
			signal: controller.signal,
			onAbort: undefined,
			render: () => [],
			invalidate() {},
			dispose: () => {
				if (this.loader === loader) this.loader = undefined;
			},
			cancel: () => {
				if (controller.signal.aborted) return;
				controller.abort();
				loader.onAbort?.();
				this.cancelled?.();
			},
		};
		// the panel was closed while the upload prepared (authentication, HTML export):
		// its loader comes already stopped, so nothing is sent.
		if (this.closed) {
			loader.cancel();
			return loader;
		}
		this.loader = loader;
		this.show(
			{ screenId: "progress", kind: "detail", title: t("Share"), lines: [t(message)], hint: "stop" },
			(action) => {
				if (action.kind !== "back" || this.loader !== loader) return false;
				loader.cancel();
				return true;
			},
		);
		return loader;
	}

	override close(): void {
		super.close();
		this.loader?.cancel();
		// Closed before any loader: the window does not wait for the preparation to end either.
		this.cancelled?.();
	}
}

/** Runs the upload with its progress in a native panel, which closes when the upload ends. */
export function shareNative(
	ctx: ExtensionContext,
	upload: (createLoader: (message: string) => ShareLoader) => Promise<void>,
): Promise<void> {
	return showNativeFlow<NativeShareView>(
		ctx,
		(changed) => new NativeShareView(changed),
		(view) => {
			const running = upload((message) => view.createLoader(message));
			// Once cancelled, its end no longer matters: the cancelled upload only cleans up.
			running.catch(() => {});
			return Promise.race([running, view.whenCancelled]);
		},
	);
}
