import {
  formatVariantParam,
  InvalidMessageError,
  PAGE_API_GLOBAL,
  parseMessage,
  parseVariantParam,
  SCHEMA_VERSION,
  slotStateSchema,
  VARIANT_STORAGE_KEY,
  variantSelectionSchema,
  type ActiveVariant,
  type IterbarPageApi,
  type ParsedVariantParam,
  type RegistrySnapshot,
  type RegistryWarning,
} from "iterbar";
import {
  browserEnvironment,
  readVariantParam,
  withVariantParam,
  type VariantsEnvironment,
} from "./environment.js";

/** Most slots one page may register, matching the snapshot contract. */
export const MAX_SLOTS = 256;

/** Most warnings a snapshot carries, matching the snapshot contract. */
const MAX_WARNINGS = 256;

/** Rejected `select()` calls the registry remembers; older ones are dropped first. */
const MAX_API_WARNINGS = 32;

/**
 * Drops the earliest selections other than `slot`'s until at most {@link MAX_SLOTS} remain, the most a URL
 * parameter or stored value may hold. Local storage is shared by every page of the origin, so it can
 * collect selections for more slots than one page mounts; the newest choice must still be saved.
 */
function withinSelectionLimit(selections: readonly ActiveVariant[], slot: string): ActiveVariant[] {
  let excess = selections.length - MAX_SLOTS;
  return selections.filter((entry) => {
    if (excess <= 0 || entry.slot === slot) return true;
    excess -= 1;
    return false;
  });
}

/** One slot as a component declares it. */
export interface SlotDefinition {
  readonly slot: string;
  /** Version names in display order; unique, 1-64 of them. */
  readonly versions: readonly string[];
  readonly defaultVersion: string;
}

interface SlotRecord {
  readonly definition: SlotDefinition;
  activeVersion: string;
  mounts: number;
  /** Why the active version is the default even though the URL or storage named another one. */
  warnings: RegistryWarning[];
}

type SelectionSource = "url" | "storage";

export interface VariantsRegistryOptions {
  /** Where selections are read from and remembered. Defaults to the global `location`, `history` and `localStorage`. */
  readonly environment?: VariantsEnvironment;
}

/**
 * Throws `invalid_message` unless `definition` names a valid slot with 1-64 unique valid versions that
 * include the default. Returns a copy that later changes to the caller's arrays cannot affect.
 */
export function validateSlotDefinition(definition: SlotDefinition): SlotDefinition {
  const state = parseMessage(slotStateSchema, {
    slot: definition?.slot,
    versions: definition?.versions,
    defaultVersion: definition?.defaultVersion,
    activeVersion: definition?.defaultVersion,
    mounts: 1,
  }, "slot definition");
  return Object.freeze({
    slot: state.slot,
    versions: Object.freeze([...state.versions]),
    defaultVersion: state.defaultVersion,
  });
}

function sameDefinition(left: SlotDefinition, right: SlotDefinition): boolean {
  return left.defaultVersion === right.defaultVersion
    && left.versions.length === right.versions.length
    && left.versions.every((version, index) => right.versions[index] === version);
}

function warning(
  code: RegistryWarning["code"],
  source: RegistryWarning["source"],
  value: string,
  message: string,
): RegistryWarning {
  return { code, source, value: value.slice(0, 1024), message };
}

const SOURCE_LABEL: Record<RegistryWarning["source"], string> = {
  url: "the iterbar URL parameter",
  storage: "stored selections",
  api: "select()",
};

function describe(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function reportListenerError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}

/**
 * The slots rendered on one page and the version each one shows. A slot's version is chosen when its first
 * instance registers: the `iterbar` URL parameter wins, then the stored selection, then the default. A URL
 * or stored version the slot does not have falls back to the default and is reported as a warning.
 */
export class VariantsRegistry {
  readonly #environment: VariantsEnvironment;
  readonly #slots = new Map<string, SlotRecord>();
  readonly #listeners = new Set<() => void>();
  #apiWarnings: RegistryWarning[] = [];

  /** The `window.__ITERBAR__` object for this registry; see {@link installPageApi}. */
  readonly pageApi: IterbarPageApi;

  constructor(options: VariantsRegistryOptions = {}) {
    this.#environment = options.environment ?? browserEnvironment();
    const pageApi: IterbarPageApi = {
      schemaVersion: SCHEMA_VERSION,
      getSnapshot: () => this.getSnapshot(),
      select: (selection) => this.select(selection),
      subscribe: (listener) => {
        if (typeof listener !== "function") throw new TypeError("subscribe(listener) needs a function");
        return this.subscribe(() => listener(this.getSnapshot()));
      },
    };
    this.pageApi = Object.freeze(pageApi);
  }

  /**
   * Counts one mounted instance of `definition.slot` and returns its idempotent unregister function. The
   * first instance decides the slot's versions and default; a later instance that declares different ones
   * is logged and shares the first one's state. Throws `invalid_message` for an invalid definition or
   * when the page already has {@link MAX_SLOTS} slots.
   */
  register(definition: SlotDefinition): () => void {
    const valid = validateSlotDefinition(definition);
    let record = this.#slots.get(valid.slot);
    if (record) {
      record.mounts += 1;
      if (!sameDefinition(record.definition, valid)) {
        console.warn(
          `Iterbar slot "${valid.slot}" is mounted with different versions or default; `
          + "every instance follows the first one's selection.",
        );
      }
    } else {
      if (this.#slots.size >= MAX_SLOTS) {
        throw new InvalidMessageError("slot definition", [`a page may register at most ${MAX_SLOTS} slots`]);
      }
      const resolved = this.#resolve(valid);
      record = { definition: valid, activeVersion: resolved.version, mounts: 1, warnings: resolved.warnings };
      this.#slots.set(valid.slot, record);
    }
    this.#notify();

    const registered = record;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#slots.get(registered.definition.slot) !== registered) return;
      registered.mounts -= 1;
      if (registered.mounts === 0) this.#slots.delete(registered.definition.slot);
      this.#notify();
    };
  }

  /**
   * The version an instance declaring `definition` should render now, without registering it: the slot's
   * active version when it is registered and `definition` has that version, its own default when it does
   * not, and otherwise what registering would choose.
   */
  activeVersion(definition: SlotDefinition): string {
    const record = this.#slots.get(definition.slot);
    if (!record) return this.#resolve(definition).version;
    return definition.versions.includes(record.activeVersion) ? record.activeVersion : definition.defaultVersion;
  }

  /**
   * Switches a registered slot to one of its versions and remembers the choice in local storage and, when
   * the URL already names the slot, in the URL. Unknown slots or versions and malformed selections are
   * recorded as `source: "api"` warnings and leave every slot unchanged. Never throws.
   */
  select(selection: unknown): void {
    const parsed = variantSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      this.#rejectSelection(warning(
        "invalid_selection", "api", describe(selection),
        "select() needs { schemaVersion: 1, slot, version } with valid names.",
      ));
      return;
    }
    const { slot, version } = parsed.data;
    const record = this.#slots.get(slot);
    if (!record) {
      this.#rejectSelection(warning("unknown_slot", "api", `${slot}:${version}`, `No slot named "${slot}" is mounted.`));
      return;
    }
    if (!record.definition.versions.includes(version)) {
      this.#rejectSelection(warning(
        "unknown_version", "api", `${slot}:${version}`, `Slot "${slot}" has no version "${version}".`,
      ));
      return;
    }
    // Remembering the choice can also drop malformed URL or stored entries, which changes the warnings; so
    // compare whole snapshots rather than only the slot's own state.
    const before = JSON.stringify(this.getSnapshot());
    this.#remember(record.definition, version);
    record.activeVersion = version;
    record.warnings = [];
    if (JSON.stringify(this.getSnapshot()) !== before) this.#notify();
  }

  /** Calls `listener` after every change to slots, selections or warnings; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    const entry = () => listener();
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /** A new snapshot of the mounted slots and of every selection the registry could not honour. */
  getSnapshot(): RegistrySnapshot {
    const warnings: RegistryWarning[] = [];
    const url = this.#read("url");
    for (const entry of url.invalid) {
      warnings.push(warning("invalid_selection", "url", entry, "Ignored a malformed entry in the iterbar URL parameter."));
    }
    for (const { slot, version } of url.selections) {
      if (!this.#slots.has(slot)) {
        warnings.push(warning("unknown_slot", "url", `${slot}:${version}`, `No slot named "${slot}" is mounted.`));
      }
    }
    for (const record of this.#slots.values()) warnings.push(...record.warnings);
    for (const entry of this.#read("storage").invalid) {
      warnings.push(warning("invalid_selection", "storage", entry, "Ignored a malformed stored selection."));
    }
    warnings.push(...this.#apiWarnings);
    return {
      schemaVersion: SCHEMA_VERSION,
      slots: [...this.#slots.values()].map(({ definition, activeVersion, mounts }) => ({
        slot: definition.slot,
        versions: [...definition.versions],
        defaultVersion: definition.defaultVersion,
        activeVersion,
        mounts,
      })),
      warnings: warnings.slice(0, MAX_WARNINGS).map((entry) => ({ ...entry })),
    };
  }

  #resolve(definition: SlotDefinition): { version: string; warnings: RegistryWarning[] } {
    for (const source of ["url", "storage"] as const) {
      const selection = this.#read(source).selections.find((entry) => entry.slot === definition.slot);
      if (!selection) continue;
      if (definition.versions.includes(selection.version)) return { version: selection.version, warnings: [] };
      return {
        version: definition.defaultVersion,
        warnings: [warning(
          "unknown_version", source, `${selection.slot}:${selection.version}`,
          `Slot "${selection.slot}" has no version "${selection.version}" (from ${SOURCE_LABEL[source]}); `
          + `showing "${definition.defaultVersion}".`,
        )],
      };
    }
    return { version: definition.defaultVersion, warnings: [] };
  }

  #read(source: SelectionSource): ParsedVariantParam {
    return parseVariantParam(source === "url" ? this.#readUrlValue() : this.#readStoredValue());
  }

  #readUrlValue(): string | null {
    try {
      return readVariantParam(this.#environment.readSearch());
    } catch {
      return null;
    }
  }

  #readStoredValue(): string | null {
    try {
      return this.#environment.storage()?.getItem(VARIANT_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Stores `version` (or forgets the slot when it is the default) and rewrites the URL entry for the slot
   * when there is one, so a reload keeps showing the selected version. Failures are ignored: the switch
   * still applies to this page.
   */
  #remember(definition: SlotDefinition, version: string): void {
    const { slot } = definition;
    try {
      const storage = this.#environment.storage();
      if (storage) {
        const others = this.#read("storage").selections.filter((entry) => entry.slot !== slot);
        const kept = version === definition.defaultVersion ? others : [...others, { slot, version }];
        const stored = formatVariantParam(withinSelectionLimit(kept, slot));
        if (stored) storage.setItem(VARIANT_STORAGE_KEY, stored);
        else storage.removeItem(VARIANT_STORAGE_KEY);
      }
    } catch {
      // Storage may be unavailable or full; the in-page switch does not depend on it.
    }
    try {
      const url = this.#read("url").selections;
      if (this.#environment.replaceSearch && url.some((entry) => entry.slot === slot)) {
        const updated = url.map((entry) => entry.slot === slot ? { ...entry, version } : entry);
        const value = formatVariantParam(withinSelectionLimit(updated, slot));
        this.#environment.replaceSearch(withVariantParam(this.#environment.readSearch(), value));
      }
    } catch {
      // The URL is best effort too; a router may refuse history changes.
    }
  }

  #rejectSelection(entry: RegistryWarning): void {
    this.#apiWarnings = [...this.#apiWarnings, entry].slice(-MAX_API_WARNINGS);
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}

/** Creates a registry that is not installed anywhere; see {@link getVariantsRegistry} for the page's shared one. */
export function createVariantsRegistry(options: VariantsRegistryOptions = {}): VariantsRegistry {
  return new VariantsRegistry(options);
}

/**
 * Sets `target.__ITERBAR__` to the registry's page API. Returns false, and leaves the existing value, when
 * another object already occupies the name.
 */
export function installPageApi(registry: VariantsRegistry, target: object = globalThis): boolean {
  const holder = target as Record<string, unknown>;
  const existing = holder[PAGE_API_GLOBAL];
  if (existing === registry.pageApi) return true;
  if (existing !== undefined) {
    console.warn(`Iterbar: window.${PAGE_API_GLOBAL} is already set; the variants registry did not replace it.`);
    return false;
  }
  Object.defineProperty(holder, PAGE_API_GLOBAL, {
    value: registry.pageApi,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return true;
}

const SHARED_REGISTRY = Symbol.for("iterbar.variants.registry.v1");

/**
 * The page's shared registry, created on first use with the browser environment and installed as
 * `window.__ITERBAR__`. Copies of this package loaded by different bundles share it through a global symbol.
 */
export function getVariantsRegistry(): VariantsRegistry {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[SHARED_REGISTRY];
  if (existing instanceof VariantsRegistry || isRegistryLike(existing)) return existing as VariantsRegistry;
  const registry = new VariantsRegistry();
  Object.defineProperty(holder, SHARED_REGISTRY, { value: registry, configurable: true, enumerable: false });
  installPageApi(registry);
  return registry;
}

function isRegistryLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof VariantsRegistry, unknown>>;
  return typeof candidate.register === "function" && typeof candidate.activeVersion === "function"
    && typeof candidate.subscribe === "function" && typeof candidate.pageApi === "object";
}
