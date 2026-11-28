# The browser

J3 Bots runs the browsers its bots use, on the person's desktop first and on the server when no desktop is there. The engine's browser is off ([decision 0110](../decisions/0110-j3-bots-runs-its-own-browsers-and-the-engines-is-off.md)). This page names the pieces, what each owns, and which part of the 0.16 work builds it. It is rewritten as each part lands.

## The pieces

```
  bot's session ──browser_* tools──┐        viewers (web, desktop, phone)
                                   v                    │ media socket
                 +-----------------+--------------------v---+
                 | J3 Bots server: Browser service           |
                 |  tab registry, placement, leases, the     |
                 |  person's hold, the sealed jar, fill, help|
                 +------+-------------------------+----------+
                        | BrowserHostRpcs          | BrowserHostRpcs
                        | (in process)             | (over the desktop's connection)
                 +------v---------+         +------v---------------------+
                 | server host    |         | desktop host                |
                 | Chrome for     |         | Electron views, one CDP     |
                 | Testing, new   |         | relay per tab, Playwright   |
                 | headless       |         |                             |
                 |  DriverPage    |         |  DriverPage                 |
                 +----------------+         +-----------------------------+
```

A tool call crosses the network once. The server decides which tab and whether the bot may act, then asks the tab's host for one piece of page work. The host runs it beside the page with the shared driver.

| Piece | What it owns | Code | Work |
| --- | --- | --- | --- |
| Shared tab | A tab's durable ref, where it runs, who opened it, the bots on it, who acts and who holds it. A private tab is never listed to a bot. | `SharedBrowserTab`, `BrowserTabWhere`, `BrowserTabOpener`, `BrowserTabHolder` in `packages/contracts/src/browser.ts` | Core (here) |
| Page host protocol | What the server asks of a host, and what a host reports: tabs, page work, screencast and input, cookies and storage. | `BrowserHostRpcs`, `BrowserHostHello`, `BrowserHostEvent`, `BrowserHostError` in `packages/contracts/src/browserHost.ts` | Core (here) |
| Tool schemas | What a bot's `browser_*` tools take and return. | `packages/contracts/src/browserTools.ts` | Core (here) |
| Driver | One tab's page, driven through Playwright: snapshot, act, evaluate, wait, navigate, dialogs, screenshots, screencast, input. | `makeDriverPage` in `packages/browser` | Core (here) |
| Host interface | One method per protocol call, so a host in the server's process and one across a connection are driven alike. | `PageHost`, `driverTabCalls`, `pageHostHandlers`, `remotePageHost` in `packages/browser` | Core (here) |
| CDP relay | Makes one desktop tab's debugger look like a browser to Playwright. | `createCdpRelayConnection` in `packages/browser` | Core (here); the desktop host uses it |
| Fake host | A host in memory, for tests of what drives one. | `makeFakePageHost` in `@j3-bots/browser/testing` | Core (here) |
| Browser service | The tab registry, placement on hosts and parking, leases, the person's hold, the `browser_*` tools, the host socket, the viewers' media socket, and the login fill and browser help on these tabs ([Server: the bot's browser](server.md#the-bots-browser)). The engine adapter's browser code is gone but what keeps the engine's browser off ([Engine: the bot's browser](engine.md#the-bots-browser)). | `apps/server/src/browser`, `browserTools.ts` in `packages/prompts` | Server host (built) |
| Server host | Chrome for Testing in new headless mode, pinned per platform and downloaded on first use; one context with no profile on disk, which takes sign-ins as cookies and storage the server writes. | `apps/server/src/browser/server` | Server host (built) |
| Sign-ins | The sealed jar, its sync with every host, moving today's sign-ins out of the engine's profile, Settings → Browser. | `SignIns` and `bringIn` in `apps/server/src/browser/signins`, `oldEngineBrowser` in `packages/engine-t3`, `readProfileSignIns` and the CDP cookie mapping in `packages/browser`, Settings → Browser in the clients | Sign-ins (here) |
| Desktop host | The in-app browser: views, the side panel, the pop-out window, private tabs, hidden tabs that keep painting. | `apps/desktop` | Desktop host |
| Viewers | Watching and using a tab from the web and the phone. | `apps/web`, `apps/mobile` | Viewers |

## Boundaries

- **`packages/browser` knows nothing of T3 Code:** not its protocol, its types or its files. Some of its code is adapted from T3 Code under the MIT license; each such file says so, and `packages/browser/NOTICE` carries the license.
- **Clients never reach a host.** They watch and use tabs through the server, by the tab's ref.
- **A client learns at once that a tab's host is gone.** A desktop's tab waits 45 s for its app to come back, listed as `away` meanwhile, and is parked if it does not. A tab with no host sends no new picture, its viewers keep the last, and the server refuses the person's input to it with a `refused` frame saying why, rather than passing it to a host that is gone or holding the tab for nothing.
- **Opening a tab for the person says why it did not.** `browser.open` tells apart no browser to take the tab, a server that runs only an app's, a full server browser, and a page the host could not open: not in time, at a refused address, or a failure ([Server: the bot's browser](server.md#the-bots-browser)).
- **A host never speaks raw CDP to the server.** One call is one piece of page work.
- **The server owns every ref.** A host mints one only for a tab it opens by itself, such as a pop-up or the person's new tab, with at least 128 bits of randomness.

## Sign-ins

The person's sign-ins are one jar on the server, which every host's store agrees with ([Server: sign-ins](server.md#sign-ins)):

- **Hosts only read, write and clear.** A host implements `cookies.read`, `cookies.write`, `storage.read`, `storage.write` and `storage.clear` (an origin's site data besides cookies, or every origin's, for signing out), and reports what its pages change (`cookies.changed`, `storage.changed`) when it can. `storage.clear` also empties the `sessionStorage` of the host's open tabs of those origins and loads a tab of one again, so a signed-out page keeps nothing in its memory. What to take, what wins and what to send each host is the server's.
- **A host with `indexedDb` carries databases too**, in `BrowserIndexedDb`: Playwright's `storageState` shape and value encoding. What it promises:
  - `storage.read` with `indexedDb` gives each origin's databases whole, every record, and `[]` when it has none. An origin whose databases hold a value that shape cannot carry (a `CryptoKey`, a `Blob`) comes back without `indexedDb`, never read in part or wrong.
  - `storage.write` makes an origin given with `indexedDb` hold exactly those databases, and leaves them as they are when it is given without. A write that fails leaves the origin's databases as they were.
  - A change that needs a version change (a database deleted, or opened at another version) waits on every page that holds the database open, and cannot be called back once asked for. So a host never leaves one waiting: it writes nothing of that origin, names it in `waiting`, and writes every other origin given. The server writes it again later.
  - The host speaks host protocol 2 (`BROWSER_HOST_PROTOCOL_VERSION`), whose `storage.write` answers `BrowserStorageWritten`: `{}` once every origin given is written, `{ waiting }` with the origins it wrote nothing of.
  - `readDatabases` and `replaceDatabases`, in `packages/browser`, do this from a page of the origin; `versionChanges` says whether the host lets a version change be made now. The limits on what is carried are the server's: a host is asked for no databases of an origin too big to carry.
- **The server's own host reads and writes storage in a probe**: a page of the origin, past any service worker (`Network.setBypassServiceWorker`), whose every request is answered with an empty page, so no site's code runs where its storage is read. It clears an origin's site data with `Storage.clearDataForOrigin` from a page of its context, then the `sessionStorage` of its open tabs of that origin: a test against a page it serves on the loopback checks both (**Verified** on Playwright's Chromium build 1234; CI runs the same test on Chrome). It reads and writes IndexedDB there too (`indexedDb`), in Playwright's `storageState` shape, with `readDatabases` and `replaceDatabases` from `packages/browser`, which follow Playwright's own storage script and value encoding (Apache License 2.0; see `packages/browser/NOTICE`). That the bypass covers the probe's navigation is **Assumed**.
- **A host names its store and its browser's run.** `cookieStore`, in its hello, stays the same for as long as the store keeps its cookies, and changes once it is cleared. With it, a host that comes back is agreed three ways, from what both held when they last agreed; without it, the host is treated as new. `browserRun` is a new random id each time the host's browser starts, so the server tells a session cookie lost to a restart from one the site removed.
- **Cookies cross the protocol in one shape**, `BrowserCookie`, keyed by their whole partition. `cookieOfCdp`, `cdpParamOf` and `cdpRemovalOf` in `packages/browser` map it to and from the DevTools protocol's `Storage.getCookies` and `Storage.setCookies`, for a host that reads raw CDP; the server's own host uses them. A cookie for its host alone has no leading dot on its domain, one set without SameSite stays without it, and one under an opaque partition is not read, since it cannot be set again.
- **The move from the engine's profile** reads it with `readProfileSignIns`, in `packages/browser`: a copy of the files it needs, opened by the Chromium that wrote it with the network off, every request answered by an empty page in the process. The origins whose storage it kept are found in its own files, by a small reader of LevelDB's log and table files (`leveldb.ts`, Snappy included).

## The driver

`makeDriverPage` drives one Playwright `Page` for as long as its scope lives. The host gives it the page and a CDP session of that page, since only the host knows how to open one.

- **Snapshot.** Playwright's accessibility tree in its `ai` mode, with boxes. Each ref is rewritten as `j3-<driver>-<document>-<native>`. The browser keeps an element's number within one document, so a ref holds across snapshots, and one bot's snapshot takes nothing from another. It ends when the main frame navigates or a frame detaches. A ref the document did not give out, or whose element is gone, is refused as `stale-ref`, which tells the bot to take a new snapshot. A ref goes alone, as `aria-ref=<ref>`: a selector that mentions `aria-ref` any other way is refused. A tree over 20,000 characters is cut at a line's end, or at the limit when no line ends in reach.
- **Masking.** Before the tree is read, and again after, each frame's password values, and values a page hides behind dots, are read in an isolated world of their own. Every form of them is masked wherever the tree or the title shows them. A value that changed between the two reads restarts the snapshot once. `data:` payloads are cut before masking.
- **Actions.** Click, type (focusing a text field first; pickers and sliders take their value whole), hover, select, drag, upload, press, scroll. A ref's element is found once, while no snapshot numbers elements, and the action runs on that element alone: an action still waiting when the page navigates fails as `stale-ref`, and never lands on the next page. Each action has a deadline, its own or 15 s. An action that opens a dialog returns at once, for the bot to answer it. A timeout says whether the target still matches, since the action may have happened.
- **Dialogs.** While one waits, the page runs no script, so a snapshot, an action, a script or a wait is refused until the dialog is answered, by the bot or by the person.
- **Evaluate.** Over CDP `Runtime.evaluate`, retried in the console's REPL mode only when the parser refused a top-level `await`. A script over its time is stopped without waiting for the renderer to acknowledge it. Results over 64 KB are refused.
- **Navigate.** Stops a script that keeps the page from answering, waits for the commit, then for the readiness asked. A page whose resources stall past the time is reported loading, not failed. A page that fails to load reports the browser's net error as `loadError`, and the tab keeps the address that failed. Only `http:` and `https:` open.
- **Screencast.** One per tab: a second, while one runs, is refused, and the server shares the one among its viewers. One frame is out at a time. While it is, only the newest waits, and every frame dropped is acknowledged to Chromium at once.

The snapshot, the masking, the actions and `evaluate` follow T3 Code's `ServerBrowserPage.ts` (**Read** at `bc0f04d`). T3 Code gives refs out per snapshot and runs one step on a tab at a time; J3 Bots keeps refs per document and finds a ref's element once, since several bots read and act on one tab.

## The server's browser

The server's own host runs full Chrome for Testing in its new headless mode, one version pinned per platform by size and SHA-256 (158.0.8127.88 in 0.16: 208 MB to download on `linux64`, 413 MB unpacked). It starts when a tab needs it, keeps at most three tabs live, parks a tab unused and unwatched for 5 minutes, and closes once it has had no tab for a sweep ([Server: the bot's browser](server.md#the-bots-browser)). What it needs from a host, and how to give it, is in [Operating: the browser](../operations/operating.md#the-browser).

**What a tab costs.** Measured on 2026-11-27 on an x86-64 Linux machine with 8 cores, with Chrome for Testing 158.0.8127.88 at a device scale factor of 1, on a page that repaints a full canvas every frame, the worst case. Each figure is the memory of the whole browser (PSS) and the cores it kept busy. **Verified** there; no arm64 machine, such as a Raspberry Pi, was measured.

| Tabs | Memory | Cores |
| --- | --- | --- |
| One still tab | 340 MB | 0 |
| One moving tab | 360 MB | about 1.4 |
| One moving tab, watched | 384 MB | about 1.4 |
| Three still tabs | 380 MB | 0 |
| Three moving tabs | 469 MB | 3.8 |

A device scale factor of 2 adds 90 MB to one moving tab, and 207 MB and nearly a core to three; in the same test of `chrome-headless-shell` it halved a viewer's frame rate at the same picture size. So the server keeps 1. Chrome for Testing takes about 160 MB more than `chrome-headless-shell` at every point, for a browser sites cannot tell from Chrome.

## Testing

`packages/browser`'s driver tests run on a real Chromium, over fake pages the test serves itself; nothing leaves the machine. They run when `J3_TEST_CHROMIUM` names a Chrome or Chromium binary, which CI sets to the runner's Chrome, and are skipped otherwise. Everything else uses `makeFakePageHost`.
