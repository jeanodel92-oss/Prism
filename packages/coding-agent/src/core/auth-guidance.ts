const UNKNOWN_PROVIDER = "unknown";

// fork: no deep paths to Markdown files in the installed package; /docs opens them.
export function getProviderLoginHelp(): string {
	return "Use /login to connect a model service or server with an account, an API key (an access key), or a server address. /docs providers explains how.";
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No access key is available for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
