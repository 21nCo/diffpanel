import type { VersionContent } from "./types.js";

/** The content of `version`, or `undefined` when `versions` has no own entry with that name. */
export function versionContent(
  versions: Readonly<Record<string, VersionContent>>,
  version: string,
): VersionContent | undefined {
  return Object.hasOwn(versions, version) ? versions[version] : undefined;
}
