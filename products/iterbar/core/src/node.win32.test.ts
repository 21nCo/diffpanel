import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { absolutePathSchema } from "./index.js";

// Run the Node path helpers against Node's own win32 path implementation, as they behave on Windows.
vi.mock("node:path", async () => (await vi.importActual<typeof import("node:path")>("node:path")).win32);

const { attachmentPath, attachmentsDirectoryPath, feedbackDirectoryPath, feedbackRecordPath, iterbarPaths } =
  await import("./node.js");

/** Every `iterbar/node` helper that takes a project root, so each one is held to the same root rule. */
const helpers: Record<string, (projectRoot: string) => string> = {
  iterbarPaths: (projectRoot) => iterbarPaths(projectRoot).daemonFile,
  feedbackDirectoryPath: (projectRoot) => feedbackDirectoryPath(projectRoot, "fb_0001"),
  feedbackRecordPath: (projectRoot) => feedbackRecordPath(projectRoot, "fb_0001"),
  attachmentsDirectoryPath: (projectRoot) => attachmentsDirectoryPath(projectRoot, "fb_0001"),
  attachmentPath: (projectRoot) => attachmentPath(projectRoot, "fb_0001", { id: "at_1", kind: "screenshot" }),
};

/** The root Windows itself parses from a produced path: a drive (`C:\`) or a full UNC share (`\\server\share\`). */
const qualifiedWindowsRoot = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)$/;

function expectRejected(projectRoot: string): void {
  for (const [name, helper] of Object.entries(helpers)) {
    expect(() => helper(projectRoot), `${name}(${JSON.stringify(projectRoot)})`)
      .toThrow(expect.objectContaining({ code: "invalid_project_root" }));
  }
}

function expectAccepted(projectRoot: string, expectedRoot: string): void {
  for (const [name, helper] of Object.entries(helpers)) {
    const produced = helper(projectRoot);
    const label = `${name}(${JSON.stringify(projectRoot)}) = ${JSON.stringify(produced)}`;
    expect(win32.parse(produced).root, label).toBe(expectedRoot);
    expect(win32.parse(produced).root, label).toMatch(qualifiedWindowsRoot);
  }
  // The daemon writes the normalized root to daemon.json, whose readers check it with absolutePathSchema.
  expect(absolutePathSchema.safeParse(iterbarPaths(projectRoot).projectRoot).success, projectRoot).toBe(true);
}

describe("iterbar/node paths on Windows", () => {
  it("accepts drive-qualified and full UNC roots", () => {
    expect(iterbarPaths("C:\\work\\app").daemonFile).toBe("C:\\work\\app\\.iterbar\\daemon.json");
    expect(iterbarPaths("c:/work/app").directory).toBe("c:\\work\\app\\.iterbar");
    expect(feedbackRecordPath("\\\\server\\share\\app", "fb_0001"))
      .toBe("\\\\server\\share\\app\\.iterbar\\feedback\\fb_0001\\feedback.json");
    expect(attachmentPath("D:\\app", "fb_0001", { id: "at_1", kind: "evidence" }))
      .toBe("D:\\app\\.iterbar\\feedback\\fb_0001\\attachments\\at_1.json");
    expect(iterbarPaths("\\\\server\\share").directory).toBe("\\\\server\\share\\.iterbar");

    for (const [projectRoot, root] of [
      ["C:\\work\\app", "C:\\"],
      ["c:/work/app", "c:\\"],
      ["C:\\", "C:\\"],
      ["C:\\..\\app", "C:\\"],
      ["\\\\server\\share", "\\\\server\\share\\"],
      ["\\\\server\\share\\", "\\\\server\\share\\"],
      ["\\\\server\\share\\app", "\\\\server\\share\\"],
      ["//server/share/app", "\\\\server\\share\\"],
      ["\\\\server\\share\\..\\..\\app", "\\\\server\\share\\"],
    ]) {
      expectAccepted(projectRoot!, root!);
    }
  });

  it("rejects roots that each process would resolve against its own current drive", () => {
    // Native win32 isAbsolute accepts the drive-relative and bare-server forms, so it alone cannot enforce the contract.
    expect(["\\work\\app", "/work/app", "\\\\server", "//server"].map((root) => win32.isAbsolute(root)))
      .toEqual([true, true, true, true]);
    // Normalizing a bare server leaves a drive-relative root ("\\"), which is what the helpers must never return.
    expect(win32.parse(win32.normalize("\\\\server")).root).toBe("\\");

    for (const projectRoot of [
      "\\work\\app", "/work/app", "C:work\\app", "C:", "work\\app", "",
      "\\\\", "\\\\server", "\\\\server\\", "//server", "//server/", "\\/server", "/\\server",
      "\\\\\\server\\share", "///server/share",
      "\\\\..\\share\\app", "\\\\server\\..\\app", "\\\\.\\share", "\\\\server\\.\\app",
      "C:\\app\0x",
    ]) {
      expectRejected(projectRoot);
    }
  });

  it("rejects device-namespace roots; the equivalent drive or UNC root is required", () => {
    for (const projectRoot of [
      "\\\\?\\C:\\work\\app", "\\\\?\\UNC\\server\\share\\app", "//?/C:/work/app",
      "\\\\.\\C:\\work\\app", "\\\\.\\pipe\\iterbar", "//./pipe/iterbar",
    ]) {
      expectRejected(projectRoot);
    }
  });

  it("rejects a UNC root whose server or share contains a character Windows forbids in names", () => {
    for (const bad of [..."<>:\"|?*", "\u0000", "\u0001", "\u001f"]) {
      for (const projectRoot of [
        `\\\\ser${bad}ver\\share\\app`, `\\\\server\\sh${bad}are\\app`, `//server${bad}/share`, `\\\\server/share${bad}`,
      ]) {
        expectRejected(projectRoot);
      }
    }
    expectAccepted("\\\\my-server.local\\share$\\app", "\\\\my-server.local\\share$\\");
  });

  it("accepts a UNC root only when both its server and share are legal names, for every separator mix", () => {
    const names = ["server", "", ".", "..", "?", "a?b", "a:b", "a*b", "a<b", "a\u0001b"];
    const isName = (name: string) =>
      name !== "" && name !== "." && name !== ".." && ![...name].some((c) => '<>:"|?*'.includes(c) || c < " ");
    for (const lead of ["\\\\", "//", "\\/", "/\\"]) {
      for (const server of names) {
        for (const separator of ["\\", "/"]) {
          for (const share of names) {
            for (const tail of ["", "\\", "/", "\\app", "/app\\x"]) {
              const projectRoot = `${lead}${server}${separator}${share}${tail}`;
              if (isName(server) && isName(share)) expectAccepted(projectRoot, `\\\\${server}\\${share}\\`);
              else expectRejected(projectRoot);
            }
          }
        }
      }
    }
  });
});
