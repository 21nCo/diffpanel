import { spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

const TASKKILL_TIMEOUT_MS = 1_000;

export function windowsTaskkillPath(environment: NodeJS.ProcessEnv = process.env): string | null {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) return null;
  const executable = win32.join(systemRoot, "System32", "taskkill.exe");
  return win32.isAbsolute(executable) ? executable : null;
}

export async function runTaskkill(
  executable: string,
  args: string[],
  timeoutMs = TASKKILL_TIMEOUT_MS,
  onSpawn?: (pid: number) => void,
): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    let killer: ChildProcess | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolvePromise(succeeded);
    };
    try {
      killer = spawn(executable, args, { stdio: "ignore", windowsHide: true });
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(!timedOut && code === 0));
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (!killer?.kill("SIGKILL")) finish(false);
        } catch {
          finish(false);
        }
      }, timeoutMs);
      if (killer.pid !== undefined) onSpawn?.(killer.pid);
    } catch {
      try { killer?.kill("SIGKILL"); } catch { /* The helper already exited. */ }
      finish(false);
    }
  });
}
