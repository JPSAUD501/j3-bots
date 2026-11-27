# 0110: J3 Bots runs its own browsers, and the engine's is off

**Status:** Accepted for 0.16. Amends [0109](0109-a-new-bot-can-browse-the-web-and-the-operator-turns-it-off.md): the switch it describes now gives a bot J3 Bots' browser, not the engine's. Amends [0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md): the fill moves into J3 Bots' own driver. Withdraws [Proposal: a typed secret in the engine's browser](../proposals/engine-browser-secret-input.md).

## Context

Until 0.15 a bot browsed in the engine's headless Chromium, on the server's machine. J3 Bots only watched those tabs and let a person take them over ([Engine: the bot's browser](../architecture/engine.md#the-bots-browser)). That left four problems:

- Sites saw a headless browser on a server, often in a data center. Many refused it or asked for checks a bot cannot pass.
- A person's sign-ins lived in one profile on the server. Signing in meant doing it in a remote view of that browser.
- The fill of a saved login could not check which field had focus, or in which frame. Only the engine knew. Closing that gap needed a change to T3 Code.
- Every change to how a bot browses waited on T3 Code's preview feature, which is built for a developer's preview, not for bots that work alone.

The owner wants a browser that is well made and works with real sites, for bots that work alone and with the person when needed.

## Decision

**J3 Bots runs the browsers its bots use. The engine's browser is off for every bot, and nothing is asked of or changed in T3 Code.**

### Where a tab runs

- **The desktop first.** A bot's new tab opens in the desktop app the person used last. Sites see a real browser on the person's own connection.
- **The server as fallback.** With no desktop connected, the tab opens in the server's own browser, which keeps at most three tabs live: past that, the least used idle one is parked, and with none idle a new one is refused.
- **A tab outlives its host.** A desktop that goes away has its tabs parked after a short grace, and a server tab unused and unwatched for a few minutes is parked too. A parked tab keeps its ref and its address, and opens again where tabs open now when a bot uses it; the bot is told the page was opened again.
- **Local mode** uses the desktop app's browser only. It never starts one on the server.
- Both hosts ship in 0.16.
- **The server's browser is full Chrome for Testing** in its new headless mode. It is not `chrome-headless-shell`, which sites can tell from Chrome. The server downloads it on first use into J3 Bots' own home. Playwright, which drives it, reads its own files from beside its modules, so the server build carries it as a package in `node_modules/` beside the bundle instead of bundling it. Each platform's version and SHA-256 are pinned. It renders at a device scale factor of 1.
- **Each host shows sites an honest identity:** Chrome of its own major version, on its own system, with the Google Chrome brand and client hints. The desktop drops `Electron` and the app's name from its user agent.

### Shared tabs

- **A tab is durable.** It has a ref of its own, which stays the same when the tab moves between hosts or the server restarts.
- **Bots see every tab**, the person's included, and may act on any of them. Several bots may work on one tab.
- **A lease decides who acts.** An action takes the tab's lease, and others wait in a short queue. Reading never waits. Nobody hands a tab over.
- **The person always wins.** Their input takes the tab at once. Their hold ends 10 s after their last input, and bots may act again. "Wait for me" holds the tab until the person says to go on.
- **Reading is not using.** A bot's snapshot or wait never takes the tab, and the person moving the pointer over it does not either. Their click, scroll, key, typing or address does.
- **The person sees who is there:** the faces of the bots on the tab, the acting bot's own cursor with its name, and one quiet line by the address bar. No coloured frames or bands.

### Private tabs

- The person can open a private tab on the desktop.
- Bots never see it: it is not listed to them, and nothing of it is synced.
- Its cookies and storage are its own, and are gone when it closes.

### Sign-ins

- **One jar, on the server.** It holds cookies, `localStorage` and the `IndexedDB` of the sites that need it. It is sealed under a key derived from the vault's data key, so it opens with the secrets and with nothing else, and names no site on disk.
- **Every host shares it.** Each desktop sends its changes as they happen and receives the others'. The server's browser starts from the jar each time, with no profile on disk. A host that comes back is agreed with the jar from what both held when they last agreed, so neither side's changes meanwhile are lost.
- **Session cookies are kept.** A host that restarts or closes when idle is no reason to sign out.
- **Signing out wins.** The person signs out of one site or of all, everywhere at once. A host that was away is signed out before anything it holds is taken back, and a cookie removed is not brought back by one that still held it.
- **Today's sign-ins move once.** The engine's profile is read once, on the server, and what it holds goes into the jar. The profile is then deleted.
- **The desktop encrypts its cookies** on disk, with Electron's `EnableCookieEncryption` fuse.
- Which sites need their `IndexedDB` is learned later. Until then, only those whose databases came from the engine's profile keep them.
- Importing sign-ins from the person's own Chrome or Firefox comes later.

### What comes from T3 Code

T3 Code's MIT license lets J3 Bots reuse its code with attribution. J3 Bots does not fork it, and the engine runs unmodified. Ported, with attribution in each file and in `packages/browser/NOTICE`:

- the accessibility snapshot, its refs per page generation, and the refusal of a stale ref;
- the masking of password values and of `data:` payloads;
- the page actions, script evaluation and waiting;
- the CDP relay that lets Playwright drive one desktop tab.

The page hardening and the import of sign-ins follow in later work.

### What the engine keeps

Provisioning sets the engine's `enableAgentBrowserAccess` to `false`, whose default is on (**Read** at `bc0f04d`), and the adapter removes the per-project access earlier releases turned on. Claude Code gets the engine's browser tools removed from its tool list (**Verified**, 2026-11); Codex, which takes no such list, still lists them, and the engine refuses every call (**Read** at `bc0f04d`; a real-engine conformance case checks the refusal). The details are in [Engine: the bot's browser](../architecture/engine.md#the-bots-browser). The adapter keeps one browser call, the deletion of the engine's old profile, for the sign-ins made there before 0.16. The rest of its browser code is gone: only `packages/engine-t3` ever knew it, and J3 Bots' browser knows nothing of T3 Code.

## Consequences

- J3 Bots writes and keeps its own browser tools, driver, viewers and sign-in sync. Much of the hardest part is ported, but the work is large.
- The fill of a saved login can check the field and its frame beside the page, before it types. The proposal to T3 Code is no longer needed.
- A person's sign-ins reach the server, sealed at rest. A bot misled into using its shell can open them there, as it can every secret ([Security: trust model](../architecture/security.md#trust-model)).
- A desktop that is asleep or closed sends a bot's new tab to the server. A server tab moves to a desktop only once it was parked, unused, and a bot opens it again while a desktop is there.
- [Architecture: the browser](../architecture/browser.md) names each piece and the work that builds it.

## Rejected

- **Driving the engine's browser from J3 Bots.** It keeps every problem above and leans on T3 Code's private surfaces.
- **Asking T3 Code for a secret-typing action.** Withdrawn: J3 Bots can now check the field itself.
- **`chrome-headless-shell` on the server.** Sites can tell it from Chrome, and compatibility with real sites comes first.
- **Separate sign-ins per host.** A person who signs in on the desktop would be signed out on the server.
