import { z } from "zod";
import { IterbarContractError, SCHEMA_VERSION } from "./errors.js";

/** `schemaVersion: 1`, carried by every top-level Iterbar message and file. */
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);

/**
 * Lowercase only, so two valid ids never name the same directory on a case-insensitive filesystem, and
 * never a Windows device name (`con`, `nul`, `com1`, ...), which Windows reserves with any extension.
 */
const ID_PATTERN = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z0-9][a-z0-9_-]{0,127}$/;

/** True when `value` is a valid record id: safe to use as a single path segment or URL segment on every OS. */
export function isSafeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/**
 * Feedback, reply and attachment ids. They name directories and files under `.iterbar/` and URL path
 * segments, so they are restricted to 1-128 lowercase letters, digits, `_` and `-`, starting with a letter
 * or digit, and must not be a Windows device name.
 */
export const idSchema = z.string().regex(
  ID_PATTERN,
  "must be 1-128 lowercase letters, digits, '_' or '-', starting with a letter or digit, and not a Windows device name",
);

/** Throws `invalid_path_segment` unless `value` is a {@link isSafeId safe id}. */
export function assertSafeId(value: string, label = "id"): string {
  if (typeof value !== "string" || !isSafeId(value)) {
    throw new IterbarContractError("invalid_path_segment", `${label} ${JSON.stringify(value)} is not a safe Iterbar id`);
  }
  return value;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** True when `value` is a valid slot or version name. */
export function isVariantName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

const variantNameMessage = "must be 1-64 letters, digits, '_', '.' or '-', starting with a letter or digit";

/** Slot names. They never contain `:` or `,`, so the `iterbar` URL parameter stays unambiguous. */
export const slotNameSchema = z.string().regex(NAME_PATTERN, variantNameMessage);

/** Version names within a slot; same rules as slot names. */
export const versionNameSchema = z.string().regex(NAME_PATTERN, variantNameMessage);

/** ISO 8601 timestamp with `Z` or an explicit offset. */
export const timestampSchema = z.iso.datetime({ offset: true });

/** An `http:` or `https:` page URL. */
export const pageUrlSchema = z.url({ protocol: /^https?$/ }).max(8192);

/** True when `value` is exactly the serialized origin of an `http:` or `https:` URL (no path, query or trailing slash). */
export function isHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
}

/** A browser origin such as `http://localhost:5173`. */
export const originSchema = z.string().refine(isHttpOrigin, "must be an http(s) origin such as http://localhost:5173");

/** The daemon's per-start secret: 256 random bits as 64 lowercase hex characters. */
export const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

/** A lowercase hex SHA-256 digest. */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest");

/** A positive process id. */
export const pidSchema = z.number().int().positive();

/** True for a POSIX absolute path or a Windows drive or UNC absolute path, without NUL characters. */
export function isAbsolutePath(value: string): boolean {
  if (value.includes("\0")) return false;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** An absolute filesystem path. */
export const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolutePath, "must be an absolute path");
