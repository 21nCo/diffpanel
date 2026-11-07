import { readVariantParam, withVariantParam } from "@iterbar/variants";
import {
  formatVariantParam,
  parseVariantParam,
  readPageApi,
  registrySnapshotSchema,
  safeParseMessage,
  SCHEMA_VERSION,
  VARIANT_URL_PARAM,
  type IterbarPageApi,
  type RegistrySnapshot,
  type SlotState,
} from "iterbar";
import { h } from "./dom.js";

/** How often the bar looks for `window.__ITERBAR__` until a registry installs it. */
const PAGE_API_POLL_MS = 500;

/** Most registry warnings listed; the rest are counted. */
const MAX_SHOWN_WARNINGS = 5;

/**
 * `search` with the `iterbar` parameter naming `version` for `slot`: an existing entry for the slot is replaced in
 * place, otherwise one is appended. Other entries and every other parameter are kept; malformed entries are dropped,
 * as the registry drops them. Returns `null` when the selections cannot be written (too many slots).
 */
export function searchWithSelection(search: string, slot: string, version: string): string | null {
  const selections = parseVariantParam(readVariantParam(search)).selections;
  const updated = selections.some((entry) => entry.slot === slot)
    ? selections.map((entry) => (entry.slot === slot ? { slot, version } : entry))
    : [...selections, { slot, version }];
  try {
    return withVariantParam(search, formatVariantParam(updated));
  } catch {
    return null;
  }
}

function isVariantPair(pair: string): boolean {
  const separator = pair.indexOf("=");
  try {
    return decodeURIComponent((separator === -1 ? pair : pair.slice(0, separator)).replaceAll("+", " ")) === VARIANT_URL_PARAM;
  } catch {
    return false;
  }
}

/**
 * The URL a page's slot report is filed under: without the fragment or the `iterbar` parameter, which switching
 * changes. The rest of the query keeps its exact text, empty segments included, since the daemon files reports by
 * the exact URL.
 */
export function reportPageUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  url.hash = "";
  // The serialized URL has only one "?" before its query, since the path cannot contain one unescaped.
  const serialized = url.href;
  const start = serialized.indexOf("?");
  if (start === -1) return serialized;
  // A query left empty (a bare "?", or only the iterbar parameter) is dropped, so switching never changes the URL.
  const query = serialized.slice(start + 1).split("&").filter((pair) => !isVariantPair(pair)).join("&");
  return query ? `${serialized.slice(0, start)}?${query}` : serialized.slice(0, start);
}

function writeSelectionToUrl(slot: string, version: string): void {
  try {
    const search = searchWithSelection(location.search, slot, version);
    if (search === null || search === location.search) return;
    history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  } catch {
    // A router or sandbox may refuse history changes; the switch itself already applied.
  }
}

export interface SlotsPanelOptions {
  /** Called with every snapshot the registry delivers, so the bar can report the page's slots. */
  readonly onSlots: (slots: readonly SlotState[]) => void;
}

/**
 * The page's slots and their versions, read from and switched through the `window.__ITERBAR__` page API. With more
 * than one slot a dropdown chooses which slot's versions are shown.
 */
export class SlotsPanel {
  readonly element: HTMLElement;
  readonly #options: SlotsPanelOptions;
  readonly #message = h("p", { class: "muted", "data-role": "slots-message" });
  readonly #single = h("p", { class: "slot-name", "data-role": "slot-name", hidden: true });
  readonly #select = h("select", { id: "iterbar-slot-select", "data-role": "slot-select" });
  readonly #picker = h("div", { class: "field", hidden: true },
    h("label", { for: "iterbar-slot-select" }, "Slot"), this.#select);
  readonly #versions = h("div", { class: "versions", role: "group", "data-role": "versions", hidden: true });
  readonly #warnings = h("ul", { class: "warnings", "data-role": "warnings", hidden: true });
  #api: IterbarPageApi | null = null;
  #unsubscribe: (() => void) | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #snapshot: RegistrySnapshot | null = null;
  #selectedSlot: string | null = null;
  #slotKey = "";
  #versionsKey = "";

  constructor(options: SlotsPanelOptions) {
    this.#options = options;
    this.element = h("section", { class: "section", "data-section": "slots" },
      h("h2", { class: "section-title" }, "Slots"), this.#message, this.#single, this.#picker, this.#versions, this.#warnings);
    this.#select.addEventListener("change", () => {
      this.#selectedSlot = this.#select.value;
      this.#render();
    });
  }

  /** Starts following the page API, waiting for it when no registry is installed yet. */
  attach(): void {
    if (this.#api || this.#poll) return;
    if (!this.#connect()) {
      this.#poll = setInterval(() => {
        if (this.#connect() && this.#poll) {
          clearInterval(this.#poll);
          this.#poll = null;
        }
      }, PAGE_API_POLL_MS);
    }
  }

  detach(): void {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#api = null;
  }

  /** Returns true once there is nothing more to wait for: the API was found, or it is unusable. */
  #connect(): boolean {
    let api: IterbarPageApi | null;
    try {
      api = readPageApi(globalThis);
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry is not compatible with this bar: ${(error as Error).message}`);
      return true;
    }
    if (!api) {
      this.#showMessage("No Iterbar variants on this page.");
      return false;
    }
    this.#api = api;
    try {
      this.#unsubscribe = api.subscribe((snapshot) => this.#update(snapshot));
      this.#update(api.getSnapshot());
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry failed: ${(error as Error).message}`);
    }
    return true;
  }

  /**
   * Applies a snapshot from the page. One that does not match the v1 contract is shown as an error, and the page is
   * then reported to have no slots, since nothing it showed before can be trusted.
   */
  #update(input: unknown): void {
    const parsed = safeParseMessage(registrySnapshotSchema, input, "registry snapshot");
    if (!parsed.success) {
      this.#snapshot = null;
      this.#warnings.hidden = true;
      this.#warnings.replaceChildren();
      this.#options.onSlots([]);
      this.#showMessage(`The page's Iterbar registry sent an invalid snapshot: ${parsed.error.message}`);
      return;
    }
    this.#snapshot = parsed.data;
    this.#options.onSlots(parsed.data.slots);
    this.#render();
  }

  #showMessage(text: string): void {
    this.#message.textContent = text;
    this.#message.hidden = false;
    this.#single.hidden = true;
    this.#picker.hidden = true;
    this.#versions.hidden = true;
  }

  #render(): void {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    this.#renderWarnings(snapshot);
    const { slots } = snapshot;
    if (slots.length === 0) {
      this.#showMessage("No slots on this page.");
      return;
    }
    this.#message.hidden = true;
    const slot = slots.find((entry) => entry.slot === this.#selectedSlot) ?? slots[0]!;
    this.#selectedSlot = slot.slot;

    this.#single.hidden = slots.length !== 1;
    this.#picker.hidden = slots.length === 1;
    this.#single.replaceChildren("Slot ", h("strong", {}, slot.slot));
    const slotKey = JSON.stringify(slots.map((entry) => entry.slot));
    if (slotKey !== this.#slotKey) {
      this.#slotKey = slotKey;
      this.#select.replaceChildren(...slots.map((entry) => h("option", { value: entry.slot }, entry.slot)));
    }
    this.#select.value = slot.slot;
    this.#renderVersions(slot);
  }

  #renderVersions(slot: SlotState): void {
    this.#versions.hidden = false;
    this.#versions.setAttribute("aria-label", `Versions of ${slot.slot}`);
    const key = JSON.stringify([slot.slot, slot.versions, slot.defaultVersion]);
    if (key !== this.#versionsKey) {
      this.#versionsKey = key;
      this.#versions.replaceChildren(...slot.versions.map((version) => {
        const button = h("button", { type: "button", class: "version", "data-version": version },
          version, version === slot.defaultVersion ? h("span", { class: "muted" }, " (default)") : null);
        button.addEventListener("click", () => this.#choose(slot.slot, version));
        return button;
      }));
    }
    for (const button of this.#versions.querySelectorAll<HTMLButtonElement>("button[data-version]")) {
      button.setAttribute("aria-pressed", String(button.dataset.version === slot.activeVersion));
    }
  }

  #renderWarnings(snapshot: RegistrySnapshot): void {
    const shown = snapshot.warnings.slice(0, MAX_SHOWN_WARNINGS);
    const rest = snapshot.warnings.length - shown.length;
    this.#warnings.hidden = shown.length === 0;
    this.#warnings.replaceChildren(
      ...shown.map((warning) => h("li", {}, warning.message)),
      ...(rest > 0 ? [h("li", {}, `${rest} more warnings.`)] : []),
    );
  }

  /** Switches through the page API and, once the registry shows the version, records it in the `iterbar` URL parameter. */
  #choose(slot: string, version: string): void {
    const api = this.#api;
    if (!api) return;
    try {
      api.select({ schemaVersion: SCHEMA_VERSION, slot, version });
      const applied = api.getSnapshot().slots.find((entry) => entry.slot === slot)?.activeVersion === version;
      if (applied) writeSelectionToUrl(slot, version);
    } catch (error) {
      this.#showMessage(`The page's Iterbar registry failed: ${(error as Error).message}`);
    }
  }
}
