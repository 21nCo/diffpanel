# Generated review schema

Return one JSON object:

```jsonc
{
  "schemaVersion": 1,
  "runId": "20260808T120000Z-ab12cd34",
  "generator": "codex",
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

## Chapter rules

- `id`: unique non-empty string.
- `parentId`: `null` for a root chapter or another chapter's `id` for nesting. Hierarchies must not contain cycles.
- `order`: unique positive integer across the run.
- `title`: action-oriented phrase, preferably eight words or fewer, without a numeric or alphabetic prefix. The Diffpanel surface numbers roots and letters child chapters.
- `summary`: short explanation of impact, intent, and dependencies.
- `itemRefs`: item IDs copied from the generation input. Each item must occur exactly once across all chapters. A structural parent may use an empty array.
- `keyChanges`: zero or more human judgment questions.

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
