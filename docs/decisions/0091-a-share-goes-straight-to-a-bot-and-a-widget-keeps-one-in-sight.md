# 0091: A share goes straight to a bot, and a widget keeps one in sight

**Status:** Accepted.

## Context

The desktop has quick access ([0069](0069-quick-access-is-a-second-window-on-the-primary-bots-conversation.md)): a word to the primary bot without leaving what the operator is doing. The phone had nothing like it. Sharing from another app already reached J3 Bots, but it opened the whole app, asked for a bot or a room in the roster's list, and left the share in that conversation's draft, where it still waited for Send. Nothing on the home screen showed a bot at all.

The owner asked for the phone's pair of quick access: "from any app you send a photo, a link or a PDF to a bot from the share menu. The widget shows the bot's face and the last result of a routine." The lead settled the shape: a small sheet over the other app; Android's Direct Share offering the bots the operator talks to most; one widget with two kinds, a bot or a routine; native code only where Android requires it, no new background service, no Firebase or Expo services.

Three choices are expensive to reverse: what runs natively and what stays in React Native, how files from another app are taken in, and how a widget learns anything while the app is closed.

## Decision

**A share opens a sheet of the app's own over the app that shared, which sends it to the bot the operator picks as one message. A home-screen widget shows a bot or a routine from what the app last learned.** [Clients: Mobile](../architecture/clients.md#mobile) describes both; [Experience](../product/experience.md#from-other-apps-and-the-home-screen) says what the operator sees; [Security](../architecture/security.md#a-share-from-another-app) says how files from other apps are handled.

- **Native where Android requires it, React Native for the rest.** Two local modules hold the Kotlin. `share-sheet` holds the activity that receives `ACTION_SEND` and `ACTION_SEND_MULTIPLE`, the copy of each shared file, and the Direct Share shortcuts. `home-widget` holds the widget's provider, its layouts and the activity that sets one up. Each activity is a React Native activity with a translucent window and a root component of its own (`J3Share`, `J3WidgetSetup`), on the same JavaScript runtime as the app, so the sheet and the setup draw with the app's components, faces and words, and use the app's one connection to the server.
- **The sheet is the whole share.** It shows what is being shared, the bots with their faces (the one shared to last first, then pinned bots, then the rest in the roster's order; hidden bots and rooms are not offered), an optional line, and Send. Send uploads the files and sends one message, as the composer's Send does, then the sheet closes and a toast names the bot. The operator's draft in that conversation is not touched. Without a pairing, the sheet says the phone is not connected to any bots yet and offers to open the app; a template file shared on its own still opens the app on its preview.
- **What a message says.** The operator's line first, then the shared text, then a link with the title the sharing app gave it (`EXTRA_SUBJECT` or `EXTRA_TITLE`) on the line above it. J3 Bots never fetches the page to find one. Files take the composer's limits and its reasons (`sharedMessage` in `client-runtime`).
- **Files come in through their content URI only, once, into the app's own storage.** A `file:` URI, which would name a path in another app, is refused. Each file is read once through the grant Android gave the activity and copied into a folder of the app's cache for that share, under a name stripped of any path. A copy stops one byte past the largest attachment the server takes, and the file is then said to be too large rather than read further. The folder is deleted when the sheet closes, whatever happened; a folder left by an ended process is deleted by the next share.
- **Direct Share offers bots, never rooms.** Up to Android's limit, as long-lived dynamic shortcuts in the sheet's order, each with the bot's still face drawn by the app. A shortcut's own tap, from the launcher, opens the bot's conversation. They are rewritten when the roster changes and taken away when the phone is signed out.
- **A widget is a bot or a routine, picked as it is added**: a bot, or a bot and then one of its routines. A bot shows its face with its light, in the state the app last saw (working, waiting for the operator, quiet), and opens its conversation. A routine shows its name, when it last ran, and the start of what its last run said, and opens that: the conversation for a run that reported back, the routine's runs for any other. A widget whose bot or routine is gone says so and opens its setup.
- **The app feeds the widgets; nothing runs for them in the background.** While its JavaScript runs and it is connected, whichever of its windows is open, the app follows what the widgets show and writes it again as it changes (names, states, routine results, the faces drawn as images, the words in the app's language), and Android draws them again. Otherwise Android's own widget refresh, every 30 minutes at most, draws them from what was written: the time a routine ran stays right, and a bot last seen working more than 30 minutes ago shows quiet, since the app cannot know its turn is still going. Waiting for the operator stays until the app learns otherwise.
- **The widget is RemoteViews, not Jetpack Glance.** Glance needs Compose in a library module, a compiler plugin and its runtime in the APK, for two small layouts that RemoteViews draws as well.
- **Additive and client-only.** No contract or server change; the protocol stays 11.

## Costs

- **Two activities share the app's JavaScript runtime.** A share that starts the app starts the session and connects as the app does, and the sheet and the app's own screens share one connection and one store. React Native supports more than one activity on one host, but each is a surface the release build must check.
- **The Kotlin is checked only by the release build.** The pull request's CI builds no Android app; the nightly does, and nothing here was run on a device or an emulator.
- **A widget is only as fresh as the app's last look.** A bot that starts working while the app is closed shows quiet until the app runs again.
- **A notification does not update a widget.** A notification that arrives while the app is in the background reaches only Android's tray, and the app is not connected then; reading it natively would be the second client rejected below. The widget catches up the next time the app connects.
- **Faces are images.** A widget shows the face drawn when the app last wrote, in light and dark, and Android picks by the launcher's theme.
- **Sending waits for the server.** The sheet stays up, with its progress, until the message is accepted; with the server out of reach it says so and keeps trying until the operator stops it.

## Rejected

- **Opening the app and leaving the share in a draft**, as before: the operator leaves what they were doing, and the share still needs a second Send.
- **A sheet drawn natively.** It would draw faces, the roster's order and the app's words a second time, in Kotlin.
- **A widget that asks the server itself**, through a background job or a push the app handles natively: a second client in Kotlin with the device's credential, and the battery cost the lead ruled out.
- **Fetching a shared link to find its title.** It would reach a site the operator did not open, from their phone, before they press Send.
- **Rooms in Direct Share and the sheet.** The owner's ask is a bot; a room's conversation is reached in the app.
