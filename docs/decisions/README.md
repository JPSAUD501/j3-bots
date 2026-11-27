# Decision records

A record exists for a decision that would be expensive to reverse. Each one states the context, the decision, what it costs, and what was rejected.

**Accepted** records are settled. **Proposed** records are recommendations waiting for the project owner. A **Superseded** record says what it decided, why it was dropped, and which record replaced it.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-t3-code-as-unmodified-engine.md) | T3 Code is the engine, used unmodified | Accepted |
| [0002](0002-single-server-between-clients-and-engine.md) | One server sits between clients and the engine | Accepted |
| [0003](0003-conversation-is-not-session.md) | Conversations belong to J3 Bots, sessions to the engine | Accepted |
| [0004](0004-speech-is-a-tool.md) | Speech is a tool | Accepted |
| [0005](0005-j3-bots-owns-wakes.md) | J3 Bots owns scheduling and routing | Accepted |
| [0006](0006-memory-is-files.md) | Memory is files | Accepted |
| [0007](0007-client-and-server-stack.md) | Client and server stack | Accepted |
| [0008](0008-license.md) | License: AGPL-3.0-or-later with an app-store permission, contributions signed off | Accepted |
| [0009](0009-a-wake-is-sent-at-most-once.md) | A wake is sent at most once, and uncertainty fails visibly | Accepted |
| [0010](0010-workers-reconcile-durable-state.md) | The turn machinery's workers reconcile durable state | Accepted |
| [0011](0011-a-room-runs-one-turn-at-a-time.md) | A room runs one turn at a time | Superseded by [0040](0040-the-members-of-a-room-run-in-parallel.md) |
| [0012](0012-desktop-reaches-the-server-directly.md) | The desktop renders the bundled web build and calls the server from its own origin | Accepted |
| [0013](0013-background-work-belongs-to-the-turn-that-started-it.md) | Background work belongs to the turn that started it | Accepted |
| [0014](0014-push-goes-through-a-push-sender.md) | Push goes through a push sender, and Expo's service is the first | Proposed |
| [0015](0015-a-release-is-a-self-contained-archive.md) | A release is self-contained: an archive per Linux architecture, and a server runtime in each desktop package | Accepted |
| [0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md) | An update keeps a snapshot to roll back to | Accepted |
| [0017](0017-the-android-app-is-a-signed-apk-on-the-release.md) | The Android app is an APK on the release, signed with the project's key | Accepted |
| [0018](0018-the-interface-follows-pips.md) | The interface follows Pips: lively bots on quiet chrome | Accepted; its motion rules amended by [0052](0052-motion-follows-palco.md) |
| [0019](0019-codex-runs-with-a-home-of-its-own.md) | Codex runs with a home folder of its own; the commands it runs keep the user's | Accepted |
| [0020](0020-the-local-desktop-gets-its-device-through-the-admin-channel.md) | The local desktop gets its device through the admin channel, never over TCP | Accepted |
| [0021](0021-a-missed-routine-runs-only-while-it-is-nearer-than-the-next.md) | A missed routine runs only while it is nearer than the next run | Accepted |
| [0022](0022-the-operator-arranges-the-roster-in-sections.md) | The operator arranges the roster in sections the server keeps | Accepted |
| [0023](0023-a-bot-template-is-a-file.md) | A bot template is a file, built and imported by the server | Accepted |
| [0024](0024-the-local-server-is-a-supervised-child-of-the-app.md) | The local-mode server is a supervised child of the app | Accepted |
| [0025](0025-a-file-stands-where-the-operator-placed-it.md) | A file stands where the operator placed it, as a mark in the draft's text | Accepted |
| [0026](0026-a-bot-uses-connected-services-through-j3-bots.md) | A bot uses connected services through J3 Bots, which holds the sign-in | Accepted; "the operator connects, a bot only suggests" superseded by [0049](0049-the-bots-manage-mcp-servers-and-skills.md) |
| [0027](0027-connector-tools-reach-a-bot-through-the-j3-bridge.md) | Connector tools reach a bot through the `j3` bridge, under the bot's permission mode | Accepted |
| [0028](0028-one-secret-store-for-logins-and-connector-secrets.md) | One secret store for logins and connector secrets | Superseded by [0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md) |
| [0029](0029-the-vault-key-comes-from-a-master-password-held-in-memory.md) | The vault's key comes from a master password, held in memory | Superseded by [0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md) |
| [0030](0030-a-visual-is-part-of-say.md) | A visual is part of `say`, drawn by J3 Bots' clients in a sandbox | Accepted |
| [0031](0031-a-release-is-signed-and-a-nightly-is-a-pre-release-of-the-next-patch.md) | A release is signed, and a nightly is a pre-release of the next patch | Accepted |
| [0032](0032-updates-are-served-outside-the-protocol.md) | Updates are served outside the protocol, and offer only a signed, newer release | Accepted; fields added as [0051](0051-an-update-asks-in-front-and-goes-server-first.md) says |
| [0033](0033-a-client-update-runs-in-a-transient-unit.md) | A client's update runs in a transient unit, and the home records how it ended | Accepted |
| [0034](0034-the-desktop-app-installs-only-a-signed-download.md) | The desktop app installs only a download its release signed | Accepted |
| [0035](0035-the-android-app-installs-its-update-through-a-session.md) | The Android app installs its own update through an installer session, after checking it | Accepted |
| [0036](0036-phone-access-restarts-the-local-server-on-the-network.md) | Phone access restarts the local server on the network, under the server's own `lan` rules | Accepted |
| [0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md) | The server types a saved login into the bot's tab, unattended | Accepted |
| [0038](0038-a-teammate-conversation-is-a-view-of-teammate-messages.md) | A teammate conversation is a view of the teammate messages that already exist | Accepted |
| [0039](0039-a-room-has-no-host.md) | A room has no host, and a message for nobody wakes everyone | Accepted; its loop guard superseded by [0042](0042-a-room-counts-rounds.md) |
| [0040](0040-the-members-of-a-room-run-in-parallel.md) | The members of a room run in parallel | Accepted |
| [0041](0041-the-apps-update-themselves-when-they-start.md) | The apps update themselves when they start | Accepted; a version found while the app runs follows [0051](0051-an-update-asks-in-front-and-goes-server-first.md) |
| [0042](0042-a-room-counts-rounds.md) | A room counts rounds, not messages | Accepted |
| [0043](0043-a-bot-reads-its-rooms-from-anywhere-and-posts-there-only-on-what-it-has-seen.md) | A bot reads its rooms from anywhere, and posts there only on what it has seen | Accepted |
| [0044](0044-j3-bots-installs-and-updates-the-harnesses.md) | J3 Bots installs and updates the harnesses | Accepted |
| [0045](0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md) | J3 Bots keeps its own copies of the harnesses, checked against the makers' checksums | Accepted |
| [0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md) | Secrets: the operator types, a bot uses a reference | Accepted |
| [0047](0047-j3-bots-is-a-complete-mcp-host-at-the-current-specification.md) | J3 Bots is a complete MCP host at the current specification | Accepted |
| [0048](0048-a-servers-interface-runs-isolated-in-j3-bots-clients.md) | A server's interface runs isolated in J3 Bots' clients | Accepted; where an app shows and what it may tell its bot amended by [0093](0093-a-connectors-app-is-part-of-the-bots-reply.md) |
| [0049](0049-the-bots-manage-mcp-servers-and-skills.md) | The bots manage MCP servers and skills | Accepted |
| [0050](0050-bots-and-rooms-are-visible-or-hidden-and-the-operators-choice-wins.md) | Bots and rooms are visible or hidden, and the operator's choice wins | Accepted, amended by 0101 |
| [0051](0051-an-update-asks-in-front-and-goes-server-first.md) | An update asks in front of the app, and goes server first, then the client | Accepted |
| [0052](0052-motion-follows-palco.md) | Motion follows Palco: a stage for entrances, and motion that carries on | Accepted; the first run's steps, lights and finale amended by [0065](0065-the-first-run-tells-what-j3-bots-is-before-it-asks.md) |
| [0055](0055-a-delegated-report-goes-back-to-its-audience.md) | A delegated task's report goes back to the audience that delegated it | Accepted |
| [0062](0062-a-home-moves-as-an-export.md) | A home moves as an export: secrets sealed under a passphrase, sessions left behind | Accepted |
| [0064](0064-the-harnesses-install-as-the-server-starts-and-fail-with-the-true-reason.md) | The harnesses install as the server starts, and fail with the true reason | Accepted |
| [0065](0065-the-first-run-tells-what-j3-bots-is-before-it-asks.md) | The first run tells what J3 Bots is before it asks, in a light drawn as light | Accepted |
| [0066](0066-connecting-an-ai-is-picking-the-account-you-have.md) | Connecting an AI is picking the account you have | Accepted; its question and drawn steps replaced by [0085](0085-signing-in-is-one-row-and-the-browser-opens-by-itself.md) |
| [0067](0067-a-first-contact-is-a-paced-hello-not-a-setup.md) | A bot's first contact is a hello in a few paced messages, not a setup | Accepted |
| [0068](0068-settings-lists-what-the-bots-added.md) | Settings lists what the bots added, and adds nothing itself | Accepted |
| [0069](0069-quick-access-is-a-second-window-on-the-primary-bots-conversation.md) | Quick access is a second window on the primary bot's conversation | Accepted |
| [0070](0070-a-turns-plan-and-its-little-ones-are-its-work.md) | A turn's plan and its little ones are its work, shown only to its audience | Accepted |
| [0071](0071-a-bot-splits-into-little-ones-under-its-face-and-its-plan-is-a-quiet-card.md) | A bot splits into little ones under its face, and its plan is a quiet card | Accepted; what a turn that is over draws amended by [0095](0095-little-ones-a-turn-handed-off-stay-until-they-are-home.md) |
| [0072](0072-errors-say-what-to-do-force-stop-and-whole-questions.md) | Errors say what to do, Stop can be forced, and questions arrive whole | Accepted |
| [0073](0073-a-suggested-reply-follows-what-the-operator-saw.md) | A suggested reply follows what the operator saw, in the bot's own conversation only | Accepted |
| [0075](0075-a-bot-sends-a-picture-as-a-photo-and-shows-what-it-looked-at-in-its-work.md) | A bot sends a picture as a photo, and shows an image it looked at in that step of its work | Accepted |
| [0076](0076-the-brand-mark-is-j3-with-a-bots-light.md) | The brand mark is "j3", with a bot's light on | Accepted |
| [0077](0077-the-engine-moves-to-t3-code-0-1-13-and-no-older-engine-starts-on-its-data.md) | The engine moves to T3 Code 0.1.13, and no older engine starts on its data | Accepted |
| [0078](0078-documents-open-in-a-viewer-of-the-apps-own.md) | Documents open in a viewer of the app's own, read on the client | Accepted |
| [0079](0079-quick-access-brings-the-window-the-operator-was-in.md) | Quick access brings the window the operator was in | Accepted |
| [0080](0080-a-routines-steps-are-each-bots-own-turns-driven-by-j3-bots.md) | A routine's steps are each bot's own turns, driven by J3 Bots | Accepted |
| [0081](0081-one-secret-card-asks-for-every-value-at-once.md) | One secret card asks for every value a request needs, at once | Accepted |
| [0082](0082-a-bots-effort-sits-beside-its-model-and-the-default-is-the-harnesss-own.md) | A bot's effort sits beside its model, and the default is the harness's own | Accepted |
| [0083](0083-only-the-engine-notices-a-person-can-act-on-show.md) | Only the engine notices a person can act on show | Accepted |
| [0084](0084-reactions-are-a-quiet-signal.md) | Reactions are a quiet signal, owned by J3 Bots | Accepted |
| [0085](0085-signing-in-is-one-row-and-the-browser-opens-by-itself.md) | Signing in is one row, and the browser opens by itself | Accepted |
| [0086](0086-code-stays-only-for-the-current-release-a-rollback-and-protocol-11.md) | Code stays only for the current release, a rollback to the one before, and the clients of its protocol | Accepted |
| [0088](0088-a-connectors-events-wake-a-bot-through-a-routine.md) | A connector's events wake a bot through a routine | Accepted |
| [0089](0089-a-connectors-skills-load-through-j3-tools.md) | A connector's skills load through J3 Bots' own tools | Accepted |
| [0090](0090-a-connector-signs-in-as-a-service-with-credentials-the-operator-gives.md) | A connector signs in as a service, with credentials the operator gives | Accepted |
| [0091](0091-a-share-goes-straight-to-a-bot-and-a-widget-keeps-one-in-sight.md) | A share goes straight to a bot, and a widget keeps one in sight | Accepted |
| [0092](0092-a-mention-in-a-bots-conversation-points-and-delivers-nothing.md) | A mention in a bot's conversation points, and delivers nothing | Accepted |
| [0093](0093-a-connectors-app-is-part-of-the-bots-reply.md) | A connector's app is part of the bot's reply, in every display mode, and tells its bot what it shows | Accepted |
| [0094](0094-a-message-quotes-messages-a-reply-whole-a-quote-a-passage.md) | A message quotes messages: a reply whole, a quote a passage | Accepted |
| [0095](0095-little-ones-a-turn-handed-off-stay-until-they-are-home.md) | Little ones a turn handed off stay until they are home | Accepted |
| [0096](0096-dictation-goes-through-the-engines-speech-recognition-and-stays-on-the-operators-machines.md) | Dictation goes through the engine's speech recognition, and stays on the operator's machines | Accepted |
| [0097](0097-whats-new-ships-with-the-apps-and-follows-the-servers-version.md) | What's new ships with the apps, and follows the server's version | Accepted |
| [0098](0098-the-desktop-app-records-the-screen-for-a-bot.md) | The desktop app records the screen for a bot, as one zip a bot's AI can read | Accepted |
| [0099](0099-usage-data-is-the-servers-typed-and-on-until-turned-off.md) | Usage data is the server's, typed, and on until the operator turns it off | Accepted |
| [0100](0100-a-diagnostics-zip-holds-what-the-server-knows-and-nothing-of-the-person.md) | A diagnostics zip holds what the server knows, and nothing of the person | Accepted |
| [0101](0101-a-bot-is-its-name-and-its-title-and-a-helper-waits-behind-the-scenes.md) | A bot is its name and its title, and a helper waits behind the scenes | Accepted |
| [0102](0102-a-bots-card-opens-from-its-face-and-name.md) | A bot's card opens from its face and name | Accepted |
| [0103](0103-a-room-of-bots-only-is-read-and-never-written-by-the-operator.md) | A room of bots only is read, never written, by the operator | Accepted |
| [0109](0109-a-new-bot-can-browse-the-web-and-the-operator-turns-it-off.md) | A new bot can browse the web, and the operator turns it off | Accepted |

When a decision is replaced, its record is rewritten to say what now holds and why the earlier choice was dropped.
