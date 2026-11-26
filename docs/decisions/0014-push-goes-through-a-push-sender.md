# 0014: Push goes through a push sender, and Expo's service is the first

**Status:** Proposed. How pushes reach the mobile app is [open question 4](../open-questions.md#4-how-do-push-notifications-reach-the-mobile-app), the project owner's to settle. This record is the recommendation, and what the server is built on until then.

## Context

A phone in the background has no socket open, so the server must reach it through a push service. Apple's and Google's push services take notifications only from whoever holds credentials tied to the published app: Apple's signing key for it, and Google's service account for it. Those cannot ship with a self-hosted server: anyone who read them out of one install could push to every install of the app. Something that holds them has to stand between the operator's server and the platforms.

T3 Code's mobile app gets the platform's own token (`Notifications.getDevicePushTokenAsync`) and registers it with a relay its project hosts (**Read** at `d5f8a75`, `apps/mobile/src/features/agent-awareness/remoteRegistration.ts` and `registrationPayload.ts`). J3 Bots has no such relay.

## Decision

**The server sends through one interface, `PushSender`.** It sends messages, each to one device (a title, a body, the device's token and platform, and data the app opens: the device, the conversation or room, the entry) with the delivery's id as its key, up to a hundred in one request, and gives back what the service answered about each; later it asks what became of the messages the service took. Everything else belongs to the server and not to a sender: which devices to push to, the wording in each device's language, the previews setting, retries, deadlines, the attempt count, which pushes go in one request, when the whole service may be tried again after a request it did not answer, and what an unreachable device means ([Server: notifications](../architecture/server.md#notifications)). A push registration names its service (`provider`), so another sender can take over by implementing the interface and having apps register with it, without touching how deliveries are written or followed.

**Expo's push service is the first sender.** The app registers an Expo push token. The server posts to Expo's API, which holds the app's Apple and Google credentials and hands each notification on. It needs no configuration: the server sends no access token, so the project leaves Expo's "enhanced security" off. A token a self-hosted server holds is no secret, since it would ship to every operator.

**What Expo, Apple and Google see** of each push: the device's push token, the title (the bot's name, or the room's), the body, the data (the device's id, the conversation's bot id or the room's id, the entry's id), on Android the channel, which names the kind of entry, the delivery's id, and, for Expo, the server's address and when it sent. The body is a fixed sentence, such as "Sent you a message", unless the operator turned previews on, when it is the entry's first line. Previews are off by default. Nothing else of a conversation leaves the server.

**What is relied on against repeats.** Expo has no idempotency key, and its FAQ says a notification may reach Apple or Google more than once or not at all, both rare, without saying which is likelier. The server records a send as begun before it makes it, so after a crash or a reply lost in the network it sends the same delivery again, once its backoff has passed, with the same key, as Expo's Android `tag` and iOS `collapseId`. Expo documents that each one replaces a notification still displayed with the same identifier, so while the first is on screen the operator sees one notification, though the phone may sound twice. One the operator already dismissed is not there to replace, and a repeat after it shows again. How devices do this is **Assumed** until the mobile app shows it on one. Android's `collapseId` is not used: Google keeps at most four of them per device while it is offline and drops the rest.

## Consequences

- No hosted component the project runs, and nothing to configure. A third party is in the path instead: Expo, with no service level, sees what Apple and Google see.
- Anyone holding a device's push token could send that app notifications through Expo. Tokens never leave the operator's database except to Expo ([Security](../architecture/security.md)).
- A push that cannot be withdrawn stays on the phone after the operator answered elsewhere.
- Moving to another service means a new `PushSender`, a new `provider` value (a migration rebuilds the registrations table's `CHECK`), and the app registering with it.

## Rejected

**A relay the project runs**, as T3 Code does. It is the one hosted component, with its cost and operations, and it would see what Expo sees. It stays the fallback if Expo's terms or reliability fail, as another `PushSender`.

**Apple's and Google's services called from each server.** They need the published app's credentials on every server, where anyone could read them out.

**Operators building the app with their own credentials.** It works only for someone who publishes their own build.

**UnifiedPush on Android.** No Google in the path, but it needs a distributor app on the phone and covers Android only. It can be added later as a second sender.
