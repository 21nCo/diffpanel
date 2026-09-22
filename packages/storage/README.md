# @diffpanel/storage

SQLite metadata and immutable content-addressed storage for Diffpanel review
runs.

```ts
import { DiffpanelStore } from "@diffpanel/storage";

const store = DiffpanelStore.open("/path/to/diffpanel-home");
const page = store.listRunsPage({ limit: 50 });
store.close();
```

The store provides stable cursor pagination, run-scoped blob authorization,
retention and garbage collection, and interrupted-publish recovery. Requires
Node.js 22.13 or newer.
