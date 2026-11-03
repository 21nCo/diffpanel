# devroll

Devroll is a set of developer tools from [21n](https://github.com/21nCo) that share one codebase. This package exports the catalog of those tools.

| Tool | Package | Status |
| --- | --- | --- |
| Diffpanel: local-first, agent-generated code review chapters across editor surfaces | [`diffpanel`](https://www.npmjs.com/package/diffpanel) | preview |
| Iterbar: dev-mode bar for switching design variants, annotating UI and sending feedback with runtime evidence to local coding agents | `iterbar` | planned |

```ts
import { findTool, tools } from "devroll";

for (const tool of tools) console.log(tool.name, tool.packageName, tool.status);
findTool("diffpanel")?.packageName; // "diffpanel"
```

Each tool is installed through its own package. This package does not install or run them.

Source: [21nCo/devroll](https://github.com/21nCo/devroll).
