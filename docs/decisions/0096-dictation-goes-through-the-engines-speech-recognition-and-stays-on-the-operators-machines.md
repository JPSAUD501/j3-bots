# 0096: Dictation goes through the engine's speech recognition, and stays on the operator's machines

**Status:** Accepted.

## Context

The owner asked for dictation in the composer, done well: speak, watch the words appear where the cursor is, fix them, and send them yourself. Until now only the Android app dictated, with the phone's recognizer, which falls back to Google's online service when the language is not on the phone; the web and desktop clients had nothing.

The engine already recognizes speech ([T3 Code `v0.1.13`](https://github.com/pingdotgg/t3code/tree/v0.1.13), `apps/server/src/speech`): a catalog of local models it downloads and runs on its own host, a WebSocket that takes a live recording and answers the words as it hears them, and the same recognition by OpenAI, xAI or OpenRouter with a key the operator gives. **Verified** on the pinned build started as J3 Bots starts it (its own home, its own port, J3 Bots' credential and scopes): the speech routes answer that credential and refuse a request without it, a model downloads and becomes the one in use through them, and a live recording of English speech came back as words while it played, then as the whole text at its end, on a desktop processor alone.

What was open: where speech is turned into words, how a client's audio reaches the engine, which model a small host runs, where a cloud provider's key lives, and how a client that meets an older server knows what to offer.

## Decision

**A client records; the J3 Bots server relays the recording to the engine's speech recognition, on the operator's own machines unless the operator chooses a cloud provider; the words land in the composer and nothing is sent by itself.**

- **Where speech becomes words** is one setting for the server and every device (`Settings.voice.place`):
  - **Automatic**, the default. A phone uses its own recognizer when the language is installed on it, recognizing on the phone and nowhere else; otherwise, and on the web and desktop, the server does.
  - **This device**: only the device's own recognizer. A device without one says it cannot dictate here.
  - **This server**: always the server's local model.
  - **A cloud provider** (OpenAI, xAI, OpenRouter): the server sends the recording, once the operator stops, with the operator's key.
  - Android never falls back to an online recognizer of its own: audio leaves the operator's machines only for a provider they chose.
- **Only `packages/engine-t3` knows the engine's speech recognition** ([decision 0001](0001-t3-code-as-unmodified-engine.md), [decision 0002](0002-single-server-between-clients-and-engine.md)): the engine runs as released. `EngineSpeech` is its catalog, install, live recognition, cloud recognition and AI tidy-up in J3 Bots' terms. Clients reach only the J3 Bots server, on its own voice socket (`HTTP_PATHS.voice`), authenticated as the RPC socket is; the server opens the engine's socket with its own credential. One socket is one dictation, and one runs at a time, since the engine runs one: a second device is told the server is busy.
- **The model the server picks** is the one of the pinned catalog that streams and hears Portuguese and English: NVIDIA's Nemotron streaming 0.6B, a 751 MB download. The catalog measures 8.5 % of Portuguese words and 7.9 % of English words wrong, and 2.8 s of a desktop processor per 30 s of speech. **Verified** on a desktop processor alone: words arrived while the recording played, and its text 0.3 s after its end, with about 0.65 GB of working memory beside the 0.73 GB model it maps. It has not run on a 4 GB board; that it fits one beside the bots is **Assumed** from those numbers. The models that hear Portuguese better do not stream (words only once the operator stops) or are 4.7 GB.
- **The model installs itself on first use.** The first dictation downloads it, and every client shows how far it got, in words. A download a cancelled dictation started runs on, so the next one finds it ready. On a host with 8 GiB of memory or less, the engine unloads the model two minutes after its last use; on a bigger one, fifteen. A bigger model is the operator's choice, under More in Settings → Voice, described by size, speed on this server and the languages it hears.
- **A cloud provider's key is a J3 Bots secret**, a single value named `voice-<provider>` that no bot may use, which the operator sees and can remove in Secrets like any other. The server gives it to the engine for one recognition and removes it from the engine as soon as that ends, so the engine keeps no key at rest.
- **The AI's tidy-up is offered, off by default.** It runs on the server once the operator stops, with the draft around the words, and spends the operator's AI allowance, as Settings says. When it fails, the words as heard land instead.
- **Audio is never stored.** It passes through the server's memory to the engine, or, for a cloud provider, is held in memory until the operator stops. Nothing logs it, nor the words.
- **Protocol 11 holds.** `Settings.voice` is new and nullable: a server that carries it serves the voice socket and the `voice.*` RPCs, and a client offers dictation through the server only then. Facing an older server, the Android app still dictates with the phone's own recognizer, and the web and desktop show no microphone.

## Costs

- **One dictation at a time on the server.** Two devices dictating at once is rare for one operator; the second is told, in words, to wait.
- **A first dictation waits for a 751 MB download.** It happens once, with its progress shown; the operator can start it from Settings → Voice instead.
- **The model sits in memory while it is in use, and a little after.** On a small host that is two minutes.
- **A cloud provider hears nothing until the operator stops.** The engine's cloud recognition takes a whole recording, so its words come at the end.
- **A key the operator gives J3 Bots is also handed to the engine for each cloud recognition.** Both run on the operator's machine, and the engine drops it after.

## Rejected

- **The browser's own speech recognition.** In Chrome it sends the audio to Google's servers, which the operator never chose, and other browsers lack it.
- **Android's online fallback.** The same: audio to a service the operator did not choose.
- **Keeping cloud keys in the engine's own store.** The operator would have keys J3 Bots cannot show or remove; Secrets is where J3 Bots keeps what the operator gives it.
- **The clients reaching the engine's speech directly.** Clients speak only to J3 Bots, and the engine's port is not theirs to reach.
- **A model that hears Portuguese better but only at the end** (Parakeet TDT v3, 4.96 % of Portuguese words wrong). Words appearing while the operator speaks was the ask; it is one choice away under More.
- **Voice messages, replies read aloud, wake words.** Not asked for here.
