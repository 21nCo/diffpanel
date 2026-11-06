import type { SlotState } from "iterbar";
import { DaemonConnection, parseDaemonConfig, type ConnectionStatus } from "./connection.js";
import { h } from "./dom.js";
import {
  BAR_STATE_STORAGE_KEY,
  edgeForKey,
  formatBarState,
  parseBarState,
  placementForDrop,
  type BarState,
} from "./position.js";
import { reportPageUrl, SlotsPanel } from "./slots.js";
import { applyBarStyles } from "./theme.js";
import { ThreadsPanel } from "./threads.js";

/** The bar's tag name. */
export const BAR_TAG = "iterbar-bar";

/** Dispatched on the bar (bubbling, composed) when comment mode turns on or off; `detail.active` is the new state. */
export const COMMENT_MODE_EVENT = "iterbar-comment-mode";

export interface CommentModeEventDetail {
  readonly active: boolean;
}

/** Pointer travel, in CSS pixels, before pressing the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/** Delay that coalesces bursts of registry changes into one slot report. */
const REPORT_DELAY_MS = 150;

const STATUS_TEXT: Readonly<Record<ConnectionStatus["kind"], string>> = {
  unconfigured: "Offline",
  invalid: "Offline",
  connecting: "Connecting…",
  connected: "Connected",
  retrying: "Reconnecting…",
  unauthorized: "Token rejected",
};

function isToggleShortcut(event: KeyboardEvent): boolean {
  // `code`, not `key`: with Alt held, macOS turns the I key into another character.
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyI";
}

function readStoredState(): BarState {
  try {
    return parseBarState(localStorage.getItem(BAR_STATE_STORAGE_KEY));
  } catch {
    return parseBarState(null);
  }
}

// Lets the module load where there is no DOM (a server render importing it by accident); defining the element
// still needs a browser.
const ElementBase: typeof HTMLElement = (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement
  ?? (class {} as unknown as typeof HTMLElement);

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly left: number;
  readonly top: number;
  moved: boolean;
}

/**
 * `<iterbar-bar>`: the Iterbar dev bar. Give it the daemon's URL and token through the `daemonUrl` and `token`
 * properties (or the `daemon-url` and `token` attributes); without them it still switches slots, but shows no
 * feedback. Everything it renders lives in its shadow root.
 */
export class IterbarBarElement extends ElementBase {
  static get observedAttributes(): string[] {
    return ["daemon-url", "token"];
  }

  readonly #root: ShadowRoot;
  readonly #bar: HTMLDivElement;
  readonly #body: HTMLDivElement;
  readonly #status = h("span", { class: "status", role: "status", "data-role": "status" });
  readonly #detail = h("p", { class: "detail", "data-role": "status-detail", hidden: true });
  readonly #handle = h("button", {
    type: "button", class: "icon handle", "data-role": "handle", "aria-label": "Move Iterbar",
    title: "Drag to a screen edge, or press an arrow key to move to that edge",
  }, "⠿");
  readonly #toggle = h("button", { type: "button", class: "icon", "data-role": "toggle", "aria-controls": "iterbar-body" });
  readonly #comment = h("button", {
    type: "button", "data-role": "comment", "aria-pressed": "false", title: "Comment mode",
  }, "Comment");
  /** Inherits the page's effective `zoom`, which the bar cancels; see {@link #fitZoom}. */
  readonly #zoomProbe = h("span", { class: "zoom-probe", "aria-hidden": "true" });
  #zoomObserver: ResizeObserver | null = null;
  readonly #slots: SlotsPanel;
  readonly #threads = new ThreadsPanel();
  #daemonUrl: string | null = null;
  #token: string | null = null;
  #connection: DaemonConnection | null = null;
  /** The daemon URL and token `#connection` was opened with. */
  #connectionKey: string | null = null;
  #reconnectQueued = false;
  #state: BarState = parseBarState(null);
  #commentMode = false;
  #slotsForReport: readonly SlotState[] | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | null = null;
  #drag: DragState | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    applyBarStyles(this.#root);
    this.#slots = new SlotsPanel({ onSlots: (slots) => this.#queueReport(slots) });
    this.#body = h("div", { class: "body", id: "iterbar-body" },
      this.#detail, this.#slots.element, this.#threads.element);
    this.#bar = h("div", { class: "bar", role: "region", "aria-label": "Iterbar", popover: "manual" },
      h("div", { class: "header" },
        this.#handle, h("span", { class: "title" }, "Iterbar"), this.#status, this.#comment, this.#toggle),
      this.#body);
    this.#root.append(this.#zoomProbe, this.#bar);

    this.#toggle.addEventListener("click", () => this.#setCollapsed(!this.#state.collapsed));
    this.#comment.addEventListener("click", () => {
      this.commentMode = !this.#commentMode;
    });
    this.#handle.addEventListener("keydown", (event) => this.#moveWithKey(event));
    this.#handle.addEventListener("pointerdown", (event) => this.#dragStart(event));
    this.#handle.addEventListener("pointermove", (event) => this.#dragMove(event));
    this.#handle.addEventListener("pointerup", (event) => this.#dragEnd(event, true));
    this.#handle.addEventListener("pointercancel", (event) => this.#dragEnd(event, false));
    this.#applyState();
    this.#renderStatus({ kind: "unconfigured" });
  }

  /** `http://127.0.0.1:<port>` of the daemon. */
  get daemonUrl(): string | null {
    return this.#daemonUrl;
  }

  set daemonUrl(value: string | null) {
    this.#daemonUrl = value ?? null;
    this.#queueReconnect();
  }

  /** The daemon's per-start token. It is never written to an attribute. */
  get token(): string | null {
    return this.#token;
  }

  set token(value: string | null) {
    this.#token = value ?? null;
    this.#queueReconnect();
  }

  /** Whether comment mode is on. Changing it dispatches {@link COMMENT_MODE_EVENT}. */
  get commentMode(): boolean {
    return this.#commentMode;
  }

  set commentMode(value: boolean) {
    const active = Boolean(value);
    if (active === this.#commentMode) return;
    this.#commentMode = active;
    this.#comment.setAttribute("aria-pressed", String(active));
    this.dispatchEvent(new CustomEvent<CommentModeEventDetail>(COMMENT_MODE_EVENT, {
      bubbles: true, composed: true, detail: { active },
    }));
  }

  /** Whether only the header is shown. Alt+Shift+I toggles it from anywhere on the page. */
  get collapsed(): boolean {
    return this.#state.collapsed;
  }

  set collapsed(value: boolean) {
    this.#setCollapsed(Boolean(value));
  }

  attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === "daemon-url") this.#daemonUrl = value;
    else if (name === "token") this.#token = value;
    this.#queueReconnect();
  }

  connectedCallback(): void {
    // Properties set on the element before it was upgraded are own properties that hide the accessors.
    for (const property of ["daemonUrl", "token", "commentMode"] as const) {
      if (!Object.prototype.hasOwnProperty.call(this, property)) continue;
      const value = (this as Record<string, unknown>)[property];
      delete (this as Record<string, unknown>)[property];
      (this as Record<string, unknown>)[property] = value;
    }
    this.#state = readStoredState();
    this.#applyState();
    this.#raise();
    this.#watchZoom();
    window.addEventListener("keydown", this.#onKeydown, true);
    this.#slots.attach();
    this.#reconnect();
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.#onKeydown, true);
    this.#zoomObserver?.disconnect();
    this.#zoomObserver = null;
    this.#slots.detach();
    this.#connection?.stop();
    this.#connection = null;
    if (this.#reportTimer) clearTimeout(this.#reportTimer);
    this.#reportTimer = null;
    this.#cancelDrag();
  }

  readonly #onKeydown = (event: KeyboardEvent): void => {
    if (!isToggleShortcut(event) || event.repeat) return;
    event.preventDefault();
    const focusInside = this.#root.activeElement !== null;
    this.#setCollapsed(!this.#state.collapsed);
    // Expanding moves focus into the bar so keyboard users can carry on; collapsing keeps focus off hidden controls.
    if (!this.#state.collapsed || focusInside) this.#toggle.focus();
  };

  /**
   * Shows the bar in the top layer, outside every page stacking context and containing block, so a `transform`,
   * `filter`, `opacity`, `contain` or `will-change` on an ancestor cannot move, clip or hide it. Removing the element
   * from the page takes it out of the top layer, so this runs on every connect. Without popover support the bar stays
   * an ordinary fixed-position element.
   */
  #raise(): void {
    const bar = this.#bar;
    if (typeof bar.showPopover !== "function" || bar.matches(":popover-open")) return;
    try {
      bar.showPopover();
    } catch {
      // Left as a fixed-position element.
    }
  }

  /** The top layer still inherits `zoom`, so the bar applies the inverse of what the page gives it. */
  #fitZoom(): void {
    const zoom = (this.#zoomProbe as { currentCSSZoom?: number }).currentCSSZoom;
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return;
    this.#bar.style.zoom = zoom === 1 ? "" : String(1 / zoom);
  }

  /** Refits on every change of the page's zoom, which changes the probe's size in device pixels. */
  #watchZoom(): void {
    this.#fitZoom();
    if (this.#zoomObserver || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => this.#fitZoom());
    try {
      observer.observe(this.#zoomProbe, { box: "device-pixel-content-box" });
    } catch {
      // Without device-pixel boxes the zoom is fitted once per connect.
      return;
    }
    this.#zoomObserver = observer;
  }

  #queueReconnect(): void {
    if (this.#reconnectQueued) return;
    this.#reconnectQueued = true;
    queueMicrotask(() => {
      this.#reconnectQueued = false;
      if (this.isConnected) this.#reconnect();
    });
  }

  /** Opens a connection for the current URL and token, unless one for them is already open. */
  #reconnect(): void {
    const key = JSON.stringify([this.#daemonUrl, this.#token]);
    if (this.#connection && key === this.#connectionKey) return;
    this.#connection?.stop();
    this.#connection = null;
    // Threads belong to the daemon that listed them; another daemon (or none) must not show them.
    if (key !== this.#connectionKey) this.#threads.clear();
    this.#connectionKey = key;
    const parsed = parseDaemonConfig(this.#daemonUrl, this.#token);
    if (!parsed.ok) {
      this.#renderStatus(parsed.status);
      return;
    }
    const connection = new DaemonConnection(parsed.config, {
      onStatus: (status) => {
        if (this.#connection === connection) this.#renderStatus(status);
      },
      onFeedback: (items) => {
        if (this.#connection === connection) this.#threads.merge(items);
      },
      onListing: (items, touched) => {
        if (this.#connection === connection) this.#threads.replace(items, touched);
      },
    });
    this.#connection = connection;
    connection.start();
    if (this.#slotsForReport) this.#queueReport(this.#slotsForReport);
  }

  #renderStatus(status: ConnectionStatus): void {
    this.#status.dataset.status = status.kind;
    this.#status.textContent = STATUS_TEXT[status.kind];
    const detail = "message" in status ? status.message
      : status.kind === "unconfigured" ? "No daemon URL and token were given, so feedback is unavailable." : "";
    this.#detail.textContent = detail;
    this.#detail.hidden = !detail;
  }

  #queueReport(slots: readonly SlotState[]): void {
    this.#slotsForReport = slots;
    if (this.#reportTimer || !this.#connection) return;
    this.#reportTimer = setTimeout(() => {
      this.#reportTimer = null;
      const pageUrl = reportPageUrl(location.href);
      if (pageUrl && this.#slotsForReport) this.#connection?.reportSlots(pageUrl, this.#slotsForReport);
    }, REPORT_DELAY_MS);
  }

  #setCollapsed(collapsed: boolean): void {
    if (collapsed === this.#state.collapsed) return;
    this.#saveState({ ...this.#state, collapsed });
  }

  #saveState(state: BarState): void {
    this.#state = state;
    this.#applyState();
    try {
      localStorage.setItem(BAR_STATE_STORAGE_KEY, formatBarState(state));
    } catch {
      // Without storage the position simply is not remembered.
    }
  }

  #applyState(): void {
    const { edge, offset, collapsed } = this.#state;
    this.#bar.dataset.edge = edge;
    this.#bar.style.setProperty("--ib-offset", String(offset));
    this.#bar.toggleAttribute("data-collapsed", collapsed);
    this.#body.hidden = collapsed;
    this.#toggle.setAttribute("aria-expanded", String(!collapsed));
    this.#toggle.setAttribute("aria-label", collapsed ? "Expand Iterbar" : "Collapse Iterbar");
    this.#toggle.title = `${collapsed ? "Expand" : "Collapse"} (Alt+Shift+I)`;
    this.#toggle.textContent = collapsed ? "▴" : "▾";
  }

  #moveWithKey(event: KeyboardEvent): void {
    const edge = edgeForKey(event.key);
    if (!edge || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (edge !== this.#state.edge) this.#saveState({ ...this.#state, edge });
  }

  #dragStart(event: PointerEvent): void {
    if (event.button !== 0 || this.#drag) return;
    const box = this.#bar.getBoundingClientRect();
    this.#drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: box.left, top: box.top, moved: false };
    this.#handle.setPointerCapture(event.pointerId);
  }

  #dragMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.#bar.toggleAttribute("data-dragging", true);
    this.#bar.style.setProperty("--ib-drag-left", `${drag.left + dx}px`);
    this.#bar.style.setProperty("--ib-drag-top", `${drag.top + dy}px`);
  }

  #dragEnd(event: PointerEvent, drop: boolean): void {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const box = this.#bar.getBoundingClientRect();
    this.#cancelDrag();
    if (!drop || !drag.moved) return;
    const placement = placementForDrop(box, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    this.#saveState({ ...this.#state, ...placement });
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = null;
    this.#bar.removeAttribute("data-dragging");
    this.#bar.style.removeProperty("--ib-drag-left");
    this.#bar.style.removeProperty("--ib-drag-top");
    if (drag && this.#handle.hasPointerCapture(drag.pointerId)) this.#handle.releasePointerCapture(drag.pointerId);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [BAR_TAG]: IterbarBarElement;
  }
  interface HTMLElementEventMap {
    [COMMENT_MODE_EVENT]: CustomEvent<CommentModeEventDetail>;
  }
}

/** Registers `<iterbar-bar>` once per page; later calls (from any copy of this package) are no-ops. */
export function defineIterbarBar(): CustomElementConstructor {
  const existing = customElements.get(BAR_TAG);
  if (existing) return existing;
  customElements.define(BAR_TAG, IterbarBarElement);
  return IterbarBarElement;
}

export interface MountIterbarBarOptions {
  /** `http://127.0.0.1:<port>` of the daemon. */
  readonly daemonUrl?: string | null;
  /** The daemon's per-start token. */
  readonly token?: string | null;
  /** Where to add the bar when the page has none; defaults to `document.body`. */
  readonly target?: Element;
}

/**
 * Defines the element and shows one bar on the page: the existing `<iterbar-bar>` when there is one (given the new
 * daemon URL and token), otherwise a new one appended to `target`.
 */
export function mountIterbarBar(options: MountIterbarBarOptions = {}): IterbarBarElement {
  defineIterbarBar();
  const bar = document.querySelector(BAR_TAG) ?? document.createElement(BAR_TAG);
  bar.daemonUrl = options.daemonUrl ?? null;
  bar.token = options.token ?? null;
  if (!bar.isConnected) (options.target ?? document.body ?? document.documentElement).append(bar);
  return bar;
}
