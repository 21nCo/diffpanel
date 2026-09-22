import type { RunPage, RunSummary } from "@diffpanel/storage";

type Execute = (args: string[]) => Promise<string>;

export async function listRunsWithCompatibility(execute: Execute, includeArchived = false): Promise<RunSummary[]> {
  const sharedArgs = ["list", ...(includeArchived ? ["--include-archived"] : [])];
  const runs: RunSummary[] = [];
  let cursor: string | null = null;
  try {
    do {
      const parsed = JSON.parse(await execute([
        ...sharedArgs,
        "--limit", "200", "--page", "--json",
        ...(cursor ? ["--cursor", cursor] : []),
      ])) as unknown;
      if (Array.isArray(parsed) && runs.length === 0) return parsed as RunSummary[];
      const page = requireRunPage(parsed);
      runs.push(...page.runs);
      cursor = page.nextCursor;
    } while (cursor);
    return runs;
  } catch (error) {
    if (runs.length > 0 || !isLegacyPaginationError(error)) throw error;
    const legacy = JSON.parse(await execute([...sharedArgs, "--json"])) as unknown;
    if (!Array.isArray(legacy)) throw new Error("Legacy Diffpanel CLI returned an invalid run list.");
    return legacy as RunSummary[];
  }
}

function requireRunPage(value: unknown): RunPage {
  if (!value || typeof value !== "object") throw new Error("Diffpanel CLI returned an invalid run page.");
  const page = value as Partial<RunPage>;
  if (!Array.isArray(page.runs) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) {
    throw new Error("Diffpanel CLI returned an invalid run page.");
  }
  return page as RunPage;
}

function isLegacyPaginationError(error: unknown): boolean {
  return error instanceof Error && /unknown option ['"]?--(?:limit|page|cursor)/i.test(error.message);
}
