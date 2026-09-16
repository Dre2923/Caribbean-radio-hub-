import { createSign } from "node:crypto";
import type { FcmEnvConfig } from "../../config/env.js";
import { InvalidPushTokenError, type PushMessage, type PushProvider } from "../types.js";

// Source: Firebase's own "Send a message using FCM HTTP v1 API" and
// "Use the FCM HTTP v1 API with OAuth 2 access tokens" documentation
// (firebase.google.com/docs/cloud-messaging/send/v1-api,
// firebase.google.com/docs/cloud-messaging/auth-server) - checked live
// during this step's research rather than assumed from memory, the same
// "verify, don't recall, anything with real architectural weight" standard
// docs/ARCHITECTURE_PLAN.md already holds itself to. The documented flow:
// sign a short-lived JWT with the service account's own RSA private key
// (RS256), exchange it for an OAuth2 access token via Google's standard
// "JWT Bearer Token" server-to-server grant, then call FCM's HTTP v1 send
// endpoint with that access token as a Bearer credential. No Firebase Admin
// SDK dependency needed for this - it's a plain HTTP flow buildable with
// Node's own built-in crypto and fetch, matching the "free/open-source
// first, no unnecessary dependency" standard already applied to
// email/providers/smtpEmailProvider.ts choosing nodemailer over a
// vendor-specific SDK.
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
// Google's own documented grant type for a service-account JWT assertion.
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
// Access tokens from this flow are valid for exactly 3600s per Google's
// documentation; requesting exactly that duration for the assertion itself
// (the JWT's own "exp") is the standard, and refreshing 60s early (see
// getAccessToken below) avoids ever presenting an access token that
// expires mid-flight.
const ASSERTION_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Step 58/OWASP API10 (Unsafe Consumption of Third-Party APIs): neither
// outbound call this provider makes carried any timeout until now - a
// hung or slow-to-respond Google endpoint (oauth2.googleapis.com or
// fcm.googleapis.com) would otherwise stall this call indefinitely, which
// in turn stalls favoriteStationAvailabilityNotifier's Promise.all fan-out
// for that one token, which in turn stalls the admin's synchronous
// `await`ed PATCH /v1/stations/:id request (Step 54's wiring) for as long
// as Google's own connection stays open. AbortSignal.timeout() is a Node
// core API confirmed (via research, not assumed) to have been added in
// v17.3.0/v16.14.0, well within this project's `engines` >=20 floor - the
// same "verify the exact Node version an API needs before relying on it"
// discipline already applied to checkStreamHealth's own timeout handling.
// 10s is more generous than checkStreamHealth's 8s default since these are
// small JSON request/response round trips to a well-provisioned Google
// endpoint, not a real-world radio stream server of unknown quality - long
// enough to absorb ordinary network jitter, short enough that one slow
// token can never meaningfully delay the fan-out or the request awaiting it.
const FCM_FETCH_TIMEOUT_MS = 10_000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

// Exported for direct unit testing (decode the result and verify its
// header/claims/signature) without needing a real network call - the same
// "pure function of its input, independently testable" shape already
// applied to parseSmtpConfig/parseTrustProxy.
export function buildServiceAccountAssertion(config: FcmEnvConfig, nowSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: config.clientEmail,
    sub: config.clientEmail,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  // Node's crypto.sign accepts a PEM-encoded private key string directly
  // (no need to parse/import it as a KeyObject first).
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(config.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

// The subset of the global fetch signature this provider actually uses -
// injectable so tests can supply a mock instead of hitting a real Google
// endpoint, the identical dependency-injection reasoning already applied
// throughout this codebase (createEmailProvider taking its config as a
// parameter, background workers taking their target list as a parameter).
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class FcmAuthError extends Error {
  constructor(detail: string) {
    super(`FCM OAuth token exchange failed: ${detail}`);
    this.name = "FcmAuthError";
  }
}

export class FcmSendError extends Error {
  constructor(detail: string) {
    super(`FCM send failed: ${detail}`);
    this.name = "FcmSendError";
  }
}

/**
 * The real push-notification provider, selected by createPushProvider()
 * (../provider.ts) whenever a real FCM service-account credential is
 * configured. Caches its own OAuth2 access token in memory across calls
 * (Google's documented flow issues a token valid for a full hour - minting
 * a fresh one on every single push would be both unnecessary load on
 * Google's token endpoint and needless added latency per notification) and
 * refreshes it proactively before expiry rather than reactively after a
 * request fails.
 */
export class FcmPushProvider implements PushProvider {
  private cachedAccessToken: { value: string; expiresAtMs: number } | null = null;

  constructor(
    private readonly config: FcmEnvConfig,
    private readonly fetchImpl: FetchLike = fetch,
    // Injectable for the identical reason checkStreamHealth's own
    // timeoutMs parameter is: production always uses the real
    // FCM_FETCH_TIMEOUT_MS default, but a test proving the timeout
    // actually aborts a hung call needs a much smaller value than 10s to
    // run at unit-test speed.
    private readonly timeoutMs: number = FCM_FETCH_TIMEOUT_MS,
  ) {}

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now) {
      return this.cachedAccessToken.value;
    }

    const assertion = buildServiceAccountAssertion(this.config, Math.floor(now / 1000));
    const response = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE, assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new FcmAuthError(`${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as OAuthTokenResponse;
    this.cachedAccessToken = {
      value: body.access_token,
      expiresAtMs: now + body.expires_in * 1000,
    };
    return body.access_token;
  }

  async send(message: PushMessage): Promise<void> {
    const accessToken = await this.getAccessToken();
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      // FCM reports an unregistered/invalid token as 404 (UNREGISTERED) or
      // 400 (INVALID_ARGUMENT, e.g. a malformed token) - a permanent,
      // token-specific failure the caller should stop retrying, not a
      // transient provider outage.
      if (response.status === 404 || response.status === 400) {
        throw new InvalidPushTokenError(message.token, `${response.status} ${detail}`);
      }
      throw new FcmSendError(`${response.status} ${detail}`);
    }
  }
}
