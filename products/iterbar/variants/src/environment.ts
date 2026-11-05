import { VARIANT_URL_PARAM } from "iterbar";

/** The subset of the Web Storage API the registry uses. */
export interface VariantStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Where the registry reads and writes selections. Every method may throw (for example, local storage in
 * a sandboxed iframe); the registry treats a throw as "no value" and never lets it escape.
 */
export interface VariantsEnvironment {
  /** The current query string, such as `?iterbar=pricing:v2`; empty when there is none. */
  readSearch(): string;
  /** Replaces the query string in place, without a reload or a new history entry. Optional. */
  replaceSearch?(search: string): void;
  /** Local storage, or `null` when the page has none. */
  storage(): VariantStorage | null;
}

interface BrowserLike {
  location?: { search?: string; pathname?: string; hash?: string };
  history?: { state?: unknown; replaceState?(state: unknown, unused: string, url?: string): void };
  localStorage?: VariantStorage;
}

/** Reads and writes the page's own URL and local storage. Missing browser APIs read as empty. */
export function browserEnvironment(target: object = globalThis): VariantsEnvironment {
  const page = target as BrowserLike;
  return {
    readSearch: () => page.location?.search ?? "",
    replaceSearch: (search) => {
      const { location, history } = page;
      if (!location || typeof history?.replaceState !== "function") return;
      history.replaceState(history.state, "", `${location.pathname ?? ""}${search}${location.hash ?? ""}`);
    },
    storage: () => page.localStorage ?? null,
  };
}

/** The raw value of the first `iterbar` parameter in `search`, as `URLSearchParams.get` reads it. */
export function readVariantParam(search: string): string | null {
  return new URLSearchParams(search).get(VARIANT_URL_PARAM);
}

function decodeKey(part: string): string | null {
  const separator = part.indexOf("=");
  try {
    return decodeURIComponent((separator === -1 ? part : part.slice(0, separator)).replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Returns `search` with the first `iterbar` parameter set to `value`, appending it when absent. Every other
 * parameter keeps its exact original text. `value` must already be URL-safe: slot and version names and
 * the `:` and `,` separators are.
 */
export function withVariantParam(search: string, value: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const parts = query ? query.split("&") : [];
  const entry = `${VARIANT_URL_PARAM}=${value}`;
  const index = parts.findIndex((part) => decodeKey(part) === VARIANT_URL_PARAM);
  if (index === -1) parts.push(entry);
  else parts[index] = entry;
  return `?${parts.join("&")}`;
}
