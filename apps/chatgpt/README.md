# Diffpanel for ChatGPT

A read-only MCP adapter and MCP Apps frontend for existing published Diffpanel
reviews. The thread entrypoint opens the viewer beside a ChatGPT conversation.
It reuses the browser-safe `diffpanel` and `@diffpanel/presentation` contracts and
the existing browser-only React evidence, coverage, and sanitized diagram
components. Git, filesystem access, hashing, and SQLite stay in the Node server.

## Build and authorize a local connection

Use Node 22.13+ and build from the monorepo root:

```sh
pnpm install
pnpm exec turbo run build --filter=@diffpanel/chatgpt...
diffpanel list --limit 20
```

Set an explicit library path and **only the run IDs you intend to share**:

```sh
export DIFFPANEL_HOME="/absolute/path/to/Diffpanel"
export DIFFPANEL_RUN_IDS="saved-run-id,another-authorized-run-id"
node apps/chatgpt/dist/server.js
```

The server uses stdio exclusively and refuses to start without both settings.
The run allowlist applies to every list/open/evidence request. There is no
arbitrary file, shell, capture, publish, or Git operation. Tunnel organization
and ChatGPT workspace permissions authorize the service connection; the
allowlist limits which saved code it exposes through that connection. A shared
workspace tunnel is accessible to its authorized operators, so use a private
development association for personal reviews. This is a single-owner local
adapter, not a multi-user hosted authorization system.

List pages contain at most 50 summaries and opaque process-local cursors. An
empty page can still have a next page; a service restart expires page cursors.
Refresh the library to start again.

## Connect to ChatGPT through Secure MCP Tunnel

1. Verify the intended signed-in account/client exposes developer-mode MCP apps
   and thread entrypoints. Current rollout and workspace policy determine
   availability.
2. Create a development tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
   and associate it with the intended ChatGPT workspace and Platform
   organization. A Platform-only association does not automatically grant
   another ChatGPT workspace access.
3. Download the current `tunnel-client` from its [latest release](https://github.com/openai/tunnel-client/releases/latest)
   and verify its published checksum. Create a runtime API key with Tunnels
   **Read + Use**; tunnel creation requires **Read + Manage**. Keep the runtime
   key outside the repository and use the client's `file:/absolute/path` secret
   reference or its documented environment-variable mechanism.
4. Create a local stdio profile. If using a managed runtime, an explicit launcher
   should set `DIFFPANEL_HOME` and `DIFFPANEL_RUN_IDS` and `exec` Node with the
   absolute built-server path; do not assume a daemon inherits terminal exports.

```sh
tunnel-client init --sample sample_mcp_stdio_local --profile diffpanel \
  --tunnel-id YOUR_TUNNEL_ID --mcp-command "/absolute/path/to/authorized-launcher"
tunnel-client doctor --profile diffpanel --explain
tunnel-client run --profile diffpanel
```

For long-lived supervision, use `tunnel-client runtimes connect` and verify
`runtimes status` reports a running, healthy, ready runtime. Keep it running
through connection discovery and every review request.

5. In [ChatGPT Plugins](https://chatgpt.com/plugins), use **Add → Create MCP App**
   (labels may vary by rollout), choose **Tunnel**, and select the development
   tunnel. This adapter delegates connection authorization to the tunnel;
   select **No authentication** for the additional server OAuth layer. Do not
   use that setting for an exposed public server.
6. Discover the four read-only tools and `ui://diffpanel/review.html`. Open
   Diffpanel from the conversation panel entrypoint. Select an authorized saved
   review and verify chapters, evidence, diagrams, and saved file sides.
7. After tool/resource changes restart the server/runtime, refresh the MCP
   connection metadata in ChatGPT, and use a new test conversation.

## Package the complete personal test plugin

`plugins/diffpanel` contains the portable manifest and read-only workflow skill.
Its source `.app.json` is deliberately empty: a registered connection is
account-specific. Copy the real `plugin_asdk_app_...` identifier from the newly
created ChatGPT MCP connection URL, then package:

```sh
pnpm --filter @diffpanel/chatgpt package:plugin --app-id YOUR_REAL_PLUGIN_ASDK_APP_ID
```

The output `apps/chatgpt/dist/diffpanel-plugin.zip` contains the manifest, skill,
and populated registered MCP mapping. It contains neither source snapshots nor
credentials and does not deploy a service. On web clients offering **Upload
plugin archive**, upload that archive and install it as a personal test plugin.
Local/repository marketplace availability differs by client; the ChatGPT
desktop app also supports repo/personal marketplaces. Test the installed
combined skill-and-MCP workflow, not only the raw MCP connection.

Secure MCP Tunnel is for private connections/developer testing. Public directory
submission requires a stable public HTTPS MCP endpoint and its own access
design. Public submission, workspace publication, generation, capture, sidebar
entrypoints, and file handlers are separate scope and approval gates.

## Immutable selection and limits

- Run, snapshot, chapter, and item identity are preserved. A SHA-256 revision
  pins the saved manifest and generated review together; republishing chapters
  invalidates evidence reads until the user explicitly reopens the review.
- Evidence comes only from run-referenced, hash-verified saved blobs. Renames
  show their old path, and additions/deletions preserve absent sides as `null`.
- Review payloads are limited to 2 MiB and each saved file side to 512 KiB.
  Binary/non-UTF-8, unavailable, unauthorized, changed-revision, and oversized
  evidence have explicit error states; a saved patch remains viewable when full
  file rendering is unavailable.
- Diff computation has a time/edit-distance budget and renders at most 300
  display rows per page. Saved before/after views remain available if the diff
  budget is exceeded. File/hunk lists reuse existing pagination.
- Selected context is limited to 8,000 characters, identifies the pinned run
  and revision, and marks truncation. It shares focused chapter explanations or
  the selected item's saved patch, rather than the entire code library.
- OpenAI model-context extensions are feature-detected, then standard MCP Apps
  context sharing is used when supported. A host-independent textarea
  provides manual context fallback. Selection updates are serialized and stale
  evidence results are discarded. Returning to the library clears context.
- Diagrams use existing conservative source policy, strict Mermaid rendering,
  and SVG sanitization. The self-contained UI declares no network domains.

## Verification and live acceptance

```sh
pnpm validate
pnpm --filter @diffpanel/chatgpt exec playwright install chromium
pnpm --filter @diffpanel/chatgpt test:browser
```

The adapter tests cover authorization, immutable saved reads, changed revisions,
binary/oversized evidence, bounded context, and actual MCP tool/resource calls.
Local iframe tests exercise chapter navigation, diagrams, saved diffs, context,
manual fallback, and stale-selection responses. They are not ChatGPT acceptance.

The opt-in `browser-tests/chatgpt.spec.ts` tests the real installed panel and a
model follow-up. Use a dedicated test conversation in a signed-in browser whose
CDP access you control, with the installed plugin and chosen review panel open.
Supply:

- `CHATGPT_CDP_URL`: that browser's loopback CDP endpoint.
- `CHATGPT_TEST_URL`: the exact dedicated test conversation URL already open.
- `CHATGPT_COMPOSER_SELECTOR` and `CHATGPT_ASSISTANT_SELECTOR`: current inspected
  composer and assistant-message selectors for this client's rollout.
- `DIFFPANEL_HOME` and `DIFFPANEL_TEST_RUN_ID`: the explicitly authorized saved
  run used by the connected service.

The test checks saved sides against local immutable blobs, waits for the host
context acknowledgement, and asks ChatGPT to identify the current run,
snapshot, revision, and item without tool calls or identifiers in the prompt.
It adds one evaluation message to that dedicated conversation. Missing live
settings skip the test; a skip never establishes acceptance.

Also record a live evaluation for: chapter/diagram navigation; denied run
requests; an unavailable service; negative edit/capture requests; skill
activation after installing the complete archive; and the fallback on a host
without context support. Retain the tested account/client, connection ID,
runtime readiness, immutable identifiers, prompts/results, and failures in a
private validation record. Do not claim completion based only on local builds.

There are no storage migrations. Roll back by disabling/uninstalling the
personal plugin and stopping its runtime, preserving the saved Diffpanel
library. Revoke development runtime credentials and remove unused test tunnels
when testing ends.
