import React, { useState } from "react";
import type { GeneratedReview, ReviewManifest } from "@diffpanel/core";

export function DiagramDirectory({ review, onOpen }: {
  review: GeneratedReview;
  onOpen: (chapterId?: string) => void;
}): React.JSX.Element {
  const chapters = review.chapters.filter((chapter) => chapter.diagram?.trim());
  const overview = !!review.prologue.diagram?.trim();
  return <section className="diagram-directory" aria-label="Available diagrams">
    <h3>Diagrams · {chapters.length + Number(overview)}</h3>
    {!overview && <p>No overview diagram generated.{review.diagramAssessment?.overviewOmissionReason ? ` ${review.diagramAssessment.overviewOmissionReason}` : " No omission reason was recorded in this review."}</p>}
    {overview && <button onClick={() => onOpen()}>Open overview diagram</button>}
    {chapters.map((chapter) => <button key={chapter.id} onClick={() => onOpen(chapter.id)}>{chapter.title}</button>)}
    {chapters.length === 0 && <p>No chapter diagrams generated.{review.diagramAssessment?.chapterDiagramOmissionReason ? ` ${review.diagramAssessment.chapterDiagramOmissionReason}` : ""}</p>}
    {review.diagramAssessment && <details><summary>Why these visuals</summary><p>{review.diagramAssessment.reasoning}</p></details>}
  </section>;
}

export function CaptureCoverage({ manifest }: { manifest: ReviewManifest }): React.JSX.Element {
  const [limit, setLimit] = useState(30);
  const skipped = manifest.skipped ?? [];
  const count = manifest.files.reduce((sum, file) => sum + file.items.length, 0);
  return <details className="capture-coverage">
    <summary>Snapshot coverage · {manifest.files.length} captured files · {skipped.length} skipped {skipped.length === 1 ? "path" : "paths"}</summary>
    <p>{count} review items cover the captured files. Skipped paths are outside item coverage.</p>
    {skipped.slice(0, limit).map((entry) => <p key={entry.filePath}><code>{entry.filePath}</code>: {entry.reason}</p>)}
    {skipped.some((entry) => entry.reason === "no textual hunks") && <p>This older snapshot omitted paths without textual hunks. Prepare a fresh review to capture pure moves and metadata changes.</p>}
    {limit < skipped.length && <button onClick={() => setLimit((value) => value + 30)}>Show more skipped paths ({skipped.length - limit} remaining)</button>}
  </details>;
}
