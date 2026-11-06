# @iterbar/variants

Framework-neutral slot registry for Iterbar. A slot is a part of the page
with several versions, such as `pricing` with `v1` and `v2`; the registry
decides which version each slot shows and lets the Iterbar bar switch it in
place through `window.__ITERBAR__` (the v1 page API from `iterbar`).

Framework bindings such as `@iterbar/react` use it; you rarely call it
directly. It is meant for development builds only.

```ts
import { getVariantsRegistry, markSlotRange, markSlotRoot } from "@iterbar/variants";

const registry = getVariantsRegistry(); // also installs window.__ITERBAR__
const definition = { slot: "pricing", versions: ["v1", "v2"], defaultVersion: "v1" };
const unregister = registry.register(definition);
const unmark = markSlotRoot(element, "pricing"); // data-iterbar-slot="pricing"
// Or mark every element between two boundary nodes, following later changes:
const unmarkRange = markSlotRange(startTemplate, endTemplate, "pricing");
// Give the boundaries slotBoundaryAttributes("start") and ("end") so an enclosing range skips this one.
const stop = registry.subscribe(() => render(registry.activeVersion(definition)));
```

`markSlotRange` follows the range when it moves to another parent or tree,
including into a shadow root. All ranges in one tree (the document, a shadow
root or a detached fragment) share one observer of that tree, so an unrelated
change is delivered once per tree and only updates the ranges it reaches; the
observer stops when the tree's last range is disposed. While the boundaries
are detached their document is watched too. The one move no observer can
see is inserting boundaries that were removed on their own into a shadow
root: call `unmarkRange.refresh()` afterwards. `@iterbar/react` refreshes
its ranges after every commit.

## Choosing a version

When a slot's first instance registers, its version comes from:

1. the `iterbar` URL parameter, `?iterbar=pricing:v2,hero:b`;
2. the selection stored in local storage under `iterbar:variants`, in the same format;
3. the slot's default.

A URL or stored entry naming a version the slot does not have shows the
default and adds an `unknown_version` warning to the snapshot; a URL entry for
a slot that is not mounted is an `unknown_slot` warning; malformed entries are
`invalid_selection` warnings. Nothing throws, and an unavailable URL or local
storage reads as empty.

`window.__ITERBAR__.select({ schemaVersion: 1, slot, version })` switches a
mounted slot, stores the choice (forgetting the slot when it is the default)
and, when the URL already names the slot, rewrites that URL entry with
`history.replaceState` so a reload keeps the choice. Each value it writes
holds at most 256 selections: local storage is shared by every page of the
origin, so when it is full the earliest other selections are dropped to keep
the new one. The cap applies when writing; longer values are still read, and
a URL that does not name the slot is left as it is.
Subscribers are notified whenever the snapshot changes, including when
remembering a choice drops a malformed URL or stored entry and its warning,
and only then. Unknown slots or versions
and malformed selections leave every slot unchanged and are recorded as
`source: "api"` warnings (the most recent 32).

## Repeated slots

Every `register` call counts one mount and returns an idempotent unregister
function; the snapshot reports `mounts`. Instances of one slot share its
selection. The earliest mounted instance's versions and default define the
slot; an instance that declares others is logged and renders its own default
when the active version is not one of its versions. When the defining
instance unregisters, the next one's definition applies: a version chosen
with `select()` stays while the new definition has it, and otherwise the slot
chooses its version again as on its first registration. So after every instance re-registers with new versions (a hot update,
for example) the slot offers the new versions. The slot leaves the snapshot when its last instance
unregisters and chooses its version again when it next registers.

A definition with an invalid slot or version name, duplicate versions, more
than 64 versions or a default outside its versions throws an
`invalid_message` `IterbarContractError`, as does registering more than 256
slots on one page.
