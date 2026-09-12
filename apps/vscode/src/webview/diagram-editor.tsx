import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DiagramDocument } from "../diagram-document.js";
import { Diagram } from "./diagram.js";
import "./styles.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();

function DiagramEditorView(): React.JSX.Element {
  const [document, setDocument] = useState<DiagramDocument | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent<{ type?: string; payload: DiagramDocument }>): void => {
      if (event.data.type === "diagram") setDocument(event.data.payload);
    };
    window.addEventListener("message", receive);
    api.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);
  if (!document) return <main><p>Loading diagram…</p></main>;
  return <main className="diagram-editor-view">
    <h1>{document.title}</h1>
    <Diagram source={document.source} />
    <details className="files"><summary>Saved evidence · {document.evidence.length}</summary>
      {document.evidence.map((entry) => <button key={entry.itemId} onClick={() => api.postMessage({ type: "openItem", itemId: entry.itemId })}>{entry.label}</button>)}
    </details>
  </main>;
}

createRoot(document.getElementById("root")!).render(<DiagramEditorView />);
