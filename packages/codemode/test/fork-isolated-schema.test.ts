/**
 * fork: a schema that cannot be rendered fails only its own
 * tool's type, which becomes `unknown`. Before, the error escaped `renderDeclarations` and `renderToolSample`, so one
 * tool's schema took down the declarations, and the codemode description, of every tool.
 */
import { describe, expect, it } from "vitest";
import { type CodemodeJsonSchema, renderDeclarations, renderToolSample } from "../src/index.ts";

const cycle: Record<string, unknown> = {};
cycle.self = cycle;

/** Schemas `JSON.stringify` rejects: a BigInt enum value, a cyclic `const`, a throwing getter. */
const broken: CodemodeJsonSchema[] = [
	{ type: "object", properties: { mode: { enum: [1n] } } } as unknown as CodemodeJsonSchema,
	{ type: "object", properties: { value: { const: cycle } } },
	{
		type: "object",
		get properties(): never {
			throw new Error("getter");
		},
	} as CodemodeJsonSchema,
];

describe("fork: one tool's unrenderable schema", () => {
	it("renders the other tools and the broken one as unknown", () => {
		for (const schema of broken) {
			const declarations = renderDeclarations({
				tools: [
					{
						name: "good",
						description: "Good.",
						inputSchema: { type: "object", properties: { a: { type: "string" } } },
						execute: () => undefined,
					},
					{
						name: "bad",
						description: "Bad.",
						inputSchema: schema,
						outputSchema: schema,
						execute: () => undefined,
					},
				],
				globals: [{ name: "helper", inputSchema: schema, outputSchema: schema, execute: () => undefined }],
			});
			expect(declarations).toContain("good(args: { a?: string; }): Promise<unknown>;");
			expect(declarations).toContain("bad(args: unknown): Promise<unknown>;");
			expect(declarations).toContain("declare function helper(args: unknown): Promise<unknown>;");
		}
	});

	it("renders the broken tool's sample with its description", () => {
		const sample = renderToolSample({ name: "bad", description: "Bad.", inputSchema: broken[0] });
		expect(sample).toContain("Bad.");
		expect(sample).toContain("bad(args: unknown)");
	});
});
