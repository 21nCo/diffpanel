import React, { createContext, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Chapter, GeneratedReview, ReviewFile, ReviewItem } from "diffpanel";
import type { StoredRun } from "@diffpanel/storage";
import {
  chapterItemRefs,
  chapterLabels,
  childChapters,
  uniqueFileCount,
} from "@diffpanel/presentation";
import { FileList, ReviewEvidence } from "./review-evidence.js";
import { CaptureCoverage, DiagramDirectory } from "./review-overview.js";
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

interface ItemMatch {
  file: ReviewFile;
  item: ReviewItem;
}

const Navigation = createContext<{ chapters: Chapter[]; onChapter: (chapter: Chapter) => void }>({ chapters: [], onChapter: () => {} });

function App(): React.JSX.Element {
  const [selection, setSelection] = useState<DetailsSelection | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  useEffect(() => {
    const listener = (event: MessageEvent<{ type?: string; payload?: DetailsSelection | null }>) => {
      if (event.data.type === "selection") { setSelection(event.data.payload ?? null); setAllFiles(false); }
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
  const selectedChildren = chapter && review ? childChapters(review.chapters, chapter.id) : [];
  const labels = review ? chapterLabels(review.chapters) : new Map<string, string>();
  return (
    <Navigation.Provider value={{ chapters: review?.chapters ?? [], onChapter: (next) => { setSelection({ run, chapter: next }); setAllFiles(false); } }}>
    <main key={`${run.summary.runId}:${chapter?.id ?? "overview"}`}>
      <header>
        <div className="eyebrow">{run.summary.repositoryName}</div>
        <h1>{allFiles ? "All review files" : chapter?.title ?? run.summary.reviewTitle}</h1>
        <div className="metrics">
          {chapter && !allFiles ? <>
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

      <nav className="review-navigation" aria-label="Review views">
        <button onClick={() => { setSelection({ run }); setAllFiles(false); }}>Review overview</button>
        <button aria-pressed={allFiles} onClick={() => setAllFiles(!allFiles)}>{allFiles ? "Return to chapters" : "All review files"}</button>
      </nav>

      <CaptureCoverage manifest={run.manifest} />
      {!allFiles && chapter?.diagram?.trim() && <button onClick={() => vscodeApi.postMessage({ type: "openDiagram", runId: run.summary.runId, chapterId: chapter.id })}>Open chapter diagram</button>}
      {!chapter && !allFiles && review && <DiagramDirectory review={review} onOpen={(chapterId) => vscodeApi.postMessage({ type: "openDiagram", runId: run.summary.runId, ...(chapterId ? { chapterId } : {}) })} />}

      {allFiles ? <FileList matches={[...items.values()]} chapters={review?.chapters ?? []} onChapter={(next) => { setSelection({ run, chapter: next }); setAllFiles(false); }} onOpen={(itemId) => vscodeApi.postMessage({ type: "openItem", runId: run.summary.runId, itemId })} /> : <>

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

      {chapter && review ? (
        <section className="chapter">
          <p>{chapter.summary}</p>
          <Questions chapter={chapter} />
          {chapter.itemRefs.length > 0 && (
            <ItemList chapterId={chapter.id} itemRefs={chapter.itemRefs} items={items} runId={run.summary.runId} />
          )}
          {selectedChildren.length > 0 && (
            <div className="review-guide">
              <h3>Review guide</h3>
              {selectedChildren.map((child) => (
                <ChapterGuide
                  key={child.id}
                  chapter={child}
                  review={review}
                  labels={labels}
                  items={items}
                  runId={run.summary.runId}
                />
              ))}
            </div>
          )}
        </section>
      ) : chapters.map((current) => (
        <section className="chapter" key={current.id}>
          <div className="chapter-number">Chapter {current.order}</div>
          <h2>{current.title}</h2>
          <p>{current.summary}</p>
          <Questions chapter={current} />
          <ItemList chapterId={current.id} itemRefs={current.itemRefs} items={items} runId={run.summary.runId} />
        </section>
      ))}
      </>}
    </main>
    </Navigation.Provider>
  );
}

function ChapterGuide({
  chapter,
  review,
  labels,
  items,
  runId,
}: {
  chapter: Chapter;
  review: GeneratedReview;
  labels: Map<string, string>;
  items: Map<string, ItemMatch>;
  runId: string;
}): React.JSX.Element {
  const children = childChapters(review.chapters, chapter.id);
  const itemRefs = chapterItemRefs(review.chapters, chapter.id);
  return (
    <article className="subtopic">
      <div className="subtopic-heading">
        <div>
          <div className="chapter-number">Step {labels.get(chapter.id) ?? chapter.order}</div>
          <h2>{chapter.title}</h2>
        </div>
        <span className="subtopic-count">{itemRefs.length} {itemRefs.length === 1 ? "item" : "items"}</span>
      </div>
      <p>{chapter.summary}</p>
      <Questions chapter={chapter} />
      {chapter.itemRefs.length > 0 && (
        <details className="review-items">
          <summary>Show {chapter.itemRefs.length} review {chapter.itemRefs.length === 1 ? "item" : "items"}</summary>
          <ItemList chapterId={chapter.id} itemRefs={chapter.itemRefs} items={items} runId={runId} />
        </details>
      )}
      {children.map((child) => (
        <ChapterGuide
          key={child.id}
          chapter={child}
          review={review}
          labels={labels}
          items={items}
          runId={runId}
        />
      ))}
    </article>
  );
}

function Questions({ chapter }: { chapter: Chapter }): React.JSX.Element | null {
  if (chapter.keyChanges.length === 0) return null;
  return (
    <div className="questions">
      <h3>Questions</h3>
      {chapter.keyChanges.map((change) => <p key={change.content}>{change.content}</p>)}
    </div>
  );
}

function ItemList({
  chapterId,
  itemRefs,
  items,
  runId,
}: {
  chapterId?: string;
  itemRefs: string[];
  items: Map<string, ItemMatch>;
  runId: string;
}): React.JSX.Element | null {
  const navigation = useContext(Navigation);
  if (itemRefs.length === 0) return null;
  return <ReviewEvidence key={`${runId}:${chapterId ?? "all"}:${itemRefs.join(",")}`} matches={itemRefs.flatMap((ref) => { const match = items.get(ref); return match ? [match] : []; })} chapters={navigation.chapters} chapterId={chapterId} onChapter={navigation.onChapter} onOpen={(itemId) => vscodeApi.postMessage({ type: "openItem", runId, itemId })} />;
}

createRoot(document.getElementById("root")!).render(<App />);
