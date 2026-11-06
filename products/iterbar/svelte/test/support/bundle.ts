import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// jsdom replaces the URL global, so resolve paths from the module's file URL string.
export const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(mode: "bundle" | "render", input: unknown): string {
  return execFileSync(process.execPath, [join(packageDirectory, "test", "support", "bundle.mjs"), mode, JSON.stringify(input)], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
}

/** A minified CommonJS browser bundle of `entry` (relative to the package), with Svelte left external. */
export function bundle(entry: string, options: { dev: boolean; nodeEnv: string }): string {
  return run("bundle", { entry, ...options });
}

/** One server render: the component in `entry`, on a server whose NODE_ENV is `nodeEnv`. */
export interface ServerRenderJob {
  readonly entry: string;
  readonly nodeEnv: string;
  readonly props?: Record<string, unknown>;
}

function jobKey({ entry, nodeEnv, props = {} }: ServerRenderJob): string {
  return JSON.stringify([entry, nodeEnv, props]);
}

/**
 * Server-renders every job in one separate Node.js process, which has no browser globals, and returns a
 * lookup of each job's HTML body. Starting that process takes a while, so a test file renders up front.
 */
export function serverRenderAll(jobs: readonly ServerRenderJob[]): (job: ServerRenderJob) => string {
  const bodies = JSON.parse(run("render", jobs.map((job) => ({ props: {}, ...job })))) as string[];
  const byKey = new Map(jobs.map((job, index) => [jobKey(job), bodies[index]!]));
  return (job) => {
    const body = byKey.get(jobKey(job));
    if (body === undefined) throw new Error(`No server render was prepared for ${jobKey(job)}`);
    return body;
  };
}
