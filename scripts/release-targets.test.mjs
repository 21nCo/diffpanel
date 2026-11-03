import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("every release target has a publish tag trigger and a matching public package", async () => {
  const targets = await readJson("release-packages.json");
  const workflow = await readFile(new URL(".github/workflows/publish-tag.yml", root), "utf8");
  const triggers = [...workflow.matchAll(/^\s+- '([a-z0-9-]+)-v\*\.\*\.\*'$/gm)].map((match) => match[1]);

  assert.deepEqual([...triggers].sort(), targets.map((target) => target.slug).sort());
  for (const target of targets) {
    const manifest = await readJson(`${target.path}/package.json`);
    assert.equal(manifest.name, target.name, `${target.path} must publish as ${target.name}`);
    assert.notEqual(manifest.private, true, `${target.name} must not be private`);
    assert.equal(manifest.repository?.directory, target.path, `${target.name} repository.directory must be ${target.path}`);
  }
});
