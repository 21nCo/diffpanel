# diffpanel

Browser-safe schemas, types, title helpers, and exact-coverage validation for
Diffpanel review data.

```ts
import { reviewManifestSchema, validateGeneratedReview } from "diffpanel";
```

The root export is safe to bundle for browsers. Node-only hashing helpers are
available from `diffpanel/node`.

Requires Node.js 22.13 or newer for the Node entry point.
