import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { DAEMON_HOST } from "iterbar";
import { DaemonHttpError, invalidRequest, unauthorized } from "./http.js";

/** Most origins the allow-list holds; each `POST /origins` adds at most 32. */
export const MAX_ALLOWED_ORIGINS = 256;

/** How long a browser may cache an allowed preflight, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** Origins whose pages may call the daemon from a browser, registered through `POST /origins`. */
export class OriginAllowList {
  readonly #origins = new Set<string>();

  has(origin: string): boolean {
    return this.#origins.has(origin);
  }

  /** Adds already-validated origins; refuses the whole request when the list would exceed its bound. */
  add(origins: readonly string[]): string[] {
    const added = origins.filter((origin) => !this.#origins.has(origin));
    if (this.#origins.size + new Set(added).size > MAX_ALLOWED_ORIGINS) {
      throw invalidRequest(`At most ${MAX_ALLOWED_ORIGINS} origins can be registered`);
    }
    for (const origin of added) this.#origins.add(origin);
    return this.list();
  }

  list(): string[] {
    return [...this.#origins];
  }
}

/** What every request is checked against: the address it must be sent to, the token and the allowed origins. */
export interface AccessPolicy {
  readonly port: number;
  readonly token: string;
  readonly origins: OriginAllowList;
}

/** The outcome of an access check, with the CORS headers that the response carries either way. */
export type AccessDecision =
  | { readonly allowed: true; readonly headers: OutgoingHttpHeaders }
  | { readonly allowed: false; readonly error: DaemonHttpError; readonly headers: OutgoingHttpHeaders };

const forbiddenHost = () =>
  new DaemonHttpError(403, "forbidden_origin", `Requests must be addressed to ${DAEMON_HOST} and the daemon's port`);

const forbiddenOrigin = () =>
  new DaemonHttpError(403, "forbidden_origin", "Browser requests must come from an origin registered with POST /origins");

/**
 * True when the request names this daemon's own address. Any other `Host` (a DNS-rebound name, `localhost`,
 * another port) is refused, so a page that rebinds its own host name to 127.0.0.1 cannot reach the daemon.
 */
function addressedToDaemon(headers: IncomingHttpHeaders, port: number): boolean {
  return headers.host === `${DAEMON_HOST}:${port}`;
}

/**
 * True for a request a browser sent. Browsers send `Origin` on every cross-origin request and WebSocket, and
 * `Sec-Fetch-Site` on every request to a loopback address. Non-browser clients (the MCP server, the CLI, Node.js
 * `fetch` and `WebSocket`) send neither, and authenticate by token alone.
 */
function isBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return headers.origin !== undefined || headers["sec-fetch-site"] !== undefined;
}

/** Compares a presented token with the daemon's in constant time. */
function tokenMatches(presented: string | null, token: string): boolean {
  if (presented === null) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** CORS headers that let an allowed page read the response; none for any other origin. */
function corsHeaders(headers: IncomingHttpHeaders, policy: AccessPolicy): OutgoingHttpHeaders {
  const { origin } = headers;
  return origin !== undefined && policy.origins.has(origin) ? { "access-control-allow-origin": origin } : {};
}

/**
 * Checks a request or WebSocket upgrade, in order: the `Host` must be this daemon's address (403), the token
 * must match (401, the same for every path and method, so nothing is revealed about what exists), and a browser
 * request must come from an allowed origin (403).
 */
export function authorize(headers: IncomingHttpHeaders, presentedToken: string | null, policy: AccessPolicy): AccessDecision {
  if (!addressedToDaemon(headers, policy.port)) return { allowed: false, error: forbiddenHost(), headers: {} };
  const cors = corsHeaders(headers, policy);
  if (!tokenMatches(presentedToken, policy.token)) return { allowed: false, error: unauthorized(), headers: cors };
  if (isBrowserRequest(headers) && cors["access-control-allow-origin"] === undefined) {
    return { allowed: false, error: forbiddenOrigin(), headers: {} };
  }
  return { allowed: true, headers: cors };
}

/** True for a CORS preflight, which browsers send without credentials before a request that carries the token. */
export function isPreflight(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  return method === "OPTIONS" && headers.origin !== undefined && headers["access-control-request-method"] !== undefined;
}

/**
 * Answers a CORS preflight. A preflight cannot carry the token, so it performs nothing and reveals nothing: the
 * answer is the same for every path. Only an allowed origin on the daemon's own address gets the CORS grant.
 */
export function authorizePreflight(headers: IncomingHttpHeaders, policy: AccessPolicy): AccessDecision {
  if (!addressedToDaemon(headers, policy.port)) return { allowed: false, error: forbiddenHost(), headers: {} };
  const cors = corsHeaders(headers, policy);
  if (cors["access-control-allow-origin"] === undefined) return { allowed: false, error: forbiddenOrigin(), headers: {} };
  return {
    allowed: true,
    headers: {
      ...cors,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
      // Chrome's Private Network Access preflight, for a dev server reached through a LAN address.
      ...(headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {}),
    },
  };
}
