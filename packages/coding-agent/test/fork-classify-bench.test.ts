// fork: the common corpus of the classification bench keeps its verdicts, so a change
// to the shell classifier that adds friction to ordinary commands, or removes a question, is seen.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, type Fixture, makeFixture, readCommonCorpus } from "../../../fork/tools/classify-bench/classify.ts";

const corpus = readCommonCorpus(join(__dirname, "../../../fork/tools/classify-bench/common.tsv"));

describe("fork: classification bench, common corpus", () => {
	let fixture: Fixture;
	beforeAll(() => {
		fixture = makeFixture();
	});
	afterAll(() => fixture.cleanup());

	it("holds a few hundred commands", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(200);
	});

	it.each(corpus.map((entry) => [entry.command, entry.today ?? entry.expected!] as const))(
		"%s is %s in ask mode",
		(command, tier) => {
			expect(classify(command, fixture.project, "ask").tier).toBe(tier);
		},
	);
});
