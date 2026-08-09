import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConductorHome(environment = process.env, platform = process.platform): string {
  if (environment.CONDUCTOR_HOME) return environment.CONDUCTOR_HOME;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Conductor");
  if (platform === "win32") return join(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Conductor");
  return join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "conductor");
}

