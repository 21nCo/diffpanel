import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AttachmentRef, absolutePathSchema, attachmentFileName, iterbarLayout } from "./index.js";
import { attachmentPath, attachmentsDirectoryPath, feedbackDirectoryPath, feedbackRecordPath, iterbarPaths } from "./node.js";

// POSIX fixtures: run against Node's posix path implementation on every host (node.win32.test.ts covers Windows).
vi.mock("node:path", async () => (await vi.importActual<typeof import("node:path")>("node:path")).posix);

const root = join("/", "work", "app");

describe("iterbar/node paths", () => {
  it("places every fixed entry inside the project's .iterbar directory", () => {
    const paths = iterbarPaths(join(root, "nested", ".."));
    expect(paths.directory).toBe(join(root, ".iterbar"));
    expect(paths.daemonFile).toBe(join(root, ".iterbar", "daemon.json"));
    expect(paths.lockFile).toBe(join(root, ".iterbar", "store.lock"));
    expect(paths.gitignoreFile).toBe(join(root, ".iterbar", ".gitignore"));
    expect(paths.tmpDirectory).toBe(join(root, ".iterbar", "tmp"));
    expect(iterbarLayout.gitignoreContents).toBe("*\n");
  });

  it("builds record and attachment paths with kind-specific extensions", () => {
    expect(feedbackRecordPath(root, "fb_0001")).toBe(join(root, ".iterbar", "feedback", "fb_0001", "feedback.json"));
    expect(attachmentPath(root, "fb_0001", { id: "at_1", kind: "screenshot" }))
      .toBe(join(root, ".iterbar", "feedback", "fb_0001", "attachments", "at_1.png"));
    expect(attachmentFileName({ id: "at_2", kind: "evidence" })).toBe("at_2.json");
  });

  it("refuses ids that would escape their directory", () => {
    for (const id of ["..", "../fb", "fb/x", ".hidden", "", "fb\\x"]) {
      expect(() => feedbackRecordPath(root, id)).toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
      expect(() => attachmentPath(root, "fb_0001", { id, kind: "evidence" }))
        .toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
    }
  });

  it("rejects inherited property names as attachment kinds", () => {
    for (const kind of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const attachment = { id: "at_1", kind } as unknown as Pick<AttachmentRef, "id" | "kind">;
      expect(() => attachmentFileName(attachment), kind).toThrow(TypeError);
      expect(() => attachmentPath(root, "fb_0001", attachment), kind).toThrow(TypeError);
    }
  });

  it("refuses ids that alias by case or name a Windows device", () => {
    for (const id of ["FB_0001", "con", "nul", "com1"]) {
      expect(() => feedbackRecordPath(root, id), id).toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
      expect(() => attachmentPath(root, "fb_0001", { id, kind: "screenshot" }), id)
        .toThrow(expect.objectContaining({ code: "invalid_path_segment" }));
    }
  });

  it("requires an absolute project root so every process resolves the same directory", () => {
    // Windows-only forms are relative paths on POSIX; a leading `//` or `/\` reads as UNC on Windows.
    for (const projectRoot of ["app", "./app", "", "/app\0x", "C:\\work\\app", "c:/work/app", "\\\\server\\share", "//server/share", "/\\server"]) {
      for (const helper of [iterbarPaths, feedbackDirectoryPath, feedbackRecordPath, attachmentsDirectoryPath]) {
        expect(() => helper(projectRoot, "fb_0001"), `${helper.name}(${JSON.stringify(projectRoot)})`)
          .toThrow(expect.objectContaining({ code: "invalid_project_root" }));
      }
      expect(() => attachmentPath(projectRoot, "fb_0001", { id: "at_1", kind: "evidence" }), projectRoot)
        .toThrow(expect.objectContaining({ code: "invalid_project_root" }));
    }
  });

  it("returns a normalized root that daemon.json readers accept", () => {
    for (const projectRoot of ["/", "/work/app", "/work/../app/"]) {
      const paths = iterbarPaths(projectRoot);
      expect(absolutePathSchema.safeParse(paths.projectRoot).success, projectRoot).toBe(true);
      expect(paths.daemonFile.startsWith("/") && !paths.daemonFile.startsWith("//"), projectRoot).toBe(true);
    }
  });
});
