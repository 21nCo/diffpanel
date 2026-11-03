# Generated review schema

This human-readable guide elaborates the provider-neutral contract exported by
`@diffpanel/generation`. Consumers should use that package for immutable input
formatting, review schemas, and validation instead of copying implementation
details from the CLI or editor extension.

Return one JSON object:

```jsonc
{
  "schemaVersion": 1,
  "runId": "20260808T120000Z-ab12cd34",
  "generator": "codex",
  "title": "PR 568 DataFn foundations",
  "diagramAssessment": {
    "kind": "other",
    "reasoning": "This example only changes review snapshot storage, with no new cross-component flow.",
    "overviewOmissionReason": "The chapter summary and file evidence explain the single storage boundary."
  },
  "chapters": [
    {
      "id": "chapter-foundation",
      "parentId": null,
      "order": 1,
      "title": "Establish the review snapshot",
      "summary": "Immutable content anchors keep generated reviews stable while the working tree changes.",
      "itemRefs": ["item_0123456789abcdef"],
      "keyChanges": [
        {
          "content": "Should repository snapshots include generated API clients by default?",
          "lineRefs": [
            {
              "filePath": "src/example.ts",
              "side": "after",
              "startLine": 10,
              "endLine": 14
            }
          ]
        }
      ]
    }
  ],
  "prologue": {
    "motivation": "Large changes were difficult to review as one flat list of files.",
    "outcome": "Reviewers can now follow the work as an ordered set of chapters.",
    "diagram": null,
    "keyChanges": [
      {
        "summary": "Reviews persist independently from working tree changes",
        "description": "Content-addressed snapshots retain exact before and after files for later review."
      }
    ],
    "focusAreas": [
      {
        "type": "architecture",
        "severity": "info",
        "title": "Snapshot ownership boundary",
        "description": "The CLI owns immutable capture while surfaces only read runs; confirm that boundary remains appropriate.",
        "locations": ["packages/storage/src/store.ts"]
      }
    ],
    "complexity": {
      "level": "medium",
      "reasoning": "The review crosses storage, Git capture, CLI, and editor boundaries."
    }
  }
}
```

## Review title

- `title`: optional 1-80 character label shown in the Diffpanel review list. Prefer the user-facing module or PR name, such as `PR 567 retired surfaces`. When omitted, Diffpanel keeps a title from `diffpanel prep --title` or falls back to the git-scope expression.

## Chapter rules

- `id`: unique non-empty string.
- `parentId`: `null` for a root chapter or another chapter's `id` for nesting. Hierarchies must not contain cycles.
- `order`: unique positive integer across the run.
- `title`: action-oriented phrase, preferably eight words or fewer, without a numeric or alphabetic prefix. The Diffpanel surface numbers roots and letters child chapters.
- `summary`: reviewer-facing explanation of the concrete outcome, intent, and any dependency that affects review order. Leaf chapters normally use one or two sentences; structural parents use two to four sentences and roll up their children.
- `itemRefs`: item IDs copied from the generation input. Each item must occur exactly once across all chapters. A structural parent may use an empty array.
- `keyChanges`: zero or more human judgment questions.

## Summary quality

A reviewer should be able to answer these questions from a chapter summary without opening its files:

- What behavior, capability, or review surface changes?
- What concrete paths, products, routes, contracts, or configuration anchors define the scope?
- For a structural parent, what distinct outcomes do its child chapters contribute?
- For a removal, is the code merely detached, or is an entire directory or capability deleted?

Avoid summaries that only repeat the title with synonyms or list abstract categories. For example, prefer:

> Deletes the entire `client/landing` workspace, including its branded routes and shared presentation modules. It also removes workspace registration and `@21n/landing` aliases from package and TypeScript tooling, leaving no buildable landing application in the repository.

over:

> Retires the marketing workspace, routes, and presentation system.

## Line references

- Use `side: "before"` for removed or previous content and `side: "after"` for current or added content.
- Copy line numbers from hunk coordinates or immutable content.
- Keep ranges tight and positive; `endLine` must be at least `startLine`.
- Every referenced file must exist in the manifest.

## Prologue rules

- `motivation` and `outcome`: one plain-language sentence or `null` when the evidence is insufficient.
- `diagram`: Mermaid source without fences only when a multi-component flow genuinely benefits from it; otherwise `null`.
- `keyChanges`: one to eight outcome-focused summary/description pairs.
- `focusAreas`: one to eight actionable review areas.
- `focusAreas[].type`: `security`, `breaking-change`, `high-complexity`, `data-integrity`, `new-pattern`, `architecture`, `performance`, or `testing-gap`.
- `focusAreas[].severity`: `critical`, `high`, `medium`, or `info`.
- `complexity.level`: `low`, `medium`, `high`, or `very-high`.

For large mixed migrations, use the first prologue `keyChanges` entry for a recommended reading order naming actual chapters and explaining the risk priority. Retain the one-to-eight entry limit. Large chapter summaries should name the repeated transformation, representative paths, and exceptions; preserve all item references rather than replacing coverage with examples.

Focused diagrams should cover material failure and restoration branches, including successful persistence followed by failed callbacks, repeated restored-state delivery, and terminal states when relevant. Use labeled arrows or a legend to distinguish imports, configuration calls, and runtime requirements. Validate diagram claims against immutable content and render the actual source before publication when a renderer is available.

## Visual explanations and repetitive changes

- Chapters may optionally contain `diagram` (Mermaid source, at most 20,000 characters, or null) and `diagramItemRefs` (supporting immutable item IDs). A chapter diagram requires at least one evidence reference belonging to the chapter or its descendants. Evidence references do not assign chapter ownership and do not change exact coverage.
- The prologue uses `diagramItemRefs` pointing to supporting items in the run. They are required for overview diagrams in newly prepared snapshots; older reviews without these references remain supported.
- Use small before/after maps for restructuring, sequence diagrams for ordering, state diagrams for behavior, or field maps for contract changes. Do not draw a whole-repository graph by default.
- Name concrete paths, symbols, or contracts, explain what an arrow means, and ground claims in the referenced evidence. Distinguish inferred intent from observed changes in the accompanying summary. The UI labels generated diagrams as author-provided explanations, not verified architecture.
- Use plain Mermaid without fences, frontmatter, configuration directives, HTML, click handlers, or external links. The renderer uses strict local rendering and provides source text when a diagram cannot render.
- Diffpanel automatically groups matching complete static import-source text rewrites across at least two files, including renamed files, and exact-content renames. Segment-aligned prefix rules may combine different modules when every observed suffix is preserved and multiple source paths in multiple files support the rule. This is conservative textual classification, not proof of unchanged behavior. Mixed hunks, changed bindings, dynamic imports, and unsupported syntax remain individually visible.
- Assign every item exactly once even for bulk edits. Never omit repeated hunks, invent representative-only coverage, or claim that grouping verifies module resolution, exports, or side effects. Explain these checks in the chapter questions.
- Keep cohesive migrations together when appropriate so transformation groups span their affected files. A file may legitimately have different hunks in different chapters; the panel groups files within a chapter and links their other chapters.


## Required diagram assessment for new reviews

New generation inputs carry `requirements.diagramAssessment: true`. Publishing against those snapshots requires a top-level `diagramAssessment` object:

- `kind`: `architectural` when ownership, dependency direction, composition, or execution flow changes; otherwise `other`.
- `reasoning`: explain the visual decision using concrete changes from this snapshot.
- `overviewOmissionReason`: required only when `prologue.diagram` is absent. Explain why an overview would not help or cannot be grounded in available evidence.
- `chapterDiagramOmissionReason`: architectural reviews with no chapter diagrams must explain why focused diagrams would not help or cannot be grounded.

For restructuring like TIDY-477, normally generate a before/after ownership map in the prologue and focused diagrams for host initialization, dependency inversion, or contract ownership in their respective chapters. Choose the useful views; do not generate filler diagrams for every leaf chapter. Every generated diagram must include evidence refs. Evidence validates provenance, not the truth of inferred architectural claims.

The validator rejects missing assessments, unexplained omissions, missing/out-of-scope evidence, and a diagram accompanied by a contradictory omission reason. Legacy snapshots remain compatible. Use actual newline characters after JSON decoding, not literal backslash-n characters inside Mermaid.

## Capture completeness

File items can represent pure moves or metadata-only changes, not only repository snapshots. Assign them exactly once even if the patch has no `@@` hunk and both line counts are zero. Inspect previous/current paths and the metadata patch. State captured file/item counts separately from skipped paths; never call skipped paths reviewed. Old immutable runs must be recaptured to recover paths that older capture versions skipped as `no textual hunks`.
