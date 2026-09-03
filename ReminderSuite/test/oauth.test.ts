import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTH_ENDPOINT,
	GOOGLE_SCOPES,
	buildAuthUrl,
	challengeFromVerifier,
	generateState,
	generateVerifier,
} from "../src/auth/pkce.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

test("generateVerifier returns an RFC 7636 length and charset", () => {
	const verifier = generateVerifier();
	assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
	assert.ok(
		verifier.length >= 43 && verifier.length <= 128,
		`verifier length ${verifier.length} outside 43..128`,
	);
});

test("generateVerifier returns a different value each call", () => {
	const values = new Set(Array.from({ length: 50 }, () => generateVerifier()));
	assert.strictEqual(values.size, 50);
});

test("challengeFromVerifier matches the RFC 7636 appendix B vector", async () => {
	const challenge = await challengeFromVerifier(
		"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
	);
	assert.strictEqual(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("challengeFromVerifier emits unpadded base64url", async () => {
	const challenge = await challengeFromVerifier(generateVerifier());
	assert.match(challenge, BASE64URL);
	assert.strictEqual(challenge.length, 43);
});

test("generateState returns unique base64url values", () => {
	const values = new Set(Array.from({ length: 50 }, () => generateState()));
	assert.strictEqual(values.size, 50);
	for (const value of values) {
		assert.match(value, BASE64URL);
		assert.ok(value.length >= 16, `state ${value.length} chars is too short`);
	}
});

test("buildAuthUrl targets the Google authorization endpoint", () => {
	const url = new URL(
		buildAuthUrl("client-id", "http://127.0.0.1:1234", "challenge", "state"),
	);
	assert.strictEqual(`${url.origin}${url.pathname}`, AUTH_ENDPOINT);
});

test("buildAuthUrl requests exactly the two calendar scopes", () => {
	const params = new URL(
		buildAuthUrl("client-id", "http://127.0.0.1:1234", "challenge", "state"),
	).searchParams;

	assert.strictEqual(
		params.get("scope"),
		"https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	);
	assert.deepStrictEqual(GOOGLE_SCOPES.slice(), [
		"https://www.googleapis.com/auth/calendar.events",
		"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	]);
});

test("buildAuthUrl never requests the broad calendar scope", () => {
	const scope =
		new URL(
			buildAuthUrl("client-id", "http://127.0.0.1:1234", "challenge", "state"),
		).searchParams.get("scope") ?? "";

	for (const granted of scope.split(" ")) {
		assert.notStrictEqual(granted, "https://www.googleapis.com/auth/calendar");
	}
});

test("buildAuthUrl sets the installed-app PKCE parameters", () => {
	const params = new URL(
		buildAuthUrl("client-id", "http://127.0.0.1:1234", "challenge", "state"),
	).searchParams;

	assert.strictEqual(params.get("client_id"), "client-id");
	assert.strictEqual(params.get("redirect_uri"), "http://127.0.0.1:1234");
	assert.strictEqual(params.get("response_type"), "code");
	assert.strictEqual(params.get("access_type"), "offline");
	assert.strictEqual(params.get("prompt"), "consent");
	assert.strictEqual(params.get("code_challenge"), "challenge");
	assert.strictEqual(params.get("code_challenge_method"), "S256");
});

test("buildAuthUrl round-trips state through the redirect query", () => {
	const state = generateState();
	const authUrl = buildAuthUrl(
		"client-id",
		"http://127.0.0.1:1234",
		"challenge",
		state,
	);

	// What Google echoes back to the loopback listener.
	const redirect = new URL(
		`${new URL(authUrl).searchParams.get("redirect_uri")}/?code=4/abc&state=${encodeURIComponent(state)}`,
	);
	assert.strictEqual(redirect.searchParams.get("state"), state);
});

test("buildAuthUrl produces a challenge the verifier can satisfy", async () => {
	const verifier = generateVerifier();
	const challenge = await challengeFromVerifier(verifier);
	const params = new URL(
		buildAuthUrl("client-id", "http://127.0.0.1:1234", challenge, "state"),
	).searchParams;

	assert.strictEqual(params.get("code_challenge"), challenge);
	assert.notStrictEqual(params.get("code_challenge"), verifier);
});
