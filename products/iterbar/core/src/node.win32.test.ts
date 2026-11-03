import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Run the Node path helpers against Node's own win32 path implementation, as they behave on Windows.
vi.mock("node:path", async () => (await vi.importActual<typeof import("node:path")>("node:path")).win32);

const { attachmentPath, feedbackRecordPath, iterbarPaths } = await import("./node.js");

describe("iterbar/node paths on Windows", () => {
  it("accepts drive-qualified and UNC roots", () => {
    expect(iterbarPaths("C:\\work\\app").daemonFile).toBe("C:\\work\\app\\.iterbar\\daemon.json");
    expect(iterbarPaths("c:/work/app").directory).toBe("c:\\work\\app\\.iterbar");
    expect(feedbackRecordPath("\\\\server\\share\\app", "fb_0001"))
      .toBe("\\\\server\\share\\app\\.iterbar\\feedback\\fb_0001\\feedback.json");
    expect(attachmentPath("D:\\app", "fb_0001", { id: "at_1", kind: "evidence" }))
      .toBe("D:\\app\\.iterbar\\feedback\\fb_0001\\attachments\\at_1.json");
  });

  it("rejects drive-relative roots that each process would resolve against its own current drive", () => {
    // Native win32 isAbsolute accepts the drive-relative forms, so it alone cannot enforce the contract.
    expect([win32.isAbsolute("\\work\\app"), win32.isAbsolute("/work/app")]).toEqual([true, true]);
    for (const projectRoot of ["\\work\\app", "/work/app", "C:work\\app", "work\\app"]) {
      expect(() => iterbarPaths(projectRoot), projectRoot).toThrow(expect.objectContaining({ code: "invalid_project_root" }));
      expect(() => feedbackRecordPath(projectRoot, "fb_0001"), projectRoot)
        .toThrow(expect.objectContaining({ code: "invalid_project_root" }));
    }
  });
});
