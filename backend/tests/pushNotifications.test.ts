import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFcmConfig, type FcmEnvConfig } from "../src/config/env.js";
import { createPushProvider } from "../src/notifications/provider.js";
import { ConsoleNotificationProvider } from "../src/notifications/providers/consoleNotificationProvider.js";
import {
  FcmPushProvider,
  FcmAuthError,
  FcmSendError,
  buildServiceAccountAssertion,
  type FetchLike,
} from "../src/notifications/providers/fcmPushProvider.js";
import { InvalidPushTokenError } from "../src/notifications/types.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const testConfig: FcmEnvConfig = {
  projectId: "test-project",
  clientEmail: "test-service-account@test-project.iam.gserviceaccount.com",
  privateKey,
};

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("parseFcmConfig (FCM_SERVICE_ACCOUNT_JSON env var)", () => {
  it("returns undefined when FCM_SERVICE_ACCOUNT_JSON is unset - no real provider configured", () => {
    expect(parseFcmConfig({})).toBeUndefined();
  });

  it("parses a valid service-account JSON into projectId/clientEmail/privateKey", () => {
    const config = parseFcmConfig({
      FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
        project_id: "my-project",
        client_email: "sa@my-project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    });
    expect(config).toEqual({
      projectId: "my-project",
      clientEmail: "sa@my-project.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    });
  });

  it("throws if the value isn't valid JSON", () => {
    expect(() => parseFcmConfig({ FCM_SERVICE_ACCOUNT_JSON: "not json" })).toThrow(/valid JSON/);
  });

  it("throws if project_id/client_email/private_key are missing", () => {
    expect(() =>
      parseFcmConfig({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "x" }) }),
    ).toThrow(/project_id\/client_email\/private_key/);
  });
});

describe("buildServiceAccountAssertion", () => {
  it("produces a JWT with the header/claims Google's OAuth2 JWT-bearer flow documents", () => {
    const nowSeconds = 1_700_000_000;
    const assertion = buildServiceAccountAssertion(testConfig, nowSeconds);
    const [headerPart, payloadPart, signaturePart] = assertion.split(".");

    expect(decodeJwtPart(headerPart)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeJwtPart(payloadPart)).toEqual({
      iss: testConfig.clientEmail,
      sub: testConfig.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });

    // The signature must actually verify against the paired public key -
    // proving this is a real, checkable RS256 signature over the
    // header.payload signing input, not just well-shaped JSON.
    const signingInput = `${headerPart}.${payloadPart}`;
    const signatureValid = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(signingInput),
      publicKey,
      Buffer.from(signaturePart, "base64url"),
    );
    expect(signatureValid).toBe(true);
  });
});

describe("createPushProvider (FCM vs. dev-console selection)", () => {
  it("selects the console provider when no FCM config is given - the safe, explicit default", () => {
    expect(createPushProvider(undefined)).toBeInstanceOf(ConsoleNotificationProvider);
  });

  it("selects the FCM provider once a real FCM config is given", () => {
    expect(createPushProvider(testConfig)).toBeInstanceOf(FcmPushProvider);
  });
});

describe("ConsoleNotificationProvider", () => {
  it("resolves without throwing - it's a logging no-op, never a real send", async () => {
    const provider = new ConsoleNotificationProvider();
    await expect(
      provider.send({ token: "abc", title: "Test", body: "Body" }),
    ).resolves.toBeUndefined();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FcmPushProvider", () => {
  it("exchanges the assertion for an access token, then sends via the FCM v1 endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "fake-access-token", expires_in: 3600 });
      }
      if (url === "https://fcm.googleapis.com/v1/projects/test-project/messages:send") {
        return jsonResponse(200, { name: "projects/test-project/messages/1" });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    };

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await provider.send({ token: "device-token-1", title: "New event", body: "Carnival tonight!" });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[1].url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(calls[1].init?.headers).toMatchObject({ Authorization: "Bearer fake-access-token" });
    const sentBody = JSON.parse(calls[1].init?.body as string);
    expect(sentBody).toEqual({
      message: {
        token: "device-token-1",
        notification: { title: "New event", body: "Carnival tonight!" },
        data: undefined,
      },
    });
  });

  it("caches the access token across sends instead of re-exchanging every time", async () => {
    let tokenExchanges = 0;
    const fetchMock: FetchLike = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenExchanges++;
        return jsonResponse(200, { access_token: "cached-token", expires_in: 3600 });
      }
      return jsonResponse(200, {});
    };

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await provider.send({ token: "t1", title: "A", body: "A" });
    await provider.send({ token: "t2", title: "B", body: "B" });

    expect(tokenExchanges).toBe(1);
  });

  it("maps a 404 FCM response to InvalidPushTokenError - a stale/unregistered token", async () => {
    const fetchMock: FetchLike = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
      }
      return new Response("UNREGISTERED", { status: 404 });
    };

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await expect(provider.send({ token: "dead-token", title: "A", body: "B" })).rejects.toThrow(
      InvalidPushTokenError,
    );
  });

  it("maps a 400 FCM response to InvalidPushTokenError - a malformed token", async () => {
    const fetchMock: FetchLike = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
      }
      return new Response("INVALID_ARGUMENT", { status: 400 });
    };

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await expect(provider.send({ token: "malformed", title: "A", body: "B" })).rejects.toThrow(
      InvalidPushTokenError,
    );
  });

  it("maps any other non-ok FCM response to FcmSendError - a transient/provider failure", async () => {
    const fetchMock: FetchLike = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
      }
      return new Response("Internal error", { status: 500 });
    };

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await expect(provider.send({ token: "t", title: "A", body: "B" })).rejects.toThrow(FcmSendError);
  });

  it("maps a failed OAuth token exchange to FcmAuthError", async () => {
    const fetchMock: FetchLike = async () => new Response("invalid_grant", { status: 400 });

    const provider = new FcmPushProvider(testConfig, fetchMock);
    await expect(provider.send({ token: "t", title: "A", body: "B" })).rejects.toThrow(FcmAuthError);
  });

  describe("timeout protection (Step 58, OWASP API10)", () => {
    // A realistic stand-in for a hung Google endpoint: fetchImpl never
    // resolves or rejects on its own, but does honor the AbortSignal it's
    // given, the same contract Node's real fetch/undici implementation
    // has - so this only passes if FcmPushProvider is actually wiring the
    // signal through to fetchImpl, not merely constructing one and
    // discarding it.
    function hungFetchThatHonorsAbort(): FetchLike {
      return (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal!.reason);
          });
        });
    }

    it("aborts a hung OAuth token exchange instead of hanging forever", async () => {
      const provider = new FcmPushProvider(testConfig, hungFetchThatHonorsAbort(), 20);
      await expect(
        provider.send({ token: "t", title: "A", body: "B" }),
      ).rejects.toThrow();
    });

    it("aborts a hung FCM send call instead of hanging forever", async () => {
      const fetchMock: FetchLike = async (url, init) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal!.reason);
          });
        });
      };
      const provider = new FcmPushProvider(testConfig, fetchMock, 20);
      await expect(
        provider.send({ token: "t", title: "A", body: "B" }),
      ).rejects.toThrow();
    });

    it("does not abort a call that completes well within the timeout", async () => {
      const fetchMock: FetchLike = async (url) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse(200, { access_token: "tok", expires_in: 3600 });
        }
        return jsonResponse(200, { name: "projects/test-project/messages/1" });
      };
      const provider = new FcmPushProvider(testConfig, fetchMock, 5000);
      await expect(
        provider.send({ token: "t", title: "A", body: "B" }),
      ).resolves.toBeUndefined();
    });
  });
});
