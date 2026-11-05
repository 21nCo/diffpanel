import { chmod, readFile, rename } from "node:fs/promises";
import { daemonInfoSchema, iterbarLayout, parseMessage, safeParseMessage, type DaemonInfo } from "iterbar";
import type { IterbarPaths } from "iterbar/node";
import { errnoCode } from "../store/errors.js";
import { removeFile, syncDirectory, temporaryPath, writeNewFile } from "../store/files.js";

/**
 * Atomically writes `.iterbar/daemon.json` with mode 0600, replacing any file a daemon that did not shut down
 * left behind. Callers hold the store lock, so no other live daemon serves this project.
 */
export async function writeDaemonFile(paths: IterbarPaths, info: DaemonInfo): Promise<void> {
  const data = `${JSON.stringify(parseMessage(daemonInfoSchema, info, "daemon info"), null, 2)}\n`;
  const temporary = temporaryPath(paths.tmpDirectory, "daemon");
  await writeNewFile(temporary, data, iterbarLayout.daemonFileMode);
  try {
    // The creation mode is narrowed by the umask; the token file must be exactly owner read-write.
    await chmod(temporary, iterbarLayout.daemonFileMode);
    await rename(temporary, paths.daemonFile);
  } catch (error) {
    await removeFile(temporary);
    throw error;
  }
  await syncDirectory(paths.directory);
}

/**
 * Removes `.iterbar/daemon.json` if it still describes this daemon (same token), so a shutdown never deletes the
 * file of a daemon that started after it.
 */
export async function removeDaemonFile(paths: IterbarPaths, token: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(paths.daemonFile, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  const current = safeParseMessage(daemonInfoSchema, json, "daemon info");
  if (!current.success || current.data.token !== token) return;
  await removeFile(paths.daemonFile);
  await syncDirectory(paths.directory);
}
