# @iterbar/react

React 18 and 19 bindings for Iterbar.

```tsx
import { Variants } from "@iterbar/react";

<Variants slot="pricing" versions={{ v1: <PricingTable />, v2: <PricingCards /> }} default="v1" />;
```

In development (`process.env.NODE_ENV !== "production"`), `Variants`
registers the slot with the page's `@iterbar/variants` registry and renders
the version chosen by the `iterbar` URL parameter (`?iterbar=pricing:v2`),
then local storage, then `default`. The Iterbar bar switches it through
`window.__ITERBAR__`, and the slot re-renders in place without a reload. The
content is wrapped in a `<div style="display: contents">` marked with
`data-iterbar-slot="pricing"`; switching remounts the slot's content, so
versions never share component state.

In production `Variants` renders the `default` version only: no wrapper, no
registry and no `window.__ITERBAR__`. Your bundler must replace
`process.env.NODE_ENV`, as it already must for React; without that
replacement and without a `process` global, `Variants` behaves as in
production.

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
