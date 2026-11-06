# @iterbar/bar

The Iterbar dev bar: `<iterbar-bar>`, a framework-free custom element that
renders in its own shadow root. It is meant for development pages only; the
Vite plugin injects it with the daemon's address and token.

```ts
import { mountIterbarBar } from "@iterbar/bar";

// Defines <iterbar-bar> and adds one to document.body (or reuses the page's).
const bar = mountIterbarBar({ daemonUrl: "http://127.0.0.1:41234", token });
bar.addEventListener("iterbar-comment-mode", (event) => console.log(event.detail.active));
```

`defineIterbarBar()` only registers the element. You can then set the
`daemonUrl` and `token` properties, or the `daemon-url` and `token`
attributes. The bar never writes the token to an attribute.

## What it shows

- **Slots** on the current page, read through the `window.__ITERBAR__` page
  API that `@iterbar/variants` installs. When the bar loads before the
  registry, it waits until the registry appears. With one slot the bar shows
  its name; with more than one, a dropdown chooses which slot's versions to
  show. Choosing a version calls `select()`. Once the registry shows that
  version, the bar writes `slot:version` into the `iterbar` URL parameter with
  `history.replaceState`, keeping every other parameter and the fragment. The
  bar also reports the page's slots to the daemon (`POST /slots`) under the
  page URL without its fragment or `iterbar` parameter.
- **Comment mode**: a toggle button. It sets `commentMode` and dispatches the
  `iterbar-comment-mode` event (bubbling and composed). It does not yet pick
  elements or send comments.
- **Feedback threads**, newest first, with status and replies. The bar lists
  them with `GET /feedback` each time the `/events` WebSocket opens, then
  applies `feedback.created` and `feedback.updated` events as they arrive. It
  keeps whichever copy of an item has the later `updatedAt`, and ignores
  events that are malformed or from another schema version.

## Connection

The daemon URL must be `http://127.0.0.1:<port>` with nothing after it, and
the token must be 64 lowercase hex characters; otherwise the bar never sends
a request. Without either value, it still switches slots and shows that
feedback is unavailable.

If the event stream drops, the bar reconnects with backoff (1 s up to 30 s)
and lists the threads again. A page whose origin is not registered with
`POST /origins` cannot read any daemon response, so it keeps retrying and
says so. A rejected token (`401`) stops the bar until it gets a new token.
Removing the element closes the stream and cancels every timer.

## Layout, keyboard and styling

- **Alt+Shift+I** collapses or expands the bar from anywhere on the page.
  Expanding moves focus to the bar's toggle.
- Every control is a native button, select or summary, so it can be reached
  with Tab, and each one shows a focus ring.
- Drag the handle (⠿) to dock the bar to any screen edge, or focus the handle
  and press an arrow key. The edge, the position along it and whether the bar
  is collapsed are saved in local storage under `iterbar:bar`, so each origin
  remembers its own.
- Styles stay inside the shadow root. The host resets every inherited
  property with `!important`, which a page rule cannot override, so page CSS
  cannot hide, move or restyle the bar.
- Light and dark themes follow `prefers-color-scheme`.
- The bar never loads a remote resource. It uses system fonts and text
  icons, and its only network traffic goes to the daemon.

## Tests

- `pnpm test`: unit tests for placement, merging and URL handling.
- `pnpm test:browser`: Playwright tests in Chromium, against a fake daemon
  built from Playwright routes and against the real daemon from
  `@iterbar/cli`. Install the browser once with
  `pnpm exec playwright install chromium`.
