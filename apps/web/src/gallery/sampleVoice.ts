// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dictation for the sample team and the gallery: the dictation services'
 * keys, a dictation that stands still in one state, and a microphone that
 * hears a voice rise and fall. Development only.
 */
import {
  Cell,
  type DictationHandle,
  type DictationState,
  type Loaded,
} from "@j3-bots/client-runtime";
import { type CloudVoiceKeys, type CloudVoiceModel, CloudVoiceModelId } from "@j3-bots/contracts";
import type {
  DictationReach,
  DictationSource,
  MicrophoneFailure,
  OpenMicrophone,
} from "../components/Dictation";
import type { VoiceSettingsIntents } from "../shell/data";

const cloudModels: ReadonlyArray<CloudVoiceModel> = [
  { id: CloudVoiceModelId.make("openai/gpt-4o-transcribe"), name: "OpenAI: GPT-4o Transcribe" },
  { id: CloudVoiceModelId.make("mistralai/voxtral-small"), name: "Mistral: Voxtral Small" },
];

/** What every sample dictation hears once stopped. */
const HEARD = "Book the venue for Friday";

/** A dictation that stays in `state` until stopped, when it ends with what it heard. */
const standing = (state: DictationState): DictationHandle => {
  const cell = new Cell(state);
  return {
    state: cell,
    audio: () => {},
    finish: () => {
      if (cell.get()._tag === "listening") cell.set({ _tag: "done", text: HEARD });
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

/**
 * Settings → Voice on a sample server, with a key saved for each service in
 * `saved`: its test hears "Book the venue for Friday".
 */
export const sampleVoiceWith = (saved: CloudVoiceKeys): VoiceSettingsIntents => {
  const keys = new Cell<Loaded<CloudVoiceKeys>>({ _tag: "ready", value: saved, stale: false });
  return {
    openCloudKeys: () => ({ state: keys, release: () => {} }),
    cloudModels: () => Promise.resolve({ _tag: "done", value: cloudModels }),
    setCloudKey: (provider, key) => {
      const now = keys.get();
      if (now._tag === "ready") {
        keys.set({ ...now, value: { ...now.value, [provider]: key !== null } });
      }
      return Promise.resolve({ _tag: "done", value: undefined });
    },
    dictate: () => standing({ _tag: "listening" }),
    microphone: speaking,
    app: "browser",
  };
};

/** Settings → Voice on the sample server: a key saved for OpenAI and for OpenRouter. */
export const sampleVoice: VoiceSettingsIntents = sampleVoiceWith({
  openai: true,
  xai: false,
  openrouter: true,
});

/** A microphone the operator or the system did not allow, or that is not there. */
const refused =
  (reason: MicrophoneFailure): OpenMicrophone =>
  () =>
    Promise.resolve({ _tag: "failed", reason });

/**
 * Dictation as a gallery frame shows it: through the server, each dictation
 * standing in `state`, with a microphone that hears speech, or one that
 * fails for `refusedFor`; or, with `reach`, nowhere, and why. `setUp` is
 * whether Settings is at hand to set it up.
 */
export const sampleDictation = ({
  state = { _tag: "listening" },
  reach = { _tag: "server" },
  refusedFor,
  setUp = true,
}: {
  state?: DictationState;
  reach?: DictationReach;
  refusedFor?: MicrophoneFailure;
  setUp?: boolean;
} = {}): DictationSource => ({
  reach,
  dictate: () => standing(state),
  microphone: refusedFor === undefined ? speaking : refused(refusedFor),
  app: "browser",
  setUp: setUp ? () => {} : undefined,
});
