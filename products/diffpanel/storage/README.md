# @diffpanel/storage

SQLite metadata and immutable content-addressed storage for Diffpanel review
runs.

```ts
import { DiffpanelStore } from "@diffpanel/storage";

const store = await DiffpanelStore.open("/path/to/diffpanel-home");
const page = store.listRunsPage({ limit: 50 });
store.close();
```

The store provides stable cursor pagination, run-scoped blob authorization,
retention and garbage collection, and interrupted-publish recovery. Default
open recovers prepared runs and orphan run directories without verifying every
ready run. Use `recoverRun(runId)` to inspect one run's manifest and review,
or `recover()` for full blob integrity verification and cleanup. The CLI exposes
full verification through `diffpanel doctor --verify`. Requires Node.js 22.13
or newer.
