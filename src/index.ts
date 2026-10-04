/**
 * Worker entry for the private Pi app behind verified Cloudflare Access.
 *
 * Every request — API and static assets — is authenticated with the real
 * Access JWT before anything else happens; mutating API calls must also be
 * unambiguous same-origin browser requests. Sessions are addressed only by
 * the verified identity: the Durable Object name is the stable identity id
 * (SHA256 over the Access issuer and subject), never anything the browser
 * sends. The Session Durable Object and the DirectoryBackupGateway container
 * backup entrypoint are exported for the runtime; the gateway is a named
 * entrypoint reachable only over RPC (`ctx.exports`), never HTTP-routed.
 */

import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { authenticate, AuthError, enforceSameOrigin } from "./auth";
import type { SubmitInput } from "./contracts";
import type { AppEnv, SessionIdentity } from "./env";
import { Session } from "./session";

export { Session, DirectoryBackupGateway };

/** Thrown by request validation; rendered as a descriptive 400. */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

const JSON_HEADERS: Record<string, string> = { "content-type": "application/json; charset=utf-8" };

/** Largest accepted prompt text; far below RPC limits, blocks accidental dumps. */
const MAX_TEXT_LENGTH = 1_000_000;
/** requestId is persisted as an exactly-once admission key inside the DO. */
const MAX_REQUEST_ID_LENGTH = 128;

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...headers },
  });
}

function errorResponse(status: number, error: string, headers?: Record<string, string>): Response {
  return jsonResponse({ error }, status, headers);
}

/**
 * Strict SubmitInput shape: exactly the three known fields, each semantically
 * valid. Rejects anything else with a descriptive 400.
 */
function parseSubmitInput(body: unknown): SubmitInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError(
      'invalid_body: expected a JSON object with fields "text", "requestId", "whenBusy"',
    );
  }
  const record = body as { readonly [key: string]: unknown };
  for (const field of Object.keys(record)) {
    if (field !== "text" && field !== "requestId" && field !== "whenBusy") {
      throw new BadRequestError(`invalid_body: unknown field "${field}"`);
    }
  }
  const text = record["text"];
  if (typeof text !== "string" || text.length === 0) {
    throw new BadRequestError('invalid_body: "text" must be a non-empty string');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new BadRequestError(
      `invalid_body: "text" is too long (over ${MAX_TEXT_LENGTH} characters)`,
    );
  }
  const requestId = record["requestId"];
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH
  ) {
    throw new BadRequestError(
      `invalid_body: "requestId" must be a non-empty string of at most ${MAX_REQUEST_ID_LENGTH} characters`,
    );
  }
  const whenBusy = record["whenBusy"];
  if (whenBusy !== "steer" && whenBusy !== "followUp") {
    throw new BadRequestError('invalid_body: "whenBusy" must be "steer" or "followUp"');
  }
  return { text, requestId, whenBusy };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequestError("invalid_body: request body must be valid JSON");
  }
}

async function submitMessage(
  request: Request,
  env: AppEnv,
  identity: SessionIdentity,
): Promise<Response> {
  enforceSameOrigin(request);
  const input = parseSubmitInput(await readJsonBody(request));
  const session = env.SESSIONS.getByName(identity.id);
  const receipt = await session.submit(identity, input);
  return jsonResponse(receipt, 202);
}

async function handleApi(
  request: Request,
  env: AppEnv,
  identity: SessionIdentity,
  pathname: string,
): Promise<Response> {
  const session = () => env.SESSIONS.getByName(identity.id);
  const method = request.method;

  switch (pathname) {
    case "/api/session":
      if (method !== "GET") {
        return errorResponse(405, "method_not_allowed", { allow: "GET" });
      }
      // The body arrives JSON-serialized from the DO RPC boundary (contracts.SessionRpcApi);
      // send the bytes as-is so the public JSON stays identical, never re-stringified.
      return new Response(await session().snapshot(identity), {
        status: 200,
        headers: JSON_HEADERS,
      });
    case "/api/session/events":
      if (method !== "GET") {
        return errorResponse(405, "method_not_allowed", { allow: "GET" });
      }
      return session().events(identity);
    case "/api/session/messages":
      if (method !== "POST") {
        return errorResponse(405, "method_not_allowed", { allow: "POST" });
      }
      return submitMessage(request, env, identity);
    case "/api/session/abort":
      if (method !== "POST") {
        return errorResponse(405, "method_not_allowed", { allow: "POST" });
      }
      enforceSameOrigin(request);
      await session().abort(identity);
      return new Response(null, { status: 204 });
    case "/api/session/checkpoint":
      if (method !== "POST") {
        return errorResponse(405, "method_not_allowed", { allow: "POST" });
      }
      enforceSameOrigin(request);
      return jsonResponse(await session().checkpoint(identity), 200);
    case "/api/session/restore":
      if (method !== "POST") {
        return errorResponse(405, "method_not_allowed", { allow: "POST" });
      }
      enforceSameOrigin(request);
      // Same pre-serialized body contract as GET /api/session; never re-stringified.
      return new Response(await session().restore(identity), {
        status: 200,
        headers: JSON_HEADERS,
      });
    default:
      return errorResponse(404, "not_found");
  }
}

const fetchHandler: ExportedHandlerFetchHandler<AppEnv> = async (request, env) => {
  try {
    const identity = await authenticate(request, env);
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return await handleApi(request, env, identity, pathname);
    }
    // Everything else is the native UI, served only after authentication.
    return env.ASSETS.fetch(request);
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.status, error.error);
    }
    // SessionApiError crosses the DO RPC boundary without its prototype:
    // match by name and read the serializable own props, so identity
    // mismatch (403) and busy/missing-checkpoint (409) keep honest statuses.
    if (error instanceof Error && error.name === "SessionApiError") {
      const { status, error: reason } = error as unknown as { status?: unknown; error?: unknown };
      if (typeof status === "number" && typeof reason === "string") {
        return errorResponse(status, reason);
      }
    }
    if (error instanceof BadRequestError) {
      return errorResponse(400, error.message);
    }
    // No token material ever reaches an Error here: tokens live in request
    // headers and are never copied into thrown messages or logs.
    console.error(
      "worker error:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    const message =
      error instanceof Error && error.message.length > 0 ? error.message : "internal_error";
    return errorResponse(500, message);
  }
};

export default {
  fetch: fetchHandler,
} satisfies ExportedHandler<AppEnv>;
