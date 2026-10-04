import { describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
} from "jose";
import {
  ACCESS_JWT_HEADER,
  type AccessTokenKeyResolver,
  AuthError,
  authenticate,
  enforceSameOrigin,
  teamJwksUrl,
  verifyAccessToken,
} from "../src/auth";

// Real RSA keypair generated per test run: genuine RS256 verification against a
// controlled local key set — no mock success-echo, no production test hooks.
async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength: 2048,
  });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateJwk: await exportJWK(privateKey),
    localJwks: createLocalJWKSet({
      keys: [{ ...publicJwk, kid: "test-key-1", use: "sig", alg: "RS256" }],
    }),
  };
}

let signingKey: CryptoKey;
let jwks: AccessTokenKeyResolver;
const ISSUER = "https://example.cloudflareaccess.com";
const AUD = "access-application-id.example";

async function sign(overrides: Record<string, unknown> = {}, key?: CryptoKey): Promise<string> {
  return new SignJWT({ email: "user@example.com", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject("1234-5678")
    .setExpirationTime("10m")
    .sign(key ?? signingKey);
}

const CONFIG = { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: AUD };

async function expectAuthError(promise: Promise<unknown>, status: number, error: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    const authErr = err as AuthError;
    expect(authErr.status).toBe(status);
    expect(authErr.error).toBe(error);
    // No JOSE internals or token material leak through the public message.
    expect(authErr.message).not.toMatch(/JWS|signature verification|jose/i);
    return;
  }
  throw new Error(`expected AuthError ${status}/${error}, resolved`);
}

/**
 * enforceSameOrigin throws synchronously (it is not an async function), so its
 * rejections must be asserted with a synchronous throw, not by wrapping the
 * call in a Promise — the synchronous throw would escape the Promise entirely
 * and fail the test before any assertion ran.
 */
function expectSyncAuthError(fn: () => unknown, status: number, error: string) {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  expect(
    threw,
    `expected synchronous AuthError ${status}/${error}, resolved instead`,
  ).toBeDefined();
  expect(threw).toBeInstanceOf(AuthError);
  const authErr = threw as AuthError;
  expect(authErr.status).toBe(status);
  expect(authErr.error).toBe(error);
  // No JOSE internals or token material leak through the public message.
  expect(authErr.message).not.toMatch(/JWS|signature verification|jose/i);
}

describe("authenticate / verifyAccessToken", () => {
  it("verifies a valid token with real RS256 crypto and derives stable issuer+subject identity", async () => {
    const { privateJwk, localJwks } = await makeKeys();
    signingKey = (await importJWK(privateJwk, "RS256")) as CryptoKey;
    jwks = localJwks;

    const token = await sign();
    const identity = await verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUD });
    expect(identity.email).toBe("user@example.com");
    // Deterministic SHA-256 of "<issuer>\n<subject>".
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${ISSUER}\n1234-5678`),
    );
    const expectedId = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(identity.id).toBe(expectedId);
    // Same identity regardless of email (identity is NOT email-derived).
    const otherEmail = await verifyAccessToken(await sign({ email: "renamed@example.com" }), jwks, {
      issuer: ISSUER,
      audience: AUD,
    });
    expect(otherEmail.id).toBe(identity.id);
  });

  it("denies a token signed with the wrong key", async () => {
    const stranger = await makeKeys();
    const strangerKey = (await importJWK(stranger.privateJwk, "RS256")) as CryptoKey;
    await expectAuthError(
      verifyAccessToken(await sign({}, strangerKey), jwks, { issuer: ISSUER, audience: AUD }),
      401,
      "invalid_token",
    );
  });

  it("denies wrong audience", async () => {
    await expectAuthError(
      verifyAccessToken(await sign(), jwks, { issuer: ISSUER, audience: "other-aud" }),
      401,
      "invalid_token",
    );
  });

  it("denies wrong issuer", async () => {
    await expectAuthError(
      verifyAccessToken(await sign(), jwks, { issuer: "https://evil.example.com", audience: AUD }),
      401,
      "invalid_token",
    );
  });

  it("denies an expired token (temporal validation)", async () => {
    const expired = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject("1234-5678")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signingKey);
    await expectAuthError(
      verifyAccessToken(expired, jwks, { issuer: ISSUER, audience: AUD }),
      401,
      "invalid_token",
    );
  });

  it("denies a tampered token", async () => {
    const token = await sign();
    const [header, payload, signature] = token.split(".");
    // noUncheckedIndexedAccess: segment access is guarded, a malformed split
    // must fail the test explicitly instead of tripping on undefined.
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error("malformed test token: expected exactly three JWT segments");
    }
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
    const tamperedPayload = btoa(JSON.stringify({ ...json, sub: "attacker" }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    await expectAuthError(
      verifyAccessToken(`${header}.${tamperedPayload}.${signature}`, jwks, {
        issuer: ISSUER,
        audience: AUD,
      }),
      401,
      "invalid_token",
    );
  });

  it("requires a nonempty sub and a nonempty email claim", async () => {
    const noSubject = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime("10m")
      .sign(signingKey);
    await expectAuthError(
      verifyAccessToken(noSubject, jwks, { issuer: ISSUER, audience: AUD }),
      401,
      "invalid_token",
    );
    await expectAuthError(
      verifyAccessToken(await sign({ email: "" }), jwks, { issuer: ISSUER, audience: AUD }),
      401,
      "invalid_token",
    );
    await expectAuthError(
      verifyAccessToken(await sign({ email: undefined }), jwks, { issuer: ISSUER, audience: AUD }),
      401,
      "invalid_token",
    );
  });
});

describe("authenticate request handling and config validation", () => {
  it("fails closed on missing/blank config and rejects non-HTTPS or unsafe team domains", async () => {
    await expectAuthError(
      authenticate(new Request("https://app.example.com/api/session", { method: "GET" }), {
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: AUD,
      }),
      500,
      "access_not_configured",
    );
    await expectAuthError(
      authenticate(new Request("https://app.example.com/api/session", { method: "GET" }), {
        ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
        ACCESS_AUD: " ",
      }),
      500,
      "access_not_configured",
    );
    for (const bad of [
      "http://example.cloudflareaccess.com",
      "example.cloudflareaccess.com/certs",
      "127.0.0.1",
      "localhost",
      "team:8080.example.com",
      "",
      "example.com",
      "cloudflareaccess.com",
      "evil.cloudflareaccess.com.attacker.io",
      "example.cloudflareaccess.com.attacker.com",
    ]) {
      expect(() => teamJwksUrl(bad)).toThrow(AuthError);
    }
    expect(teamJwksUrl("example.cloudflareaccess.com")).toBe(
      "https://example.cloudflareaccess.com/cdn-cgi/access/certs",
    );
  });

  it("fails closed when the access token header is missing", async () => {
    await expectAuthError(
      authenticate(new Request("https://app.example.com/api/session", { method: "GET" }), CONFIG),
      401,
      "missing_token",
    );
  });

  it("rejects tokens via the header path", async () => {
    const stranger = await makeKeys();
    const strangerKey = (await importJWK(stranger.privateJwk, "RS256")) as CryptoKey;
    // Config valid, but the token is signed by an untrusted key — must deny.
    await expectAuthError(
      authenticate(
        new Request("https://app.example.com/api/session", {
          method: "GET",
          headers: { [ACCESS_JWT_HEADER]: await sign({}, strangerKey) },
        }),
        CONFIG,
      ),
      401,
      "invalid_token",
    );
  });
});

describe("enforceSameOrigin", () => {
  const BASE = "https://app.example.com";

  function request(method: string, headers: Record<string, string> = {}): Request {
    return new Request(`${BASE}/api/session/messages`, { method, headers });
  }

  it("allows same-origin mutating requests and returns the service origin", () => {
    expect(enforceSameOrigin(request("POST", { Origin: BASE }))).toBe(BASE);
  });

  it("requires Origin on mutating methods (missing Origin fails closed)", () => {
    expectSyncAuthError(() => enforceSameOrigin(request("POST")), 403, "missing_origin");
    expectSyncAuthError(() => enforceSameOrigin(request("DELETE")), 403, "missing_origin");
  });

  it("rejects cross-origin and unparseable Origin", () => {
    expectSyncAuthError(
      () => enforceSameOrigin(request("POST", { Origin: "https://evil.example.com" })),
      403,
      "origin_mismatch",
    );
    expectSyncAuthError(
      () => enforceSameOrigin(request("POST", { Origin: "not-a-url" })),
      403,
      "origin_mismatch",
    );
  });

  it("rejects cross-site/sec-fetch-site same-site even with a matching Origin header", () => {
    expectSyncAuthError(
      () => enforceSameOrigin(request("PATCH", { Origin: BASE, "Sec-Fetch-Site": "cross-site" })),
      403,
      "origin_mismatch",
    );
    expectSyncAuthError(
      () => enforceSameOrigin(request("PUT", { Origin: BASE, "Sec-Fetch-Site": "same-site" })),
      403,
      "origin_mismatch",
    );
  });

  it("does not require Origin for safe methods", () => {
    // Safe methods skip the check entirely; Host/Referer are never consulted
    // as an origin allowlist anywhere in enforceSameOrigin.
    expect(enforceSameOrigin(new Request(`${BASE}/api/session`, { method: "GET" }))).toBe(BASE);
  });
});
