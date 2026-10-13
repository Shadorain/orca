---
name: orca-chat-visuals
description: Show a chart, diagram, table, report or mockup inline in this Orca chat as an HTML
  page. Use when a visual would help the user understand your answer. Only available when the
  ORCA_CHAT_SCRATCH_DIR environment variable is set.
user-invocable: false
---

# Inline visuals in an Orca chat

Orca can show an HTML page inside your reply. Use one whenever a visual would make the answer
clearer.

## Writing the page

- Save it in the folder named by `ORCA_CHAT_SCRATCH_DIR` (`printenv ORCA_CHAT_SCRATCH_DIR`; in
  PowerShell `$env:ORCA_CHAT_SCRATCH_DIR`). If it's unset or you can't write there, skip the visual.
  This folder is temporary: Orca may remove it after 30 days without chat activity or changes.
  Save files meant to last in the workspace.
- One complete HTML file per visual, directly in that folder, under 512 KB. Use a new file name
  for a new visual (e.g. `latency-by-region-7c1e.html`); rewrite the same file to update that
  visual. Names use letters, digits, `.`, `_`, `-`, ending in `.html`. The user can open, edit and
  share the file.
- Inline your styles, scripts and data. Libraries and fonts may load only from cdn.jsdelivr.net,
  unpkg.com, cdnjs.cloudflare.com, esm.sh, fonts.googleapis.com and fonts.gstatic.com. The page
  can't make network requests; use inline SVG or `data:` URLs for images.
- Don't size anything to the viewport height (`100vh`); Orca fits the frame to your content.
- Optional: Orca's theme colors are available as CSS variables (`--background`, `--foreground`,
  `--muted-foreground`, `--border`, `--primary`, `--chart-1` to `--chart-5`). Give each a fallback,
  e.g. `var(--chart-1, #4e79a7)`: a shared page is the file as written, without Orca's theme.

## Showing it

After the file exists, put this on its own line in your reply, outside any code block:

::orca-visual{file="latency-by-region-7c1e.html" title="Latency by region"}

`file` is the bare file name, never a path; `title` is optional. At most 8 per reply.
