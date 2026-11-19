/** The shipped documentation as data for a graphical reader; no terminal cells or arbitrary file paths. */
import { readFileSync } from "node:fs";
import {
	docFile,
	docTopics,
	matchTopics,
	type SearchableTopic,
	searchableTopics,
	topicMatches,
} from "./docs-command.ts";
import { getLanguage, type Language } from "./i18n/index.ts";

const catalogs = new Map<Language, SearchableTopic[]>();

export function documentationData(command: Record<string, unknown>): object {
	const language = getLanguage();
	let topics = catalogs.get(language);
	if (!topics) {
		topics = searchableTopics(docTopics());
		catalogs.set(language, topics);
	}
	if (command.path !== undefined) {
		const topic = topics.find((entry) => entry.path === command.path);
		if (!topic) throw new Error("Unknown documentation page.");
		return { path: topic.path, title: topic.label, markdown: readFileSync(docFile(topic.path), "utf8") };
	}
	const query = typeof command.query === "string" ? command.query : "";
	const path = query.trim().toLowerCase();
	const exact = topics.find((topic) => topic.path.toLowerCase() === path || topic.path.toLowerCase() === `${path}.md`);
	return {
		// each result has its own match count and first line, with more context than
		// the terminal's one-line footer.
		topics: (exact ? [exact] : matchTopics(topics, query)).map((topic) => {
			const found = query ? topicMatches(topic, query, 30, 110) : undefined;
			return { label: topic.label, path: topic.path, matches: found?.count, excerpt: found?.excerpt };
		}),
	};
}
