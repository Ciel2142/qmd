---
name: qmd-memory
description: Store and recall durable knowledge with qmd memory (remember/recall/forget). Use when learning a durable user preference, a non-obvious gotcha, a reference worth keeping, or when starting a task that touches a system/tool/repo you may have notes on.
license: MIT
compatibility: Requires qmd CLI ≥ 2.5.2 with the memory verbs, or the qmd MCP server.
allowed-tools: Bash(qmd:*), mcp__qmd__remember, mcp__qmd__recall, mcp__qmd__forget
---

# qmd Memory

Durable, searchable knowledge store. Plain-markdown facts, one per file, under
`memory/{user,feedback,project,reference}/`. This is the **knowledge lane** — distinct
from beads (the work/issue lane). Never duplicate a fact across both.

## When to remember
- A durable user preference or identity fact → `--type user`
- Guidance on how to work / a correction → `--type feedback`
- A repo/system fact not in code or git → `--type project`
- A reference pointer or discovery (URL, dashboard, gotcha) → `--type reference`

## When to recall
- Starting a task that touches a system/tool/repo → `recall "<topic>"`
- The user references past context → `recall "<topic>"`
- If the SessionStart hook (`qmd recall --session`) is configured, the user/feedback/pinned snapshot is injected automatically; otherwise run it yourself at task start.

## Routing rule vs beads
True regardless of what you're working on → qmd memory. Only meaningful inside the
current work (task state, decisions tied to an issue) → beads.

## Commands
```bash
qmd remember "<fact>" --type reference --tags a,b [--pin] [--source S]
qmd remember "<fact>" --as my-slug          # explicit slug
qmd remember "<fact>" --replace my-slug     # update in place
qmd remember "<fact>" --force               # write as a new entry despite a near-duplicate (vs --replace, which updates)
qmd recall "<query>" [--lex] [--type T] [--limit N]
qmd recall --session                        # snapshot (used by the SessionStart hook)
qmd forget <slug>
```
Prefer the MCP tools (`remember`/`recall`/`forget`) when the MCP server is running; the CLI commands above work identically otherwise.

## Notes
- A freshly remembered fact is lex-searchable immediately; vector recall follows once the
  `qmd watch` daemon embeds it (seconds). Both `recall` and `recall --lex` work meanwhile.
- `remember` warns on a near-duplicate instead of writing — use `--replace <slug>` to update.
- Memories are plain markdown: you can hand-edit a file; the daemon re-embeds it.
