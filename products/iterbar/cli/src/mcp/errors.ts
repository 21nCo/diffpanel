import type { DaemonErrorCode } from "iterbar";

/**
 * The `error.code` of a failed Iterbar tool call. `daemon_unavailable` means no daemon serves the project (or the
 * one described by `daemon.json` is gone); every other code is the daemon's own, passed through.
 */
export type IterbarToolErrorCode = "daemon_unavailable" | DaemonErrorCode;

export interface IterbarToolErrorOptions extends ErrorOptions {
  /** Fields reported next to `error`, such as the `cursor` a failed wait resumes from. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A tool failure the agent can act on; reported as an MCP tool error carrying `{ error: { code, message } }` and any
 * `details`.
 */
export class IterbarToolError extends Error {
  readonly code: IterbarToolErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: IterbarToolErrorCode, message: string, options: IterbarToolErrorOptions = {}) {
    super(message, options);
    this.name = "IterbarToolError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** What every `daemon_unavailable` message ends with. */
export const START_DAEMON_HINT = "Run `iterbar dev` in the project root to start the daemon, then call the tool again.";

export function daemonUnavailable(reason: string, options?: ErrorOptions): IterbarToolError {
  return new IterbarToolError("daemon_unavailable", `${reason} ${START_DAEMON_HINT}`, options);
}
