import type { IterbarPageApi } from "iterbar";

declare global {
  interface Window {
    __ITERBAR__?: IterbarPageApi;
  }
}
