/**
 * The bar's only stylesheet, adopted by its shadow root. Nothing here reaches the page, and the page reaches in only
 * through inherited properties and rules on the host element, so:
 *
 * - `:host` resets every property with `!important`. Between a page rule and a `:host` rule that are both
 *   `!important`, the shadow tree's wins, so no page rule can hide, move or restyle the host.
 * - `display: contents` gives the host no box of its own; the bar is a fixed-position child shown in the top layer
 *   (`popover="manual"`), so ancestors that would become its containing block or paint over it have no effect. The
 *   user-agent popover rules (inset, margin, size, border, padding, overflow, colours) are all overridden on `.bar`.
 * - Custom properties are declared on `.bar`, inside the shadow tree, so same-named page variables never apply.
 * - Fonts are system fonts and icons are text: the bar never loads a remote resource.
 */
export const BAR_CSS = String.raw`
:host {
  all: initial !important;
  /* "all" leaves these two alone, so a page's "direction: rtl" would still be inherited. */
  direction: ltr !important;
  unicode-bidi: isolate !important;
  display: contents !important;
}

[hidden] { display: none !important; }

.zoom-probe {
  position: fixed;
  top: 0;
  left: 0;
  width: 100px;
  height: 0;
  visibility: hidden;
  pointer-events: none;
}

.bar {
  --ib-bg: #ffffff;
  --ib-fg: #1b1d21;
  --ib-muted: #5d6470;
  --ib-border: #cfd5de;
  --ib-surface: #f2f4f7;
  --ib-accent: #2f4fd0;
  --ib-accent-fg: #ffffff;
  --ib-focus: #2f4fd0;
  --ib-warn: #8a5a00;
  --ib-shadow: 0 8px 28px rgba(15, 20, 30, 0.2);
  --ib-margin: 12px;
  --ib-offset: 1;
  color-scheme: light;
  position: fixed;
  inset: auto;
  z-index: 2147483647;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100% - 2 * var(--ib-margin)));
  max-width: calc(100% - 2 * var(--ib-margin));
  height: auto;
  max-height: calc(100% - 2 * var(--ib-margin));
  margin: 0;
  padding: 0;
  overflow: visible;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-weight: 400;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  color: var(--ib-fg);
  background: var(--ib-bg);
  border: 1px solid var(--ib-border);
  border-radius: 10px;
  box-shadow: var(--ib-shadow);
  cursor: auto;
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}

@media (prefers-color-scheme: dark) {
  .bar {
    --ib-bg: #1c1f25;
    --ib-fg: #e8eaee;
    --ib-muted: #a3aab6;
    --ib-border: #3a404b;
    --ib-surface: #272b33;
    --ib-accent: #7d97ff;
    --ib-accent-fg: #0d1020;
    --ib-focus: #9cb0ff;
    --ib-warn: #f2c26b;
    --ib-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    color-scheme: dark;
  }
}

/* Its header's one-line width, capped by max-width; "auto" would shrink to the narrowest wrap at the far edge. */
.bar[data-collapsed] { width: max-content; }

.bar[data-edge="top"], .bar[data-edge="bottom"] {
  left: calc(var(--ib-margin) + var(--ib-offset) * (100% - 2 * var(--ib-margin)));
  transform: translateX(calc(var(--ib-offset) * -100%));
}
.bar[data-edge="top"] { top: var(--ib-margin); }
.bar[data-edge="bottom"] { bottom: var(--ib-margin); }
.bar[data-edge="left"], .bar[data-edge="right"] {
  top: calc(var(--ib-margin) + var(--ib-offset) * (100% - 2 * var(--ib-margin)));
  transform: translateY(calc(var(--ib-offset) * -100%));
}
.bar[data-edge="left"] { left: var(--ib-margin); }
.bar[data-edge="right"] { right: var(--ib-margin); }
.bar[data-dragging] {
  top: var(--ib-drag-top);
  left: var(--ib-drag-left);
  right: auto;
  bottom: auto;
  transform: none;
  opacity: 0.9;
}

*, *::before, *::after { box-sizing: border-box; }

/* Wraps rather than overflowing a narrow screen, expanded or collapsed. */
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px;
}
.title { font-weight: 600; margin-right: auto; white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 4px; color: var(--ib-muted); font-size: 12px; white-space: nowrap; }
.status::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ib-muted);
}
.status[data-status="connected"]::before { background: #2e9e5b; }
.status[data-status="retrying"]::before, .status[data-status="connecting"]::before { background: #d69a1d; }
.status[data-status="unauthorized"]::before, .status[data-status="invalid"]::before { background: #d24b4b; }

.body {
  overflow: auto;
  padding: 0 10px 10px;
  border-top: 1px solid var(--ib-border);
}

.section { margin: 10px 0 0; }
.section-title { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ib-muted); }
p { margin: 0 0 6px; }
.muted { color: var(--ib-muted); }
.detail { color: var(--ib-warn); margin-top: 8px; }

button, select {
  font: inherit;
  color: inherit;
  margin: 0;
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}
button[aria-pressed="true"] {
  background: var(--ib-accent);
  border-color: var(--ib-accent);
  color: var(--ib-accent-fg);
}
button[aria-pressed="true"] .muted { color: inherit; }
.icon { padding: 3px 6px; line-height: 1; }
.handle { cursor: grab; touch-action: none; }
.bar[data-dragging] .handle { cursor: grabbing; }

:focus { outline: none; }
:focus-visible {
  outline: 2px solid var(--ib-focus);
  outline-offset: 2px;
}

.field { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.field select { flex: 1; min-width: 0; }
.slot-name strong { font-weight: 600; }
.versions { display: flex; flex-wrap: wrap; gap: 4px; }
.warnings { margin: 6px 0 0; padding-left: 16px; color: var(--ib-warn); font-size: 12px; }

.threads { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.thread details { border: 1px solid var(--ib-border); border-radius: 6px; background: var(--ib-surface); }
.thread summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 6px;
  cursor: pointer;
  list-style: none;
  border-radius: 6px;
}
.thread summary::-webkit-details-marker { display: none; }
.thread-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-count { color: var(--ib-muted); font-size: 11px; white-space: nowrap; }
.thread-body { padding: 4px 8px 8px; }
.thread-full { white-space: pre-wrap; overflow-wrap: anywhere; }
.replies { margin: 0; padding-left: 16px; }
.reply { margin: 0 0 4px; overflow-wrap: anywhere; }
.reply-author { font-weight: 600; margin-right: 4px; }
.badge {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ib-border);
}
.badge[data-status="working"] { background: #d69a1d; color: #1b1300; }
.badge[data-status="needs-info"] { background: #d24b4b; color: #ffffff; }
.badge[data-status="done"], .badge[data-status="resolved"] { background: #2e9e5b; color: #ffffff; }
`;

let shared: CSSStyleSheet | null = null;

/** Gives `root` the bar's stylesheet: one constructed sheet shared by every bar, or a `<style>` element where unsupported. */
export function applyBarStyles(root: ShadowRoot): void {
  if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    if (!shared) {
      shared = new CSSStyleSheet();
      shared.replaceSync(BAR_CSS);
    }
    root.adoptedStyleSheets = [shared];
    return;
  }
  const style = document.createElement("style");
  style.textContent = BAR_CSS;
  root.append(style);
}
