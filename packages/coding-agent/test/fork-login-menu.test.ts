// fork: /login, local first, without Radius.
import { describe, expect, it } from "vitest";
import { RADIUS_PROVIDER_ID } from "../src/core/radius.ts";
import { isOfferedAtLogin, loginMethodOptions } from "../src/fork/login-menu.ts";

describe("fork: /login menu", () => {
	it("lists the compatible server first", () => {
		expect(
			loginMethodOptions({
				server: "Connect a compatible server (URL)",
				subscription: "Sign in with an account",
				apiKey: "Sign in with an API key",
			}),
		).toEqual(["Connect a compatible server (URL)", "Sign in with an account", "Sign in with an API key"]);
		expect(loginMethodOptions({ apiKey: "Sign in with an API key" })).toEqual(["Sign in with an API key"]);
	});

	it("does not offer Radius", () => {
		expect(isOfferedAtLogin(RADIUS_PROVIDER_ID)).toBe(false);
		expect(isOfferedAtLogin("openai")).toBe(true);
	});
});
