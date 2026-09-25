import React, { useId, useState } from "react";
import type { Chapter } from "diffpanel";
import { groupFiles, itemLocationLabel, moveDescription, otherFileChapters, partitionChanges, type ItemMatch } from "@diffpanel/presentation";

export interface EvidenceProps {
  matches: ItemMatch[];
  chapters: Chapter[];
  chapterId?: string;
  onOpen: (itemId: string) => void;
  onChapter: (chapter: Chapter) => void;
}

const PAGE_SIZE = 30;

export function FileList({ matches, chapters, chapterId, onOpen, onChapter }: EvidenceProps): React.JSX.Element {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listId = useId();
  const groups = groupFiles(matches);
  return <div className="files">
    {groups.slice(0, limit).map(({ file, items, additions, deletions }) => {
      const others = otherFileChapters(file, chapters, chapterId);
      const spansChapters = otherFileChapters(file, chapters).length > 1;
      const hunkListId = `${listId}-${file.id}`;
      const isExpanded = expanded.has(file.id);
      return <div className="file-group" key={file.id}>
        <div className="file-heading">
          <button className="file-open" onClick={() => onOpen(items[0]!.id)} aria-label={`Open saved diff for ${file.filePath}`}>
            <span className="file-path" title={file.filePath}>{file.filePath}</span>
            <small className="file-meta"><span className="additions">+{additions}</span><span className="deletions">−{deletions}</span></small>
          </button>
          {items.length > 1 && <button className="hunk-toggle" aria-label={`${items.length} changes in ${file.filePath}`} aria-expanded={isExpanded} aria-controls={hunkListId} onClick={() => setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(file.id)) next.delete(file.id); else next.add(file.id);
            return next;
          })}><span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> {items.length} changes</button>}
        </div>
        {file.oldPath && <div className="old-path">From {file.oldPath} · {moveDescription(file)}</div>}
        {items.length > 1 && <div id={hunkListId} hidden={!isExpanded}>
          {chapterId && spansChapters && <p className="hunk-scope">Only this chapter’s changes are listed. Opening the saved diff shows the whole file.</p>}
          <HunkList matches={items.map((item) => ({ file, item }))} onOpen={onOpen} />
        </div>}
        {items.length === 1 && items[0]!.kind === "file" && items[0]!.status !== "snapshot" && items[0]!.patch && <details>
          <summary>File metadata</summary><pre className="patch">{items[0]!.patch}</pre>
        </details>}
        {spansChapters && others.length > 0 && <details className="other-chapters">
          <summary>{chapterId ? "Also in" : "Chapters:"} {others.length} {others.length === 1 ? "chapter" : "chapters"}</summary>
          {others.map((chapter) => <button key={chapter.id} onClick={() => onChapter(chapter)}>{chapter.title}</button>)}
        </details>}
      </div>;
    })}
    {limit < groups.length && <button onClick={() => setLimit((value) => value + PAGE_SIZE)}>Show next {Math.min(PAGE_SIZE, groups.length - limit)} files ({groups.length - limit} remaining)</button>}
  </div>;
}

function HunkList({ matches, onOpen }: Pick<EvidenceProps, "matches" | "onOpen">): React.JSX.Element {
  const [limit, setLimit] = useState(PAGE_SIZE);
  return <div className="hunk-list">
    {matches.slice(0, limit).map(({ item }) => <div key={item.id}>
      <button onClick={() => onOpen(item.id)}>{itemLocationLabel(item)}</button>
      {item.kind === "file" && item.status !== "snapshot" && item.patch && <pre className="patch">{item.patch}</pre>}
    </div>)}
    {limit < matches.length && <button onClick={() => setLimit((value) => value + PAGE_SIZE)}>Show more changes ({matches.length - limit} remaining)</button>}
  </div>;
}

export function ReviewEvidence(props: EvidenceProps): React.JSX.Element | null {
  const { transformations, individual } = partitionChanges(props.matches);
  const [showAll, setShowAll] = useState(false);
  if (props.matches.length === 0) return null;
  return <div className="review-evidence">
    <div className="evidence-toolbar"><button aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? "Show grouped changes" : "Browse all files"}</button>
      <span>{groupFiles(props.matches).length} files · {props.matches.length} changes</span></div>
    {transformations.length > 0 && <p className="compression-summary">{props.matches.length - individual.length} changes in {transformations.length} transformation {transformations.length === 1 ? "group" : "groups"} · {individual.length} individual changes</p>}
    {showAll ? <FileList {...props} /> : <>
      <MoveMap {...props} />
      {transformations.length > 0 && <section><h3>Repeated transformations</h3>
        {transformations.map((group) => <details className="transformation" key={group.key}>
          <summary>{group.kind === "moves" ? "Exact-content moves" : group.mappings.map((mapping) => `${mapping.before}${mapping.prefix ? "*" : ""} → ${mapping.after}${mapping.prefix ? "*" : ""}`).join(", ")} · {groupFiles(group.matches).length} files · {group.matches.length} changes</summary>
          {group.kind === "imports" ? <>
            <p>Matching import-source text edits. Check resolution, exports, and side effects separately.</p>
            {group.mappings.some((mapping) => mapping.prefix) && <p>Prefix rules describe these captured edits only. Each matched suffix is unchanged.</p>}
            {group.matches.some(({ file }) => file.status === "renamed") && <p>Includes moved files. Other edits in these files remain individually reviewable.</p>}
            <div className="mapping-list">{group.mappings.map((mapping) => <button className="mapping" key={JSON.stringify(mapping)} aria-label={`Open example of ${mapping.before} becoming ${mapping.after}`} onClick={() => props.onOpen(group.matches[0]!.item.id)}><code>{mapping.before}{mapping.prefix ? "*" : ""}</code><span aria-label="becomes">→</span><code>{mapping.after}{mapping.prefix ? "*" : ""}</code></button>)}</div>
            <h3>Representative diff</h3>
            <pre className="patch">{group.matches[0]!.item.patch}</pre>
            <button onClick={() => props.onOpen(group.matches[0]!.item.id)}>Open representative saved diff</button>
            <details><summary>Inspect examples</summary>{groupFiles(group.matches).slice(0, 3).map(({ file, items }) => <button key={file.id} onClick={() => props.onOpen(items[0]!.id)}>{file.filePath}</button>)}</details>
          </> : <p>Before and after snapshot content hashes match. Paths changed.</p>}
          <details><summary>Browse all {groupFiles(group.matches).length} affected files</summary><FileList {...props} matches={group.matches} /></details>
        </details>)}
      </section>}
      {individual.length > 0 && <section><h3>{transformations.length ? "Exceptions and other edits" : "Files to review"}</h3><FileList {...props} matches={individual} /></section>}
    </>}
  </div>;
}

function MoveMap(props: EvidenceProps): React.JSX.Element | null {
  const moves = groupFiles(props.matches).filter(({ file }) => file.status === "renamed" && file.oldPath);
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (moves.length === 0) return null;
  return <details className="move-map"><summary>Observed path changes · {moves.length} files</summary>
    {moves.slice(0, limit).map(({ file, items }) => <button key={file.id} className="mapping" onClick={() => props.onOpen(items[0]!.id)}>
      <span>{file.oldPath}</span><span aria-label="moved to">→</span><span>{file.filePath}<small>{moveDescription(file)}</small></span>
    </button>)}
    {limit < moves.length && <button onClick={() => setLimit((value) => value + PAGE_SIZE)}>Show more paths ({moves.length - limit} remaining)</button>}
  </details>;
}
