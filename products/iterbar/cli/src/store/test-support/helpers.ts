import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { FeedbackDraft } from "iterbar";

const script = fileURLToPath(new URL("./store-process.mjs", import.meta.url));

/** A fresh absolute project root; removed by the returned cleanup. */
export async function temporaryProject(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "iterbar-store-")));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface StoreProcessMessage {
  readonly event: "ready" | "acquired" | "error" | "attachments-written" | "closed";
  readonly pid?: number;
  readonly code?: string | null;
  readonly ownerPid?: number | null;
  readonly feedbackId?: string;
  readonly message?: string;
}

/** Another Iterbar process running the built store; see `store-process.mjs`. */
export class StoreProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly #messages: StoreProcessMessage[] = [];
  readonly #waiters: Array<() => void> = [];
  readonly exited: Promise<void>;

  constructor(mode: "hold" | "crash-after-attachments", projectRoot: string, draft?: FeedbackDraft) {
    this.child = spawn(process.execPath, [script, mode, projectRoot, JSON.stringify(draft ?? null)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    let stderr = "";
    this.child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    this.child.once("exit", (code, signal) => {
      if (code !== 0 && signal === null) this.#messages.push({ event: "error", code: "crashed", message: stderr });
      this.#notify();
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.#messages.push(JSON.parse(line) as StoreProcessMessage);
      this.#notify();
    });
  }

  #notify(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  /** The first message with one of `events`, waiting for it. */
  async next(...events: StoreProcessMessage["event"][]): Promise<StoreProcessMessage> {
    for (;;) {
      const found = this.#messages.find((message) => events.includes(message.event) || message.code === "crashed");
      if (found) {
        if (found.code === "crashed") throw new Error(`Store process crashed: ${found.message}`);
        return found;
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Store process exited before ${events.join(" or ")}`);
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  go(): void {
    this.child.stdin.write("go\n");
  }

  /** Lets a holding process close its store and exit. */
  async finish(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }

  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

/** The pid of a process that has already exited. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid as number;
}

export const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("0000000d4948445200000001000000010806000000", "hex"),
]);
export const EVIDENCE = Buffer.from(JSON.stringify({ events: [{ type: "console", level: "warn", text: "slow" }] }));

const content = {
  schemaVersion: 1 as const,
  pageUrl: "http://localhost:5173/pricing?iterbar=pricing:v2",
  activeVariants: [{ slot: "pricing", version: "v2" }],
  screenshotUnavailableReason: null,
};

export const commentDraft: FeedbackDraft = {
  ...content,
  kind: "comment",
  text: "Make the button larger.",
  target: {
    selector: "[data-testid=\"buy\"]",
    textExcerpt: "Buy now",
    boundingBox: { x: 16, y: 40, width: 320, height: 48 },
    sourceLocation: { path: "src/routes/Pricing.tsx", line: 12, column: 5 },
  },
  evidenceWindow: { start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T10:00:35.000Z", eventCount: 1 },
};

export const chooseVariantDraft: FeedbackDraft = {
  ...content,
  kind: "choose_variant",
  text: "",
  choice: { slot: "pricing", version: "v2" },
  target: null,
  screenshotUnavailableReason: "Capture was blocked by the page",
  evidenceWindow: null,
};
