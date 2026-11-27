# 0012: The desktop renders the bundled web build and calls the server from its own origin

**Status:** Accepted

## Context

The desktop app is an Electron shell around the web client ([Clients: desktop](../architecture/clients.md#desktop)). In a browser the web client and the server share an origin, because the server serves the client. The desktop app cannot get that for free: it carries its own build of the client, and the server it talks to is one the operator names, at loopback, at a private address over plain HTTP, or behind TLS.

A page served from a privileged custom scheme (`j3bots://app`) is a secure context, which the client needs for Web Locks, WebCrypto and notifications. Chromium blocks mixed content from secure pages and is rolling out a check on requests from public pages to private addresses (Local Network Access). Either could stop such a page from calling `http://192.0.2.10:3737`. The alternative is a proxy: the custom scheme forwards `/api` requests to the server through the main process, and a WebSocket bridge carries the socket over a `MessagePort`.

**Verified** with Electron 44.10.1 (the version T3 Code pins, **Read** at `db51b67`, `apps/desktop/package.json`) on Linux: from a page on `j3bots-dev://app`, which reports `isSecureContext`, `fetch` and `WebSocket` over `http:` and `ws:` to loopback and to a private LAN address succeed, with a Content Security Policy that names the server and without one. Nothing is blocked as mixed content, and no local-network permission is asked. `https:` and `wss:` succeed too. The server sees `Origin: j3bots-dev://app`. Windows and macOS were not measured (**Assumed** the same, since the check lives in Chromium, not in the platform).

## Decision

The window loads the bundled web build from `j3bots://app` (`j3bots-dev://app` in development), and the page calls the server at the server's own origin with the platform's `fetch` and `WebSocket`, exactly as a browser does. The custom scheme serves only the build's files; it forwards nothing.

The server answers CORS for the two desktop origins, `j3bots://app` and `j3bots-dev://app` (`DESKTOP_APP_ORIGINS` in `packages/contracts`), and no other. A preflight from `j3bots://app` or `j3bots-dev://app` is allowed for the headers clients send, without credentials, since the credential is a bearer header and never a cookie. A request from any other origin, a preflight included, is answered as if there were no CORS at all. The page's Content Security Policy allows connections only to its own origin and to the server the operator named.

The main process keeps the named server and checks it before keeping it: an answer from `/api/server` that decodes as a J3 Bots server, with no redirect followed. Plain HTTP is accepted only to loopback and private IP literals and `localhost`, the ranges the server itself serves over HTTP ([Security](../architecture/security.md#j3-bots-own-surface)). The page asks for a server through a preload bridge whose messages both sides decode with the schemas in `packages/desktop-bridge`; it never learns another server without the main process checking it.

## Consequences

- The desktop reaches the server by the same code path as the web client: one HTTP client, one socket, one reconnect. Nothing in `client-runtime` knows it runs in Electron. Attachment uploads go the same way, with `XMLHttpRequest` from the page, reporting progress: the page already holds the token, and the Content Security Policy keeps where it goes to the named server. **Verified** on Linux, Electron 44.10.1: from `j3bots-dev://app` to the server's testing layer on a plain-HTTP loopback origin, a 25 MiB file uploads with progress and arrives whole, and an upload aborted under way is cancelled ([Clients: desktop](../architecture/clients.md#desktop)).
- Each Electron upgrade must measure again that a secure custom-scheme page may still call private addresses over plain HTTP. If Chromium starts asking for local network access, the app grants it to its own origin, or falls back to the proxy below.
- The server's surface grows by one CORS rule. Pages on any other origin still cannot read its answers.
- The page keeps its credential, drafts and unsent messages in IndexedDB, which is emptied right before a server is kept, and a server counts as kept only once it is written to the app's settings. Emptying it can fail without saying so, so the credential is also stored with the origin of the server that issued it and is absent for any other. A device token so never reaches a server other than the one that issued it, even after a lost or damaged settings file.

## Rejected

**A proxy in the main process.** The custom scheme forwards HTTP to the server and a `MessagePort` carries the socket. It needs no CORS on the server and survives a future mixed-content block, but it doubles the connection code (a second WebSocket implementation whose closes and errors must match the browser's), puts every request through IPC, and hides from the page the network failures the client's reconnect relies on.

**Loading the server's own origin in the window.** The window shows the web client the server serves, as a browser would. No CORS, no bundled build. A page from a plain-HTTP origin is not a secure context, so it loses Web Locks and notifications, and the shell would run whatever client the server serves, at whatever version, with the preload bridge exposed to it.
