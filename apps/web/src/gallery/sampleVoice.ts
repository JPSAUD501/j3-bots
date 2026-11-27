// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dictation for the sample team and the gallery: the server's speech models,
 * a dictation that stands still in one state, and a microphone that hears a
 * voice rise and fall. Development only.
 */
import {
  Cell,
  type DictationHandle,
  type DictationState,
  type Loaded,
} from "@j3-bots/client-runtime";
import {
  type CloudVoiceKeys,
  type CloudVoiceModel,
  CloudVoiceModelId,
  type VoiceModel,
  VoiceModelId,
  type VoiceStatus,
} from "@j3-bots/contracts";
import type {
  DictationReach,
  DictationSource,
  MicrophoneFailure,
  OpenMicrophone,
} from "../components/Dictation";
import type { VoiceSettingsIntents } from "../shell/data";

const sampleVoiceModels: ReadonlyArray<VoiceModel> = [
  {
    id: VoiceModelId.make("nemotron-streaming-0.6b"),
    name: "Nemotron streaming 0.6B",
    size: 751_000_000,
    languages: ["en", "pt", "es", "de", "fr"],
    live: true,
    errorPercent: { en: 7.9, pt: 8.5 },
    secondsPer30s: 2.8,
    recommended: true,
    installed: true,
  },
  {
    id: VoiceModelId.make("parakeet-tdt-0.6b-v3"),
    name: "Parakeet TDT 0.6B v3",
    size: 670_000_000,
    languages: ["en", "pt", "es", "de", "fr", "it", "nl", "pl"],
    live: false,
    errorPercent: { en: 6.1, pt: 4.96 },
    secondsPer30s: 1.9,
    recommended: false,
    installed: false,
  },
  {
    id: VoiceModelId.make("whisper-large-v3"),
    name: "Whisper large v3",
    size: 4_700_000_000,
    languages: ["en", "pt", "es", "de", "fr", "it", "ja", "zh"],
    live: false,
    errorPercent: { en: 5.4, pt: 5.2 },
    secondsPer30s: null,
    recommended: false,
    installed: false,
  },
];

const ready = <A>(value: A): Cell<Loaded<A>> =>
  new Cell<Loaded<A>>({ _tag: "ready", value, stale: false });
const recommended = sampleVoiceModels[0];

const status: VoiceStatus =
  recommended === undefined
    ? { _tag: "unavailable", reason: "platform" }
    : { _tag: "available", model: recommended, installing: null };

const cloudModels: ReadonlyArray<CloudVoiceModel> = [
  { id: CloudVoiceModelId.make("openai/gpt-4o-transcribe"), name: "OpenAI: GPT-4o Transcribe" },
  { id: CloudVoiceModelId.make("mistralai/voxtral-small"), name: "Mistral: Voxtral Small" },
];

const keys = new Cell<Loaded<CloudVoiceKeys>>({
  _tag: "ready",
  value: { openai: false, xai: false, openrouter: true },
  stale: false,
});

/** Settings → Voice on the sample server: its model ready, a key saved for OpenRouter. */
export const sampleVoice: VoiceSettingsIntents = {
  openStatus: () => ({ state: ready(status), release: () => {} }),
  openCloudKeys: () => ({ state: keys, release: () => {} }),
  models: () => Promise.resolve({ _tag: "done", value: sampleVoiceModels }),
  cloudModels: () => Promise.resolve({ _tag: "done", value: cloudModels }),
  setCloudKey: (provider, key) => {
    const now = keys.get();
    if (now._tag === "ready") {
      keys.set({ ...now, value: { ...now.value, [provider]: key !== null } });
    }
    return Promise.resolve({ _tag: "done", value: undefined });
  },
};

/** A dictation that stays in `state` until stopped, when it ends with what it heard. */
const standing = (state: DictationState): DictationHandle => {
  const cell = new Cell(state);
  return {
    state: cell,
    audio: () => {},
    finish: () => {
      const now = cell.get();
      cell.set({
        _tag: "done",
        text: "committed" in now ? `${now.committed} ${now.tentative}` : "",
      });
    },
    cancel: () => {},
  };
};

/** A microphone that hears a voice rise and fall, a tenth of a second at a time, until stopped. */
const speaking: OpenMicrophone = (listener) => {
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const loudness = 0.02 + 0.1 * Math.abs(Math.sin(step / 3));
    listener.samples(
      Float32Array.from({ length: 1_600 }, (_, index) => loudness * Math.sin(index / 4)),
    );
  }, 100);
  return Promise.resolve({ _tag: "open", stop: () => clearInterval(timer) });
};

/** A microphone the operator or the system did not allow, or that is not there. */
const refused =
  (reason: MicrophoneFailure): OpenMicrophone =>
  () =>
    Promise.resolve({ _tag: "failed", reason });

/**
 * Dictation as a gallery frame shows it: through the server, each dictation
 * standing in `state`, with a microphone that hears speech, or one that
 * fails for `refusedFor`; or, with `reach`, nowhere, and why.
 */
export const sampleDictation = ({
  state = { _tag: "listening", live: true, committed: "", tentative: "" },
  reach = { _tag: "server" },
  refusedFor,
}: {
  state?: DictationState;
  reach?: DictationReach;
  refusedFor?: MicrophoneFailure;
} = {}): DictationSource => ({
  reach,
  dictate: () => standing(state),
  microphone: refusedFor === undefined ? speaking : refused(refusedFor),
  app: "browser",
});
