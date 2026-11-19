/**
 * fork: client_secret_basic joined the raw client id and secret with ":".
 * A client id "team:desktop" reached a server that splits at the first ":" as id "team". RFC 6749 section 2.3.1
 * form-encodes both parts first; a synthetic server decoding the header now gets the registered values back.
 */
import { describe, expect, it } from "vitest";
import { exchangeAuthorizationCode, refreshAuthorization } from "../src/oauth/index.ts";

/** Decodes a Basic header the way RFC 6749 servers do: split at the first ":", then form-decode each part. */
function decodeBasic(header: string | null): { id: string; secret: string } {
	const pair = Buffer.from((header ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
	const colon = pair.indexOf(":");
	const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, " "));
	return { id: decode(pair.slice(0, colon)), secret: decode(pair.slice(colon + 1)) };
}

describe("fork: OAuth client_secret_basic encoding", () => {
	const client = { client_id: "team:desktop é+&%", client_secret: "s3:cr et/=+?%" };

	it("sends the client id and secret so the server reads them back unchanged", async () => {
		const received: { id: string; secret: string }[] = [];
		const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
			received.push(decodeBasic(new Headers(init?.headers).get("authorization")));
			return new Response(JSON.stringify({ access_token: "a", token_type: "Bearer" }));
		};
		const metadata = {
			issuer: "https://auth.example",
			authorization_endpoint: "https://auth.example/authorize",
			token_endpoint: "https://auth.example/token",
			response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: ["client_secret_basic"],
		};
		await exchangeAuthorizationCode("https://auth.example", {
			metadata,
			clientInformation: client,
			code: "c",
			codeVerifier: "v",
			redirectUrl: "http://127.0.0.1/callback",
			fetch,
		});
		await refreshAuthorization("https://auth.example", {
			metadata,
			clientInformation: client,
			refreshToken: "r",
			fetch,
		});
		expect(received).toEqual([
			{ id: client.client_id, secret: client.client_secret },
			{ id: client.client_id, secret: client.client_secret },
		]);
	});
});
