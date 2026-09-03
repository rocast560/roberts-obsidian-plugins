/**
 * Pure OAuth 2.0 / PKCE helpers (RFC 7636).
 *
 * Nothing here may import `obsidian` or a node builtin: this module is the one
 * part of the auth layer covered by `node --test`, and it also has to run on
 * mobile where node builtins are unavailable.
 */

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/**
 * The only scopes this plugin ever requests. `calendar.events` covers reading
 * and writing events; the read-only calendar list is needed to let the user
 * pick a target calendar. The broad `auth/calendar` scope is deliberately not
 * used.
 */
export const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/calendar.events",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

export const GOOGLE_SCOPE_PARAM = GOOGLE_SCOPES.join(" ");

/** Bytes of entropy for a code verifier; 32 bytes base64url-encode to 43 chars. */
const VERIFIER_BYTES = 32;
/** Bytes of entropy for the CSRF state value. */
const STATE_BYTES = 16;

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

/**
 * A fresh PKCE code verifier: 43 characters drawn from the unreserved set,
 * within the 43-128 character range RFC 7636 section 4.1 requires.
 */
export function generateVerifier(): string {
	return randomBase64Url(VERIFIER_BYTES);
}

/** A fresh CSRF `state` value for one authorization request. */
export function generateState(): string {
	return randomBase64Url(STATE_BYTES);
}

/** S256 code challenge: BASE64URL(SHA256(ASCII(verifier))). */
export async function challengeFromVerifier(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Authorization URL for the installed-app (loopback) flow. `access_type=offline`
 * plus `prompt=consent` is what makes Google return a refresh token.
 */
export function buildAuthUrl(
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
	state: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPE_PARAM,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});
	return `${AUTH_ENDPOINT}?${params.toString()}`;
}
