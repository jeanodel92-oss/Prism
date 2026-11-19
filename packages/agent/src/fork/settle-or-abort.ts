// fork: a tool that ignores its AbortSignal used to block the whole agent loop. Parallel
// tool calls are awaited together, so one call that never settled kept the other results of
// its batch from being recorded, and aborting (Esc) could not end the turn (a hung ask_user_question froze a batch of five calls)
// .

/** How long an aborted tool may still take to settle with its own result. */
export const ABORT_GRACE_MS = 1000;

/**
 * Settles like `run`, except that once `signal` aborts, `run` has `graceMs` to settle; after
 * that, rejects with `abandon()` and ignores whatever `run` does later.
 */
export function settleOrAbort<T>(
	run: Promise<T>,
	signal: AbortSignal | undefined,
	abandon: () => Error,
	graceMs = ABORT_GRACE_MS,
): Promise<T> {
	if (!signal) return run;
	return new Promise<T>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = () => {
			settled = true;
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			timer = setTimeout(() => {
				if (settled) return;
				finish();
				reject(abandon());
			}, graceMs);
		};
		run.then(
			(value) => {
				if (settled) return;
				finish();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				finish();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}
