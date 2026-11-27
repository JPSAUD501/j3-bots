# 0030: A visual is part of `say`, drawn by J3 Bots' clients in a sandbox

**Status:** Accepted

## Context

A bot often has something better shown than told: a chart of numbers, a comparison table, a diagram of a plan, a mockup. T3 Code gives agents a way to do this: `html_preview` renders an HTML page in a headless browser and returns a screenshot and its height, and `html_render` shows the page inline in T3 Code's own thread view. J3 Bots' operator never sees that view. Until now the base prompt told a bot to write the page to a file and attach it, which the operator then opens like any download, outside the conversation.

The operator wants these pages drawn inside the conversation, as T3 Code draws them. There were two ways to get there.

**A. Capture `html_render`.** The bot keeps T3 Code's flow, and the engine adapter reads each `html_render` call from the engine's stream, the way it reads `send_to_user`, and delivers the page as part of the bot's message.

**B. Make it part of `say`.** `say` takes a `visual` that names an HTML file in the bot's workspace, and the server reads that file and stores the page with the message.

## Decision

**B. A visual is part of `say`.** `say({text, visual: {path, title, height?}})` names an `.html` file in the workspace, at most 512 KB of UTF-8 text. The server reads it as it reads an attachment, checks it, and stores `{title, html, height}` as the message's `visual`. Nothing on the server runs or parses the page, and it is never logged. A notification or the roster says the message's text, never the page.

The clients draw it above the message, in a frame that can run the page's own scripts and nothing else: no network, no storage, no access to the client. How and why are in [Security: visuals](../architecture/security.md#visuals) and [Clients: visuals](../architecture/clients.md#visuals).

The bot can still check its page with `html_preview` before it shows it, where the engine has a browser. `html_render` stays the engine's; J3 Bots does not capture it.

## Why not A

Capturing `html_render` would have kept the model on a flow it already knows. These made it unreliable, all **Read** in T3 Code at `59651c1`:

- **The stream does not carry the page.** The engine summarizes any tool input over 16 KB before it streams it (`MAX_DYNAMIC_VALUE_BYTES`, `apps/server/src/orchestration-v2/WireProjection.ts`), so a chart with its data inline arrives as a summary. The item's detail can be fetched on demand, but only up to 256 KB (`MAX_ON_DEMAND_BYTES`), and an `html_render` called with a `path` carries no page at all, only the path to a file on the engine's machine.
- **What the engine keeps is its own.** The page T3 Code shows is wrapped in its own document, theme and scripts (`packages/shared/src/htmlRender.ts`), and it loads remote URLs as they are ("Remote URLs load as-is", `apps/server/src/mcp/toolkits/html/tools.ts`). J3 Bots would have to take that wrapper apart to apply its own policy.
- **Order.** An `html_render` call and the `say` that explains it are separate calls. Nothing ties one to the other, so a capture would have to guess which message a page belongs to, and a page shown with no `say` after it would arrive alone.
- **Rooms and routines.** `say` already knows where a message goes: the conversation, a room, the operator privately during a room turn. A captured `html_render` knows none of that.

B costs the model one more field on a tool it calls every turn, and the tool's description says what the page must be. The page goes as a file path, not inline, for the reason A failed: J3 Bots matches a `say` it receives to the call in the engine's stream by its input, which must stay under the engine's 16 KB summary threshold.

`html_render` itself needs nothing from J3 Bots. It publishes even without a browser (a failed measure is caught), and the engine approves the call itself (`mcp__t3-code__html_render` in `ClaudeAdapterV2.ts`'s approved list). A bot that calls it anyway shows the operator nothing; the base prompt names `say`'s `visual` instead. Hiding `html_render` from Claude with `--disallowedTools` was left out: whether that flag reaches an MCP server's tools is **Assumed**, and the prompt already says how to show a page.

## A field, not a kind

The visual is an optional field of `MessageEntry`, not an entry kind of its own. A page belongs to the message that explains it, and the entries table checks the kinds it stores: adding one would mean rebuilding a table that thirteen others reference, inside a migration that runs with foreign keys on. The field needs `PROTOCOL_VERSION` 8, which the 0.4 release brings once for all its changes: a client that predates visuals then shows its update screen, never a message without its page and never the page's source.

## Consequences

- A visual is drawn the same way wherever J3 Bots shows a conversation: the web, the desktop app and Android load one document built by `@j3-bots/client-runtime`, under one policy from `@j3-bots/contracts`, in a frame sandboxed with scripts only (Android's WebView through `visualShell`).
- A visual cannot load anything: a chart library must be inlined, and a remote image or font does not appear. It cannot open a peer connection, embed another page or declare a shadow root in its markup, since a nested document the guard did not see would bring WebRTC back. A resource hint can still reach a host (a known gap in [Security](../architecture/security.md#known-gaps)). The prompt and the tool description say so.
- A page that never yields stalls the visuals that share its renderer process, and each shows as failed after ten seconds. The app's own page stays responsive (**Verified**, Chrome 151 and Electron 44). A reload does not reliably bring the others back (**Verified**, Chrome 151 and Electron 44); closing the tab or restarting the app does (**Assumed**).
- The engine's own rendering is unused. If T3 Code ever streams pages whole and in order with the text, A can be revisited without changing what the operator sees.
