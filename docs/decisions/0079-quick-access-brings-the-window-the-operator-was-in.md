# 0079: Quick access brings the window the operator was in

**Status:** Accepted.

## Context

Quick access ([0069](0069-quick-access-is-a-second-window-on-the-primary-bots-conversation.md)) opens over whatever the operator is doing, and what they ask is very often about it: "is this the invoice we were waiting for?", "summarize this page". The bot could not see what "this" was. The owner asked for quick access to capture the app the operator was in and its window's title, and, when the operator wants, a picture of that window; to show them as removable chips above the composer; and to give them to the bot with the message. Desktop only, and privacy first.

Settled before the build: capture happens when the global shortcut is pressed, and only then; no list of every open window; the picture is off until the operator turns it on, for one message or in Settings; the title is on, with a switch in Settings; what is sent is exactly what the chips show; where nothing can be read, nothing shows and nothing complains.

Three questions carry cost if answered wrong: how each system is read without a native module, how the bot is told without a title being able to instruct it, and what is kept.

## Decision

**The desktop app reads the window in front as the shortcut opens quick access, by each system's own means, and the page shows it as chips; what the chips show goes with the next message, the title as marked data after the operator's words and the picture as an attachment.** [Clients: Desktop](../architecture/clients.md#desktop) describes it; [Experience](../product/experience.md#a-quick-word-with-the-primary-bot) says what the operator sees; [Security](../architecture/security.md#j3-bots-own-surface) says what it reads; [Prompts](../prompts/architecture.md#wake-envelopes) says how the bot is told.

- **Each system by its own means, with no native module.** The app ships no `node_modules`, so a native module would be a second build per system and a supply chain the release does not have.
  - **Linux on X11:** in the app's own process, over the display's socket it already speaks for compositing ([0069](0069-quick-access-is-a-second-window-on-the-primary-bots-conversation.md)): the root window's `_NET_ACTIVE_WINDOW`, the window's `WM_CLASS`, `_NET_WM_NAME` or `WM_NAME`, and its pixels by `GetImage`. The class becomes the name a dock shows through the app's desktop entry. A picture only while a compositing manager runs, as without one what other windows cover is not kept.
  - **macOS:** `osascript` (JavaScript for Automation) lists the windows on screen front to back (`CGWindowListCopyWindowInfo`), and the first ordinary window of another process is the one; `screencapture -l` takes its picture. macOS gives a window's title and picture only to an app the operator allowed under Screen Recording, so without it the chip names the app alone, and turning the picture on asks, in a card that says why, and opens System Settings.
  - **Windows:** a small helper in Windows PowerShell, which every supported Windows has, calls user32 and dwmapi through .NET: the foreground window, its title, its process's description, and `PrintWindow` for its picture. It compiles itself the first time the shortcut is pressed and then stays, idle, for ten minutes after the last press.
  - **Wayland:** nothing. No app may read another's window there without the desktop portal asking the operator each time, which is not a quick word. Quick access opens without chips, and Settings says why.
- **Read before quick access takes the keys, or in front-to-back order.** On X11 and Windows the window with the keys changes the moment quick access focuses, so the app waits up to 150 ms for the read before it shows the window. A Windows helper still compiling misses that, and then the first window under quick access's in front-to-back order is the one, passing over those kept above all others (a video's picture in picture, a pinned window), which would otherwise always come first. macOS lists ordinary windows in that order apart from floating ones, so quick access opens at once there.
- **Never from the app itself, never from the tray.** Pressed while one of J3 Bots' own windows has the keys, or opened from the tray's menu, nothing is read.
- **The chips are the message's.** One chip for the app and title, removable; one for the picture, off until tapped. A tap shows what goes, whole. What they show when Send is pressed is what goes, and only with that one message: the chips are gone once it is sent, and with each new showing.
- **A picture is taken only when the page asks**, which it does only once the operator turns the picture on, or as quick access opens when Settings asks for one on every message. It is a JPEG of at most 1,600 px on its longest side, uploaded at Send like any attachment.
- **The bot is told in J3 Bots' own words, and the title stays data.** After the operator's message, one fixed line says the operator was looking at this window as they wrote and that its title is the app's or the page's, not the operator's words; the app and title follow in a nonce-tagged data block. With no title, the line says only which app.
- **The message keeps it.** The entry holds `lookingAt` (the app, and the title when it went), so the conversation shows "Looking at …" under the message on every client, and a replaced session's digest gives it after that message as the envelope did.
- **Additive.** `lookingAt` is an optional field of `message.send` and of a message entry; the protocol stays 11.

## Costs

- **Three ways of reading a window, two of them in another language.** The JXA and C# are short and in this repository, run with each system's own interpreter. They cannot be type-checked with the app.
- **What only a person at a real desktop can check was not checked.** The X11 reading was run against Xvfb with a real window. macOS and Windows are built from their documented APIs and have not been run, nor has a picture on a composited X11 desktop.
- **The Windows helper holds a PowerShell process** for ten minutes after the last press, and the first press after it stops shows the chips a moment late, read from the windows' order.
- **macOS asks for Screen Recording itself only once**, and Electron reports that not-yet-asked state as not allowed, so the app keeps whether it had macOS ask (`screenAsked` in its settings) and opens System Settings after that.
- **A title is the operator's data, and it reaches the bot's AI provider** with the message. It is on by default, as the owner asked, and both the chip and Settings take it off.
- **A picture whose message could not be kept** after its upload stays on the server unclaimed, as a file whose message was never sent does.

## Rejected

- **A native module** (koffi, a node-gyp addon): a build per system and architecture, prebuilt binaries fetched at install, and the app ships no `node_modules`.
- **Electron's `desktopCapturer` for the window's identity.** It names no app, has no notion of the front window, and takes a thumbnail of every window to list them: the list of all windows the owner decided against.
- **The list of every open window.** Decided against by the lead: it is far more than a quick word needs.
- **Taking the picture as quick access opens, every time.** It would read the screen when the operator did not ask, which is the one thing they cannot see happen.
- **Putting the title in the operator's message text.** The bot would read the other app's words as the operator's.
- **A spoken rule in the base prompt.** Its word budget is full, and the line beside the block says it where it applies.
- **The desktop portal on Wayland.** It asks the operator to choose a window each time, which defeats the shortcut.
