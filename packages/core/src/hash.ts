import { createHash, randomUUID } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function stableId(prefix: string, ...parts: Array<string | number | null>): string {
  return `${prefix}_${sha256(parts.map((part) => part ?? "").join("\0")).slice(0, 16)}`;
}

