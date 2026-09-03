import { Platform, requestUrl } from "obsidian";
import type * as NodeHttp from "node:http";
import {
	REVOKE_ENDPOINT,
	TOKEN_ENDPOINT,
	buildAuthUrl,
	challengeFromVerifier,
	generateState,
	generateVerifier,
} from "./pkce.ts";

export {
	AUTH_ENDPOINT,
	GOOGLE_SCOPES,
	GOOGLE_SCOPE_PARAM,
	REVOKE_ENDPOINT,
	TOKEN_ENDPOINT,
	buildAuthUrl,
	challengeFromVerifier,
	generateState,
	generateVerifier,
} from "./pkce.ts";

/** Successful response body from the Google token endpoint. */
export interface TokenResponse {
	access_token: string;
	expires_in: number;
	/** Only present on the authorization_code exchange (and only with access_type=offline). */
	refresh_token?: string;
	token_type?: string;
	scope?: string;
}

/**
 * An error returned by the Google token endpoint. `code` carries Google's
 * machine-readable `error` field, e.g. `invalid_grant` when a refresh token has
 * been revoked or expired.
 */
export class OAuthError extends Error {
	code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "OAuthError";
		this.code = code;
	}
}

/** The user closed the browser tab / denied consent, or sign-in timed out. */
export class AuthCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthCancelledError";
	}
}

/** How long the loopback listener waits for the browser redirect. */
const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_PAGE = htmlPage(
	"Signed in",
	"ReminderSuite is connected to your Google account. You can close this tab.",
);
const FAILURE_PAGE = htmlPage(
	"Sign-in failed",
	"ReminderSuite could not complete sign-in. You can close this tab and try again from the plugin settings.",
);

function htmlPage(title: string, message: string): string {
	// Static text only — nothing from the request is ever echoed back into the page.
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;line-height:1.5"><h1>${title}</h1><p>${message}</p></body>`;
}

/**
 * Loads node's http module. Only ever called after a `Platform.isDesktopApp`
 * check — esbuild keeps node builtins external, so the mobile bundle never
 * evaluates this.
 */
function loadHttp(): typeof NodeHttp {
	return require("node:http") as typeof NodeHttp;
}

function formBody(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

function errorFromBody(status: number, body: unknown): OAuthError {
	const details =
		typeof body === "object" && body !== null
			? (body as { error?: unknown; error_description?: unknown })
			: {};
	const code = typeof details.error === "string" ? details.error : `http_${status}`;
	const description =
		typeof details.error_description === "string" ? details.error_description : "";
	const message = description
		? `Google rejected the token request: ${code} (${description})`
		: `Google rejected the token request: ${code}`;
	return new OAuthError(message, code);
}

/**
 * POSTs a form-encoded grant to Google's token endpoint. Shared by the initial
 * code exchange and by refresh. Never logs the request or response.
 */
export async function requestToken(
	fields: Record<string, string>,
): Promise<TokenResponse> {
	const response = await requestUrl({
		url: TOKEN_ENDPOINT,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		headers: { Accept: "application/json" },
		body: formBody(fields),
		throw: false,
	});

	let body: unknown;
	try {
		body = response.json;
	} catch {
		body = null;
	}

	if (response.status < 200 || response.status >= 300) {
		throw errorFromBody(response.status, body);
	}

	const token = body as Partial<TokenResponse> | null;
	if (!token || typeof token.access_token !== "string") {
		throw new OAuthError(
			"Google's token response did not contain an access token.",
			"malformed_response",
		);
	}

	return {
		access_token: token.access_token,
		expires_in: typeof token.expires_in === "number" ? token.expires_in : 3600,
		refresh_token:
			typeof token.refresh_token === "string" ? token.refresh_token : undefined,
		token_type: typeof token.token_type === "string" ? token.token_type : undefined,
		scope: typeof token.scope === "string" ? token.scope : undefined,
	};
}

/** Best-effort token revocation. Callers ignore failures. */
export async function revokeToken(token: string): Promise<void> {
	await requestUrl({
		url: `${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: "",
		throw: false,
	});
}

interface LoopbackResult {
	code: string;
	redirectUri: string;
}

function closeServer(server: NodeHttp.Server): void {
	// Browsers keep the redirect connection alive; without dropping sockets the
	// listener would linger well past the flow.
	const closeAll = (server as { closeAllConnections?: () => void })
		.closeAllConnections;
	if (typeof closeAll === "function") {
		closeAll.call(server);
	}
	server.close();
}

/**
 * Runs a one-shot loopback listener on 127.0.0.1 with an OS-assigned port,
 * opens the system browser, and resolves with the authorization code Google
 * redirects back. The server is always closed before this settles.
 */
function awaitAuthorizationCode(
	clientId: string,
	codeChallenge: string,
	state: string,
): Promise<LoopbackResult> {
	const http = loadHttp();

	return new Promise<LoopbackResult>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let redirectUri = "";

		const settle = (error: Error | null, result?: LoopbackResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			closeServer(server);
			if (error) reject(error);
			else resolve(result as LoopbackResult);
		};

		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const params = url.searchParams;

			// Browsers also ask for /favicon.ico; keep waiting for the real redirect.
			if (!params.has("code") && !params.has("error")) {
				res.writeHead(404, {
					"Content-Type": "text/plain; charset=utf-8",
					Connection: "close",
				});
				res.end("Not found");
				return;
			}

			if (params.get("state") !== state) {
				res.writeHead(400, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					Connection: "close",
				});
				res.end(FAILURE_PAGE, () => {
					settle(
						new Error(
							"Sign-in was rejected: the redirect did not match this sign-in request (state mismatch).",
						),
					);
				});
				return;
			}

			const failure = params.get("error");
			const code = params.get("code");

			if (failure || !code) {
				res.writeHead(400, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					Connection: "close",
				});
				res.end(FAILURE_PAGE, () => {
					settle(
						failure === "access_denied"
							? new AuthCancelledError("Sign-in was denied in the browser.")
							: new Error("Google did not return an authorization code."),
					);
				});
				return;
			}

			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				Connection: "close",
			});
			res.end(SUCCESS_PAGE, () => {
				settle(null, { code, redirectUri });
			});
		});

		server.on("error", (error: Error) => {
			settle(new Error(`Could not start the local sign-in listener: ${error.message}`));
		});

		timer = setTimeout(() => {
			settle(
				new AuthCancelledError(
					"Sign-in timed out after 5 minutes. Try again from the plugin settings.",
				),
			);
		}, LOOPBACK_TIMEOUT_MS);

		server.listen(0, "127.0.0.1", () => {
			try {
				const address = server.address();
				if (address === null || typeof address === "string") {
					throw new Error("The local sign-in listener did not report a port.");
				}
				redirectUri = `http://127.0.0.1:${address.port}`;
				window.open(buildAuthUrl(clientId, redirectUri, codeChallenge, state));
			} catch (error) {
				settle(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

/**
 * Full installed-app sign-in: loopback listener, system browser, PKCE code
 * exchange. Desktop only.
 */
export async function runLoopbackFlow(
	clientId: string,
	clientSecret: string,
): Promise<TokenResponse> {
	if (!Platform.isDesktopApp) {
		throw new Error(
			"Google sign-in is only available in the Obsidian desktop app. Sign in there; the tokens sync with your vault.",
		);
	}
	if (!clientId || !clientSecret) {
		throw new Error("Enter your Google client ID and client secret first.");
	}

	const verifier = generateVerifier();
	const codeChallenge = await challengeFromVerifier(verifier);
	const state = generateState();
	const { code, redirectUri } = await awaitAuthorizationCode(
		clientId,
		codeChallenge,
		state,
	);

	return requestToken({
		code,
		client_id: clientId,
		client_secret: clientSecret,
		code_verifier: verifier,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});
}
