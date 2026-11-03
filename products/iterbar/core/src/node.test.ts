import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AttachmentRef, attachmentFileName, iterbarLayout } from "./index.js";
import { attachmentPath, feedbackRecordPath, iterbarPaths } from "./node.js";

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
    for (const projectRoot of ["app", "./app", "", "/app\0x"]) {
      expect(() => iterbarPaths(projectRoot)).toThrow(expect.objectContaining({ code: "invalid_project_root" }));
    }
  });
});
