import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDiffpanelHome(
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (environment.DIFFPANEL_HOME) return environment.DIFFPANEL_HOME;
  if (environment.CONDUCTOR_HOME) return environment.CONDUCTOR_HOME;

  const current = platform === "darwin"
    ? join(homeDirectory, "Library", "Application Support", "Diffpanel")
    : platform === "win32"
      ? join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "Diffpanel")
      : join(environment.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share"), "diffpanel");
  const legacy = platform === "darwin"
    ? join(homeDirectory, "Library", "Application Support", "Conductor")
    : platform === "win32"
      ? join(environment.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "Conductor")
      : join(environment.XDG_DATA_HOME ?? join(homeDirectory, ".local", "share"), "conductor");

  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
