# 0099: Usage data is the server's, typed, and on until the operator turns it off

**Status:** Accepted. Replaces "no telemetry by default" in the [vision](../vision.md) and in [Security](../architecture/security.md#what-is-logged).

## Context

J3 Bots had no way to know whether it works for the people who run it: which harnesses and models they use, whether turns finish, whether updates land, which surfaces they open. The owner asked for anonymous usage data, on by default, done well: nothing a person wrote, named or owns, an easy way off, and a way to see what leaves.

T3 Code, the engine J3 Bots runs, has its own product analytics, sent to T3's ingest by default, and relay tracing that follows the same switches (**Read** at `bc0f04d`, `apps/server/src/telemetry/AnalyticsService.ts`, `packages/shared/src/otelEnvironment.ts`). The engine J3 Bots runs is not T3 Code's product, and its operator never agreed to T3's analytics.

## Decision

**The J3 Bots server sends anonymous usage data to J3 Bots' PostHog project, as typed events with closed values, while its environment allows it and the operator's switch in Settings is on, which it is by default. Clients send their few events to their own server, never anywhere else. The engine's own analytics and tracing are always off.**

- **The server owns it.** Only the server sends. A client tells its server what it is once its connection opens (`telemetry.hello`), and records the two things no request shows (`telemetry.record`): What's new opened, a message dictated or a message sent with a screen recording, and the mode a connector's app is shown in. The server attaches what the client said of itself to the events that client's requests cause. No client carries an analytics SDK.
- **Typed, never free.** Every event and every property is declared in `packages/contracts/src/telemetry.ts`, each value a closed set of words, a boolean, a bucketed count, a whole number of seconds or a release number. The server encodes each event against that schema, refusing any property it does not declare, before it leaves. Nothing a person wrote or named can be one: no text, no names, no ids of bots, rooms or conversations, no paths, addresses, hostnames, emails or secrets.
  - A model is sent as the engine's catalog names it only when its id has the shape Anthropic or OpenAI publish, and as `custom` otherwise, since a model id someone else chose can name a person or a deployment. The engine does not mark every such model: Claude Code lists a gateway's models as its own (**Read** at `bc0f04d`, `ClaudeModelCatalog.ts`, `claudeReportedModels`).
  - An error is sent as its tag and its code, never its message.
  - Counts that could tell one install from another are buckets (`0`, `1`, `2-3`, `4-10`, `11+`).
  - Every event carries `$process_person_profile: false`, so PostHog makes no profile, and `$geoip_disable: true`, so it looks up no place from the address the batch came from.
- **Identity.** The install's id is random, kept in the server's database, and sent only as its SHA-256. Each client device keeps a random id of its own, sent hashed the same way.
- **On by default, off in four ways.** The Settings switch, which the operator turns off for the whole server and which takes effect at once; `J3_TELEMETRY_ENABLED=false`; `DO_NOT_TRACK=1`, which wins over everything; and a CI runner or a source checkout, unless `J3_TELEMETRY_ENABLED=true` says otherwise. Turning it off drops what waits to be sent. There is no first-run step.
- **See what is sent.** The server keeps the newest 100 events it sent, exactly as they left, and every client shows them from the switch. A diagnostics export can reuse the same list (`Telemetry.sent`).
- **Delivery.** PostHog's batch API, with no SDK: a UUID per event, batches of at most 50 every ten seconds, at most 1,000 events waiting (the oldest go first), a backoff with jitter after a failure, a batch dropped after six tries or at once when it is refused, and at most a second at the server's stop. Usage data never fails or holds anything else.
- **The destination.** `https://us.i.posthog.com` and J3 Bots' project key, kept in source: a PostHog project key can only write events, never read them, so it is public by design. `J3_TELEMETRY_HOST` and `J3_TELEMETRY_KEY` send elsewhere, for a fork. J3 Bots never calls PostHog's management API.
- **The engine's are off.** The adapter starts the engine with `T3CODE_TELEMETRY_ENABLED=false` and `T3CODE_OTEL_SDK_DISABLED=true`, after its environment allowlist, so nothing turns them back on ([Engine](../architecture/engine.md)).

## What it costs

- **Data leaves the operator's machine by default.** That is the change from the vision's old promise. What leaves is typed and bounded, shown in Settings, and stopped by one switch or one variable.
- **The project key is in a public repository.** Anyone can write events into the project with it. That is true of every PostHog client key; the data is read only by the project's members.
- **A client's events trust the client.** A modified client can tell its server it is another surface or send events it did not see. It can only send words the contract lists.
- **No token counts.** The engine reports none to J3 Bots, so `turn.finished` carries none.

## What was rejected

- **Off by default, or asked at first run.** The owner wants to know how J3 Bots is used by the people who run it, not only by those who find a switch; the switch, the variables and the list of what was sent are the operator's control.
- **An analytics SDK in each client.** Each client would reach a third party on its own, with its own identity and its own switch, and the operator would have to trust three of them. The server already holds a connection with each client.
- **Free-form properties.** A message, a name or an error's text would sooner or later carry something a person wrote. Closed sets keep that out by construction.
- **Session replay, heatmaps, feature flags and surveys.** They watch people rather than count what J3 Bots does.
