import React, { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { diagramSourceError } from "../diagram-policy.js";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: 20_000,
  maxEdges: 150,
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  theme: "neutral",
});
let nextDiagram = 0;

export function Diagram({ source }: { source?: string | null }): React.JSX.Element | null {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const element = target.current;
    if (!element || !source) return;
    element.replaceChildren();
    setError(null);
    const invalid = diagramSourceError(source);
    if (invalid) { setError(invalid); return; }
    void mermaid.render(`review-diagram-${nextDiagram++}`, source).then(({ svg }) => {
      if (!cancelled) {
        element.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ["style"],
          FORBID_TAGS: ["foreignObject", "a", "image", "script"],
          FORBID_ATTR: ["href", "xlink:href"],
        });
      }
    }).catch(() => { if (!cancelled) setError("Could not render this diagram. View its source below."); });
    return () => { cancelled = true; };
  }, [source]);
  if (!source) return null;
  return <section className="diagram-section">
    <h3>Generated explanation</h3>
    <p>Author-provided diagram; verify its claims against the saved evidence.</p>
    {error && <p role="status">{error}</p>}
    <div className="diagram-canvas" ref={target} role="img" aria-label="Generated explanation of the change; Mermaid source available below" />
    <details><summary>Diagram source</summary><pre className="patch">{source}</pre></details>
  </section>;
}
