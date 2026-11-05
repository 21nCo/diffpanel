---
name: iterbar
description: Iterate on a web UI with the user through Iterbar, a dev bar that collects comments on page elements and choices between variants. Use when a user asks for several versions of a component or section to compare, to work through or wait for Iterbar feedback, to answer comments left in the dev bar, or to keep a chosen variant and remove the others.
---

# Iterbar

Iterbar lets the user look at a running dev page, switch between versions of a section, point at an element and leave
a comment, or pick a winning version. You read that feedback, change the code, and answer in the same thread; the
user sees your replies and statuses live in the bar.

You reach Iterbar only through the `iterbar` MCP server's tools. Never read or write `.iterbar/` yourself, except to
open an attachment file whose `path` a tool gave you.

## Prerequisites

1. The `iterbar` MCP tools are available (`list_feedback`, `get_feedback`, `reply`, `set_status`, `list_slots`,
   `wait_for_feedback`). If they are not, stop and ask the user to add the server; see
   [references/setup.md](references/setup.md).
2. The daemon runs. Call `list_feedback`. If it fails with error code `daemon_unavailable`, ask the user to run
   `iterbar dev` in the project root (or the app's dev server, when its Iterbar plugin starts the daemon), then
   retry. Do not try to start long-running processes yourself unless the user asks you to.

Read [references/tools.md](references/tools.md) for every tool's inputs, results and errors.

## Create N variants in a slot

A slot is one place in the UI that renders one of several named versions. Only the active version renders; the bar
switches between them in place, and the `iterbar` URL parameter (`?iterbar=pricing:v2`) selects one for a link.

1. Pick a slot name for the section (for example `pricing` or `hero`). Slot and version names are 1 to 64 letters,
   digits, `_`, `.` or `-`, starting with a letter or digit; they must not contain `:` or `,`.
2. Keep the current implementation as the first version, unchanged, so the user can compare against it. Write each
   new version as its own component next to it, named after the version (`PricingV2`, `PricingCompact`).
3. Render them through the framework's Variants component, with the current version as the default. The snippet is
   illustrative: the framework packages are not published yet, so the project's Iterbar setup decides the exact import
   and props; follow what the project already uses.

   ```tsx
   import { Variants } from "@iterbar/react";

   <Variants slot="pricing" versions={{ v1: PricingV1, v2: PricingV2, v3: PricingV3 }} default="v1" />
   ```

   Use the Svelte component in a Svelte app. In production builds `Variants` renders only the default.
4. Make the versions genuinely different in the dimension the user asked about (layout, density, copy, emphasis),
   and keep everything else equal so the comparison is fair. Each version must work on its own: same props, same
   data, no shared state that only one of them sets.
5. Ask the user to open the page. Once it has loaded, `list_slots` shows the slot with its versions; if the slot is
   missing, the page has not rendered it yet or the bar is not on the page.
6. Tell the user which versions exist and what differs between them, then wait for feedback (below).

## Iterate on comments

Work in a loop, one feedback item at a time, oldest first:

1. At the start of a session, before you have a cursor, call `list_feedback` without filters and keep its `cursor`.
   It counts everything listed as seen, so pick out what still needs you: `open` items, `working` items an earlier
   session left unfinished (handle them like open ones), and any other unresolved thread whose last reply is from the
   user (an answer to a `needs-info` question or a follow-up; continue the thread). Afterwards, list with `status: "open"` and your latest `cursor`. A filtered
   listing hands your cursor back unchanged, so a thread the filter hides (such as one waiting in `needs-info`) still
   reaches you through the next wait.
2. For each item, `get_feedback`. Use `target.sourceLocation` (project-relative `path:line:column`), the selector,
   the text excerpt, the screenshot and `activeVariants` to find exactly what the user meant. A comment applies to
   the version that was active when it was sent (`activeVariants`); change that version, not the others, unless the
   user asks otherwise. The evidence attachment holds console, network and error events from around that moment;
   read it when the comment is about broken behavior.
3. `set_status` to `working` before you change code.
4. Make the change. Keep it scoped to what the comment asks.
5. `reply` with what you changed in a sentence or two (file and version), then `set_status` to `done`.
6. When the comment is ambiguous, `reply` with one specific question and `set_status` to `needs-info` instead of
   guessing. Their answer arrives as a user reply in the same thread.
7. When the user says a thread is finished, or you have answered a question that needs no change, `set_status` to
   `resolved`.

When the open items are handled, call `wait_for_feedback` with the latest `cursor` (from `list_feedback` or the
previous wait). It returns when a user sends new feedback or replies in a thread:

- `outcome: "feedback"`: handle each item in `items`; `events` says whether it is new (`created`) or has a new user
  reply (`user_reply` with its `replyId`). Continue with the returned `cursor`.
- `outcome: "timeout"`: nothing arrived. Wait again with the returned `cursor`, or tell the user you are stopping.

Always pass the most recent cursor, to `list_feedback` as well as to `wait_for_feedback`, so nothing sent while you
were working is missed or handed to you twice. Never start over without one once you have it. Your own
replies and status changes never end a wait. The default timeout is 300 seconds and the maximum 1,800; if your client
gives up on long tool calls, use a shorter `timeoutSeconds` and wait again.

If any tool fails with `daemon_unavailable` during the loop, the user stopped the dev server or daemon. Tell them to
run `iterbar dev` again; keep your cursor, and continue with it once it is back. A failed wait may carry a newer
`cursor` next to its error; use that one when it does.

## Collapse to a chosen version

The user picks a winner with a `choose_variant` feedback item (`choice: { slot, version }`, with an optional note in
`text`), or says so in a comment.

1. `set_status` to `working` on the item.
2. Replace the `Variants` element with the chosen version rendered directly. If the chosen version is not the
   original, move its code to where the original lived and give it the original's name, so imports elsewhere keep
   working.
3. Delete the other versions' components, and remove the slot's leftovers: imports, the Variants import if nothing
   else uses it, and test or story files written only for the discarded versions.
4. Check that the project still builds and its tests pass, and that nothing else referenced the deleted versions
   (search for their names).
5. `reply` with the version that was kept and what was removed, then `set_status` to `done`.

Never collapse a slot without an explicit choice from the user.
