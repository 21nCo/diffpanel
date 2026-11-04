import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isIterbarStoreError } from "../store/index.js";
import { startDaemon, type RunningDaemon } from "../daemon/index.js";

export const DEV_USAGE = `Usage: iterbar dev [--root <directory>]

Starts the Iterbar daemon for a project and runs it until interrupted. The daemon listens on a
random port of 127.0.0.1 and writes its address and token to <directory>/.iterbar/daemon.json.

Options:
  --root <directory>  Project root (default: the current directory)
  -h, --help          Show this help
`;

/** Signals that stop the daemon gracefully. A second one while it shuts down stops the process at once. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface DevCommandIo {
  readonly stdout: Pick<NodeJS.WritableStream, "write">;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
}

type ParsedArgs = { readonly help: true } | { readonly help: false; readonly root: string | undefined };

function parseArgs(args: readonly string[]): ParsedArgs {
  let root: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "-h" || arg === "--help") return { help: true };
    let value: string | undefined;
    if (arg === "--root") {
      index += 1;
      value = args[index];
    } else if (arg.startsWith("--root=")) {
      value = arg.slice("--root=".length);
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}`);
    }
    if (!value) throw new Error("--root needs a directory");
    if (root !== undefined) throw new Error("--root was given more than once");
    root = value;
  }
  return { help: false, root };
}

/** Waits for a stop signal or for the daemon to close on its own. */
function untilStopped(daemon: RunningDaemon): Promise<void> {
  return new Promise((done) => {
    const stop = () => {
      for (const signal of STOP_SIGNALS) process.off(signal, stop);
      done();
    };
    for (const signal of STOP_SIGNALS) process.once(signal, stop);
    void daemon.closed.then(stop);
  });
}

/** `iterbar dev`: runs the daemon in the foreground. Resolves with the process exit code. */
export async function runDev(args: readonly string[], io: DevCommandIo = process): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    io.stderr.write(`iterbar dev: ${(error as Error).message}\n\n${DEV_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout.write(DEV_USAGE);
    return 0;
  }

  let daemon: RunningDaemon;
  try {
    // The real path, so the root in daemon.json matches what other tools resolve for the same project.
    const projectRoot = await realpath(resolve(parsed.root ?? process.cwd()));
    daemon = await startDaemon({ projectRoot });
  } catch (error) {
    const reason = isIterbarStoreError(error) || (error as { code?: unknown }).code === "ENOENT"
      ? (error as Error).message
      : String((error as Error)?.stack ?? error);
    io.stderr.write(`iterbar dev: could not start the daemon: ${reason}\n`);
    return 1;
  }

  io.stdout.write(`Iterbar daemon listening on ${daemon.url} (pid ${daemon.info.pid}) for ${daemon.info.projectRoot}\n`);
  await untilStopped(daemon);
  await daemon.close();
  io.stdout.write("Iterbar daemon stopped\n");
  return 0;
}
