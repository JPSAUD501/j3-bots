# The every-surface check

The every-surface check keeps the promises J3 Bots makes across devices, end to end: the desktop app and the Android app, each paired as its own device, against one server. It is a script kept in the repository (`apps/desktop/every-surface`, with its server side in `apps/server/every-surface`), and every step passes on an assertion, not on someone looking at a screen. It needs a display and an Android emulator, so it runs by hand: no CI job runs it.

## What it proves

The server runs the scripted agent ([Server: configuration](../architecture/server.md#configuration)), so bots run turns with no model. The check pairs a client of its own to set the scene and to read what the server holds, creates two bots, and pairs the desktop app (the development build, driven with Playwright) and the Android app (the development build on an emulator, driven with agent-device).

1. **Continuity.**
   - Two messages written on the desktop, the second asking the bot for a reply (`[[script:speak text=…]]`): the phone shows both and the reply, once each and in order. The scripted agent answers through J3 Bots' `say` with `done: true`, as a bot does, so no turn adds "A reply didn’t arrive".
   - The phone in airplane mode keeps two messages and sends nothing (the server holds neither), and the desktop writes one meanwhile. Back online, each message reaches the server once, the phone's two in the order they were written, after the desktop's, which arrived while the phone was away; the desktop and the phone both show the server's order.
   - The desktop, cut off from the server, sends a message that cannot go (it shows "Sending…", and the server holds nothing) and keeps a draft; then its process is killed. Launched again with the server reachable, it still has the draft in the composer, and the message reaches the server once.
2. **Cross-device resolution.** The scripted agent asks a question, then requests an approval. Each is answered on the phone (the question's single choice answers on a tap), and the desktop's card shows it resolved without a reload, within five seconds, with no way left to answer. Answering again with the desktop's own credential fails with `Conflict("card-closed")`.
3. **The desktop's own surfaces.**
   - A notification's click opens its conversation. The server notifies only about what no paired device has in view, so the phone leaves the conversation first and the desktop opens the other bot. The check records the notification as the main process shows it and delivers the click as Electron reports one: no notification server runs under Xvfb, so the system's banner is not part of it.
   - The tray lists the bot that waits, read from the menu the main process gives the tray.
   - The global shortcut is registered with the system. Pressing it needs an input tool the check does not assume; the [desktop smoke](../../apps/desktop/test/smoke.test.ts) runs the Show it triggers, which puts the cursor in the composer.
   - `xdg-open` with a link to a bot (`j3bots-dev://bot/<id>`, the development build's scheme) opens that bot, through the link handler the app registers in the check's own profile.

Each step leaves captures of both screens in `apps/desktop/every-surface-captures/` (or `J3_EVERY_SURFACE_CAPTURES`).

## Running it

It has two sides, which may be one machine or two: the **server and phone side** runs the server, the emulator and Metro; the **desktop side** runs the desktop app and the check. The desktop side reaches the server through a TCP forward of its port, and drives the phone through a command that runs one shell line on the other side.

On the server and phone side, with the debug build installed on a booted emulator (`emulator-5554`) and Metro on port 8081 (`npx expo start` in `apps/mobile`, with `adb reverse tcp:8081 tcp:8081`):

```sh
J3_EVERY_SURFACE_PORT=4517 pnpm --filter @j3-bots/server every-surface:host
```

It starts a development server on loopback with the scripted agent, on `J3_EVERY_SURFACE_PORT` (a free port when unset; it refuses 3773, your own server's), in a scratch home that it removes when stopped. It waits for the engine (the first start downloads it), stops at once if the server exits, and prints a pairing code for the check. The emulator reaches the server at `10.0.2.2`, its alias for its host's loopback, so the phone's airplane mode cuts it off; Metro stays reachable through `adb reverse`, which airplane mode leaves alone.

On the desktop side, with the server's port forwarded to the same port on loopback (`ssh -L 4517:127.0.0.1:4517 <server side>`, or nothing when both sides are one machine):

```sh
J3_EVERY_SURFACE_SERVER=http://127.0.0.1:4517 \
J3_EVERY_SURFACE_CODE=<the code> \
J3_EVERY_SURFACE_PHONE_SHELL="ssh <server side>" \
  dbus-run-session -- xvfb-run -a pnpm --filter @j3-bots/desktop every-surface
```

It builds the web client and the desktop app, then runs the check, in a D-Bus session of its own (`dbus-run-session`), so the app's notifications and tray never reach your desktop's. The settings it reads:

| Variable | Default | What it is |
| --- | --- | --- |
| `J3_EVERY_SURFACE_SERVER` | none | The server as the desktop side reaches it |
| `J3_EVERY_SURFACE_CODE` | none | The code the server side printed. It works once, within five minutes; the server side also prints the command that makes another |
| `J3_EVERY_SURFACE_PHONE_SERVER` | `http://10.0.2.2:<port>` | The server as the phone reaches it |
| `J3_EVERY_SURFACE_PHONE_SHELL` | `sh -c` | What runs one shell line where `adb` and `agent-device` reach the emulator |
| `J3_EVERY_SURFACE_METRO` | `http://127.0.0.1:8081` | Metro, as the phone reaches it |
| `J3_EVERY_SURFACE_CAPTURES` | `apps/desktop/every-surface-captures` | Where the captures go |

A development build of the Android app shows React Native's warnings over the bottom of the screen, where the composer is; the check closes them before each tap or text it gives the phone. agent-device's `react-native dismiss-overlay` does not recognise that collapsed bar, so the check finds it in the snapshot and taps its close button.

The check clears the Android app's data before it pairs it, and the desktop app runs on a scratch profile, with Chromium kept off the system's keyring (`--password-store=basic`), so neither touches a pairing of yours.

## What it needs

- On the server and phone side: Linux with this checkout installed, the network for the engine's first download, an Android emulator (x86_64, Android 11 or later for airplane mode through `cmd connectivity`), the app's debug build (`expo prebuild`, then `./gradlew assembleDebug` in `apps/mobile/android`), `adb` and `agent-device` on `PATH`. The emulator takes about 5 GB; stop Gradle's daemons after a build (`./gradlew --stop`) before it boots.
- On the desktop side: Linux with this checkout installed, a display (`xvfb-run`), `dbus-run-session` and `xdg-open`.

## What it does not prove

- **iOS, macOS and Windows.** The phone is an Android emulator; the desktop app runs on Linux only.
- **Push.** Not run: the project has no Expo or Firebase project, which a push to an Android device needs, so the check has no push steps.
- **The system's own surfaces.** The notification banner, the tray icon as a desktop shell draws it, and a key press of the global shortcut: under Xvfb there is no desktop shell, so the check reads what the app hands the system instead.
- **A real model.** Turns run on the scripted agent; what a model would say is the [prompt evals'](../../packages/prompts/evals) to judge.
