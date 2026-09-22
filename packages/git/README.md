# @diffpanel/git

Bounded, cancellation-aware Git capture for Diffpanel worktree, staged,
commit-range, and repository snapshots.

```ts
import { captureReview } from "@diffpanel/git";

const capture = await captureReview(
  { kind: "worktree", repoPath: process.cwd() },
  { signal: AbortSignal.timeout(30_000) },
);
```

Capture follows neither repository-relative traversal nor worktree symlinks,
enforces configurable file/output budgets, and retries mutable worktree reads
when the snapshot changes during capture. Requires Node.js 22.13 or newer.
