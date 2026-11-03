import { describe, expect, it } from "vitest";
import { windowsTaskkillPath } from "./windows-process.js";

describe("windowsTaskkillPath", () => {
  it("resolves taskkill from the absolute Windows system directory", () => {
    expect(windowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(windowsTaskkillPath({ WINDIR: "D:\\WinDir" })).toBe("D:\\WinDir\\System32\\taskkill.exe");
  });

  it("refuses a relative or missing system directory", () => {
    expect(windowsTaskkillPath({ SystemRoot: "Windows" })).toBeNull();
    expect(windowsTaskkillPath({})).toBeNull();
  });
});
