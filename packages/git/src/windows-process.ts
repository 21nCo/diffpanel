import { win32 } from "node:path";

export function windowsTaskkillPath(environment: NodeJS.ProcessEnv = process.env): string | null {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (!systemRoot) return null;
  const executable = win32.join(systemRoot, "System32", "taskkill.exe");
  return win32.isAbsolute(executable) ? executable : null;
}
