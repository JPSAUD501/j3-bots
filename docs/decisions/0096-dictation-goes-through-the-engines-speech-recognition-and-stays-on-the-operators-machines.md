# 0096: Dictation lands in the composer, through the J3 Bots server

**Status:** Accepted. Amended by [0107](0107-dictation-goes-to-the-operators-cloud-provider-and-the-server-runs-no-speech-model.md): the server runs no speech model and no longer uses the engine's speech recognition; the web and desktop dictate through the operator's cloud provider, with its key sent from J3 Bots, and the AI's tidy-up and the model picker are gone. Below, what holds now.

## Context

The owner asked for dictation in the composer, done well: speak, watch the words appear where the cursor is, fix them, and send them yourself. Until now only the Android app dictated, with the phone's recognizer, which falls back to Google's online service when the language is not on the phone; the web and desktop clients had nothing.

The engine already recognizes speech ([T3 Code `v0.1.13`](https://github.com/pingdotgg/t3code/tree/v0.1.13), `apps/server/src/speech`): a catalog of local models it downloads and runs on its own host, a WebSocket that takes a live recording and answers the words as it hears them, and the same recognition by OpenAI, xAI or OpenRouter with a key the operator gives. **Verified** on the pinned build started as J3 Bots starts it (its own home, its own port, J3 Bots' credential and scopes): the speech routes answer that credential and refuse a request without it, a model downloads and becomes the one in use through them, and a live recording of English speech came back as words while it played, then as the whole text at its end, on a desktop processor alone.

What was open: where speech is turned into words, how a client's audio reaches the engine, which model a small host runs, where a cloud provider's key lives, and how a client that meets an older server knows what to offer.

## Decision

**A client records; the J3 Bots server sends the recording to the cloud provider the operator chose, with their key; the words land in the composer and nothing is sent by itself.** Until 0.15.0 the server relayed it to the engine's local model; [decision 0107](0107-dictation-goes-to-the-operators-cloud-provider-and-the-server-runs-no-speech-model.md) records why that was dropped.

- **Where speech becomes words** is one setting for the server and every device (`Settings.voice.place`): automatic, this device, or a cloud provider (OpenAI, xAI, OpenRouter), as [decision 0107](0107-dictation-goes-to-the-operators-cloud-provider-and-the-server-runs-no-speech-model.md) has them. Android never falls back to an online recognizer of its own: audio leaves the operator's machines only for a provider they chose.
- **Clients reach only the J3 Bots server**, on its own voice socket (`HTTP_PATHS.voice`), authenticated as the RPC socket is ([decision 0002](0002-single-server-between-clients-and-engine.md)).
- **A cloud provider's key is a J3 Bots secret**, a single value named `voice-<provider>` that no bot may use, which the operator sees and can remove in Secrets like any other. The server sends it to the provider with each recording, and to nothing else.
- **Audio is never stored.** It is held in the server's memory until the operator stops, then sent to the provider. Nothing logs it, nor the words.
- **Protocol 11 holds.** `Settings.voice` is new and nullable, and `Settings.voice.provider` marks a server that dictates through a provider: a client offers dictation through the server only then. Facing an older server, the Android app still dictates with the phone's own recognizer, and the web and desktop show no microphone.

## Costs

- **A cloud provider hears nothing until the operator stops.** It takes a whole recording, so its words come at the end.
- The rest are in [decision 0107](0107-dictation-goes-to-the-operators-cloud-provider-and-the-server-runs-no-speech-model.md).

## Rejected

- **The browser's own speech recognition.** In Chrome it sends the audio to Google's servers, which the operator never chose, and other browsers lack it.
- **Android's online fallback.** The same: audio to a service the operator did not choose.
- **Keeping cloud keys in the engine's own store.** The operator would have keys J3 Bots cannot show or remove; Secrets is where J3 Bots keeps what the operator gives it.
- **The clients reaching the engine's speech directly.** Clients speak only to J3 Bots, and the engine's port is not theirs to reach.
- **Voice messages, replies read aloud, wake words.** Not asked for here.
