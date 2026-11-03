# iterbar

Versioned (v1) contracts shared by every Iterbar package: zod schemas and
TypeScript types for feedback, the page variants registry, the local daemon's
HTTP and WebSocket messages, and the `.iterbar/` directory layout.

```ts
import { feedbackSchema, parseMessage } from "iterbar";

const feedback = parseMessage(feedbackSchema, JSON.parse(text), "feedback");
```

The root export is browser-safe. Node.js path helpers for `.iterbar/` are
available from `iterbar/node`:

```ts
import { feedbackRecordPath, iterbarPaths } from "iterbar/node";
```

## Versioning

Every top-level protocol message and schema-backed JSON file (`daemon.json`,
`store.lock`, `feedback.json`) carries `schemaVersion: 1`; `.gitignore`,
temporary files and attachment contents are not versioned. `parseMessage`
rejects any other major version with `UnsupportedSchemaVersionError`
(`code: "unsupported_schema_version"`) before checking the shape, and reports
every other mismatch as `InvalidMessageError` (`code: "invalid_message"`).
Unknown properties are dropped, so additive v1 fields are tolerated; breaking
changes ship as a new major version.

## Contents

- **Feedback**: `feedbackSchema` (stored record with replies and status),
  `feedbackDraftSchema` (what the bar sends), targets, source locations,
  screenshot and evidence attachment references.
- **Page registry**: `registrySnapshotSchema`, `variantSelectionSchema`,
  `slotReportSchema`, the `window.__ITERBAR__` page API (`readPageApi`) and the
  `iterbar` URL parameter codec.
- **Daemon**: `daemonInfoSchema` (`daemon.json`), `storeLockSchema`, endpoint
  table, request, response, error and WebSocket event schemas, and token
  transport helpers.
- **Layout**: `iterbarLayout` and, from `iterbar/node`, absolute path helpers
  that refuse unsafe ids. A project root is valid for `absolutePathSchema`
  when it is at most `MAX_ABSOLUTE_PATH_LENGTH` (4096) characters and POSIX
  absolute, or on Windows drive-qualified (`C:\`) or full UNC
  (`\\server\share`), whose server and share names avoid the characters
  Windows forbids (`< > : " | ? *` and controls). The helpers apply that rule
  to both the given root and its normalized form, so every `projectRoot` they
  return passes `absolutePathSchema`. They reject a schema-valid root whose
  normalized form exceeds the bound (Windows appends `\` to a bare UNC share).

Requires Node.js 22.13 or newer for the Node entry point.
