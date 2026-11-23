// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ExpoSpeechRecognitionErrorCode,
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { Mic, Square } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Linking, Platform, Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import {
  dictationAvailable,
  dictationLanguage,
  whereRecognitionRuns,
} from "../platform/dictation.ts";
import {
  type Heard,
  hear,
  heardText,
  nothingHeard,
  type RecognitionPlace,
} from "../platform/recognition.ts";

/** Why dictation stopped without the operator stopping it, or did not start. */
type DictationProblem =
  /** The microphone was refused; the next press asks again. */
  | "denied"
  /** The microphone was refused for good; only the system's settings allow it now. */
  | "blocked"
  | "noSpeech"
  | "network"
  | "language"
  | "failed";

type DictationState =
  | { readonly _tag: "idle" }
  /** Asking for the microphone, or finding where recognition runs. */
  | { readonly _tag: "preparing" }
  | { readonly _tag: "listening"; readonly place: RecognitionPlace };

export interface Dictation {
  readonly state: DictationState;
  readonly problem: DictationProblem | null;
  readonly start: () => void;
  readonly stop: () => void;
  /** Stops listening with no final result; what was heard so far stays in the draft. */
  readonly abort: () => void;
  /** Forgets the last problem, as the operator moves on. */
  readonly dismiss: () => void;
}

/** What dictation does with a recognizer error; null for one that is no problem. */
const problemOf = (
  error: ExpoSpeechRecognitionErrorCode,
  heardAnything: boolean,
): DictationProblem | null => {
  switch (error) {
    case "aborted":
      return null;
    // Silence after words is the end of what was said.
    case "no-speech":
    case "speech-timeout":
      return heardAnything ? null : "noSpeech";
    case "network":
      return "network";
    case "language-not-supported":
      return "language";
    case "not-allowed":
      return "denied";
    case "audio-capture":
    case "interrupted":
    case "bad-grammar":
    case "service-not-allowed":
    case "busy":
    case "client":
    case "too-many-requests":
    case "unknown":
      return "failed";
  }
};

/** A press of Dictate, from preparing it to the recognizer's end. */
interface Session {
  /** A press is being prepared: cleared to cancel it. */
  preparing: boolean;
  /** The recognizer's session is this composer's: its end is this composer's to follow. */
  owned: boolean;
  /** What the recognizer hears goes into the draft. */
  taking: boolean;
  /**
   * The operator pressed Stop. Android's on-device recognizer answers a stop
   * of a continuous session with a client error instead of its end, so an
   * error from then on is the end they asked for.
   */
  stopping: boolean;
  heard: Heard;
}

/**
 * Stops a session this composer started, and taking what it hears.
 * `expo-speech-recognition` answers `abort()` with an `aborted` error event,
 * on Android and iOS alike, which ends the session as any other end does.
 */
const stopTaking = (session: Session) => {
  if (!session.owned || !session.taking) return;
  session.taking = false;
  ExpoSpeechRecognitionModule.abort();
};

/** Cancels a press being prepared too. */
const interrupt = (session: Session) => {
  session.preparing = false;
  stopTaking(session);
};

/**
 * Dictation into the draft with the platform's speech recognizer, preferring
 * recognition on the device. The first press asks for the microphone. What
 * is heard goes to `onHeard` as it is heard, the whole text each time; it is
 * never sent. Listening stops once the draft is `frozen`, or the conversation
 * is no longer `inView`. Null where the platform has no recognizer. The
 * recognizer is one for the app: this composer only follows a session it
 * started, and stops it when it unmounts.
 */
export function useDictation({
  onHeard,
  frozen,
  inView,
}: {
  readonly onHeard: (text: string) => void;
  /** The draft takes no change. */
  readonly frozen: boolean;
  /** The operator can see the conversation. */
  readonly inView: boolean;
}): Dictation | null {
  const [available] = useState(dictationAvailable);
  const [state, setState] = useState<DictationState>({ _tag: "idle" });
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const session = useRef<Session>({
    preparing: false,
    owned: false,
    taking: false,
    stopping: false,
    heard: nothingHeard,
  });

  useEffect(() => {
    const current = session.current;
    return () => interrupt(current);
  }, []);
  useEffect(() => {
    if (frozen) interrupt(session.current);
  }, [frozen]);
  // Not a press being prepared: Android reports the app in the background
  // while its permission dialog is open.
  useEffect(() => {
    if (!inView) stopTaking(session.current);
  }, [inView]);

  const finish = (next: DictationProblem | null) => {
    Object.assign(session.current, {
      preparing: false,
      owned: false,
      taking: false,
      stopping: false,
    });
    setState({ _tag: "idle" });
    if (next !== null) setProblem(next);
  };

  useSpeechRecognitionEvent("result", (event) => {
    const current = session.current;
    const best = event.results[0];
    if (!current.owned || !current.taking || best === undefined) return;
    current.heard = hear(current.heard, best.transcript, event.isFinal);
    onHeard(heardText(current.heard));
  });
  useSpeechRecognitionEvent("error", (event) => {
    const current = session.current;
    if (!current.owned) return;
    finish(
      current.taking && !current.stopping
        ? problemOf(event.error, heardText(current.heard) !== "")
        : null,
    );
  });
  useSpeechRecognitionEvent("end", () => {
    if (session.current.owned) finish(null);
  });

  if (!available) return null;

  const start = () => {
    const current = session.current;
    if (current.preparing || current.owned) return;
    current.preparing = true;
    setProblem(null);
    setState({ _tag: "preparing" });
    void (async () => {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!current.preparing) return finish(null);
      if (!permission.granted) return finish(permission.canAskAgain ? "denied" : "blocked");
      const language = dictationLanguage();
      const place = await whereRecognitionRuns(language);
      if (!current.preparing) return finish(null);
      Object.assign(current, {
        preparing: false,
        owned: true,
        taking: true,
        stopping: false,
        heard: nothingHeard,
      });
      setState({ _tag: "listening", place });
      ExpoSpeechRecognitionModule.start({
        ...(language === undefined ? {} : { lang: language }),
        interimResults: true,
        // Until the operator stops it: a pause to think does not end the message.
        continuous: true,
        requiresOnDeviceRecognition: place === "device",
        addsPunctuation: true,
        iosTaskHint: "dictation",
      });
    })().catch(() => finish("failed"));
  };

  return {
    state,
    problem,
    start,
    stop: () => {
      const current = session.current;
      if (!current.owned || !current.taking) return;
      current.stopping = true;
      ExpoSpeechRecognitionModule.stop();
    },
    abort: () => interrupt(session.current),
    dismiss: () => setProblem(null),
  };
}

/**
 * The composer's trailing button while there is nothing to send, or while it
 * listens: Dictate, then Stop.
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
  if (dictation.state._tag === "listening") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("composer.dictation.stop")}
        onPress={dictation.stop}
        className="size-11 items-center justify-center rounded-full bg-foreground"
      >
        <Icon icon={Square} size={14} color="accent-background" filled />
      </Pressable>
    );
  }
  const disabled = unavailable || dictation.state._tag === "preparing";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("composer.dictate")}
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : dictation.start}
      className="size-11 items-center justify-center rounded-full active:bg-muted"
    >
      <Icon icon={Mic} size={20} color="accent-muted-foreground" />
    </Pressable>
  );
}

const problemKey = {
  denied: "composer.dictation.denied",
  blocked: "composer.dictation.denied",
  noSpeech: "composer.dictation.noSpeech",
  network: "composer.dictation.network",
  language: "composer.dictation.language",
  failed: "composer.dictation.failed",
} as const;

/**
 * The quiet line under the pill: that the phone listens, and that its speech
 * service recognizes it online when it does; or why dictation stopped.
 */
export function DictationLine({ dictation }: { readonly dictation: Dictation }) {
  const { t } = useI18n();
  const { state, problem } = dictation;
  const line =
    state._tag === "listening"
      ? t(
          state.place === "device"
            ? "composer.dictation.listening"
            : "composer.dictation.listeningOnline",
        )
      : problem === null
        ? null
        : t(problemKey[problem]);
  // Android reads the line through its live region; iOS has none.
  useEffect(() => {
    if (Platform.OS === "ios" && line !== null) AccessibilityInfo.announceForAccessibility(line);
  }, [line]);
  if (line === null) return null;
  if (state._tag === "listening") {
    return (
      <Text accessibilityLiveRegion="polite" className="px-3 text-xs text-muted-foreground">
        {line}
      </Text>
    );
  }
  return (
    <View className="flex-row items-center justify-between gap-2 ps-3">
      <Text accessibilityLiveRegion="polite" className="flex-1 text-xs text-muted-foreground">
        {line}
      </Text>
      {problem === "blocked" && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openSettings()}
          className="min-h-11 justify-center px-3"
        >
          <Text className="text-sm text-accent">{t("composer.dictation.settings")}</Text>
        </Pressable>
      )}
    </View>
  );
}
