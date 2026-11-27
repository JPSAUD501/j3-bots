# 0098: The desktop app records the screen for a bot, as one zip a bot's AI can read

**Status:** Accepted.

## Context

Showing a bot how something is done is often quicker than describing it: a chore with many clicks, a bug that shows only in a certain order, an app the bot has never seen. The owner asked for a way to record the screen and send it to a bot, and put the scope plainly: it is a feature to record and send, and the AI decides the rest. A bot's AI reads files, not video players, so a recording is only useful if what it holds can be read without watching it: where the operator clicked, what they typed, which window was in front.

## Decision

**The desktop app records every whole screen, the operator's voice, and the keys, clicks, scrolls and windows they use, into one zip that lands in the draft as a file. Nothing leaves the computer while it records; in the draft it uploads to the operator's server as any file does, and the bot gets it when the message is sent. It ships in 0.15.0.**

- **Where it starts.** The composer's `+` offers Record your screen in the desktop app and its quick access, beside files; quick access opens the sheet in the main window. A bot can offer it too: `say` takes `offer: "record-screen"`, which shows a Record your screen button under its message. In a browser and on the phone, which cannot record, the offer is a quiet line that says to open the app on the computer. The bot's prompt says it can offer this when showing would be quicker than telling.
- **The sheet.** It says, in plain words, what is recorded (all screens, the voice, keys and clicks), that it goes to the bot as a file, that the bot's AI looks at it, and how passwords are kept. It offers the microphone, with its level live, and on macOS the two permissions while they are missing (Screen Recording, Accessibility). Then it counts 3, 2, 1. There is no screen picker: every whole screen is recorded, so nothing the operator shows is left out.
- **While it records.** A small control floats over everything: the bot's face listening, a red dot, the voice's level, Pause or Resume, Stop and Discard. There is no clock. It can be dragged, and macOS and Windows leave it out of the capture. The app's windows hide and come back on Stop. Pause records nothing until Resume, keys and clicks included.
- **The zip.** `screen-<n>.mp4` per screen, left to right, H.264 at 720p or less and 5 frames a second; `voice.webm` (Opus); `events.jsonl`, with clicks placed on their screen (its number, the video's pixels and the position from 0 to 1), typed text in runs, special keys and shortcuts, scrolls, the app and window title on each change, and pauses; `frames/`, a JPEG at each click and window change; `manifest.json`; and a `README.md` written for an AI, which says how to read the rest. Times count from the start, paused time left out. The zip is stored, not compressed, since the videos are compressed already.
- **On disk as it records.** Each encoder hands the main process a piece a second, appended to its file; events and pictures are written as they come. The zip is never written: the app serves it as ranges over those files, so a recording never takes twice its size. A recording the app did not finish, as when it quit, has its videos cut back to their last whole piece and its events to their last whole line, and is offered again on the next start, marked as interrupted. The disk's free space is checked before it starts and as it runs; it warns when space runs low and stops, keeping what it recorded, before the disk fills. There is no time limit.
- **Passwords.** Where the system says a password field has the keys, only that a password was typed is kept: macOS's secure input, Windows' UI Automation `IsPassword` on the focused element. A key is held until the next reading, and kept as a password if the reading before or after it was on; once the signal is lost, no more text is kept. Elsewhere the sheet says to pause before typing one.
- **Wayland and X11.** On Wayland no app may read other apps' input, and the system's portal gives the app the one screen the operator shares when it asks (**Read** in Electron 44's `desktopCapturer` documentation), so a recording there is that screen and the voice, and the sheet says so. X11 gets everything. On Linux the control shows in the video, since no system there can leave a window out of a capture.
- **Sending.** On Stop the zip is in the draft. It uploads in pieces that resume, to a cap of its own (8 GiB) that the server's free disk bounds, not by raising the 25 MB every other file has. A server says it takes recordings with `screenRecordings: true` in the roster snapshot, and a client offers recording only then. The protocol stays 11. Everywhere else, the zip shows as a normal file.
- **Transcript.** A `transcript.json` is for when J3 Bots transcribes speech on the operator's machines (decision 0096, not merged yet). Until a recording carries one, the manifest's `transcript` is null and the README says the voice is only in the audio.

## Dependencies

- **Chromium's own encoders, through `MediaRecorder`.** H.264 into fragmented MP4 and Opus into WebM, in the control's page, a piece a second. No muxer or encoder package is added. Electron 44's `MediaRecorder` wrote H.264 at 1280×720 and 5 frames a second into fragmented MP4, paused time left out (**Verified** under Xvfb on Linux x64). It encodes no AAC on Linux, so the voice is a file of its own in Opus rather than a track of a video.
- **`uiohook-napi` 1.5.5, for keys, clicks and the wheel.** The binding is MIT (Alexander Drozdov); the libuiohook it holds is LGPL-3.0-or-later (Alexander Barker). It ships N-API binaries for macOS, Linux and Windows on x64 and arm64, so nothing is compiled when it installs or in CI, and one binary serves every Electron version. Its last release is from March 2026 (**Read** in its npm metadata). The app copies the binary for its platform beside its bundle and loads it directly, without the package's JavaScript; the licenses and a notice of where its source is ship beside it, and the package's build fails without them. libuiohook is the library the other Node input hooks wrap too.
- **`fflate` 0.8.3, MIT, for tests only:** the store's tests unzip what the app serves.

## Costs

- **Typed text is read as a US keyboard makes it.** The hook reports keys, not the characters a layout makes of them. Letters, digits and the space are right on most layouts; punctuation may not be. The README says so, and the video shows what was typed.
- **Password detection on macOS and Windows has not run on those systems** (**Assumed**). Each is a small helper the app starts while it records: `osascript` asking Carbon's `IsSecureEventInputEnabled`, and PowerShell asking UI Automation. Until it is verified, the sheet's promise rests on them.
- **The control is in the video on Linux.**
- **A recording waits on the computer** that made it until it is uploaded or discarded, and is kept in the app's data folder meanwhile.
- **A recording taken out of a draft unsent stays on the server**, as any uploaded file does, until the bot or room it was for is deleted. For a recording that can be gigabytes, the server should remove uploads no message took; that is a change for every file, not this one.
- **Native code in the desktop app**, with its own license to carry.

## Rejected

- **Picking a screen or a window.** It is one more choice before the recording, and it leaves out what the operator moves to. Every whole screen is recorded instead.
- **The browser's screen picker (`getDisplayMedia`)**: one screen per prompt, and a picker each time.
- **Muxing in the page with a library, or the voice as a track of each video**: it adds a dependency to do what Chromium's recorder already does, and Linux has no AAC to mux.
- **Writing the zip at Stop**: it doubles the disk a recording takes and makes Stop wait.
- **A helper program per system for input**: three programs to build, sign and ship, for what libuiohook already does.
- **Raising the cap for every file**: a recording is the one file that needs gigabytes; every other file keeps its limit.
