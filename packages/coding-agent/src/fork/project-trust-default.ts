/**
 * fork: whether a folder is trusted when the user gave no answer this launch.
 * A folder without project resources is trusted by default, unless the user refused it (or a parent): the refusal
 * still applies to resources a checkout brings back, which `/reload` would otherwise load without asking.
 */
export function trustedWithoutPrompt(decision: boolean | null, hasResources: boolean): boolean {
	return decision === true || (!hasResources && decision !== false);
}
