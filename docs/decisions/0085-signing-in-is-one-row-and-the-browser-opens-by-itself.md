# 0085: Signing in is one row, and the browser opens by itself

**Status:** Accepted. Amends [0066](0066-connecting-an-ai-is-picking-the-account-you-have.md): its question and its drawn steps are replaced by what this record says.

## Context

The owner tried "Sign in with Claude" and "Sign in with ChatGPT" and asked for two things. The browser should open by itself on that tap, with no second tap on a link. And the screen should be laid out around what the person expects: the sign-in action belongs where the screen already says "Not connected", not loose further down. In his words the screen looked thrown together.

Both had a cause in how [0066](0066-connecting-an-ai-is-picking-the-account-you-have.md) built it.

- **The page was not always opened.** The server reported, with each sign-in page, whether the harness had opened the browser itself, and the client opened the page only when it had not. Where the server could not hand the page to J3 Bots through `BROWSER`, on Windows, it took every page the harness printed as already opened (**Assumed** in [Engine: sign-in from the app](../architecture/engine.md#sign-in-from-the-app)). When the harness had not opened it, nothing did, and the person had to find "Open the page again" and press it.
- **The screen was built from the steps, not from the account.** An account's state line said "Not connected yet.", then three drawn steps, then a hint, then the full-width button at the foot of the panel, or, in the first run, at the foot of the screen, under "Use ChatGPT instead" and "Advanced". Settings put the version and its Update under every account whatever its state. Before any of it, the first run asked a question with two large buttons, and only the one picked showed its sign-in.

## Decision

**J3 Bots opens the sign-in page itself, and each AI account is one row whose status line carries the one action that moves it forward.**

- **The page opens on the tap.** The client that started the sign-in opens the page once, as soon as the server has it, through the app's link path: in the desktop app, `window.open`, which the app hands to the system's browser with `shell.openExternal`. It no longer asks whether the harness opened it. The server now always sends `opened: false`, so the desktop apps of 0.12, which still decode the field and open the page only when it is false, behave the same.
- **One row per account, on every screen that connects an AI:** the first run's step, Settings → Providers, and a conversation whose bot waits for its AI, on the web, in the desktop app and on Android. The row is the account's name and maker, and under it one line that says where it stands: "Not connected", "Your browser opened. Sign in to Claude there.", "You're signed in. Checking Claude…", "Connected", or what went wrong, in plain words. The action sits on that line, at its end: **Sign in with Claude**, **Cancel** while it signs in or waits for its download, **Try again**, **Look again**, **Download Claude**, or, from another device, **How to connect**, which opens where it signs in and the command under the row. A connected account shows a check instead.
- **What is read only when needed sits under the row.** A download's thin bar, the quiet "Browser didn't open? Open the page" link while a sign-in waits, the maker's install page, and the folded Details. The version and its Update show under an account only once it is connected.
- **The rows are the question.** The first run asks "Which AI will Maya use?" and shows both rows. The person signs in to the one they have, right there; there is no picking step before it and no "Use ChatGPT instead". Creating the bot is the quiet button under the rows while an account still asks for a press, and the big one once an account is connected or on its way.
- **The drawn steps go.** The status line says the same in words, at the place the person looks, and the browser opening by itself makes the first step happen rather than describe it.
- **The device code waits.** None of the sign-ins J3 Bots runs for a client today shows a code to type: Claude Code has no such flow, and Codex's `--device-auth` runs only from the command line (`j3-bots provider login codex --device-auth`). When a client sign-in takes one, its code belongs on the row, large and copied on tap, beside the action, with the browser still opening by itself on the page that asks for it.

## Costs

- **A second tab, where the harness also opened it.** A harness that opens the browser itself instead of handing the page to `BROWSER`, as one on Windows may, now leaves two tabs of the same page; signing in on either finishes the sign-in. That is the price of never leaving the person with none. Which harnesses open their own browser on Windows and macOS with no terminal is **Assumed**; it has not been run.
- **Both accounts show at once.** A person who has only one sees the other's row, signed out. The row says only "Not connected" with its button, which reads as a choice, not as something to fix.
- **The fallback link is always there while a sign-in waits.** The desktop app cannot tell whether the system opened the browser: Electron's window-open handler hands the address to `shell.openExternal` and denies the window, so the page has nothing to check. The link stays quiet, under the row.
- **The web in a browser and the Android app still sign in nowhere.** The page returns to the harness on the server's own computer, so only a browser there can finish it ([0066](0066-connecting-an-ai-is-picking-the-account-you-have.md#rejected)). Their rows say where it signs in, behind **How to connect**.
- **Protocol 11 is unchanged.** `opened` stays in the contract, always false, for the clients of 0.12.

## Rejected

- **Making the server tell for sure whether the harness opened the browser.** Nothing the harness does says so: on Windows it is given no `BROWSER` to call, and what it prints is the same whether its own open worked or not.
- **Keeping the question before the sign-in.** It cost a screen and a press before the one action the person came for, and hid the other account behind "Use ChatGPT instead". A row each answers the same question with the sign-in itself.
- **Keeping the drawn steps beside the row's line.** Two accounts of the same thing on one screen, one of them a diagram, is what made it look thrown together.
- **Opening the page in a window of the app's own.** The page has to return to the harness's server on `localhost`, which the system's browser reaches as well, and the person's own browser is where their account is already signed in.
