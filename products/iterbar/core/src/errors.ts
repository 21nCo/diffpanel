import type { z } from "zod";

/** The only protocol major version this package reads and writes. */
export const SCHEMA_VERSION = 1 as const;

/** Protocol major versions this package can read. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = Object.freeze([SCHEMA_VERSION]);

/** Stable machine-readable codes carried by every {@link IterbarContractError}. */
export type IterbarContractErrorCode =
  | "invalid_message"
  | "unsupported_schema_version"
  | "invalid_path_segment"
  | "invalid_project_root";

const contractErrorCodes: ReadonlySet<string> = new Set<IterbarContractErrorCode>([
  "invalid_message",
  "unsupported_schema_version",
  "invalid_path_segment",
  "invalid_project_root",
]);

/** Base class for every error this package throws on purpose. Match on `code`, not on the class, across bundles. */
export class IterbarContractError extends Error {
  readonly code: IterbarContractErrorCode;

  constructor(code: IterbarContractErrorCode, message: string) {
    super(message);
    this.name = "IterbarContractError";
    this.code = code;
  }
}

/** A message declared a protocol major version this reader does not understand. */
export class UnsupportedSchemaVersionError extends IterbarContractError {
  readonly receivedVersion: number;
  readonly supportedVersions: readonly number[] = SUPPORTED_SCHEMA_VERSIONS;

  constructor(label: string, receivedVersion: number) {
    super(
      "unsupported_schema_version",
      `${label} uses schemaVersion ${receivedVersion}; this reader supports ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.receivedVersion = receivedVersion;
  }
}

/** A message with a supported (or missing) version that does not match its schema. */
export class InvalidMessageError extends IterbarContractError {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super("invalid_message", `Invalid ${label}: ${issues.join("; ")}`);
    this.name = "InvalidMessageError";
    this.issues = Object.freeze([...issues]);
  }
}

/** True for any error raised by this package, including copies loaded from another bundle. */
export function isIterbarContractError(error: unknown): error is IterbarContractError {
  return error instanceof IterbarContractError
    || (error instanceof Error && contractErrorCodes.has((error as { code?: unknown }).code as string));
}

export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: IterbarContractError };

/**
 * Rejects an object whose `schemaVersion` is a different positive integer major version before any
 * shape check, so a newer writer's message is never half-read as v1. Missing or malformed versions are
 * left to the schema, which reports them as an invalid message.
 */
export function assertSupportedSchemaVersion(input: unknown, label = "message"): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  // `in`, not an own-property check: the schema reads inherited properties too, so the version check must.
  if (!("schemaVersion" in input)) return;
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && Number.isSafeInteger(version) && version >= 1
    && !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    throw new UnsupportedSchemaVersionError(label, version);
  }
}

/**
 * Reads a versioned protocol message. Throws {@link UnsupportedSchemaVersionError} for another major
 * version and {@link InvalidMessageError} for anything else that does not match `schema`. Unknown
 * properties are dropped, so additive v1 fields from a newer writer are tolerated.
 */
export function parseMessage<S extends z.ZodType>(schema: S, input: unknown, label = "message"): z.output<S> {
  assertSupportedSchemaVersion(input, label);
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidMessageError(label, result.error.issues.map((issue) =>
      `${[label, ...issue.path.map(String)].join(".")}: ${issue.message}`));
  }
  return result.data;
}

/** {@link parseMessage} for JSON text; malformed JSON is an invalid message. */
export function parseMessageJson<S extends z.ZodType>(schema: S, text: string, label = "message"): z.output<S> {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new InvalidMessageError(label, [`${label}: not valid JSON (${(error as Error).message})`]);
  }
  return parseMessage(schema, input, label);
}

/** Non-throwing {@link parseMessage}. */
export function safeParseMessage<S extends z.ZodType>(
  schema: S,
  input: unknown,
  label = "message",
): ParseResult<z.output<S>> {
  try {
    return { success: true, data: parseMessage(schema, input, label) };
  } catch (error) {
    if (isIterbarContractError(error)) return { success: false, error };
    throw error;
  }
}
