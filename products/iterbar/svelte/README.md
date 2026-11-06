# @iterbar/svelte

Svelte 5 bindings for Iterbar, for Svelte and SvelteKit apps. Svelte 4 is not
supported.

```svelte
<script>
  import { Variants } from "@iterbar/svelte";
  import PricingTable from "./PricingTable.svelte";
  import PricingCards from "./PricingCards.svelte";
  import Hero from "./Hero.svelte";
</script>

<Variants slot="pricing" versions={{ v1: PricingTable, v2: PricingCards }} default="v1" />

{#snippet calm()}<Hero tone="calm" />{/snippet}
{#snippet bold()}<Hero tone="bold" />{/snippet}
<Variants slot="hero" versions={{ a: { snippet: calm }, b: { snippet: bold } }} default="a" />
```

A version is either a component that takes no props (rendered as
`<PricingTable />`) or `{ snippet }` for any other markup, such as a component
with props, several elements or plain text. Svelte cannot tell a snippet from a
component at runtime, so a snippet goes in an object.

In development (`process.env.NODE_ENV === "development"`), `Variants`
registers the slot with the page's `@iterbar/variants` registry and renders
the version chosen by the `iterbar` URL parameter (`?iterbar=pricing:v2`),
then local storage, then `default`. The Iterbar bar switches it through
`window.__ITERBAR__`, and the slot re-renders in place without a reload.
Switching remounts the slot's content, so versions never share component
state.

The server renders `default` and never touches `window`, local storage or the
registry. Hydration hydrates that `default`, and the client switches to the
selected version right after hydrating, so server and client markup agree. A
client mount without server markup renders the selected version from its
first render, as React's `useSyncExternalStore` does, and new `versions`
without the active one render their default at once. The start `<template>`
carries `data-iterbar-instance`, the `$props.id()` that tells a hydrating
instance from a new one.

`Variants` adds no wrapper element. In development it renders an empty
`<template>` before and after the version, and marks each of the version's
top-level elements with `data-iterbar-slot="pricing"`, following elements the
version later adds or replaces. HTML allows `<template>` inside `<p>`, `<ul>`,
`<table>`, `<tbody>` and `<tr>`, so a slot of inline text, `<li>` or `<tr>`
versions stays valid markup and hydrates without errors. A version whose
output has no element (plain text) has nothing to mark. The templates are
elements, so in development they count for structural selectors such as
`:first-child`.

Slots can nest. The templates carry `data-iterbar-slot-boundary="start"` and
`"end"`, and a slot skips everything between a nested slot's templates, so a
`Variants` rendered at the top level of another slot's version keeps its own
marks: each element is marked with the innermost slot that renders it.

With any other `NODE_ENV`, or none, `Variants` renders the `default` version
only: no templates, no marks, no registry and no `window.__ITERBAR__`. Server
and client must agree on development. Vite, and so SvelteKit, replaces
`process.env.NODE_ENV` in client code; then a development bundle needs no
`process` global in the browser, and a production bundle contains none of the
development code (the registry, its validation and the DOM observers).
Without that replacement, `Variants` reads the `process` global; when there
is none, it behaves as in production.

An invalid slot or version name, or a `default` that is not a key of
`versions`, throws an `invalid_message` error while rendering in development;
on the client a `<svelte:boundary>` catches it.

## `slot` inside another component

Svelte reads a `slot="..."` attribute on a direct child of another component
as legacy slot content, so `<Card><Variants slot="pricing" ... /></Card>`
would hand `Variants` to `Card`'s named slot `pricing` instead of rendering it
in `Card`'s children. Put it inside an element there, or pass the name
through a spread, which Svelte leaves alone:

```svelte
<Card>
  <Variants {...{ slot: "pricing" }} versions={{ v1: PricingTable, v2: PricingCards }} default="v1" />
</Card>
```

Anywhere else, including inside an element or a block such as `{#if}` within
a component's children, `slot="pricing"` works as written.

## Another registry

`VariantsProvider` makes the components below it use another registry, for
example in tests:

```svelte
<script>
  import { createVariantsRegistry } from "@iterbar/variants";
  import { VariantsProvider } from "@iterbar/svelte";
</script>

<VariantsProvider registry={createVariantsRegistry()}>
  <App />
</VariantsProvider>
```

## Package

The package ships its `.svelte` sources (with TypeScript, which Svelte 5
compiles directly) for your Svelte compiler, under the `svelte` export
condition, with type declarations. It needs Svelte 5.57.3 or later; tests run
on that version in jsdom, plus server rendering in Node.js.
