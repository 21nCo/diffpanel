import {
  PAGE_API_GLOBAL,
  readPageApi,
  registrySnapshotSchema,
  VARIANT_STORAGE_KEY,
  type RegistrySnapshot,
} from "iterbar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserEnvironment,
  createVariantsRegistry,
  getVariantsRegistry,
  installPageApi,
  markSlotRoot,
  MAX_SLOTS,
  slotBoundaryAttributes,
  slotRootAttributes,
  withVariantParam,
  type SlotDefinition,
  type VariantsEnvironment,
  type VariantStorage,
} from "./index.js";

const pricing: SlotDefinition = { slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1" };
const hero: SlotDefinition = { slot: "hero", versions: ["a", "b"], defaultVersion: "a" };

class MemoryStorage implements VariantStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function page(search = "", stored?: string) {
  const storage = new MemoryStorage();
  if (stored !== undefined) storage.setItem(VARIANT_STORAGE_KEY, stored);
  const state = { search };
  const environment: VariantsEnvironment = {
    readSearch: () => state.search,
    replaceSearch: (next) => {
      state.search = next;
    },
    storage: () => storage,
  };
  return { state, storage, registry: createVariantsRegistry({ environment }) };
}

function select(registry: { pageApi: { select(selection: never): void } }, slot: string, version: string) {
  registry.pageApi.select({ schemaVersion: 1, slot, version } as never);
}

function slotOf(snapshot: RegistrySnapshot, slot: string) {
  return snapshot.slots.find((entry) => entry.slot === slot);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("version precedence", () => {
  it("prefers the URL, then local storage, then the default", () => {
    expect(page("?iterbar=pricing:v2", "pricing:v3").registry.activeVersion(pricing)).toBe("v2");
    expect(page("?other=1", "pricing:v3").registry.activeVersion(pricing)).toBe("v3");
    expect(page("", "hero:b").registry.activeVersion(pricing)).toBe("v1");

    const { registry } = page("?iterbar=hero:b,pricing:v3", "pricing:v2");
    registry.register(pricing);
    registry.register(hero);
    expect(registry.getSnapshot().slots).toEqual([
      { slot: "pricing", versions: ["v1", "v2", "v3"], defaultVersion: "v1", activeVersion: "v3", mounts: 1 },
      { slot: "hero", versions: ["a", "b"], defaultVersion: "a", activeVersion: "b", mounts: 1 },
    ]);
  });

  it("uses the last URL entry for a slot named twice", () => {
    expect(page("?iterbar=pricing:v2,pricing:v3").registry.activeVersion(pricing)).toBe("v3");
  });
});

describe("unknown and malformed selections", () => {
  it("falls back to the default for an unknown URL version and reports it, without consulting storage", () => {
    const { registry } = page("?iterbar=pricing:v9", "pricing:v2");
    expect(registry.activeVersion(pricing)).toBe("v1");
    registry.register(pricing);
    const snapshot = registrySnapshotSchema.parse(registry.getSnapshot());
    expect(slotOf(snapshot, "pricing")?.activeVersion).toBe("v1");
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ code: "unknown_version", source: "url", value: "pricing:v9" }),
    ]);
  });

  it("reports an unknown stored version and an unknown URL slot until that slot mounts", () => {
    const { registry } = page("?iterbar=hero:b", "pricing:v9");
    registry.register(pricing);
    expect(registry.getSnapshot().warnings).toEqual([
      expect.objectContaining({ code: "unknown_slot", source: "url", value: "hero:b" }),
      expect.objectContaining({ code: "unknown_version", source: "storage", value: "pricing:v9" }),
    ]);
    registry.register(hero);
    expect(registry.getSnapshot().warnings.map((entry) => entry.code)).toEqual(["unknown_version"]);
  });

  it("reports malformed URL and stored entries verbatim and still applies the valid ones", () => {
    const { registry } = page("?iterbar=pricing,pricing:v2,:x", "hero:b,b@d:v1");
    registry.register(pricing);
    registry.register(hero);
    const snapshot = registrySnapshotSchema.parse(registry.getSnapshot());
    expect(snapshot.slots.map((slot) => slot.activeVersion)).toEqual(["v2", "b"]);
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ code: "invalid_selection", source: "url", value: "pricing" }),
      expect.objectContaining({ code: "invalid_selection", source: "url", value: ":x" }),
      expect.objectContaining({ code: "invalid_selection", source: "storage", value: "b@d:v1" }),
    ]);
  });

  it("treats a throwing environment as empty instead of throwing", () => {
    const registry = createVariantsRegistry({
      environment: {
        readSearch: () => {
          throw new Error("no location");
        },
        replaceSearch: () => {
          throw new Error("no history");
        },
        storage: () => {
          throw new DOMException("denied", "SecurityError");
        },
      },
    });
    expect(registry.activeVersion(pricing)).toBe("v1");
    registry.register(pricing);
    expect(() => select(registry, "pricing", "v2")).not.toThrow();
    expect(slotOf(registry.getSnapshot(), "pricing")?.activeVersion).toBe("v2");
  });

  it("records rejected select() calls as api warnings and leaves the slot unchanged", () => {
    const { registry, storage } = page();
    registry.register(pricing);
    const listener = vi.fn();
    registry.subscribe(listener);
    select(registry, "missing", "v2");
    select(registry, "pricing", "v9");
    registry.pageApi.select({ schemaVersion: 2, slot: "pricing", version: "v2" } as never);
    registry.pageApi.select("pricing:v2" as never);
    const snapshot = registrySnapshotSchema.parse(registry.getSnapshot());
    expect(slotOf(snapshot, "pricing")?.activeVersion).toBe("v1");
    expect(snapshot.warnings.map(({ code, source, value }) => ({ code, source, value }))).toEqual([
      { code: "unknown_slot", source: "api", value: "missing:v2" },
      { code: "unknown_version", source: "api", value: "pricing:v9" },
      { code: "invalid_selection", source: "api", value: '{"schemaVersion":2,"slot":"pricing","version":"v2"}' },
      { code: "invalid_selection", source: "api", value: "pricing:v2" },
    ]);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(storage.values.size).toBe(0);
  });

  it("does not notify when a rejected selection leaves the snapshot unchanged", () => {
    const { registry } = page();
    const listener = vi.fn();
    registry.subscribe(listener);
    for (let index = 0; index < 32; index += 1) select(registry, "missing", "v1");
    expect(listener).toHaveBeenCalledTimes(32);
    select(registry, "missing", "v1");
    expect(listener).toHaveBeenCalledTimes(32);
    select(registry, "missing", "v2");
    expect(listener).toHaveBeenCalledTimes(33);
  });

  it("keeps only the most recent rejected selections and a valid snapshot", () => {
    const { registry } = page();
    registry.register(pricing);
    for (let index = 0; index < 100; index += 1) select(registry, "pricing", `x${index}`);
    const warnings = registrySnapshotSchema.parse(registry.getSnapshot()).warnings;
    expect(warnings).toHaveLength(32);
    expect(warnings.at(-1)?.value).toBe("pricing:x99");
  });
});

describe("repeated slots and unregistering", () => {
  it("counts mounts per slot, shares the selection and removes the slot after the last unregister", () => {
    const { registry } = page();
    const first = registry.register(pricing);
    const second = registry.register(pricing);
    expect(slotOf(registry.getSnapshot(), "pricing")?.mounts).toBe(2);

    select(registry, "pricing", "v3");
    expect(registry.activeVersion(pricing)).toBe("v3");

    first();
    first();
    expect(slotOf(registry.getSnapshot(), "pricing")).toMatchObject({ mounts: 1, activeVersion: "v3" });
    second();
    expect(registry.getSnapshot().slots).toEqual([]);
  });

  it("ignores a stale unregister after the slot was removed and registered again", () => {
    const { registry } = page();
    const stale = registry.register(pricing);
    stale();
    registry.register(pricing);
    stale();
    expect(slotOf(registry.getSnapshot(), "pricing")?.mounts).toBe(1);
  });

  it("restores the remembered version when a slot mounts again", () => {
    const { registry } = page();
    const unregister = registry.register(pricing);
    select(registry, "pricing", "v2");
    unregister();
    registry.register(pricing);
    expect(slotOf(registry.getSnapshot(), "pricing")?.activeVersion).toBe("v2");
  });

  it("keeps the first definition for a repeated slot and lets each instance fall back to its own default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry } = page();
    const other: SlotDefinition = { slot: "pricing", versions: ["v1", "v4"], defaultVersion: "v4" };
    registry.register(pricing);
    registry.register(other);
    expect(warn).toHaveBeenCalledOnce();
    expect(slotOf(registry.getSnapshot(), "pricing")).toMatchObject({ versions: ["v1", "v2", "v3"], mounts: 2 });
    expect(registry.activeVersion(other)).toBe("v1");
    select(registry, "pricing", "v2");
    expect(registry.activeVersion(other)).toBe("v4");
  });

  it("takes the next instance's definition when the defining one unregisters, so updated versions apply", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry } = page("?iterbar=pricing:v4");
    const updated: SlotDefinition = { slot: "pricing", versions: ["v1", "v2", "v4"], defaultVersion: "v1" };
    const first = registry.register(pricing);
    const second = registry.register(pricing);
    select(registry, "pricing", "v3");
    expect(slotOf(registry.getSnapshot(), "pricing")?.activeVersion).toBe("v3");

    // Each instance re-registers with the new versions in turn, as staggered hot updates do.
    first();
    const third = registry.register(updated);
    expect(slotOf(registry.getSnapshot(), "pricing")?.versions).toEqual(["v1", "v2", "v3"]);
    second();
    expect(slotOf(registry.getSnapshot(), "pricing")).toMatchObject({
      versions: ["v1", "v2", "v4"], activeVersion: "v1", mounts: 1,
    });
    select(registry, "pricing", "v4");
    expect(registry.activeVersion(updated)).toBe("v4");
    expect(registry.getSnapshot().warnings).toEqual([]);

    third();
    expect(registry.getSnapshot().slots).toEqual([]);
  });

  it("honours a URL version that only the next instance's definition has", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registry } = page("?iterbar=pricing:v4");
    const first = registry.register(pricing);
    expect(registry.getSnapshot().warnings.map((entry) => entry.code)).toEqual(["unknown_version"]);
    registry.register({ slot: "pricing", versions: ["v1", "v4"], defaultVersion: "v1" });
    first();
    expect(slotOf(registry.getSnapshot(), "pricing")?.activeVersion).toBe("v4");
    expect(registry.getSnapshot().warnings).toEqual([]);
  });

  it("notifies subscribers on register, select and unregister", () => {
    const { registry } = page();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const unregister = registry.register(pricing);
    select(registry, "pricing", "v2");
    select(registry, "pricing", "v2");
    unregister();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    registry.register(pricing);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("change notifications", () => {
  it("notifies when select() rewrites a URL with a malformed entry, even though the version is unchanged", () => {
    const { registry, state } = page("?iterbar=pricing:v2,oops");
    registry.register(pricing);
    const listener = vi.fn();
    registry.subscribe(listener);
    expect(registry.getSnapshot().warnings).toEqual([
      expect.objectContaining({ code: "invalid_selection", source: "url", value: "oops" }),
    ]);

    select(registry, "pricing", "v2");

    expect(state.search).toBe("?iterbar=pricing:v2");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot().warnings).toEqual([]);
    select(registry, "pricing", "v2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies when select() rewrites storage with a malformed entry, even though the version is unchanged", () => {
    const { registry, storage } = page("", "oops,hero:b");
    registry.register(pricing);
    const listener = vi.fn();
    registry.subscribe(listener);
    expect(registry.getSnapshot().warnings).toEqual([
      expect.objectContaining({ code: "invalid_selection", source: "storage", value: "oops" }),
    ]);

    select(registry, "pricing", "v1");

    expect(storage.getItem(VARIANT_STORAGE_KEY)).toBe("hero:b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot().warnings).toEqual([]);
    select(registry, "pricing", "v1");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("remembering selections", () => {
  it("stores non-default selections and forgets the slot when the default is selected", () => {
    const { registry, storage } = page("", "hero:b");
    registry.register(pricing);
    select(registry, "pricing", "v2");
    expect(storage.getItem(VARIANT_STORAGE_KEY)).toBe("hero:b,pricing:v2");
    select(registry, "pricing", "v1");
    expect(storage.getItem(VARIANT_STORAGE_KEY)).toBe("hero:b");
  });

  it("rewrites the URL entry for the slot, keeping other parameters, so a reload shows the selection", () => {
    const { registry, state } = page("?a=1%3A2&iterbar=pricing:v9,hero:b&z=+");
    registry.register(pricing);
    select(registry, "pricing", "v3");
    expect(state.search).toBe("?a=1%3A2&iterbar=pricing:v3,hero:b&z=+");
    expect(registry.getSnapshot().warnings.map((entry) => entry.code)).toEqual(["unknown_slot"]);
  });

  it(`keeps a new stored selection when storage already holds ${MAX_SLOTS} others, dropping the oldest`, () => {
    const others = Array.from({ length: MAX_SLOTS }, (_, index) => `s${index}:a`);
    const { registry, storage } = page("", others.join(","));
    registry.register(pricing);
    select(registry, "pricing", "v2");

    const stored = storage.getItem(VARIANT_STORAGE_KEY)?.split(",");
    expect(stored).toHaveLength(MAX_SLOTS);
    expect(stored?.at(-1)).toBe("pricing:v2");
    expect(stored?.slice(0, -1)).toEqual(others.slice(1));

    const reloaded = createVariantsRegistry({ environment: { readSearch: () => "", storage: () => storage } });
    reloaded.register(pricing);
    expect(slotOf(reloaded.getSnapshot(), "pricing")?.activeVersion).toBe("v2");
  });

  it(`keeps the slot's URL entry when the URL names more than ${MAX_SLOTS} slots, dropping the earliest others`, () => {
    const others = Array.from({ length: MAX_SLOTS }, (_, index) => `s${index}:a`);
    const { registry, state } = page(`?iterbar=${others.join(",")},pricing:v1`);
    registry.register(pricing);
    select(registry, "pricing", "v3");

    const entries = new URLSearchParams(state.search).get("iterbar")?.split(",");
    expect(entries).toHaveLength(MAX_SLOTS);
    expect(entries).toEqual([...others.slice(1), "pricing:v3"]);
  });

  it("leaves the URL alone when it does not name the slot", () => {
    const { registry, state } = page("?iterbar=hero:b");
    registry.register(pricing);
    select(registry, "pricing", "v2");
    expect(state.search).toBe("?iterbar=hero:b");
  });
});

describe("definitions", () => {
  it.each([
    { slot: "bad slot", versions: ["v1"], defaultVersion: "v1" },
    { slot: "pricing", versions: [], defaultVersion: "v1" },
    { slot: "pricing", versions: ["v1", "v1"], defaultVersion: "v1" },
    { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v3" },
    { slot: "pricing", versions: ["v1", "a,b"], defaultVersion: "v1" },
  ])("rejects $slot $versions default $defaultVersion", (definition) => {
    const { registry } = page();
    expect(() => registry.register(definition)).toThrow(expect.objectContaining({ code: "invalid_message" }));
    expect(registry.getSnapshot().slots).toEqual([]);
  });

  it(`refuses more than ${MAX_SLOTS} slots`, () => {
    const { registry } = page();
    for (let index = 0; index < MAX_SLOTS; index += 1) registry.register({ ...hero, slot: `s${index}` });
    expect(() => registry.register(pricing)).toThrow(expect.objectContaining({ code: "invalid_message" }));
    expect(registrySnapshotSchema.safeParse(registry.getSnapshot()).success).toBe(true);
  });
});

describe("page API", () => {
  it("installs a window.__ITERBAR__ that readPageApi accepts and that delivers snapshots", () => {
    const { registry } = page();
    const target: Record<string, unknown> = {};
    expect(installPageApi(registry, target)).toBe(true);
    const api = readPageApi(target);
    expect(api).toBe(registry.pageApi);
    const snapshots: RegistrySnapshot[] = [];
    const unsubscribe = api!.subscribe((snapshot) => snapshots.push(snapshot));
    registry.register(pricing);
    api!.select({ schemaVersion: 1, slot: "pricing", version: "v2" });
    unsubscribe();
    expect(snapshots.map((snapshot) => slotOf(registrySnapshotSchema.parse(snapshot), "pricing")?.activeVersion))
      .toEqual(["v1", "v2"]);
    expect(api!.getSnapshot()).toEqual(registry.getSnapshot());
  });

  it("does not replace another page API", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const foreign = { schemaVersion: 1 };
    const target: Record<string, unknown> = { [PAGE_API_GLOBAL]: foreign };
    expect(installPageApi(page().registry, target)).toBe(false);
    expect(target[PAGE_API_GLOBAL]).toBe(foreign);
  });

  it("reports a throwing listener and still calls the others", () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    try {
      const { registry } = page();
      const failure = new Error("listener failed");
      const later = vi.fn();
      registry.subscribe(() => {
        throw failure;
      });
      registry.subscribe(later);
      registry.register(pricing);
      expect(later).toHaveBeenCalledOnce();
      expect(reported).toEqual([failure]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares one registry per page and installs it as the global page API", () => {
    const holder = globalThis as Record<PropertyKey, unknown>;
    const key = Symbol.for("iterbar.variants.registry.v1");
    try {
      const registry = getVariantsRegistry();
      expect(getVariantsRegistry()).toBe(registry);
      expect(readPageApi()).toBe(registry.pageApi);
    } finally {
      delete holder[key];
      delete holder[PAGE_API_GLOBAL];
    }
  });
});

describe("browser helpers", () => {
  it("reads and replaces the query string through location and history", () => {
    const replaceState = vi.fn();
    const environment = browserEnvironment({
      location: { search: "?iterbar=pricing:v2", pathname: "/plans", hash: "#top" },
      history: { state: { route: 1 }, replaceState },
    });
    expect(environment.readSearch()).toBe("?iterbar=pricing:v2");
    environment.replaceSearch?.("?iterbar=pricing:v3");
    expect(replaceState).toHaveBeenCalledWith({ route: 1 }, "", "/plans?iterbar=pricing:v3#top");
    expect(browserEnvironment({}).readSearch()).toBe("");
    expect(browserEnvironment({}).storage()).toBeNull();
  });

  it("sets the first iterbar parameter or appends one", () => {
    expect(withVariantParam("", "pricing:v2")).toBe("?iterbar=pricing:v2");
    expect(withVariantParam("?a=1", "pricing:v2")).toBe("?a=1&iterbar=pricing:v2");
    expect(withVariantParam("?%69terbar=x&iterbar=y&b=%E0", "p:v")).toBe("?iterbar=p:v&iterbar=y&b=%E0");
  });

  it("marks and unmarks a slot root", () => {
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as Element;
    const unmark = markSlotRoot(element, "pricing");
    expect(attributes.get("data-iterbar-slot")).toBe("pricing");
    unmark();
    expect(attributes.size).toBe(0);
    expect(slotRootAttributes("pricing")).toEqual({ "data-iterbar-slot": "pricing" });
    expect(slotBoundaryAttributes("start")).toEqual({ "data-iterbar-slot-boundary": "start" });
  });
});
