# 0107: Dictation goes to the operator's cloud provider, and the server runs no speech model

**Status:** Accepted. Amends [0096](0096-dictation-goes-through-the-engines-speech-recognition-and-stays-on-the-operators-machines.md) (where speech becomes words) and [0098](0098-the-desktop-app-records-the-screen-for-a-bot.md) (the recording's control, its transcript and its README).

## Context

0.14.0 dictated on the web and desktop through the engine's local speech model ([decision 0096](0096-dictation-goes-through-the-engines-speech-recognition-and-stays-on-the-operators-machines.md)). The owner used it and found it poor: the words came out wrong, Portuguese most of all, the first dictation waited for a 751 MB download with its progress under the field, and the composer locked while it prepared. Setting it up meant choosing a model and a place by names that mean nothing to someone who is not technical. The floating control of a screen recording was larger and plainer than the rest of the app, and the recording's README explained tools rather than the files.

The owner chose: no local speech model at all; the web and desktop dictate through a cloud provider (OpenAI, xAI or OpenRouter) with the operator's own key; Android keeps its own on-device recognizer; a recording gets a transcript only when such a provider is set up.

## Decision

**The J3 Bots server sends a finished recording straight to the cloud provider the operator chose, with their key from Secrets, and answers the words. It runs no speech model and no longer uses the engine's speech recognition. A device with a recognizer of its own, the Android app, may still use it.**

- **Where speech becomes words** (`Settings.voice.place`):
  - **Automatic**, the default: a phone with an on-device recognizer for the language uses it; anywhere else the provider the operator chose (`Settings.voice.provider`) does.
  - **This device**: only the device's own recognizer. The web and desktop cannot dictate then.
  - **A provider** (OpenAI, xAI, OpenRouter): always that provider, on a phone too.
  - **This server** is gone. A server of protocol 11 before 0.15.0 may still hold it, so the literal stays in the contract; this server never sends it, refuses it in a change, and migration 0069 moves a stored `server` to `automatic` and copies a place that named a provider into `provider`.
- **The server talks to the provider itself** (`apps/server/src/voice/CloudSpeech.ts`). The requests follow T3 Code's own cloud speech at `bc0f04d` (MIT): the endpoints, the models, the form fields each provider takes, and OpenRouter's catalog of transcription models that keep no data (**Read**). The key goes from Secrets to the provider and nowhere else, never to the engine. OpenAI and xAI are told the words to always spell right; OpenRouter is not, since its request has no field for them. "Um", "uh" and the like are removed when the operator asks (xAI leaves them out itself). Nothing logs the audio, the words or the key.
- **Clients still reach only the J3 Bots server**, on its voice socket, as [decision 0096](0096-dictation-goes-through-the-engines-speech-recognition-and-stays-on-the-operators-machines.md) has it. Several dictations may run at once: nothing on the server is shared between them.
- **Settings → Voice is one page:** the dictation service (one of the three, or none), its key (saved to Secrets as `voice-<provider>`, with a link to the provider's page that makes one), OpenRouter's model when that is the service, a Test that listens for two seconds and shows the words, and the language. On the phone it also offers where to dictate: automatic, on the phone, or by the service. Words to always spell right and removing "um" and "uh" are under More. While set-up is missing, the page says what to do first in one sentence. The microphone without a service or key opens this page; quick access, which has no settings at hand, says the same sentence in the field.
- **Dictating happens inside the field.** While it records, the microphone becomes a small capsule: Cancel, a red dot, the time so far, the voice's level as a waveform, and Stop. On Stop it says it is writing the words down, in place. The words land where the caret was, which moves along with whatever the operator types meanwhile: the field is never locked. A problem shows as a short line inside the composer, with Set up when Settings → Voice fixes it. Android does the same with its own recognizer or the service; its live partial words are gone, since a service's words come only at the end.
- **The AI's tidy-up and the model picker are gone**, with the engine's speech: nothing else ran them. Their columns stay in the database for a rollback to read, and the contract keeps their fields, always off and empty, for clients of protocol 11 before 0.15.0.
- **A screen recording's transcript** ([decision 0098](0098-the-desktop-app-records-the-screen-for-a-bot.md)) is written by the same provider, in pieces, and only when one is set up with its key. Without it the zip carries the voice alone, and its README says the audio has no transcript.
- **The recording's floating control** is compact and in the app's look: the bot's face, a red dot, the voice's level, and Pause, Stop and Discard as icon buttons with tooltips. It can be dragged, and macOS and Windows leave it out of the capture. The README in the zip says what each file is and how to place a point on a video; the commands for tools are gone.
- **Protocol 11 holds.** `Settings.voice.provider` is new and optional: a server that carries it dictates through a provider, and the web and desktop offer the microphone only then.

## Costs

- **Dictation on the web and desktop needs a provider account and its key.** Without one there is no dictation there, and no transcript for a recording. The operator pays the provider for what it transcribes.
- **The voice leaves the operator's machines** for the provider they chose, on every dictation from the web and desktop. 0096 kept it on their machines unless they chose otherwise.
- **Words come only once the operator stops**, on every device that uses the provider. A phone's own recognizer showed them as they were spoken; on Android they now land at the end too, so both behave alike.
- **A key a 0.14.0 server handed the engine for a recognition stopped midway stays in the engine's own secret store.** 0.14.0 removed one at each engine start; J3 Bots no longer opens the engine's speech to do so. It is a file of mode 0600 in the engine's private home, and only that server ever wrote one there.
- **The Android chip field lost its open words.** The native view drew the recognizer's partial words greyed; it no longer gets any. Its Kotlin was changed without a device build in this change (**Assumed** to compile).
- **On Linux the floating control still shows in the video**, since no system there can leave a window out of a capture; the README says so.

## Rejected

- **Keeping the local model beside the providers.** It was the owner's complaint: poor words and a long download. A choice nobody should make is not worth its code.
- **A recognizer in the browser or the desktop app.** In Chrome the browser's own sends the audio to Google, a service the operator never chose; an app-side model is the local model again.
- **The engine's cloud speech.** It would hand the operator's key to the engine for each recognition and tie dictation to the engine's speech routes, for nothing J3 Bots cannot send itself.
- **A transcript from the phone's recognizer or without a provider.** A recording is made on the desktop, which has none.
