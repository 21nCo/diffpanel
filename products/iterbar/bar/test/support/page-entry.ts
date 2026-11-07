// Bundled into the fixture page: the bar and the variants registry, as an app would load them in dev.
import { createVariantsRegistry, getVariantsRegistry, installPageApi } from "@iterbar/variants";
import { BAR_STATE_STORAGE_KEY, BAR_TAG, COMMENT_MODE_EVENT, defineIterbarBar, mountIterbarBar } from "../../src/index.js";

const fixture = {
  BAR_STATE_STORAGE_KEY, BAR_TAG, COMMENT_MODE_EVENT, createVariantsRegistry, defineIterbarBar, getVariantsRegistry,
  installPageApi, mountIterbarBar,
};

declare global {
  interface Window {
    fixture: typeof fixture;
  }
}

window.fixture = fixture;
