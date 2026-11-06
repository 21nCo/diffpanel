# @iterbar/react

React 18 and 19 bindings for Iterbar.

```tsx
import { Variants } from "@iterbar/react";

<Variants slot="pricing" versions={{ v1: PricingTable, v2: PricingCards }} default="v1" />;
<Variants slot="hero" versions={{ a: <Hero tone="calm" />, b: <Hero tone="bold" /> }} default="a" />;
```

A version is either a component that takes no props (rendered as
`<PricingTable />`; function, class, `memo`, `forwardRef` and `lazy`
components all work) or any React node.

In development (`process.env.NODE_ENV === "development"`), `Variants`
registers the slot with the page's `@iterbar/variants` registry and renders
the version chosen by the `iterbar` URL parameter (`?iterbar=pricing:v2`),
then local storage, then `default`. The Iterbar bar switches it through
`window.__ITERBAR__`, and the slot re-renders in place without a reload.
Switching remounts the slot's content, so versions never share component
state.

`Variants` adds no wrapper element. In development it renders an empty
`<template>` before and after the version, and marks each of the version's
top-level elements with `data-iterbar-slot="pricing"`, following elements the
version later adds or replaces. HTML and React allow `<template>` inside
`<p>`, `<ul>`, `<table>`, `<tbody>` and `<tr>`, so a slot of inline text,
`<li>` or `<tr>` versions stays valid markup and hydrates without errors. A
version whose output has no element (plain text, `null`) has nothing to mark.
The templates are elements, so in development they count for structural
selectors such as `:first-child`.

Slots can nest. The templates carry `data-iterbar-slot-boundary="start"` and
`"end"`, and a slot skips everything between a nested slot's templates, so a
`Variants` rendered at the top level of another slot's version keeps its own
marks: each element is marked with the innermost slot that renders it.

With any other `NODE_ENV`, or none, `Variants` renders the `default` version
only: no templates, no marks, no registry and no `window.__ITERBAR__`. Server
and client must agree on development, or hydration reports a mismatch. Your
bundler must replace `process.env.NODE_ENV`, as it already must for React;
then a development bundle needs no `process` global in the browser, and a
production bundle contains none of the development code (the registry, its
validation and the DOM observers). Without that replacement, `Variants` reads
the `process` global; when there is none, it behaves as in production.

The entry starts with `"use client"`, so React Server Components (for
example the Next.js App Router) can import `Variants` and `VariantsProvider`
and render them as client components. Their props then cross the server to
client boundary, which carries elements but not server functions or class
instances: in a Server Component, pass versions as elements
(`{ v1: <PricingTable />, v2: <PricingCards /> }`) or as components from a
`"use client"` module, and render `VariantsProvider` inside a client
component. A client component can pass any of the version forms above.

Server rendering always renders `default`; after hydration the client
switches to the selected version.

An invalid slot or version name, or a `default` that is not a key of
`versions`, throws an `invalid_message` error during render in development.

`VariantsProvider` makes the components below it use another registry, for
example in tests:

```tsx
import { createVariantsRegistry } from "@iterbar/variants";
import { VariantsProvider } from "@iterbar/react";

<VariantsProvider registry={createVariantsRegistry()}>{app}</VariantsProvider>;
```

Tests run against React 19 and, through `test-support/react-18`, React 18.
