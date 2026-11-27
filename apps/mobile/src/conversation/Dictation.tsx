// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DictationFailure,
  type DictationState,
  type HeardWords,
  targetKey,
  type VoiceClient,
} from "@j3-bots/client-runtime";
import {
  type DeviceRecognizer,
  type DictationBlock,
  type DictationPath,
  dictationPath,
  levelOf,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useSettings } from "@j3-bots/client-runtime/react";
import {
  dictationBlockWords,
  dictationFailureWords,
  dictationStateWords,
} from "@j3-bots/client-runtime/wording";
import { type EntryTarget, MAX_VOICE_DRAFT_LENGTH } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { I18n } from "@j3-bots/i18n";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { Mic, Square } from "lucide-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AccessibilityInfo, AppState, BackHandler, Linking, Pressable, View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useReducedMotion } from "../motion.ts";
import {
  askMicrophone,
  microphoneAllowed,
  phoneRecognizer,
  usePhoneRecognizer,
} from "../platform/dictation.ts";
import { type Heard, hear, heardWords, nothingHeard } from "../platform/recognition.ts";
import { samplesOf, voiceCapture } from "../platform/voiceCapture.ts";
import { Text } from "../text.tsx";
import { useVoiceStatus } from "../voiceStatus.ts";
import { composerButtonFrame, composerButtonSlop } from "./composerButton.ts";
import { type DictationOrigin, dictatedDraft, originOf } from "./dictatedDraft.ts";

// Dictation into the composer (decision 0096). Where speech becomes words is
// the operator's choice in Settings → Voice: the phone's own recognizer, on
// the phone alone, or the server, which hears the microphone through the
// voice socket. Android's online recognizer is never used. Words land where
// the caret was as they are heard, the ones still open to change lighter,
// and wait there: nothing is sent by itself.

/** Why dictation stopped without the operator's Stop, or did not start. */
type DictationNotice =
  /** The microphone was refused; `canAsk` while Android still lets the app ask. */
  | { readonly _tag: "microphone"; readonly canAsk: boolean }
  /** The microphone could not start, as while another app holds it. */
  | { readonly _tag: "microphoneFailed" }
  /** Dictation cannot run here (`dictationPath`): the press records nothing. */
  | { readonly _tag: "blocked"; readonly block: DictationBlock }
  | { readonly _tag: "failed"; readonly reason: DictationFailure }
  | { readonly _tag: "noSpeech" };

type DictationPhase =
  | { readonly _tag: "idle" }
  /** Finding where it runs, and asking for the microphone. */
  | { readonly _tag: "preparing" }
  /** The phone's own recognizer listens. */
  | { readonly _tag: "device" }
  | { readonly _tag: "server"; readonly state: DictationState };

/** Where dictation last left the draft: its text, and the selection after it. */
interface DictationPlaced {
  readonly text: string;
  readonly selection: readonly [number, number];
  /** The words still open to change, drawn lighter. */
  readonly open: readonly [number, number] | null;
}

export interface Dictation {
  readonly phase: DictationPhase;
  /** Words come as they are spoken: the composer says it listens. */
  readonly listening: boolean;
  readonly placed: DictationPlaced | null;
  readonly notice: DictationNotice | null;
  /** The microphone's level, 0 to 1, while it records. */
  readonly level: SharedValue<number>;
  readonly start: () => void;
  readonly stop: () => void;
  /** Forgets the last notice, as the operator moves on. */
  readonly dismiss: () => void;
}

type ServerDictation = ReturnType<VoiceClient["dictate"]>;

/** A dictation from the press that started it to its end. */
interface Session {
  readonly origin: DictationOrigin;
  /** What has been heard, as last placed. */
  heard: HeardWords;
  /** The server took audio: an end with no words is one where nothing was heard. */
  listened: boolean;
  /** The phone's recognizer, and whether the operator pressed Stop. */
  device: { heard: Heard; stopping: boolean } | null;
  server: {
    readonly handle: ServerDictation;
    unsubscribe: () => void;
    /** The microphone's pieces go to the server. */
    capturing: boolean;
    /** The operator stopped: the server is working out the last words. */
    finished: boolean;
  } | null;
}

const IDLE: DictationPhase = { _tag: "idle" };
const NOTHING_HEARD: HeardWords = { committed: "", tentative: "" };

const sameWords = (a: HeardWords, b: HeardWords) =>
  a.committed === b.committed && a.tentative === b.tentative;

/** Everything heard, settled or not, as the words a stop leaves. */
const allOf = (heard: HeardWords): string =>
  [heard.committed.trim(), heard.tentative.trim()].filter((part) => part !== "").join(" ");

/**
 * Dictation into `target`'s draft, at the field's `selection` when a press
 * starts it; null where this phone cannot dictate at all (`dictationPath`'s
 * `none`). The draft takes no other change while it runs. Stop keeps what was
 * heard; Back cancels and puts the draft back as it was; the conversation
 * leaving the operator's view stops it. Unmounting ends it, keeping the
 * settled words. The phone's recognizer is one for the app: this hook only
 * follows a recognition it started.
 */
export function useDictation({
  target,
  selection,
  frozen,
  inView,
}: {
  readonly target: EntryTarget;
  /** The field's selection now. */
  readonly selection: () => readonly [number, number];
  /** The draft takes no change: a dictation under way is cancelled. */
  readonly frozen: boolean;
  /** The operator can see the conversation. */
  readonly inView: boolean;
}): Dictation | null {
  const client = useJ3Client();
  const { t } = useI18n();
  const settings = useSettings();
  const voice = settings._tag === "ready" ? settings.value.voice : null;
  const place = voice?.place ?? null;
  const language = voice?.language ?? "auto";
  const status = useVoiceStatus(voice !== null);
  const phone = usePhoneRecognizer(language);
  const reduced = useReducedMotion();
  const level = useSharedValue(0);
  const [phase, setPhase] = useState<DictationPhase>(IDLE);
  const [notice, setNotice] = useState<DictationNotice | null>(null);
  const [placed, setPlaced] = useState<DictationPlaced | null>(null);
  const session = useRef<Session | null>(null);
  /** Counts presses: a press being prepared goes on only while it is the latest. */
  const presses = useRef(0);

  const pathFor = (device: DeviceRecognizer): DictationPath => {
    const path = dictationPath({ place, device, status, secureContext: true });
    // Through the server, the phone records with the app's own module.
    return path._tag === "server" && voiceCapture === null ? { _tag: "none" } : path;
  };

  const showLevel = (value: number) =>
    level.set(reduced ? value : withSpring(value, reanimatedSpring(springs.soft)));

  const write = (text: string, mentions: DictationOrigin["mentions"], next: DictationPlaced) => {
    client.setDraftText(target, text, mentions);
    setPlaced(next);
  };

  /** `heard` in the draft, where the selection was. */
  const placeWords = (current: Session, heard: HeardWords) => {
    current.heard = heard;
    const draft = dictatedDraft(current.origin, heard);
    write(draft.text, draft.mentions, {
      text: draft.text,
      selection: [draft.caret, draft.caret],
      open: draft.open,
    });
  };

  /**
   * Ends `current`, leaving `words` in the draft, or the draft as it was
   * before when there are none, and saying why when `next` does.
   */
  const end = (current: Session, words: string | null, next: DictationNotice | null) => {
    if (session.current !== current) return;
    session.current = null;
    const { server } = current;
    if (server !== null) {
      server.capturing = false;
      server.unsubscribe();
      server.handle.cancel();
      voiceCapture?.stop();
    }
    if (words === null || words.trim() === "") {
      const { origin } = current;
      write(origin.text, origin.mentions, {
        text: origin.text,
        selection: [origin.start, origin.end],
        open: null,
      });
    } else {
      placeWords(current, { committed: words, tentative: "" });
    }
    showLevel(0);
    setPhase(IDLE);
    setNotice(next);
  };

  const finishServer = (current: Session) => {
    const server = current.server;
    if (server === null || server.finished) return;
    server.finished = true;
    server.capturing = false;
    voiceCapture?.stop();
    showLevel(0);
    const { text, start, end: until } = current.origin;
    // The draft around the words, for the AI's tidy-up, when it is not too long to send.
    server.handle.finish(
      text.length <= MAX_VOICE_DRAFT_LENGTH ? { text, start, end: until } : undefined,
    );
  };

  /** Records into the server's dictation until it stops, or the microphone does. */
  const capture = (current: Session) => {
    const server = current.server;
    if (server === null || server.capturing || server.finished) return;
    if (voiceCapture === null || !voiceCapture.start()) {
      end(current, current.heard.committed, { _tag: "microphoneFailed" });
      return;
    }
    const microphone = voiceCapture;
    server.capturing = true;
    void (async () => {
      while (server.capturing) {
        const piece = await microphone.read().catch(() => null);
        if (piece === null || !server.capturing) break;
        server.handle.audio(piece);
        showLevel(levelOf(samplesOf(piece)));
      }
      // The microphone stopped by itself: what was said goes, as after Stop.
      if (server.capturing) finishServer(current);
    })();
  };

  const startServer = (current: Session) => {
    const handle = client.voice.dictate();
    const server = { handle, unsubscribe: () => {}, capturing: false, finished: false };
    current.server = server;
    const follow = () => {
      if (session.current !== current) return;
      const state = handle.state.get();
      switch (state._tag) {
        case "done":
          end(
            current,
            state.text,
            state.text.trim() === "" && current.listened ? { _tag: "noSpeech" } : null,
          );
          return;
        case "failed":
          end(current, current.heard.committed, { _tag: "failed", reason: state.reason });
          return;
        case "listening":
          current.listened = true;
          capture(current);
          break;
        case "connecting":
        case "installing":
        case "finishing":
        case "tidying":
          break;
      }
      // The microphone may have failed to start, which ends it.
      if (session.current !== current) return;
      if ("committed" in state) {
        const heard = { committed: state.committed, tentative: state.tentative };
        if (!sameWords(heard, current.heard)) placeWords(current, heard);
      }
      setPhase({ _tag: "server", state });
    };
    server.unsubscribe = handle.state.subscribe(follow);
    follow();
  };

  const start = () => {
    if (session.current !== null) return;
    presses.current += 1;
    const press = presses.current;
    const latest = () => presses.current === press;
    setNotice(null);
    setPhase({ _tag: "preparing" });
    void (async () => {
      const recognizer = await phoneRecognizer(language);
      const path = pathFor(recognizer.state);
      if (!latest()) return;
      if (path._tag === "blocked" || path._tag === "none") {
        setPhase(IDLE);
        if (path._tag === "blocked") setNotice({ _tag: "blocked", block: path.block });
        return;
      }
      const access = await askMicrophone();
      if (!latest()) return;
      if (access !== "granted") {
        setPhase(IDLE);
        setNotice({ _tag: "microphone", canAsk: access === "denied" });
        return;
      }
      const draft = client.drafts.get().get(targetKey(target));
      const current: Session = {
        origin: originOf({ text: draft?.text ?? "", mentions: draft?.mentions ?? [] }, selection()),
        heard: NOTHING_HEARD,
        listened: path._tag === "device",
        device: null,
        server: null,
      };
      session.current = current;
      if (path._tag === "server") {
        startServer(current);
        return;
      }
      current.device = { heard: nothingHeard, stopping: false };
      setPhase({ _tag: "device" });
      AccessibilityInfo.announceForAccessibility(t("dictation.listening"));
      try {
        ExpoSpeechRecognitionModule.start({
          ...(recognizer.locale === null ? {} : { lang: recognizer.locale }),
          interimResults: true,
          // Until the operator stops it: a pause to think does not end the message.
          continuous: true,
          // On the phone alone (`createOnDeviceSpeechRecognizer`), never Android's online recognizer.
          requiresOnDeviceRecognition: true,
          addsPunctuation: true,
          volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
        });
      } catch {
        end(current, null, { _tag: "failed", reason: "failed" });
      }
    })().catch(() => {
      if (!latest()) return;
      setPhase(IDLE);
      setNotice({ _tag: "failed", reason: "failed" });
    });
  };

  const stop = () => {
    const current = session.current;
    if (current === null) return;
    if (current.device !== null) {
      current.device.stopping = true;
      ExpoSpeechRecognitionModule.stop();
    } else {
      finishServer(current);
    }
  };

  /**
   * Ends what is under way: a press being prepared, or a dictation, leaving
   * the draft as it was (`restore`) or with the words already settled.
   */
  const leave = (restore: boolean) => {
    presses.current += 1;
    const current = session.current;
    if (current === null) {
      setPhase(IDLE);
      return;
    }
    // Ends the recognition without a last result; its `aborted` error is passed over.
    if (current.device !== null) ExpoSpeechRecognitionModule.abort();
    end(current, restore ? null : current.heard.committed, null);
  };

  useSpeechRecognitionEvent("result", (event) => {
    const current = session.current;
    const best = event.results[0];
    if (current?.device == null || best === undefined) return;
    current.device.heard = hear(current.device.heard, best.transcript, event.isFinal);
    placeWords(current, heardWords(current.device.heard));
  });
  useSpeechRecognitionEvent("volumechange", (event) => {
    // Android's level, from -2 to 10; under 0 is not heard.
    if (session.current?.device != null) showLevel(Math.min(1, Math.max(0, event.value / 10)));
  });
  useSpeechRecognitionEvent("error", (event) => {
    const current = session.current;
    if (current?.device == null || event.error === "aborted") return;
    const heard = heardWords(current.device.heard);
    const said = allOf(heard);
    // Android's on-device recognizer answers Stop of a continuous recognition
    // with a client error instead of its end: the end the operator asked for.
    if (current.device.stopping) return end(current, said, null);
    switch (event.error) {
      // Silence after words is the end of what was said.
      case "no-speech":
      case "speech-timeout":
        return end(current, said, said === "" ? { _tag: "noSpeech" } : null);
      case "not-allowed":
        return end(current, heard.committed, { _tag: "microphone", canAsk: true });
      case "audio-capture":
        return end(current, heard.committed, { _tag: "microphoneFailed" });
      default:
        return end(current, heard.committed, { _tag: "failed", reason: "failed" });
    }
  });
  useSpeechRecognitionEvent("end", () => {
    const current = session.current;
    if (current?.device == null) return;
    const said = allOf(heardWords(current.device.heard));
    end(current, said, said === "" && !current.device.stopping ? { _tag: "noSpeech" } : null);
  });

  const onFrozen = useEffectEvent(() => leave(true));
  const onLeftView = useEffectEvent(() => stop());
  const onUnmount = useEffectEvent(() => leave(false));
  const onBack = useEffectEvent((): boolean => {
    if (session.current === null && phase._tag !== "preparing") return false;
    leave(true);
    return true;
  });
  const onForeground = useEffectEvent(() => {
    if (notice?._tag !== "microphone") return;
    // Allowed in the phone's settings meanwhile: nothing to say any more.
    void microphoneAllowed().then((allowed) => {
      if (allowed) setNotice(null);
    });
  });

  useEffect(() => () => onUnmount(), []);
  useEffect(() => {
    if (frozen) onFrozen();
  }, [frozen]);
  // Not a press being prepared: Android reports the app in the background
  // while its permission dialog is open.
  useEffect(() => {
    if (!inView) onLeftView();
  }, [inView]);
  const active = phase._tag !== "idle";
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => onBack());
    return () => subscription.remove();
  }, [active]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") onForeground();
    });
    return () => subscription.remove();
  }, []);

  if (!active && pathFor(phone?.state ?? "none")._tag === "none") return null;
  return {
    phase,
    listening:
      phase._tag === "device" ||
      (phase._tag === "server" && phase.state._tag === "listening" && phase.state.live),
    placed,
    notice,
    level,
    start,
    stop,
    dismiss: () => setNotice(null),
  };
}

/**
 * The microphone, beside Send: Dictate, then Stop with the microphone's level
 * around it while it records. Stop takes no press while the server works out
 * the last words.
 */
export function DictationButton({
  dictation,
  unavailable,
}: {
  readonly dictation: Dictation;
  /** The draft takes no change: dictation cannot start meanwhile. */
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  const { phase } = dictation;
  if (phase._tag === "device" || phase._tag === "server") {
    const working =
      phase._tag === "server" &&
      (phase.state._tag === "finishing" || phase.state._tag === "tidying");
    return (
      <View style={composerButtonFrame}>
        <Level level={dictation.level} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("dictation.stop")}
          accessibilityState={{ disabled: working, busy: working }}
          onPress={working ? undefined : dictation.stop}
          hitSlop={composerButtonSlop}
          className={`size-8 items-center justify-center rounded-full bg-foreground ${working ? "opacity-50" : ""}`}
        >
          <Icon icon={Square} size={12} color="accent-background" filled />
        </Pressable>
      </View>
    );
  }
  const disabled = unavailable || phase._tag === "preparing";
  return (
    <View style={composerButtonFrame}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("composer.dictate")}
        accessibilityState={{ disabled }}
        onPress={disabled ? undefined : dictation.start}
        hitSlop={composerButtonSlop}
        className="size-8 items-center justify-center rounded-full active:bg-muted"
      >
        <Icon icon={Mic} size={18} color="accent-muted-foreground" />
      </Pressable>
    </View>
  );
}

/** A soft ring behind Stop that swells with the microphone's level. */
function Level({ level }: { readonly level: SharedValue<number> }) {
  const ring = useAnimatedStyle(() => ({
    opacity: 0.12 + 0.18 * level.get(),
    transform: [{ scale: 1 + 0.45 * level.get() }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[composerButtonFrame, ring]}
      className="absolute inset-0 items-center justify-center"
    >
      <View className="size-8 rounded-full bg-foreground" />
    </Animated.View>
  );
}

/** What the line under the composer says of a notice. */
const noticeWords = (notice: DictationNotice, i18n: I18n): string => {
  switch (notice._tag) {
    case "microphone":
      return i18n.t(notice.canAsk ? "composer.dictation.denied" : "composer.dictation.blocked");
    case "microphoneFailed":
      return i18n.t("dictation.microphoneFailed");
    case "blocked":
      return dictationBlockWords(notice.block, i18n);
    case "failed":
      return dictationFailureWords(notice.reason, i18n);
    case "noSpeech":
      return i18n.t("composer.dictation.noSpeech");
  }
};

/**
 * The quiet line under the composer: what the server is doing while words
 * do not come as they are spoken (getting ready, downloading, writing the
 * last words down, tidying), and why dictation stopped by itself or cannot
 * start. A microphone Android no longer lets the app ask for opens the
 * phone's settings from here.
 */
export function DictationLine({ dictation }: { readonly dictation: Dictation }) {
  const i18n = useI18n();
  const { phase, notice } = dictation;
  const working =
    phase._tag === "server" && !dictation.listening ? dictationStateWords(phase.state, i18n) : null;
  const line = working ?? (notice === null ? null : noticeWords(notice, i18n));
  if (line === null) return null;
  return (
    <View className="flex-row items-center justify-between gap-2 ps-3">
      <Text accessibilityLiveRegion="polite" className="flex-1 text-xs text-muted-foreground">
        {line}
      </Text>
      {working === null && notice?._tag === "microphone" && !notice.canAsk && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openSettings()}
          className="min-h-11 justify-center px-3"
        >
          <Text className="text-sm text-accent">{i18n.t("composer.dictation.settings")}</Text>
        </Pressable>
      )}
    </View>
  );
}
