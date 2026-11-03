# Devroll

Devroll is a monorepo of developer tools from 21n that share code. Each tool keeps its own name, packages and docs; code that two or more tools need lives once in `packages/`.

## Tools

| Tool | What it does | Packages | Docs |
| --- | --- | --- | --- |
| Diffpanel | Local-first, agent-generated code review chapters across editor surfaces | `diffpanel`, `@diffpanel/*` | [products/diffpanel](products/diffpanel/README.md) |
| Iterbar (planned) | Dev-mode bar for switching design variants, annotating UI and sending feedback with runtime evidence to local coding agents | `iterbar` | |

## Layout

```text
packages/
  devroll/            the `devroll` npm package: the catalog of Devroll tools
  <shared>/           shared `@devroll/*` packages used by more than one tool
products/
  diffpanel/          Diffpanel's CLI, VS Code extension, packages and agent skill
  <tool>/             one directory per tool
scripts/              release and package-verification scripts
```

A tool joins this repository when it shares runtime code with a tool already here. General-purpose building blocks that other developers would add to their own apps belong in Superfunctions instead, and Devroll tools depend on them as ordinary packages.

## Development

Devroll uses Node.js 22.13 or newer and pnpm (pinned through `packageManager`).

```bash
nvm use
pnpm install
pnpm validate
```

`pnpm validate` lints, typechecks, tests and builds every workspace, then packs the public packages and installs them in a clean external consumer. The **Verify** workflow runs the same command on every pull request and on `main`.

## Publishing packages

Public packages are released by pushing a package-specific version tag in the form `<slug>-v<version>`. The **Publish tagged package** workflow resolves the slug through `release-packages.json`, checks that the tag matches the package's exact `package.json` version, builds and tests that package, verifies its tarball in a clean consumer and publishes it with the `NPM_TOKEN` secret. Prerelease versions (for example `0.1.0-beta.1`) publish under the `next` dist-tag.

```bash
git tag devroll-v0.0.1
git push origin devroll-v0.0.1
```

To add a package to the release flow, add it to `release-packages.json` and add its `<slug>-v*.*.*` trigger to `.github/workflows/publish-tag.yml`; `scripts/release-targets.test.mjs` fails when the two drift apart. A failed run can be retried from the workflow's manual dispatch with the existing tag.
