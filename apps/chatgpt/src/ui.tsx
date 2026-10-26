import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { chapterItemRefs, chapterLabels } from "@diffpanel/presentation";
import { reviewManifestSchema, reviewFileSchema, reviewItemSchema, assertGeneratedReview } from "diffpanel";
import { diffLines } from "diff";
import { Diagram } from "../../vscode/src/webview/diagram.js";
import { ReviewEvidence } from "../../vscode/src/webview/review-evidence.js";
import { CaptureCoverage } from "../../vscode/src/webview/review-overview.js";
import { TOOLS } from "./contracts.js";
import type { OpenReview, ReviewSummary, SavedEvidence } from "./contracts.js";
import { selectedContext } from "./context.js";

const host = new App({ name: "Diffpanel", version: "0.1.0" });
const extensions = new OpenAIExtensions(host);
type Page = { runs: ReviewSummary[]; nextCursor: string | null };

function decodeRun(value: unknown): OpenReview {
  const run = value as OpenReview;
  const manifest = reviewManifestSchema.parse(run.manifest);
  const review = assertGeneratedReview(manifest, run.review);
  if (run.summary.runId !== manifest.runId || !/^[a-f0-9]{64}$/.test(run.revision)) throw new Error("The service returned an invalid saved review.");
  return { ...run, manifest, review };
}

function ReviewPanel() {
  const [connected, setConnected] = useState(false);
  const [library, setLibrary] = useState<Page>({ runs: [], nextCursor: null });
  const [run, setRun] = useState<OpenReview | null>(null);
  const [pendingRun, setPendingRun] = useState<OpenReview | null>(null);
  const [chapterId, setChapterId] = useState<string>();
  const [evidence, setEvidence] = useState<SavedEvidence | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [contextStatus, setContextStatus] = useState("Connect to ChatGPT to share context.");
  const [fallback, setFallback] = useState("");
  const currentRun = useRef<OpenReview | null>(null);
  const selection = useRef(0);
  const queue = useRef(Promise.resolve());

  function share(next: OpenReview | null, chapter?: string, item?: SavedEvidence) {
    const token = selection.current;
    const context = next ? selectedContext(next, chapter, item) : { content: [{ type: "text" as const, text: "Diffpanel selection cleared. Do not assume a previously selected review or item remains active." }], structuredContent: { runId: null } };
    setFallback(context.content[0]!.text);
    setContextStatus("Updating selected context…");
    queue.current = queue.current.catch(() => {}).then(async () => {
      if (token !== selection.current) return;
      try {
        if (extensions.modelContext) await extensions.modelContext.update(context);
        else if (host.getHostCapabilities()?.updateModelContext) await host.updateModelContext(context);
        else throw new Error("Unsupported context sharing");
        if (token === selection.current) setContextStatus("Selected saved evidence shared with ChatGPT.");
      } catch {
        if (token === selection.current) setContextStatus("This host cannot share context. Copy the selected context below into your message.");
      }
    });
  }

  function selectRun(next: OpenReview) {
    selection.current++;
    currentRun.current = next;
    setRun(next); setPendingRun(null); setChapterId(undefined); setEvidence(null); setSelectedItemId(undefined); setError(undefined); setBusy(false);
    share(next);
  }

  async function call(name: string, args: Record<string, unknown>) {
    const result = await host.callServerTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content?.find((part) => part.type === "text")?.text ?? "Service unavailable.");
    return result._meta?.diffpanel ?? result.structuredContent;
  }

  useEffect(() => {
    let active = true;
    function theme(context: ReturnType<App["getHostContext"]>) {
      if (context?.theme) applyDocumentTheme(context.theme);
      if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    }
    host.onhostcontextchanged = theme;
    host.ontoolresult = (result) => {
      if (!active) return;
      try {
        if (result.isError) throw new Error(result.content?.find((part: { type: string; text?: string }) => part.type === "text")?.text ?? "Unable to open review.");
        const data = (result._meta?.diffpanel ?? result.structuredContent) as { manifest?: unknown; library?: Page; runs?: ReviewSummary[]; nextCursor?: string | null } | undefined;
        if (data?.manifest) {
          const next = decodeRun(data);
          if (currentRun.current && (currentRun.current.summary.runId !== next.summary.runId || currentRun.current.revision !== next.revision)) setPendingRun(next);
          else selectRun(next);
        } else if (data?.library) setLibrary(data.library);
        else if (data?.runs) setLibrary({ runs: data.runs, nextCursor: data.nextCursor ?? null });
      } catch (failure) { setError(failure instanceof Error ? failure.message : "Invalid service response."); }
    };
    void host.connect().then(() => { if (active) { setConnected(true); theme(host.getHostContext()); } }).catch(() => { if (active) setError("ChatGPT's MCP Apps bridge is unavailable. Reopen this panel from the connected Diffpanel plugin."); });
    return () => { active = false; host.onhostcontextchanged = undefined; };
  }, []);

  useEffect(() => {
    if (connected && currentRun.current) share(currentRun.current);
  }, [connected]);

  async function loadLibrary(cursor?: string) {
    const token = ++selection.current;
    setBusy(true); setError(undefined);
    try {
      const data = await call(TOOLS.list, { limit: 20, ...(cursor ? { cursor } : {}) }) as Page;
      if (token === selection.current) setLibrary(data);
    } catch (failure) { if (token === selection.current) setError((failure as Error).message); }
    finally { if (token === selection.current) setBusy(false); }
  }
  async function open(runId: string) {
    const token = ++selection.current;
    setBusy(true); setError(undefined);
    try {
      const data = await call(TOOLS.open, { runId });
      if (token === selection.current) selectRun(decodeRun(data));
    } catch (failure) { if (token === selection.current) setError((failure as Error).message); }
    finally { if (token === selection.current) setBusy(false); }
  }
  function chapter(next?: string) {
    selection.current++; setChapterId(next); setEvidence(null); setSelectedItemId(undefined); setError(undefined); setBusy(false);
    if (run) share(run, next);
  }
  async function item(itemId: string) {
    if (!run) return;
    const token = ++selection.current;
    setSelectedItemId(itemId); setEvidence(null); setBusy(true); setError(undefined);
    const file = run.manifest.files.find((file) => file.items.some((item) => item.id === itemId))!;
    share(run, chapterId, { runId: run.summary.runId, revision: run.revision, file, item: file.items.find((item) => item.id === itemId)!, before: null, after: null });
    try {
      const next = await call(TOOLS.evidence, { runId: run.summary.runId, revision: run.revision, itemId }) as SavedEvidence;
      const savedFile = reviewFileSchema.safeParse(next?.file);
      const savedItem = reviewItemSchema.safeParse(next?.item);
      if (!savedFile.success || !savedItem.success || (next.before !== null && typeof next.before !== "string") || (next.after !== null && typeof next.after !== "string")) throw new Error("The service returned malformed saved evidence.");
      if (next.runId !== run.summary.runId || next.revision !== run.revision || savedFile.data.id !== file.id || savedItem.data.id !== itemId) throw new Error("The service returned evidence for another selection.");
      if (token === selection.current) setEvidence({ ...next, file: savedFile.data, item: savedItem.data });
    } catch (failure) { if (token === selection.current) setError((failure as Error).message); }
    finally { if (token === selection.current) setBusy(false); }
  }
  const chapterValue = run?.review.chapters.find((chapter) => chapter.id === chapterId);
  const refs = run && chapterId ? new Set(chapterItemRefs(run.review.chapters, chapterId)) : null;
  const matches = run?.manifest.files.flatMap((file) => file.items.filter((item) => !refs || refs.has(item.id)).map((item) => ({ file, item }))) ?? [];
  const labels = run ? chapterLabels(run.review.chapters) : new Map<string, string>();
  const selectedPatch = run?.manifest.files.flatMap((file) => file.items).find((item) => item.id === selectedItemId)?.patch;
  return <main>
    <header><span className="eyebrow">DIFFPANEL · SAVED REVIEW</span><h1>{run?.summary.reviewTitle ?? "Review library"}</h1>
      <p>Read-only immutable evidence beside your conversation.</p>
      {run && <details><summary>{run.summary.repositoryName} · {run.manifest.files.length} files</summary><p>Run <code>{run.summary.runId}</code></p><p>Snapshot <code>{run.manifest.snapshotHash}</code></p><p>Review revision <code>{run.revision}</code></p></details>}
    </header>
    {!connected && <p role="status">Connecting to the host…</p>}
    {busy && <p role="status">Loading saved evidence…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {pendingRun && <aside><p>A different review or revision was opened. Your current evidence is still selected.</p><button onClick={() => selectRun(pendingRun)}>Switch to {pendingRun.summary.reviewTitle}</button><button onClick={() => setPendingRun(null)}>Keep current review</button></aside>}
    {!run ? <section aria-label="Review library"><button disabled={!connected || busy} onClick={() => void loadLibrary()}>Refresh authorized reviews</button>
      {library.runs.length === 0 && <p>No authorized published reviews on this page. Authorize specific run IDs in the local service; use Next page if available.</p>}
      {library.runs.map((summary) => <button className="run" key={summary.runId} disabled={!connected || busy} onClick={() => void open(summary.runId)}><strong>{summary.reviewTitle}</strong><small>{summary.repositoryName} · {summary.createdAt}</small></button>)}
      {library.nextCursor && <button disabled={!connected || busy} onClick={() => void loadLibrary(library.nextCursor!)}>Next page</button>}
    </section> : <>
      <nav aria-label="Review navigation"><button onClick={() => { selection.current++; currentRun.current = null; setRun(null); setPendingRun(null); setChapterId(undefined); setEvidence(null); setSelectedItemId(undefined); setError(undefined); setBusy(false); share(null); }}>Review library</button><button aria-pressed={!chapterId} onClick={() => chapter()}>Overview / all files</button>
        <label>Chapter<select value={chapterId ?? ""} onChange={(event) => chapter(event.target.value || undefined)}><option value="">Overview</option>{run.review.chapters.map((value) => <option key={value.id} value={value.id}>{labels.get(value.id)} · {value.title}</option>)}</select></label></nav>
      <CaptureCoverage manifest={run.manifest} />
      <section><h2>{chapterValue?.title ?? "Review overview"}</h2><p>{chapterValue?.summary ?? run.review.prologue.motivation}</p>{!chapterValue && <><p>{run.review.prologue.outcome}</p><p>{run.review.prologue.complexity.level} complexity: {run.review.prologue.complexity.reasoning}</p>{run.review.prologue.focusAreas.map((focus) => <article key={`${focus.type}:${focus.title}`}><h3>{focus.severity}: {focus.title}</h3><p>{focus.description}</p></article>)}</>}
        {chapterValue?.keyChanges.map((change, index) => <article key={index}><h3>{change.content}</h3>{change.lineRefs.map((ref, i) => <p key={i}><code>{ref.filePath}</code> · {ref.side} lines {ref.startLine}–{ref.endLine}</p>)}</article>)}
        <Diagram source={chapterValue ? chapterValue.diagram : run.review.prologue.diagram} />
        <ReviewEvidence key={`${run.revision}:${chapterId ?? "all"}`} matches={matches} chapters={run.review.chapters} chapterId={chapterId} onChapter={(next) => chapter(next.id)} onOpen={(id) => void item(id)} />
      </section>
      {selectedItemId && <section aria-label="Selected saved diff"><h2>Saved diff</h2>{evidence && <SavedDiff key={`${evidence.revision}:${evidence.item.id}`} evidence={evidence} />}{!evidence && selectedPatch && <pre>{selectedPatch}</pre>}</section>}
    </>}
    <footer><p role="status">{contextStatus}</p>{fallback && <details><summary>Selected context / manual fallback</summary><p>Copy this bounded context into ChatGPT if automatic sharing is unavailable.</p><textarea readOnly aria-label="Selected review context" value={fallback} /></details>}</footer>
  </main>;
}

function SavedDiff({ evidence }: { evidence: SavedEvidence }) {
  const [mode, setMode] = useState<"diff" | "before" | "after">("diff");
  const [offset, setOffset] = useState(0);
  const differences = useMemo(() => diffLines(evidence.before ?? "", evidence.after ?? "", { timeout: 80, maxEditLength: 4000 }), [evidence]);
  const rows = useMemo(() => mode === "diff"
    ? differences?.flatMap((change) => change.value.split(/(?<=\n)/).map((text) => ({ text, kind: change.added ? "addition" : change.removed ? "deletion" : "same" }))) ?? []
    : (evidence[mode] ?? "").split(/(?<=\n)/).map((text) => ({ text, kind: "same" })), [mode, differences, evidence]);
  return <><h3>{evidence.file.filePath}</h3><p>{evidence.file.oldPath && `From ${evidence.file.oldPath} · `}{evidence.file.status} · item {evidence.item.id}</p>
    <div role="group" aria-label="Saved diff mode">{(["diff", "before", "after"] as const).map((value) => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setOffset(0); }}>{value === "diff" ? "Unified diff" : `Saved ${value}`}</button>)}</div>
    {mode === "diff" && !differences && <p>Diff computation exceeded its bounded budget. View Saved before and Saved after instead.</p>}
    {mode !== "diff" && evidence[mode] === null && <p>This side does not exist in the saved snapshot.</p>}
    <pre className="saved-diff" aria-label={`Saved ${mode} contents`}>{rows.slice(offset, offset + 300).map((row, index) => <span className={row.kind} key={offset + index}><span className="line-number">{offset + index + 1} </span>{row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}{row.text}</span>)}</pre>
    <p>{rows.length ? `${offset + 1}–${Math.min(offset + 300, rows.length)} of ${rows.length} displayed lines` : "No textual lines"}</p><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 300))}>Previous lines</button><button disabled={offset + 300 >= rows.length} onClick={() => setOffset(offset + 300)}>Next lines</button>
    <details><summary>Selected saved item patch</summary><pre>{evidence.item.patch}</pre></details>
  </>;
}

createRoot(document.getElementById("root")!).render(<ReviewPanel />);
