import { describe, expect, it } from "vitest";
import { schemaToType } from "../src/declarations.ts";

describe("tuple schemas", () => {
	// `items` applies after `prefixItems`; `false` only forbids extra elements.
	it("renders a closed tuple from prefixItems with items: false", () => {
		const schema = {
			type: "array",
			prefixItems: [{ type: "number" }, { type: "number" }],
			items: false,
			minItems: 2,
		};
		expect(schemaToType(schema)).toBe("[number, number]");
	});

	it("keeps the prefix types when items types the extra elements", () => {
		expect(schemaToType({ type: "array", prefixItems: [{ type: "number" }], items: { type: "string" } })).toBe(
			"[number, ...Array<string>]",
		);
		expect(schemaToType({ type: "array", prefixItems: [{ type: "number" }], items: true })).toBe(
			"[number, ...Array<unknown>]",
		);
	});

	it("reads draft-04 tuples with additionalItems the same way", () => {
		expect(schemaToType({ type: "array", items: [{ type: "string" }], additionalItems: false })).toBe("[string]");
		expect(schemaToType({ type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } })).toBe(
			"[string, ...Array<number>]",
		);
	});

	it("leaves plain arrays unchanged", () => {
		expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("Array<string>");
		expect(schemaToType({ type: "array", items: false })).toBe("Array<never>");
		expect(schemaToType({ type: "array" })).toBe("unknown[]");
	});
});
