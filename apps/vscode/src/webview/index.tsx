import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Chapter } from "@diffpanel/core";
import type { StoredRun } from "@diffpanel/storage";
import { chapterItemRefs, diffCounts, uniqueFileCount } from "../presentation.js";
import "./styles.css";

interface DetailsSelection {
  run: StoredRun;
  chapter?: Chapter;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function App(): React.JSX.Element {
  const [selection, setSelection] = useState<DetailsSelection | null>(null);
  useEffect(() => {
    const listener = (event: MessageEvent<{ type?: string; payload?: DetailsSelection | null }>) => {
      if (event.data.type === "selection") setSelection(event.data.payload ?? null);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  if (!selection) {
    return <main className="empty"><div className="mark">◇</div><h2>Select a review</h2><p>Generated reviews appear here after an agent publishes them.</p></main>;
  }

  const { run, chapter } = selection;
  const review = run.review;
  const chapters = chapter ? [chapter] : review?.chapters ?? [];
  const items = new Map(run.manifest.files.flatMap((file) => file.items.map((item) => [item.id, { file, item }] as const)));
  const selectedItemRefs = chapter && review ? chapterItemRefs(review.chapters, chapter.id) : [];
  const selectedFileCount = chapter ? uniqueFileCount(run.manifest.files, selectedItemRefs) : 0;
  const subtopicCount = chapter && review ? review.chapters.filter((candidate) => candidate.parentId === chapter.id).length : 0;
  return (
    <main>
      <header>
        <div className="eyebrow">{run.summary.repositoryName}</div>
        <h1>{chapter?.title ?? run.summary.reviewTitle}</h1>
        <div className="metrics">
          {chapter ? <>
            <span>{selectedFileCount} {selectedFileCount === 1 ? "file" : "files"}</span>
            <span>{selectedItemRefs.length} {selectedItemRefs.length === 1 ? "item" : "items"}</span>
            {subtopicCount > 0 && <span>{subtopicCount} {subtopicCount === 1 ? "subtopic" : "subtopics"}</span>}
          </> : <>
            <span>{run.summary.fileCount} files</span>
            <span>{run.summary.itemCount} items</span>
            <span>{run.summary.chapterCount} chapters</span>
            {run.summary.archivedAt && <span>archived</span>}
          </>}
        </div>
      </header>

      {!chapter && review && (
        <section className="prologue">
          {review.prologue.motivation && <><h3>Why</h3><p>{review.prologue.motivation}</p></>}
          {review.prologue.outcome && <><h3>Outcome</h3><p>{review.prologue.outcome}</p></>}
          <div className={`complexity complexity-${review.prologue.complexity.level}`}>
            <strong>{review.prologue.complexity.level} complexity</strong>
            <span>{review.prologue.complexity.reasoning}</span>
          </div>
          <h3>Review focus</h3>
          {review.prologue.focusAreas.map((area) => (
            <article className="focus" key={`${area.type}-${area.title}`}>
              <span className={`severity severity-${area.severity}`}>{area.severity}</span>
              <strong>{area.title}</strong>
              <p>{area.description}</p>
            </article>
          ))}
        </section>
      )}

      {run.summary.status !== "ready" && (
        <section className="waiting"><h3>Awaiting chapter generation</h3><p>Run the <code>$diffpanel-chapters</code> skill and publish its output for this snapshot.</p></section>
      )}

      {chapters.map((current) => (
        <section className="chapter" key={current.id}>
          {!chapter && <div className="chapter-number">Chapter {current.order}</div>}
          {!chapter && <h2>{current.title}</h2>}
          <p>{current.summary}</p>
          {current.keyChanges.length > 0 && <div className="questions">
            <h3>Questions</h3>
            {current.keyChanges.map((change) => <p key={change.content}>{change.content}</p>)}
          </div>}
          <div className="files">
            {(chapter ? selectedItemRefs : current.itemRefs).map((itemRef) => {
              const match = items.get(itemRef);
              if (!match) return null;
              const counts = diffCounts(match.file, match.item);
              return <button key={itemRef} onClick={() => vscodeApi.postMessage({ type: "openItem", runId: run.summary.runId, itemId: itemRef })}>
                <span className="file-path" title={match.file.filePath}>{match.file.filePath}</span>
                <small className="file-meta">
                  <span className="additions">+{counts.additions}</span>
                  <span className="deletions">−{counts.deletions}</span>
                  <span className="line-label">{match.item.kind === "file" ? "snapshot" : `line ${match.item.newStart ?? match.item.oldStart ?? 1}`}</span>
                </small>
              </button>;
            })}
          </div>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
