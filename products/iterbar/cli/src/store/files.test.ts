import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { iterbarPaths } from "iterbar/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileAtomic, writeFileAtomic } from "./files.js";
import { acquireStoreLock } from "./lock.js";
import { openFeedbackStore } from "./store.js";
import { temporaryProject } from "./test-support/helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await temporaryProject());
});

afterEach(async () => {
  vi.mocked(open).mockClear();
  await cleanup();
});

/** Makes the next exclusive creation of a temporary `create-` file fail as if its name were taken. */
async function collideOnce(): Promise<void> {
  const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  let collided = false;
  vi.mocked(open).mockImplementation(async (path, ...rest) => {
    if (!collided && /[/\\]create-[^/\\]+\.tmp$/.test(String(path))) {
      collided = true;
      throw Object.assign(new Error(`EEXIST: file already exists, open '${String(path)}'`), { code: "EEXIST" });
    }
    return actual(path, ...rest);
  });
}

describe("createFileAtomic", () => {
  it("returns false only when the target exists, not when its temporary name is taken", async () => {
    const target = join(root, "target");
    await writeFile(target, "kept");
    expect(await createFileAtomic(root, target, "new")).toBe(false);
    expect(await readFile(target, "utf8")).toBe("kept");

    const absent = join(root, "absent");
    await collideOnce();
    await expect(createFileAtomic(root, absent, "new")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(stat(absent)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createFileAtomic(root, absent, "new")).toBe(true);
    expect(await readFile(absent, "utf8")).toBe("new");
  });

  it("never lets first use succeed without .iterbar/.gitignore", async () => {
    await collideOnce();
    await expect(openFeedbackStore(root)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(stat(iterbarPaths(root).gitignoreFile)).rejects.toMatchObject({ code: "ENOENT" });
    const store = await openFeedbackStore(root);
    expect(await readFile(iterbarPaths(root).gitignoreFile, "utf8")).toBe("*\n");
    await store.close();
  });
});

/** Makes closing the next temporary file whose name starts with `label-` fail after it has really closed. */
async function failCloseOnce(label: string): Promise<Error> {
  const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  const injected = Object.assign(new Error("injected close failure"), { code: "EIO" });
  let failed = false;
  vi.mocked(open).mockImplementation(async (path, ...rest) => {
    const handle = await actual(path, ...rest);
    if (!failed && new RegExp(`[/\\\\]${label}-[^/\\\\]+\\.tmp$`).test(String(path))) {
      failed = true;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw injected;
      };
    }
    return handle;
  });
  return injected;
}

describe("a temporary file whose close fails", () => {
  it.each(["writeFileAtomic", "createFileAtomic"] as const)("is removed by %s, which rethrows the failure", async (operation) => {
    const tmpDirectory = join(root, "tmp");
    await mkdir(tmpDirectory);
    const target = join(root, "target");
    const injected = await failCloseOnce(operation === "writeFileAtomic" ? "write" : "create");
    const write = operation === "writeFileAtomic" ? writeFileAtomic : createFileAtomic;
    await expect(write(tmpDirectory, target, "data")).rejects.toBe(injected);
    expect(await readdir(tmpDirectory)).toEqual([]);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is removed when it is a lock candidate, and acquisition rethrows the failure", async () => {
    await (await openFeedbackStore(root)).close();
    const { lockFile, tmpDirectory } = iterbarPaths(root);
    const injected = await failCloseOnce("lock");
    await expect(acquireStoreLock(lockFile, tmpDirectory)).rejects.toBe(injected);
    expect(await readdir(tmpDirectory)).toEqual([]);
    await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    await (await acquireStoreLock(lockFile, tmpDirectory)).release();
  });
});
