import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface ProcessOptions {
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  acceptedExitCodesOrOptions: readonly number[] | ProcessOptions = [0],
): Promise<ProcessResult> {
  const options: ProcessOptions = Array.isArray(acceptedExitCodesOrOptions)
    ? { acceptedExitCodes: acceptedExitCodesOrOptions }
    : acceptedExitCodesOrOptions as ProcessOptions;
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES;

  if (options.signal?.aborted) throw abortError(command);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Process timeout must be a positive integer.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("Process output limit must be a positive integer.");

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const processGroupId = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: Error | null = null;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const finish = (error: Error | null, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const terminate = (error: Error): void => {
      if (terminalError) return;
      terminalError = error;
      terminateProcess(child, processGroupId, "SIGTERM");
      forceTimer = setTimeout(() => terminateProcess(child, processGroupId, "SIGKILL"), 1_000);
      forceTimer.unref();
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate(new Error(`${command} exceeded the ${maxOutputBytes}-byte output limit.`));
        return;
      }
      target.push(chunk);
    };

    const onAbort = (): void => terminate(abortError(command));

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (exitCode) => {
      if (terminalError) {
        finish(terminalError);
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? -1,
      };
      if (!acceptedExitCodes.includes(result.exitCode)) {
        finish(new Error(
          `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString("utf8").trim()}`,
        ));
        return;
      }
      finish(null, result);
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => terminate(new Error(`${command} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timeout.unref();
  });
}

function abortError(command: string): Error {
  return new Error(`${command} was cancelled.`);
}

function terminateProcess(child: ChildProcess, processGroupId: number | undefined, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && processGroupId) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // Fall through to the direct-child fallback when the group is already gone.
    }
  }
  if (process.platform === "win32" && processGroupId) {
    const args = ["/PID", String(processGroupId), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    try {
      const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
      killer.unref();
    } catch {
      // Fall through to the direct-child fallback.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

export async function gitBuffer(
  cwd: string,
  args: string[],
  acceptedExitCodesOrOptions: readonly number[] | ProcessOptions = [0],
): Promise<Buffer> {
  return (await runProcess("git", args, cwd, acceptedExitCodesOrOptions)).stdout;
}

export async function gitText(
  cwd: string,
  args: string[],
  acceptedExitCodesOrOptions: readonly number[] | ProcessOptions = [0],
): Promise<string> {
  return (await gitBuffer(cwd, args, acceptedExitCodesOrOptions)).toString("utf8").trim();
}
