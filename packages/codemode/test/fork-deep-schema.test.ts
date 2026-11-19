/**
 * fork: a tool whose inline input schema nests 10 000 levels renders,
 * its depths past the limit as `unknown`, instead of overflowing the stack and failing every codemode call.
 */
import { describe, expect, it } from "vitest";
import { type CodemodeJsonSchema, renderToolSample, schemaToType } from "../src/index.ts";

/** `{ a: { a: … { a: string } } }`, `levels` objects deep, plus the same through arrays. */
function deep(levels: number, through: "object" | "array"): CodemodeJsonSchema {
	let schema: CodemodeJsonSchema = { type: "string" };
	for (let level = 0; level < levels; level++) {
		schema =
			through === "object"
				? { type: "object", properties: { a: schema }, required: ["a"] }
				: { type: "array", items: schema };
	}
	return schema;
}

describe("fork: deeply nested tool schemas", () => {
	it("renders 10 000 levels of objects or arrays, past the limit as unknown", () => {
		expect(schemaToType(deep(10_000, "object"))).toContain("{ a: unknown; }");
		expect(schemaToType(deep(10_000, "array"))).toMatch(/^(Array<)+unknown(>)+$/);
		expect(schemaToType(deep(3, "object"))).toBe("{ a: { a: { a: string; }; }; }");
	});

	it("renders the sample of a tool with such a schema", () => {
		const sample = renderToolSample({ name: "deep", description: "Deep.", inputSchema: deep(10_000, "object") });
		expect(sample).toContain("deep(");
	});
});
