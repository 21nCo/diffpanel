import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);
const harness = createRequire(require.resolve("@iterbar/react-18-test-harness/package.json"));
const react18 = (name: string) => dirname(harness.resolve(`${name}/package.json`));

export default defineConfig({
  test: {
    environment: "jsdom",
    projects: [
      { extends: true, test: { name: "react-19", env: { ITERBAR_TEST_REACT_MAJOR: "19" } } },
      {
        extends: true,
        test: { name: "react-18", env: { ITERBAR_TEST_REACT_MAJOR: "18" } },
        // Point every React import, including Testing Library's, at the harness's React 18 install.
        resolve: {
          alias: [
            { find: /^react$/, replacement: react18("react") },
            { find: /^react\/(.*)$/, replacement: `${react18("react")}/$1` },
            { find: /^react-dom$/, replacement: react18("react-dom") },
            { find: /^react-dom\/(.*)$/, replacement: `${react18("react-dom")}/$1` },
            { find: /^@testing-library\/react$/, replacement: react18("@testing-library/react") },
          ],
        },
      },
    ],
  },
});
