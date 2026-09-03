import { OAuthError, revokeToken, requestToken, runLoopbackFlow } from "./oauth.ts";

/**
 * Google tokens as persisted in the plugin's data.json.
 *
 * No account email is stored: identifying the account would need an `openid`
 * scope this plugin deliberately does not request.
 */
export interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds at which the access token expires. */
	expiresAt: number;
}

/**
 * Thrown when the stored grant can no longer be used and the user has to sign
 * in again. Callers in later tasks should surface this as a prompt rather than
 * a generic failure.
 */
export class ReauthRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReauthRequiredError";
	}
}

/** Wiring to the plugin's settings; keeps TokenStore free of Plugin internals. */
export interface TokenStoreDeps {
	getClientId(): string;
	getClientSecret(): string;
	getTokens(): StoredTokens | null;
	setTokens(tokens: StoredTokens | null): void;
	save(): Promise<void>;
}

/** Refresh this long before the access token actually expires. */
const EXPIRY_SKEW_MS = 60 * 1000;

function expiresAtFrom(expiresIn: number): number {
	return Date.now() + expiresIn * 1000;
}

export class TokenStore {
	private deps: TokenStoreDeps;
	/** Shared across concurrent callers so one refresh serves all of them. */
	private refreshInFlight: Promise<string> | null = null;

	constructor(deps: TokenStoreDeps) {
		this.deps = deps;
	}

	isSignedIn(): boolean {
		const tokens = this.deps.getTokens();
		return tokens !== null && tokens.refreshToken !== "";
	}

	/**
	 * The access token every Google API call should use. Returns the cached one
	 * while it has more than a minute of life left, otherwise refreshes.
	 *
	 * Pass `forceRefresh: true` when a caller knows the cached token was
	 * rejected (e.g. a 401 from an API despite an unexpired `expiresAt`) and
	 * the cached value must not be reused.
	 */
	async getAccessToken(forceRefresh = false): Promise<string> {
		const tokens = this.deps.getTokens();
		if (tokens === null) {
			throw new ReauthRequiredError(
				"Not signed in to Google. Open ReminderSuite settings and sign in.",
			);
		}

		if (
			!forceRefresh &&
			tokens.accessToken !== "" &&
			tokens.expiresAt - Date.now() > EXPIRY_SKEW_MS
		) {
			return tokens.accessToken;
		}

		if (this.refreshInFlight === null) {
			this.refreshInFlight = this.refresh().finally(() => {
				this.refreshInFlight = null;
			});
		}
		return this.refreshInFlight;
	}

	/** Runs the browser sign-in flow and persists the resulting tokens. */
	async signIn(): Promise<void> {
		const response = await runLoopbackFlow(
			this.deps.getClientId(),
			this.deps.getClientSecret(),
		);

		if (response.refresh_token === undefined) {
			throw new Error(
				"Google did not return a refresh token. Remove ReminderSuite at https://myaccount.google.com/permissions and sign in again.",
			);
		}

		this.deps.setTokens({
			accessToken: response.access_token,
			refreshToken: response.refresh_token,
			expiresAt: expiresAtFrom(response.expires_in),
		});
		await this.deps.save();
	}

	/** Revokes the grant with Google (best effort) and clears local tokens. */
	async signOut(): Promise<void> {
		const tokens = this.deps.getTokens();
		const token = tokens?.refreshToken || tokens?.accessToken;
		if (token !== undefined && token !== "") {
			try {
				await revokeToken(token);
			} catch {
				// Revocation is best effort: the local tokens are cleared regardless.
			}
		}
		await this.clearTokens();
	}

	private async refresh(): Promise<string> {
		const tokens = this.deps.getTokens();
		if (tokens === null || tokens.refreshToken === "") {
			await this.clearTokens();
			throw new ReauthRequiredError(
				"Not signed in to Google. Open ReminderSuite settings and sign in.",
			);
		}

		const clientId = this.deps.getClientId();
		const clientSecret = this.deps.getClientSecret();
		if (clientId === "" || clientSecret === "") {
			throw new ReauthRequiredError(
				"Google client ID and secret are missing. Re-enter them in ReminderSuite settings.",
			);
		}

		let response;
		try {
			response = await requestToken({
				grant_type: "refresh_token",
				refresh_token: tokens.refreshToken,
				client_id: clientId,
				client_secret: clientSecret,
			});
		} catch (error) {
			if (error instanceof OAuthError && error.code === "invalid_grant") {
				await this.clearTokens();
				throw new ReauthRequiredError(
					"Google sign-in has expired or been revoked. Sign in again in ReminderSuite settings.",
				);
			}
			throw error;
		}

		const next: StoredTokens = {
			accessToken: response.access_token,
			// A refresh response usually omits refresh_token; keep the existing one.
			refreshToken: response.refresh_token ?? tokens.refreshToken,
			expiresAt: expiresAtFrom(response.expires_in),
		};
		this.deps.setTokens(next);
		await this.deps.save();
		return next.accessToken;
	}

	private async clearTokens(): Promise<void> {
		this.deps.setTokens(null);
		await this.deps.save();
	}
}
