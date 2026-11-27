// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DictationFailure,
  type DictationState,
  targetKey,
  type VoiceClient,
} from "@j3-bots/client-runtime";
import {
  type DeviceRecognizer,
  type DictationBlock,
  type DictationPath,
  dictationPath,
  followFieldEdit,
  followTyping,
  type HeardWords,
  levelOf,
  placeHeard,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useSettings } from "@j3-bots/client-runtime/react";
import {
  dictationBlockWords,
  dictationFailureNeedsSetup,
  dictationFailureWords,
  elapsedWords,
} from "@j3-bots/client-runtime/wording";
import type { EntryTarget } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import type { I18n } from "@j3-bots/i18n";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { Check, CircleAlert, Mic, X } from "lucide-react-native";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  BackHandler,
  Linking,
  Pressable,
  View,
} from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { appear, useReducedMotion } from "../motion.ts";
import {
  askMicrophone,
  microphoneAllowed,
  phoneRecognizer,
  usePhoneRecognizer,
} from "../platform/dictation.ts";
import { type Heard, hear, heardWords, nothingHeard } from "../platform/recognition.ts";
import { samplesOf, voiceCapture } from "../platform/voiceCapture.ts";
import { Text } from "../text.tsx";
import { useColor } from "../theme.ts";
import { useCloudKeys } from "../voiceStatus.ts";
import { composerButtonFrame, composerButtonSlop } from "./composerButton.ts";

// Dictation into the composer (decisions 0096 and 0107). Where speech
// becomes words is the operator's choice in Settings → Voice: the phone's own
// recognizer, on the phone alone, or their dictation service, through the
// server, which hears the microphone through the voice socket. Android's
// online recognizer is never used. While it records, the composer shows it
// inside, and the field still takes typing; once it stops, the words land
// where the caret was, moved along with what was typed. Nothing is sent by
// itself.

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
  /** The microphone records, since `startedAt` (ms). */
  | { readonly _tag: "recording"; readonly startedAt: number }
  /** The service writes it down. */
  | { readonly _tag: "finishing" };

/** Where dictation last left the draft: its text, and the selection after the words. */
interface DictationPlaced {
  readonly text: string;
  readonly selection: readonly [number, number];
}

export interface Dictation {
  readonly phase: DictationPhase;
  readonly placed: DictationPlaced | null;
  readonly notice: DictationNotice | null;
  /** The microphone's level, 0 to 1, while it records. */
  readonly level: SharedValue<number>;
  readonly start: () => void;
  readonly stop: () => void;
  /** Ends it with no words. */
  readonly cancel: () => void;
  /** Forgets the last notice, as the operator moves on. */
  readonly dismiss: () => void;
  /** Opens Settings → Voice, where a notice that says so is fixed. */
  readonly setUp: () => void;
}

type ServerDictation = ReturnType<VoiceClient["dictate"]>;

/** A dictation from the press that started it to its end. */
interface Session {
  /** Where the words go: where the caret was, moved along with what was typed since. */
  at: { readonly start: number; readonly end: number };
  /** The draft as `at` was last moved along with it. */
  seen: string;
  /** The server took audio: an end with no words is one where nothing was heard. */
  listened: boolean;
  /** The phone's recognizer, and whether the operator pressed Stop. */
  device: { heard: Heard; stopping: boolean } | null;
  server: {
    readonly handle: ServerDictation;
    unsubscribe: () => void;
    /** The microphone's pieces go to the server. */
    capturing: boolean;
    /** The operator stopped: the service is writing it down. */
    finished: boolean;
  } | null;
}

const IDLE: DictationPhase = { _tag: "idle" };

/** Everything heard, settled or not, as the words a stop leaves. */
const allOf = (heard: HeardWords): string =>
  [heard.committed.trim(), heard.tentative.trim()].filter((part) => part !== "").join(" ");

/**
 * Dictation into `target`'s draft, at the field's `selection` when a press
 * starts it; null where this phone cannot dictate at all (`dictationPath`'s
 * `none`). The draft keeps taking the operator's typing. Stop has the words
 * land; Back cancels; the conversation leaving the operator's view stops it.
 * Unmounting cancels it. Words that come while the draft takes no change
 * land once it does. The phone's recognizer is one for the app: this hook
 * only follows a recognition it started.
 */
export function useDictation({
  target,
  text,
  selection,
  frozen,
  inView,
  onSetUp,
}: {
  readonly target: EntryTarget;
  /** The draft's text now. */
  readonly text: string;
  /** The field's selection now. */
  readonly selection: () => readonly [number, number];
  /** The draft takes no change now: words wait, and a press starts nothing. */
  readonly frozen: boolean;
  /** The operator can see the conversation. */
  readonly inView: boolean;
  /** Opens Settings → Voice. */
  readonly onSetUp: () => void;
}): Dictation | null {
  const client = useJ3Client();
  const { t } = useI18n();
  const settings = useSettings();
  const voice = settings._tag === "ready" ? settings.value.voice : null;
  const language = voice?.language ?? "auto";
  const keys = useCloudKeys(voice?.provider !== undefined);
  const phone = usePhoneRecognizer(language);
  const reduced = useReducedMotion();
  const level = useSharedValue(0);
  const [phase, setPhase] = useState<DictationPhase>(IDLE);
  const [notice, setNotice] = useState<DictationNotice | null>(null);
  const [placed, setPlaced] = useState<DictationPlaced | null>(null);
  const session = useRef<Session | null>(null);
  // Whether the draft takes no change, as the latest render saw it, for what ends a dictation later.
  const frozenNow = useRef(frozen);
  useLayoutEffect(() => {
    frozenNow.current = frozen;
  }, [frozen]);
  // Words heard while the draft took no change, which land once it does.
  const waiting = useRef<{ readonly session: Session; readonly words: string } | null>(null);
  /** Counts presses: a press being prepared goes on only while it is the latest. */
  const presses = useRef(0);

  const pathFor = (device: DeviceRecognizer): DictationPath => {
    const path = dictationPath({ voice, device, keys, secureContext: true });
    // Through the server, the phone records with the app's own module.
    return path._tag === "server" && voiceCapture === null ? { _tag: "none" } : path;
  };

  // The words' place follows each change of the draft, the operator's or another device's.
  useLayoutEffect(() => {
    const current = session.current ?? waiting.current?.session ?? null;
    if (current === null) return;
    current.at = followTyping(current.at, current.seen, text);
    current.seen = text;
  }, [text]);

  const showLevel = (value: number) =>
    level.set(reduced ? value : withSpring(value, reanimatedSpring(springs.soft)));

  /** `words` where `current`'s place is now, the caret after them if it stood there. */
  const land = (current: Session, words: string) => {
    const draft = client.drafts.get().get(targetKey(target));
    const now = draft?.text ?? "";
    const followed = followTyping(current.at, current.seen, now);
    const at = {
      start: Math.min(followed.start, now.length),
      end: Math.min(followed.end, now.length),
    };
    const place = placeHeard({ text: now, ...at }, { committed: words, tentative: "" });
    const mentions = followFieldEdit(
      {
        _tag: "change",
        before: now,
        after: place.text,
        over: at.start < at.end ? [at.start, at.end] : null,
        written: null,
        caret: place.committed,
      },
      draft?.mentions ?? [],
    );
    const [start, end] = selection();
    const caret =
      start === at.start && end === at.end
        ? { start: place.committed, end: place.committed }
        : followTyping({ start, end }, now, place.text);
    client.setDraftText(target, place.text, mentions);
    setPlaced({ text: place.text, selection: [caret.start, caret.end] });
  };

  /** Ends `current`, landing `words` when there are any, and saying why when `next` does. */
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
    if (words !== null && words.trim() !== "") {
      if (frozenNow.current) waiting.current = { session: current, words: words.trim() };
      else land(current, words.trim());
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
    server.handle.finish();
    setPhase({ _tag: "finishing" });
  };

  /** Records into the server's dictation until it stops, or the microphone does. */
  const capture = (current: Session) => {
    const server = current.server;
    if (server === null || server.capturing || server.finished) return;
    if (voiceCapture === null || !voiceCapture.start()) {
      end(current, null, { _tag: "microphoneFailed" });
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
      const state: DictationState = handle.state.get();
      switch (state._tag) {
        case "done":
          end(
            current,
            state.text,
            state.text.trim() === "" && current.listened ? { _tag: "noSpeech" } : null,
          );
          return;
        case "failed":
          end(current, null, { _tag: "failed", reason: state.reason });
          return;
        case "listening":
          current.listened = true;
          capture(current);
          return;
        case "connecting":
        case "finishing":
          return;
      }
    };
    server.unsubscribe = handle.state.subscribe(follow);
    follow();
  };

  const start = () => {
    if (session.current !== null || frozen) return;
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
        if (path._tag === "blocked" && path.block === "setup") onSetUp();
        else if (path._tag === "blocked") setNotice({ _tag: "blocked", block: path.block });
        return;
      }
      const access = await askMicrophone();
      if (!latest()) return;
      if (access !== "granted") {
        setPhase(IDLE);
        setNotice({ _tag: "microphone", canAsk: access === "denied" });
        return;
      }
      const [from, to] = selection();
      const current: Session = {
        at: {
          start: Math.min(from, to, text.length),
          end: Math.min(Math.max(from, to), text.length),
        },
        seen: text,
        listened: path._tag === "device",
        device: null,
        server: null,
      };
      session.current = current;
      setPhase({ _tag: "recording", startedAt: Date.now() });
      AccessibilityInfo.announceForAccessibility(t("dictation.listening"));
      if (path._tag === "server") {
        startServer(current);
        return;
      }
      current.device = { heard: nothingHeard, stopping: false };
      // Dictation through the server tells it as it starts (`voice.dictate`); this one does here.
      client.recordUsage({ event: "feature.used", properties: { feature: "voice-input" } });
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

  /** Ends what is under way, a press being prepared or a dictation, with no words. */
  const cancel = () => {
    presses.current += 1;
    const current = session.current;
    if (current === null) {
      setPhase(IDLE);
      return;
    }
    // Ends the recognition without a last result; its `aborted` error is passed over.
    if (current.device !== null) ExpoSpeechRecognitionModule.abort();
    end(current, null, null);
  };

  useSpeechRecognitionEvent("result", (event) => {
    const current = session.current;
    const best = event.results[0];
    if (current?.device == null || best === undefined) return;
    current.device.heard = hear(current.device.heard, best.transcript, event.isFinal);
  });
  useSpeechRecognitionEvent("volumechange", (event) => {
    // Android's level, from -2 to 10; under 0 is not heard.
    if (session.current?.device != null) showLevel(Math.min(1, Math.max(0, event.value / 10)));
  });
  useSpeechRecognitionEvent("error", (event) => {
    const current = session.current;
    if (current?.device == null || event.error === "aborted") return;
    const said = allOf(heardWords(current.device.heard));
    // Android's on-device recognizer answers Stop of a continuous recognition
    // with a client error instead of its end: the end the operator asked for.
    if (current.device.stopping) return end(current, said, null);
    switch (event.error) {
      // Silence after words is the end of what was said.
      case "no-speech":
      case "speech-timeout":
        return end(current, said, said === "" ? { _tag: "noSpeech" } : null);
      case "not-allowed":
        return end(current, said, { _tag: "microphone", canAsk: true });
      case "audio-capture":
        return end(current, said, { _tag: "microphoneFailed" });
      default:
        return end(current, said, { _tag: "failed", reason: "failed" });
    }
  });
  useSpeechRecognitionEvent("end", () => {
    const current = session.current;
    if (current?.device == null) return;
    const said = allOf(heardWords(current.device.heard));
    end(current, said, said === "" && !current.device.stopping ? { _tag: "noSpeech" } : null);
  });

  const onThawed = useEffectEvent(() => {
    const held = waiting.current;
    if (held === null) return;
    waiting.current = null;
    land(held.session, held.words);
  });
  const onLeftView = useEffectEvent(() => stop());
  const onUnmount = useEffectEvent(() => cancel());
  const onBack = useEffectEvent((): boolean => {
    if (session.current === null && phase._tag !== "preparing") return false;
    cancel();
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
    if (!frozen) onThawed();
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
    placed,
    notice,
    level,
    start,
    stop,
    cancel,
    dismiss: () => setNotice(null),
    setUp: () => {
      setNotice(null);
      onSetUp();
    },
  };
}

/** Each bar of the level, and how tall it stands against it: the middle ones most, so a voice reads as a voice. */
const BARS = [
  { place: "first", weight: 0.55 },
  { place: "second", weight: 0.85 },
  { place: "middle", weight: 1 },
  { place: "fourth", weight: 0.75 },
  { place: "last", weight: 0.5 },
] as const;

/** One bar of the level, drawn on the UI thread from `level`. */
function LevelBar({
  level,
  weight,
}: {
  readonly level: SharedValue<number>;
  readonly weight: number;
}) {
  const bar = useAnimatedStyle(() => ({
    transform: [{ scaleY: 0.14 + 0.86 * level.get() * weight }],
  }));
  return <Animated.View style={bar} className="h-4 w-0.5 rounded-full bg-muted-foreground" />;
}

/** The time since `startedAt` as a clock shows it, once a second. */
function Elapsed({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text className="min-w-7 text-xs text-muted-foreground tabular-nums">
      {elapsedWords(now - startedAt)}
    </Text>
  );
}

/**
 * The microphone, beside Send. At rest it dictates. While it records it
 * opens into a capsule inside the composer: Cancel, a red dot, the time, the
 * voice's level, and Stop, which has the words written down; while they are,
 * the capsule says so, with Cancel.
 */
export function DictationControl({
  dictation,
  unavailable,
}: {
  readonly dictation: Dictation;
  /** The draft takes no change: dictation cannot start meanwhile. */
  readonly unavailable: boolean;
}) {
  const { t } = useI18n();
  const muted = useColor("accent-muted-foreground");
  const { phase } = dictation;
  if (phase._tag === "recording" || phase._tag === "finishing") {
    return (
      <Animated.View
        entering={appear}
        className="my-1.5 flex-row items-center gap-1.5 self-end rounded-full bg-muted ps-0.5 pe-0.5"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("dictation.cancel")}
          onPress={dictation.cancel}
          hitSlop={6}
          className="size-8 items-center justify-center rounded-full active:bg-muted-strong"
        >
          <Icon icon={X} size={16} color="accent-muted-foreground" />
        </Pressable>
        {phase._tag === "recording" ? (
          <>
            <View className="size-2 rounded-full bg-blocked" />
            <Elapsed startedAt={phase.startedAt} />
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={t("dictation.level")}
              className="h-4 flex-row items-center gap-0.5"
            >
              {BARS.map(({ place, weight }) => (
                <LevelBar key={place} level={dictation.level} weight={weight} />
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("dictation.stop")}
              onPress={dictation.stop}
              hitSlop={6}
              className="size-8 items-center justify-center rounded-full bg-foreground"
            >
              <Icon icon={Check} size={16} color="accent-background" />
            </Pressable>
          </>
        ) : (
          <View accessibilityLiveRegion="polite" className="flex-row items-center gap-1.5 pe-3">
            <ActivityIndicator size="small" color={muted} style={{ transform: [{ scale: 0.7 }] }} />
            <Text className="text-xs text-muted-foreground">{t("dictation.finishing")}</Text>
          </View>
        )}
      </Animated.View>
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

/** What the composer says of a notice. */
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

/** Whether Settings → Voice fixes what `notice` says. */
const fixedInSettings = (notice: DictationNotice): boolean =>
  (notice._tag === "blocked" && notice.block === "no-device-recognizer") ||
  (notice._tag === "failed" && dictationFailureNeedsSetup(notice.reason));

/**
 * Why dictation stopped by itself or cannot start, inside the composer over
 * the text, with Set up where Settings → Voice fixes it, or the phone's
 * settings where Android no longer lets the app ask for the microphone, and
 * a way to put it away.
 */
export function DictationNotice({ dictation }: { readonly dictation: Dictation }) {
  const i18n = useI18n();
  const { notice } = dictation;
  if (notice === null) return null;
  const action =
    notice._tag === "microphone" && !notice.canAsk
      ? { label: i18n.t("composer.dictation.settings"), onPress: () => void Linking.openSettings() }
      : fixedInSettings(notice)
        ? { label: i18n.t("dictation.setUp"), onPress: dictation.setUp }
        : null;
  return (
    <Animated.View entering={appear} className="flex-row items-start gap-2 ps-3 pe-1 pt-1.5">
      <View className="pt-0.5">
        <Icon icon={CircleAlert} size={14} color="accent-blocked" />
      </View>
      <Text accessibilityLiveRegion="polite" className="flex-1 text-xs text-foreground">
        {noticeWords(notice, i18n)}
      </Text>
      {action !== null && (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          className="min-h-8 justify-center rounded-full px-2.5 active:bg-muted"
        >
          <Text className="text-sm text-accent">{action.label}</Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={i18n.t("dictation.dismiss")}
        onPress={dictation.dismiss}
        hitSlop={8}
        className="size-7 items-center justify-center rounded-full active:bg-muted"
      >
        <Icon icon={X} size={14} color="accent-muted-foreground" />
      </Pressable>
    </Animated.View>
  );
}
