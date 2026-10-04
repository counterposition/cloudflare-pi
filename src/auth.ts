/**
 * Cloudflare Access authentication.
 *
 * Public API contract (all shapes are exact and relied upon by the worker):
 *
 * - `authenticate(request, config)` verifies the Cloudflare Access JWT found in
 *   the `Cf-Access-Jwt-Assertion` request header using the team's remote JWKS
 *   (RS256, issuer and audience checked, expiry enforced by `jwtVerify`).
 *   On success it resolves to the authenticated identity:
 *
 *     { id: string, email: string }
 *
 *   `id` is the STABLE identity used for session keying. It is a SHA-256 hex
 *   digest of `<issuer>\n<subject>` — derived only from the verified token's
 *   `iss` and `sub`, never from the email or any unverified header. It is
 *   deterministic across devices and logins for the same Access user.
 *   `email` is the verified token's `email` claim (required, nonempty).
 *
 * - `enforceSameOrigin(request, config)` returns the validated service origin
 *   (string) for mutating requests, or throws `AuthError` (403) when the
 *   request is not an unambiguous same-origin browser request.
 *
 * - `AuthError` carries `status` (number) and `error` (stable, non-sensitive
 *   message; never the token, never JOSE internals).
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
  type JWTVerifyOptions,
} from "jose";

/**
 * Key resolver for token verification. Satisfied by jose's `createRemoteJWKSet`
 * (production) and `createLocalJWKSet` (tests with real generated keys).
 */
export type AccessTokenKeyResolver = (
  protectedHeader?: JWSHeaderParameters,
  token?: FlattenedJWSInput,
) => Promise<CryptoKey>;

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Stable, non-sensitive error with an HTTP status; safe to expose to clients. */
export class AuthError extends Error {
  readonly status: number;
  /** Stable machine-readable reason; no token material, no JOSE error text. */
  readonly error: string;

  constructor(status: number, error: string) {
    super(error);
    this.name = "AuthError";
    this.status = status;
    this.error = error;
  }
}

function requireConfig(teamDomain: unknown, aud: unknown): { team: string; aud: string } {
  if (typeof teamDomain !== "string" || teamDomain.trim().length === 0) {
    throw new AuthError(500, "access_not_configured");
  }
  if (typeof aud !== "string" || aud.trim().length === 0) {
    throw new AuthError(500, "access_not_configured");
  }
  return { team: teamDomain.trim(), aud };
}

/**
 * Validate that `teamDomain` is a bare Cloudflare Access team hostname
 * (`<team>.cloudflareaccess.com`) and derive the JWKS URL. Rejects URLs, paths,
 * ports, IPs, and other DNS names, so no arbitrary untrusted fetch target can
 * be smuggled in through configuration.
 */
export function teamJwksUrl(teamDomain: string): string {
  const trimmed = teamDomain.trim();
  if (
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("@")
  ) {
    throw new AuthError(500, "invalid_team_domain");
  }
  const candidate = `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AuthError(500, "invalid_team_domain");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== trimmed.toLowerCase() ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.port !== ""
  ) {
    throw new AuthError(500, "invalid_team_domain");
  }
  const hostname = url.hostname;
  const isIpV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const isIpV6 = hostname.startsWith("[") || hostname.includes(":");
  const dnsName = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
    hostname,
  );
  if (isIpV4 || isIpV6 || !dnsName || hostname === "localhost") {
    throw new AuthError(500, "invalid_team_domain");
  }
  if (!hostname.endsWith(".cloudflareaccess.com") || hostname === ".cloudflareaccess.com") {
    throw new AuthError(500, "invalid_team_domain");
  }
  return `${url.origin}/cdn-cgi/access/certs`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Core verification against an explicit key store. Production uses the remote
 * JWKS (`authenticate`); tests use a locally generated real RSA key set to
 * exercise genuine RS256 verification without a live network dependency.
 */
export async function verifyAccessToken(
  token: string,
  keyStore: AccessTokenKeyResolver,
  expected: { issuer: string; audience: string },
): Promise<{ id: string; email: string }> {
  const options: JWTVerifyOptions = {
    algorithms: ["RS256"],
    issuer: expected.issuer,
    audience: expected.audience,
    // Expiry/nbf are enforced by jwtVerify against the current time.
    clockTolerance: 0,
    requiredClaims: ["iss", "sub", "aud", "exp"],
  };

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, keyStore, options);
    payload = result.payload as Record<string, unknown>;
  } catch {
    // Bad signature, wrong issuer/audience, expired, malformed — all fail closed
    // with the same non-sensitive reason; JOSE error details are never surfaced.
    throw new AuthError(401, "invalid_token");
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new AuthError(401, "invalid_token");
  }
  const email = payload.email;
  if (typeof email !== "string" || email.trim().length === 0) {
    throw new AuthError(401, "invalid_token");
  }

  // Stable identity: issuer + subject only. Email is not part of identity.
  const id = await sha256Hex(`${expected.issuer}\n${subject}`);
  return { id, email };
}

export async function authenticate(
  request: Request,
  config: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string },
): Promise<{ id: string; email: string }> {
  const { team, aud } = requireConfig(config.ACCESS_TEAM_DOMAIN, config.ACCESS_AUD);
  const jwksUrl = teamJwksUrl(team);
  // Cached per-module JWKS client; jose keeps key rotation internally.
  const keyStore = remoteJwks(jwksUrl);
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token.length === 0) {
    throw new AuthError(401, "missing_token");
  }
  return verifyAccessToken(token, keyStore, { issuer: `https://${team}`, audience: aud });
}

const jwksCache = new Map<string, AccessTokenKeyResolver>();
function remoteJwks(url: string): AccessTokenKeyResolver {
  let cached = jwksCache.get(url);
  if (cached === undefined) {
    cached = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, cached);
  }
  return cached;
}

const MUTATING_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

/**
 * Require an unambiguous same-origin browser request for mutating methods.
 *
 * Design for missing Origin: a mutating request WITHOUT an `Origin` header is
 * rejected (403). Same-origin browser fetches on these endpoints always send
 * `Origin`, so requiring it protects the public authenticated endpoints from
 * non-browser and cross-origin writers; we never fall back to the
 * user-controlled `Host`/`Referer` as an allowlist.
 *
 * `Sec-Fetch-Site` (when present, cannot be trusted alone) must not claim
 * `cross-site` or `same-site`; cross-site initiation is rejected even if the
 * Origin header somehow matches.
 *
 * Returns the validated service origin (the request URL's own origin).
 */
export function enforceSameOrigin(request: Request, _config?: { SERVICE_ORIGIN?: string }): string {
  if (!MUTATING_METHODS[request.method.toUpperCase()]) {
    return new URL(request.url).origin;
  }
  const requestOrigin = new URL(request.url).origin;

  const originHeader = request.headers.get("Origin");
  if (originHeader === null || originHeader.length === 0) {
    throw new AuthError(403, "missing_origin");
  }
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    throw new AuthError(403, "origin_mismatch");
  }
  if (origin.origin !== requestOrigin) {
    throw new AuthError(403, "origin_mismatch");
  }

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && (fetchSite === "cross-site" || fetchSite === "same-site")) {
    throw new AuthError(403, "origin_mismatch");
  }

  return requestOrigin;
}
