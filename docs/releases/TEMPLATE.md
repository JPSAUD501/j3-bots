# J3 Bots x.y.z

One or two sentences on what this release is for the person using it. Say which T3 Code version it pins.

## Updating

This release speaks **protocol N**. Say whether that is the same protocol as the release before it, or a new one.

Update the server first, then the apps. "Update now" in the update prompt does this in that order: it updates the server, waits for it to answer on this version, then updates the app it was pressed in. A browser reloads.

- **The server:** from the update prompt on any device, or `j3-bots update` on its machine. Either copies the databases into a snapshot first. List this release's migrations and what each changes.
- **The desktop app and the Android app** follow the server from the prompt. With "Update automatically" on, they also update themselves as they open. The deb and the Mac build link to this release.
- **The web client** comes with the server.

When the protocol changes, say what an app that has not updated yet shows: the screen that says which side is behind, with the update that brings it forward.

### Rolling back

What `j3-bots update --rollback` to the previous release puts back, what is lost with it, and whether the apps still talk to the older server.

## What's new

The update prompt shows the bold lead of each top-level item below, in order, as the release's highlights: up to five, each up to 160 characters. Write each lead as a whole short sentence that stands on its own, and put the pull request and the details after it. The whole section also goes, as written, into the `j3-app` skill of the release's server build, which is how a bot knows what changed: write it for the person using J3 Bots, and keep it to what they will see.

- **What changed, in one short sentence** ([#123](https://github.com/JPSAUD501/j3-bots/pull/123)). What it does and why, for the person using it.

## Known limits

**Not tried for real yet:** what was checked only by tests or fakes.

**Limits of this version:** what does not work yet.
