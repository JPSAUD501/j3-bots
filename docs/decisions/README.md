# Decision records

A record exists for a decision that would be expensive to reverse. Each one states the context, the decision, what it costs, and what was rejected.

**Accepted** records are settled. **Proposed** records are recommendations waiting for the project owner.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-t3-code-as-unmodified-engine.md) | T3 Code is the engine, used unmodified | Accepted |
| [0002](0002-single-server-between-clients-and-engine.md) | One server sits between clients and the engine | Accepted |
| [0003](0003-conversation-is-not-session.md) | Conversations belong to J3 Bots, sessions to the engine | Accepted |
| [0004](0004-speech-is-a-tool.md) | Speech is a tool | Accepted |
| [0005](0005-j3-bots-owns-wakes.md) | J3 Bots owns scheduling and routing | Accepted |
| [0006](0006-memory-is-files.md) | Memory is files | Proposed |
| [0007](0007-client-and-server-stack.md) | Client and server stack | Accepted |
| [0008](0008-license.md) | License: AGPL-3.0-or-later with an app-store permission, contributions signed off | Accepted |
| [0009](0009-a-wake-is-sent-at-most-once.md) | A wake is sent at most once, and uncertainty fails visibly | Proposed |
| [0010](0010-workers-reconcile-durable-state.md) | The turn machinery's workers reconcile durable state | Accepted |
| [0011](0011-a-room-runs-one-turn-at-a-time.md) | A room runs one turn at a time | Accepted |
| [0012](0012-desktop-reaches-the-server-directly.md) | The desktop renders the bundled web build and calls the server from its own origin | Proposed |
| [0013](0013-background-work-belongs-to-the-turn-that-started-it.md) | Background work belongs to the turn that started it | Accepted |
| [0014](0014-push-goes-through-a-push-sender.md) | Push goes through a push sender, and Expo's service is the first | Proposed |
| [0015](0015-a-release-is-a-self-contained-archive.md) | A release is self-contained: an archive per Linux architecture, and a server runtime in each desktop package | Accepted |
| [0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md) | An update keeps a snapshot to roll back to | Accepted |
| [0017](0017-the-android-app-is-a-signed-apk-on-the-release.md) | The Android app is an APK on the release, signed with the project's key | Accepted |
| [0018](0018-the-interface-follows-pips.md) | The interface follows Pips: lively bots on quiet chrome | Accepted |
| [0019](0019-codex-runs-with-a-home-of-its-own.md) | Codex runs with a home folder of its own; the commands it runs keep the user's | Accepted |
| [0020](0020-the-local-desktop-gets-its-device-through-the-admin-channel.md) | The local desktop gets its device through the admin channel, never over TCP | Accepted |
| [0021](0021-a-missed-routine-runs-only-while-it-is-nearer-than-the-next.md) | A missed routine runs only while it is nearer than the next run | Proposed |
| [0022](0022-the-operator-arranges-the-roster-in-sections.md) | The operator arranges the roster in sections the server keeps | Proposed |
| [0023](0023-a-bot-template-is-a-file.md) | A bot template is a file, built and imported by the server | Accepted |
| [0024](0024-the-local-server-is-a-supervised-child-of-the-app.md) | The local-mode server is a supervised child of the app | Proposed |
| [0025](0025-a-file-stands-where-the-operator-placed-it.md) | A file stands where the operator placed it, as a mark in the draft's text | Accepted |
| [0026](0026-a-bot-uses-connected-services-through-j3-bots.md) | A bot uses connected services through J3 Bots, which holds the sign-in | Accepted |
| [0027](0027-connector-tools-reach-a-bot-through-the-j3-bridge.md) | Connector tools reach a bot through the `j3` bridge, under the bot's permission mode | Accepted |
| [0028](0028-one-secret-store-for-logins-and-connector-secrets.md) | One secret store for logins and connector secrets | Proposed |
| [0029](0029-the-vault-key-comes-from-a-master-password-held-in-memory.md) | The vault's key comes from a master password, held in memory | Proposed |
| [0030](0030-a-visual-is-part-of-say.md) | A visual is part of `say`, drawn by J3 Bots' clients in a sandbox | Proposed |
| [0031](0031-a-release-is-signed-and-a-nightly-is-a-pre-release-of-the-next-patch.md) | A release is signed, and a nightly is a pre-release of the next patch | Accepted |
| [0032](0032-updates-are-served-outside-the-protocol.md) | Updates are served outside the protocol, and offer only a signed, newer release | Proposed |
| [0033](0033-a-client-update-runs-in-a-transient-unit.md) | A client's update runs in a transient unit, and the home records how it ended | Proposed |
| [0034](0034-the-desktop-app-installs-only-a-signed-download.md) | The desktop app installs only a download its release signed | Proposed |
| [0035](0035-the-android-app-installs-its-update-through-a-session.md) | The Android app installs its own update through an installer session, after checking it | Proposed |
| [0036](0036-phone-access-restarts-the-local-server-on-the-network.md) | Phone access restarts the local server on the network, under the server's own `lan` rules | Accepted |
| [0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md) | The server types a saved login into the bot's tab, unattended | Proposed |

When a decision is replaced, its record is rewritten to say what now holds and why the earlier choice was dropped.
