# Generated review schema

Return one JSON object:

```jsonc
{
  "schemaVersion": 1,
  "runId": "20260808T120000Z-ab12cd34",
  "generator": "codex",
  "title": "PR 568 DataFn foundations",
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
