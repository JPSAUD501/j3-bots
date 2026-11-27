# 0097: What's new ships with the apps, and follows the server's version

**Status:** Accepted.

## Context

The update prompt shows a release's highlights, read from the release notes, and links to the notes, but only before an update ([decision 0051](0051-an-update-asks-in-front-and-goes-server-first.md)). Once the update is done, nothing says what changed. The notes don't fill that gap: they are in English and written for whoever runs the update, with migrations, protocols and rollbacks. The owner asked for a small "What's new" button that shows the news when J3 Bots updates.

## Decision

**Every client has a "What's new" place that lists what each release lets people do, newest first. Once after an update it carries a quiet mark, "New in 0.14", until it is opened. The text ships with the apps, in every language, and the mark follows the server's version as each device last saw it.**

- **Where it is.** On the web and the desktop, it is a row in the roster's footer, above Settings, where the update prompt's way back already sits. A non-technical person sees it without opening anything. On the phone, the roster's header has no room for a row, so What's new is the last row of Settings, and while it is marked, a quiet line over the roster says "New in 0.14" and opens it, as the update's own line does. Quick access is one conversation and has no footer, so it has none. Nothing opens by itself: there is no modal and no notification.
- **What it says.** Each release has a few entries. Each entry has a short title, one or two plain sentences on what you can now do, and optionally where to find it. They are written for someone who isn't technical, in English and Brazilian Portuguese. Entries have no pictures yet.
- **Where the text lives.** It is a typed catalog in `packages/i18n/src/whatsNew/`, with one file per release (`v<x.y.z>.ts`). Each text has every language (`InEveryLanguage`), so a missing translation does not compile. It is not parsed from the GitHub release or from the notes. Those are written for operators, and a client would need the network and a parser to read them.
- **Which releases show.** A device shows the releases up to the version its server runs. A release candidate or a nightly counts as the release it leads to. An app newer than its server doesn't announce what that server can't do yet. A server older than every release in the catalog shows nothing, and the place is hidden.
- **The mark.** The device keeps the server's version it last saw and the newest release it opened (`j3:whatsNewSeen`, in the browser's storage or the phone's). The server's version comes from the update status every client already reads when it connects and every hour. So a device marks the release once the server it talks to runs it, even if the update was started elsewhere, and keeps showing it offline. The mark names the newest release shown, until that release is opened. A patch release with no entries of its own brings no new mark. A device that never opened What's new carries the mark the first time there is something to show, since there is no way to tell a new person from someone who has just updated. The mark is quiet enough not to need that.
- **The release gains a step.** The lead writes the release's entries along with its notes. The release workflow's first job refuses a tag whose commit has no `packages/i18n/src/whatsNew/v<x.y.z>.ts`, the same way it refuses a tag without notes, and it reads that file through the API without running the repository's code. A test on every pull request checks that each such file is in the catalog under the version its name says. So a file the workflow finds is a release the apps show.
- **No protocol change.** Nothing new crosses the wire: the server's version was already in the update status. An older client knows nothing of the catalog and shows nothing until it updates, which is fine.

## Costs

- **A release needs a commit before its tag** for the entries, as it already did for the notes. A patch release needs at least one entry too, even if it only says what it fixed.
- **Two places say what's new:** the notes, for operators and the bot's `j3-app` skill, and the catalog, for people. They are written for different readers and can say different things.
- **A new device sees the mark once**, on a release that came out long ago for the people who already used it.
- **Another window of the same browser** keeps its mark until it reloads after What's new was opened in one.

## Rejected

- **Reading the highlights from the release feed after the update.** They are English and written for operators. A client would need the network to show them, and an Android app newer than its server would have nothing to read.
- **A dialog that opens after an update.** It interrupts, and it would come right after the update prompt, which already interrupted.
- **Marking by the app's own version.** On the desktop and the phone, the app can run a different version than its server. The features a person can use come with the server.
- **Checking the entries in the server's build.** CI builds stable-looking versions of its own (such as `0.0.1` and `0.0.2` in the upgrade check), which have no entries, so such a check would fail CI's own builds. The release workflow is the one place that knows a build is a release.
