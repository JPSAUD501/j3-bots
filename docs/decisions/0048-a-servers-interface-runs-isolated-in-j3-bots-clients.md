# 0048: A server's interface runs isolated in J3 Bots' clients

**Status:** Accepted

## Context

The owner wants J3 Bots to speak MCP in full, at the specification's 2026-07-28 version and back to 2025-11-25, including MCP Apps: a server can give a tool an interface, which the client draws when the tool is called. The extension is `io.modelcontextprotocol/ui`, whose stable version is 2026-01-26. A tool names a `ui://` resource in `_meta.ui.resourceUri`; the resource is an HTML document (`text/html;profile=mcp-app`) with a declared Content Security Policy and device permissions; the host draws it in a frame and speaks JSON-RPC with it over `postMessage`: it tells the app where it is drawn, gives it the tool's input and answer, and runs the tools and reads the resources the app asks for, opens the links it asks to open and sends the messages it proposes.

The reference host keeps an app away from its own page with a proxy page on a second origin, which frames the app on yet another. J3 Bots has one origin: the operator's server, or the desktop app's scheme. It already draws untrusted pages, a bot's visuals, in a sandbox with an opaque origin ([0030](0030-a-visual-is-part-of-say.md)). An app differs from a visual in what it is for: it runs scripts that reach the network and asks the host to act.

The owner also decided that J3 Bots adds no approval of its own: a bot's harness permission mode is the only gate on what the bot does. The lead decided, following the owner's rule that the harness's permission mode is the only gate: an app's calls are the one place the harness never sees, so J3 Bots applies the bot's mode there. The owner can change it.

## Decision

**A connector's app is drawn by J3 Bots' clients, under the work of the turn whose call opened it, in a frame with an opaque origin and the network its server declared; what it asks J3 Bots to do goes as the bot's request, under the bot's grant and permission mode, and what it would do as the operator waits on the operator.**

- **The server reads the app beside the call** that opened it, through the bot's own session, and keeps it, its document once per content, with the call's input and answer, under the turn's work fold. Reading it never fails the call ([Server: connectors](../architecture/server.md#connectors)).
- **The frame has no origin.** `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`, in the client's own app page, which writes the app's document over itself; the app page's policy is the widest an app may have (`https:` and `wss:`), the document's narrows it to what its server declared, and nothing but declared `https:` and `wss:` hosts on the internet, never the J3 Bots server's, is ever allowed. Nested frames, device permissions and an origin of the app's own (`frameDomains`, `permissions`, `domain`) are never granted ([Security: connector apps](../architecture/security.md#connector-apps)).
- **An app's calls are its bot's.** Its `tools/call` and `resources/read` go through J3 Bots to its own connector only, through the bot's session, with the grant checked as for the bot's own calls, and only to a tool its server lists and opened to apps. Since the client, not the harness, makes them, J3 Bots asks what the harness would ask: outside full access, each tool waits on the operator's Allow before its first call while the app is drawn; in full access, where the harness would ask nothing either, it runs. The server checks the bot's mode at each call, as it is then, and refuses one the operator did not allow (`needs-allow`), which is when the client asks. This is the bot's permission mode applied where the harness cannot see the call, not an approval of J3 Bots' own.
- **What is the operator's stays theirs.** A message an app proposes is sent only when the operator presses Send, as their own message; a link opens in their browser only when they press Open, and only an `http:` or `https:` address. An app cannot add to the bot's context (`ui/update-model-context` is refused), and is drawn inline only.

## What it costs

- **Apps that need an origin do not work.** An app gets no storage, no cookie and `Origin: null` on what it fetches, so one that keeps state in the browser, or whose server's CORS names a dedicated origin, fails in J3 Bots where it works in a host that gives it one.
- **No nested frames and no device features.** An app that embeds a map or a video from another origin, or asks for the camera, cannot.
- **What an app shows is its server's.** It can imitate J3 Bots' own lines; the client's line naming the tool and connector above it, and what it asks under it, are outside its reach, and nothing more.
- **Every client keeps the host's side of the protocol.** It is written once, in `@j3-bots/client-runtime`, but each platform frames it its own way: the web and desktop with the app page, Android with a native view and a shell page.

## What was rejected

- **An origin of its own for each app**, as the reference host does. It needs a second origin the operator's server does not have: a wildcard domain and certificate, or a public service of J3 Bots' that every app's document would pass through.
- **`srcdoc`.** A `srcdoc` frame inherits the policy of the page that made it, which on the desktop allows no inline script, and gives the app's own policy no header of its own.
- **Running an app's calls without asking.** The client makes them, so the harness never sees them: a supervised bot's app would act where the bot itself would have asked.
- **An app's message as the bot's input, sent at once.** It would let a server write to the bot in the operator's name.
