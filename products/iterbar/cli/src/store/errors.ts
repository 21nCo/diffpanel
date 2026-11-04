import type { StoreLock } from "iterbar";

/**
 * Stable machine-readable codes of {@link IterbarStoreError}. `store_locked`, `not_found`, `invalid_request` and
 * `payload_too_large` match the daemon error codes of the same name.
 */
export type IterbarStoreErrorCode =
  | "store_locked"
  | "lock_lost"
  | "store_closed"
  | "not_found"
  | "invalid_request"
  | "payload_too_large"
  | "corrupt_store";

const storeErrorCodes: ReadonlySet<string> = new Set<IterbarStoreErrorCode>([
  "store_locked",
  "lock_lost",
  "store_closed",
  "not_found",
  "invalid_request",
  "payload_too_large",
  "corrupt_store",
]);

/** Base class for every error the store throws on purpose. Match on `code`, not on the class, across bundles. */
export class IterbarStoreError extends Error {
  readonly code: IterbarStoreErrorCode;

  constructor(code: IterbarStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IterbarStoreError";
    this.code = code;
  }
}

/** Another live process owns `.iterbar/store.lock`. */
export class StoreLockedError extends IterbarStoreError {
  /** The owner's lock, or `null` when the lock kept changing while this process tried to acquire it. */
  readonly owner: StoreLock | null;

  constructor(lockFile: string, owner: StoreLock | null) {
    super(
      "store_locked",
      owner
        ? `${lockFile} is held by process ${owner.pid} (started ${owner.startedAt}); stop it or use its daemon`
        : `${lockFile} is being acquired by another process`,
    );
    this.name = "StoreLockedError";
    this.owner = owner;
  }
}

/** True for any error raised by the store, including copies loaded from another bundle. */
export function isIterbarStoreError(error: unknown): error is IterbarStoreError {
  return error instanceof IterbarStoreError
    || (error instanceof Error && storeErrorCodes.has((error as { code?: unknown }).code as string));
}

/** The Node.js `code` of a system error, or `undefined`. */
export function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
