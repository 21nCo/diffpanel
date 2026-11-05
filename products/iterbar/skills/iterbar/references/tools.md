# Iterbar MCP tools

`iterbar mcp` serves these tools over stdio. Each one calls the project's daemon (`iterbar dev`), the only writer of
`.iterbar/`. A successful result carries its data as structured content and as the same JSON in a text block.

## Errors

A failed call is an MCP tool error (`isError: true`) whose structured content is
`{ "error": { "code": "<code>", "message": "<text>" } }`; the text block reads `<code>: <message>`. A failed
`wait_for_feedback` that had got as far as a cursor also carries it, as `cursor` next to `error` (and as JSON on a
second line of the text block); continue with that cursor.

| Code | Meaning | What to do |
| --- | --- | --- |
| `daemon_unavailable` | No daemon serves the project: none was started, it stopped, or `.iterbar/daemon.json` is stale or for another project. | Ask the user to run `iterbar dev` in the project root, then retry. |
| `not_found` | No feedback item (or attachment) has that id. | List again; the id came from somewhere else. |
| `invalid_request` | The input was refused, for example a `cursor` that no tool returned. | Fix the input. |
| `unsupported_schema_version` | The daemon speaks a newer protocol than this server. | Ask the user to update Iterbar. |
| `internal` | Anything unexpected. | Report the message to the user. |

Inputs that do not match a tool's schema (an unknown status, a timeout above 1,800 seconds) are refused by the MCP
server before any daemon call, as an `Input validation error` tool error.

## Feedback items

Every tool that returns feedback returns full items:

- `id`, `kind` (`comment` or `choose_variant`), `status` (`open`, `working`, `needs-info`, `done`, `resolved`),
  `createdAt`, `updatedAt`;
- `text`: the comment, or the optional note of a variant choice; `choice: { slot, version }` for `choose_variant`;
- `pageUrl` and `activeVariants` (`[{ slot, version }]`, the versions shown when it was sent);
- `target`: `null`, or the element: `selector`, `textExcerpt`, `boundingBox` and `sourceLocation`
  (`{ path, line, column }`, project relative, or `null`);
- `screenshot` and `evidence` attachment references (or `null`), and `screenshotUnavailableReason`;
- `replies`: `[{ id, author: { kind: "user" | "agent", name }, text, createdAt }]`, oldest first.

## `list_feedback`

Inputs, all optional: `status`, `kind`, `since` (ISO 8601; items updated at or after it); `cursor` (your latest one,
from `list_feedback` or `wait_for_feedback`).

Result: `{ items, cursor }`, oldest first; with a `cursor` and no filters, also `events` (as in
`wait_for_feedback`): what is new since that cursor. Pass the returned `cursor` to `wait_for_feedback`. It counts as
seen only what you were shown:

- no filters, with a cursor: every listed item is shown, so the cursor moves past all of it;
- filters, with a cursor: your cursor comes back unchanged, so events on items the filters hid (a user's answer on a
  `needs-info` thread while you list `open` ones) are still returned by the next wait;
- without a cursor: the cursor starts now, and everything sent before the call counts as seen.

## `get_feedback`

Inputs: `feedbackId`; `includeAttachments` (default `true`).

Result: `{ feedback, attachments }`, where each attachment is `{ id, kind, mediaType, byteLength, path, inlined }`.
With `includeAttachments`, the content also has the screenshot as an `image` block (PNG) and the evidence as a
`resource` block (JSON text, `file://` URI of its file). Evidence larger than 1 MiB is not inlined; read the file at
its `path` instead. Screenshots are always inlined when attachments are requested; they can be up to the store's
screenshot limit, so pass `includeAttachments: false` and read the `path` when you do not need the image.

## `reply`

Inputs: `feedbackId`, `text` (plain text, not blank, at most 20,000 characters).

Result: `{ feedback }` with the new reply last. The reply's author is `{ kind: "agent", name }`, named after your MCP
client.

## `set_status`

Inputs: `feedbackId`, `status`: `working`, `needs-info`, `done` or `resolved`. Agents never set `open`.

Result: `{ feedback }`. Setting the current status again changes nothing.

## `list_slots`

No inputs. Result: `{ pages }`, one entry per page URL that reported its slots, most recently reported last:
`{ pageUrl, reportedAt, slots: [{ slot, versions, defaultVersion, activeVersion, mounts }] }`. Pages report while
they are open in a browser with the bar; the list is kept in the daemon's memory and starts empty when it restarts.

## `wait_for_feedback`

Inputs: `cursor` (optional, from the previous `list_feedback` or `wait_for_feedback`); `timeoutSeconds` (integer,
default 300, 0 to 1,800).

Blocks until something new arrives after the cursor, or the timeout passes. New means a feedback item was created or
a user replied in a thread. Agent replies and status changes are not new. Without a cursor, the wait first takes a
baseline: it lists the feedback and counts everything in that listing as seen, then lists once more, which returns at
once anything sent after the first listing; anything that lands later is new too, even if it arrives before the wait
is listening for events. From then on, every outcome (and a failure) carries a cursor that resumes from the baseline.

A cursor relies only on the order in which the daemon commits feedback, never on how long a write or a listing takes:
an item that takes long to save is still returned once it is saved.

The wait ends at its timeout however much else changes meanwhile; a daemon request still running then is cut short,
and the returned cursor still covers whatever it would have found. A `timeoutSeconds` of 0 checks once and returns
(within about a second). The one exception is the second baseline listing of a wait without a cursor: it always
finishes (or fails with `daemon_unavailable` after the daemon's 30-second request limit), so that the baseline it
acknowledged is never left without a cursor.

Result: `{ outcome, items, events, cursor }`:

- `outcome`: `feedback` or `timeout`;
- `items`: the items with something new, oldest first (empty on timeout);
- `events`: `[{ feedbackId, kind: "created" | "user_reply", at, replyId? }]`;
- `cursor`: pass it to the next wait. It is missing only when a wait without a cursor timed out before its first
  listing finished, so nothing was counted as seen. Then call `list_feedback` without filters, which shows every
  item, including anything sent meanwhile, and continue with its cursor.

A client that sends a progress token receives a progress notification every 15 seconds while the wait lasts,
so clients that reset their request timeout on progress keep waiting. If the daemon stops during the wait, the call
fails with `daemon_unavailable`. Once `iterbar dev` runs again, wait again with the `cursor` in the failure, or with
the one you passed when the failure has none; if neither exists, start with `list_feedback` without filters.
