import assert from "node:assert/strict";
import test from "node:test";
import { npmTagForVersion } from "./release-version.mjs";

test("only prerelease identifiers select the npm next tag", () => {
  assert.equal(npmTagForVersion("0.0.2"), "latest");
  assert.equal(npmTagForVersion("0.0.2+build-5"), "latest");
  assert.equal(npmTagForVersion("0.0.2-rc.1"), "next");
  assert.equal(npmTagForVersion("0.0.2-rc.1+build-5"), "next");
});
