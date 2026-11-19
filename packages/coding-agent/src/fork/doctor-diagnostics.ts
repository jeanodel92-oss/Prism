/** fork: extension load errors captured by main where the resource loader owns them. */
export interface ExtensionLoadDiagnostic {
	path: string;
	error: string;
}

let extensionLoadDiagnostics: ExtensionLoadDiagnostic[] = [];
let lastModelFailure: { message: string; at: string } | undefined;

export function setExtensionLoadDiagnostics(diagnostics: ExtensionLoadDiagnostic[]): void {
	extensionLoadDiagnostics = diagnostics.map(({ path, error }) => ({ path, error }));
}

export function getExtensionLoadDiagnostics(): readonly ExtensionLoadDiagnostic[] {
	return extensionLoadDiagnostics;
}

export function recordModelFailure(message: string): void {
	lastModelFailure = { message, at: new Date().toISOString() };
}

export function getLastModelFailure(): { message: string; at: string } | undefined {
	return lastModelFailure;
}

/** Tests only. */
export function clearLastModelFailure(): void {
	lastModelFailure = undefined;
}
