// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DictationHandle, DictationState, DraftMention } from "@j3-bots/client-runtime";
import {
  type DictationPath,
  followFieldEdit,
  followTyping,
  levelOf,
  placeHeard,
} from "@j3-bots/client-runtime/presentation";
import {
  dictationBlockWords,
  dictationFailureNeedsSetup,
  dictationFailureWords,
  elapsedWords,
} from "@j3-bots/client-runtime/wording";
import type { I18n } from "@j3-bots/i18n";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon, MicIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useI18n } from "../app/context";
import { shellShortcuts } from "../shell/shortcuts";
import { selectInField } from "./ChipField";
import { Button } from "./ui/button";

// Dictation in the composer (decisions 0096 and 0107): the microphone
// records, the server has the operator's dictation service write it down
// once they stop, and the words land where the caret was. The operator can
// keep typing meanwhile; the words' place moves along with what they type.
// Nothing is sent by itself.

/** Why the microphone did not open. */
export type MicrophoneFailure = "denied" | "no-microphone" | "failed";

export type MicrophoneOpening =
  /** Recording; `stop` lets the microphone go. */
  | { readonly _tag: "open"; readonly stop: () => void }
  | { readonly _tag: "failed"; readonly reason: MicrophoneFailure };

/** What the microphone hands over while it records. */
interface MicrophoneListener {
  /** A piece of the recording: mono samples at the voice socket's rate, a tenth of a second. */
  readonly samples: (samples: Float32Array) => void;
  /** The microphone stopped by itself, as when it was unplugged. */
  readonly lost: () => void;
}

/** Opens the microphone, asking for it if the page may not use it yet. */
export type OpenMicrophone = (listener: MicrophoneListener) => Promise<MicrophoneOpening>;

/** Where dictation runs from this composer: the server, or nowhere and why. */
export type DictationReach = Extract<DictationPath, { readonly _tag: "server" | "blocked" }>;

/** What the composer dictates with. Absent where there is no dictation: no microphone shows. */
export interface DictationSource {
  readonly reach: DictationReach;
  /** Starts a dictation on the server. */
  readonly dictate: () => DictationHandle;
  readonly microphone: OpenMicrophone;
  /** Where the page runs, which says where the operator allows the microphone. */
  readonly app: "browser" | "desktop";
  /**
   * Opens Settings → Voice, where a dictation service and its key are set
   * up. Absent where Settings is not at hand, as in quick access: the
   * composer then says what to set up.
   */
  readonly setUp?: (() => void) | undefined;
}

/** A dictation under way, and where its words go in the draft as it is now. */
interface Session {
  readonly handle: DictationHandle;
  /** The draft it dictates into. */
  readonly draft: string;
  /** Where the words go: where the caret was, moved along with what was typed since. */
  at: { readonly start: number; readonly end: number };
}

/** Why the last press or dictation gave no words, and whether Settings → Voice fixes it. */
export interface DictationProblem {
  readonly text: string;
  readonly setUp: boolean;
}

/** A piece of the recording as the voice socket takes it: 32-bit floats, little-endian. */
export const littleEndian = (samples: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, sample] of samples.entries()) view.setFloat32(index * 4, sample, true);
  return bytes;
};

/** Why the microphone did not open, and what the operator does about it. */
export const microphoneFailureWords = (
  reason: MicrophoneFailure,
  app: DictationSource["app"],
  { t }: I18n,
): string =>
  reason === "denied"
    ? t(app === "desktop" ? "dictation.denied.desktop" : "dictation.denied.browser")
    : t(reason === "no-microphone" ? "dictation.noMicrophone" : "dictation.microphoneFailed");

const isOver = (state: DictationState) => state._tag === "done" || state._tag === "failed";

const noState = () => null;
const noChange = () => () => {};

/** The microphone's level as it records, for the meter to follow outside React. */
interface LevelFeed {
  /** Calls `listener` with each level, 0 to 1. Returns the function that stops it. */
  readonly subscribe: (listener: (level: number) => void) => () => void;
}

const levelFeed = () => {
  const listeners = new Set<(level: number) => void>();
  return {
    feed: {
      subscribe: (listener: (level: number) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies LevelFeed,
    tell: (level: number) => {
      for (const listener of listeners) listener(level);
    },
  };
};

/**
 * Dictation in one composer. A press starts it where the caret is; while it
 * records, the microphone gives way to Cancel, the time, the voice's level
 * and Stop, and the field still takes the operator's typing: the words' place
 * moves with it. Stop has the server write it down, shown in place; then the
 * words land where the caret was, the caret after them if it stood there.
 * Escape cancels: nothing lands. A dictation that fails, or a press where
 * dictation cannot run, says why inside the composer, with Set up when
 * Settings → Voice fixes it; where a press only needs set-up and Settings is
 * at hand, it opens Settings → Voice instead. The microphone records from the
 * press until it stops, is cancelled, fails or the composer goes.
 */
export function useDictation({
  source,
  draftKey,
  value,
  mentions,
  field,
  selection,
  available,
  onValueChange,
}: {
  readonly source: DictationSource | undefined;
  readonly draftKey: string;
  readonly value: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  readonly field: RefObject<HTMLDivElement | null>;
  /** The field's selection as the operator last left it, where the words go. */
  readonly selection: () => readonly [number, number] | null;
  /** Whether the draft takes a change now: a dictation starts, and its words land, only then. */
  readonly available: boolean;
  readonly onValueChange: (value: string, mentions: ReadonlyArray<DraftMention>) => void;
}) {
  const i18n = useI18n();
  const shortcut = shellShortcuts().dictate;
  const [session, setSession] = useState<Session | null>(null);
  // The session under way, for what the microphone and the handle tell after a render.
  const current = useRef<Session | null>(null);
  // The microphone of the session under way, once it opened.
  const microphone = useRef<(() => void) | null>(null);
  // The draft as the session's place was last moved along with it.
  const seen = useRef(value);
  // Words heard while the draft took no change, which land once it does.
  const waiting = useRef<{ readonly session: Session; readonly words: string } | null>(null);
  // Where the selection goes once the field shows `text`.
  const pending = useRef<{ readonly text: string; readonly start: number; readonly end: number }>(
    null,
  );
  const [levels] = useState(levelFeed);
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const [problemFor, setProblemFor] = useState(draftKey);
  if (problemFor !== draftKey) {
    setProblemFor(draftKey);
    setProblem(null);
  }
  const state = useSyncExternalStore(
    session?.handle.state.subscribe ?? noChange,
    session?.handle.state.get ?? noState,
    session?.handle.state.get ?? noState,
  );

  // The words' place follows each change of the draft, the operator's or another tab's.
  useLayoutEffect(() => {
    const under = current.current;
    if (under !== null) under.at = followTyping(under.at, seen.current, value);
    seen.current = value;
  }, [value]);

  const letMicrophoneGo = () => {
    microphone.current?.();
    microphone.current = null;
  };
  const end = (ended: Session) => {
    if (current.current !== ended) return;
    letMicrophoneGo();
    ended.handle.cancel();
    current.current = null;
    setSession(null);
  };

  const start = () => {
    if (source === undefined || current.current !== null || !available) return;
    setProblem(null);
    if (source.reach._tag === "blocked") {
      const { block } = source.reach;
      if (block === "setup" && source.setUp !== undefined) {
        source.setUp();
        return;
      }
      setProblem({
        text: dictationBlockWords(block, i18n),
        setUp: block !== "insecure-page" && source.setUp !== undefined,
      });
      return;
    }
    const [from, to] = selection() ?? [value.length, value.length];
    const handle = source.dictate();
    const started: Session = {
      handle,
      draft: draftKey,
      at: { start: from, end: to },
    };
    current.current = started;
    seen.current = value;
    setSession(started);
    void source
      .microphone({
        samples: (samples) => {
          if (current.current !== started) return;
          levels.tell(levelOf(samples));
          handle.audio(littleEndian(samples));
        },
        lost: () => stop(started),
      })
      .then((opening) => {
        if (current.current !== started) {
          if (opening._tag === "open") opening.stop();
          return;
        }
        if (opening._tag === "open") {
          microphone.current = opening.stop;
          return;
        }
        end(started);
        setProblem({
          text: microphoneFailureWords(opening.reason, source.app, i18n),
          setUp: false,
        });
      });
  };

  /** The operator is done speaking: the server has it written down. */
  const stop = (stopped: Session) => {
    if (current.current !== stopped) return;
    const now = stopped.handle.state.get();
    if (now._tag === "finishing" || isOver(now)) return;
    letMicrophoneGo();
    stopped.handle.finish();
  };

  const cancel = () => {
    const under = current.current;
    if (under !== null) end(under);
  };

  /** `words` where `heard`'s place is, the caret after them if it stood there. */
  const land = (heard: Session, words: string) => {
    const at = followTyping(heard.at, seen.current, value);
    const place = placeHeard({ text: value, ...at }, { committed: words, tentative: "" });
    const moved = followFieldEdit(
      {
        _tag: "change",
        before: value,
        after: place.text,
        over: at.start < at.end ? [at.start, at.end] : null,
        written: place.text.slice(place.from, place.committed),
        caret: place.committed,
      },
      mentions,
    );
    const [selStart, selEnd] = selection() ?? [value.length, value.length];
    // A caret still at the words' place goes after them; one elsewhere stays by its own text.
    const caret =
      selStart === at.start && selEnd === at.end
        ? { start: place.committed, end: place.committed }
        : followTyping({ start: selStart, end: selEnd }, value, place.text);
    pending.current = { text: place.text, ...caret };
    onValueChange(place.text, moved);
  };

  /** What the server says of `heard`: its end puts the words in the draft. */
  const told = useEffectEvent((heard: Session) => {
    if (current.current !== heard) return;
    const now = heard.handle.state.get();
    if (!isOver(now)) return;
    end(heard);
    if (now._tag === "failed") {
      setProblem({
        text: dictationFailureWords(now.reason, i18n),
        setUp: dictationFailureNeedsSetup(now.reason) && source?.setUp !== undefined,
      });
      return;
    }
    const words = now.text.trim();
    if (words === "") return;
    if (available) land(heard, words);
    else waiting.current = { session: heard, words };
  });
  useEffect(() => {
    if (session === null) return;
    // What it tells from now on, and where it stands already: it may have moved before this.
    const look = () => told(session);
    const unsubscribe = session.handle.state.subscribe(look);
    look();
    return unsubscribe;
  }, [session]);

  // Words that came while the draft took no change land once it does, unless it was left.
  const landWaiting = useEffectEvent(() => {
    const held = waiting.current;
    if (held === null) return;
    waiting.current = null;
    if (held.session.draft === draftKey) land(held.session, held.words);
  });
  useEffect(() => {
    if (available) landWaiting();
  }, [available]);

  /** The composer leaving `draft`, for another or for good: a dictation into it ends. */
  const left = useEffectEvent((draft: string) => {
    const under = current.current;
    if (under !== null && under.draft === draft) end(under);
    if (waiting.current?.session.draft === draft) waiting.current = null;
  });
  useEffect(() => () => left(draftKey), [draftKey]);

  // Dictation no longer offered, as in a window put away, cancels one under way.
  const offered = source !== undefined;
  const withdrawn = useEffectEvent(() => cancel());
  useEffect(() => {
    if (!offered) withdrawn();
  }, [offered]);

  // The caret goes where it was, moved along with the words, once the field shows them.
  useLayoutEffect(() => {
    const element = field.current;
    const after = pending.current;
    if (element === null || after === null || after.text !== value) return;
    pending.current = null;
    if (element.ownerDocument.activeElement === element) {
      selectInField(element, after.start, after.end);
    }
  }, [field, value]);

  const toggle = () => {
    if (current.current === null) start();
    else stop(current.current);
  };

  const phase: DictationPhase =
    state === null || isOver(state)
      ? "idle"
      : state._tag === "finishing"
        ? "finishing"
        : "recording";
  return {
    /** Whether this composer offers dictation at all. */
    offered: source !== undefined,
    phase,
    levels: levels.feed,
    /** Why the last press or dictation did not give words. */
    problem,
    shortcut,
    toggle,
    cancel,
    dismiss: () => setProblem(null),
    /** Opens Settings → Voice, where a problem marked `setUp` is fixed. */
    setUp: () => {
      setProblem(null);
      source?.setUp?.();
    },
    /** The operator edited the draft: what the last dictation said is behind them. */
    edited: () => setProblem(null),
    /** Handles a key in the composer; true when it took it. */
    onKeyDown: (event: KeyboardEvent<HTMLElement>): boolean => {
      if (source === undefined || event.defaultPrevented || event.nativeEvent.isComposing) {
        return false;
      }
      if (event.key === "Escape" && current.current !== null) {
        // Taken here, so the shell or quick access does not close as well.
        event.preventDefault();
        cancel();
        return true;
      }
      if (!shortcut.matches(event.nativeEvent)) return false;
      event.preventDefault();
      if (!event.repeat) toggle();
      return true;
    },
  };
}

/** Where a composer's dictation is: at rest, recording, or being written down. */
type DictationPhase = "idle" | "recording" | "finishing";

export type DictationView = ReturnType<typeof useDictation>;

/** How many bars the meter shows: the last 1.6 seconds, a tenth each. */
const BARS = 16;
/** The least a bar shows, so silence still reads as a meter. */
const REST = 0.12;
/** Each bar's place, oldest first: the bars never reorder, only their heights change. */
const BAR_PLACES = Array.from({ length: BARS }, (_, index) => `bar-${index}`);

/**
 * The voice's level as it records, as bars that scroll from the right: each
 * tenth of a second's level is drawn from `levels` outside React. It is
 * information, so it moves under reduced motion too; only its easing goes.
 */
function Waveform({ levels, label }: { levels: LevelFeed; label: string }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    const shown = Array.from({ length: BARS }, () => 0);
    return levels.subscribe((level) => {
      shown.shift();
      shown.push(level);
      bars.current.forEach((bar, index) => {
        if (bar !== null)
          bar.style.transform = `scaleY(${REST + (1 - REST) * (shown[index] ?? 0)})`;
      });
    });
  }, [levels]);
  return (
    <span role="img" aria-label={label} className="inline-flex h-4 items-center gap-0.5">
      {BAR_PLACES.map((place, index) => (
        <span
          key={place}
          ref={(bar) => {
            bars.current[index] = bar;
          }}
          className="h-full w-0.5 origin-center scale-y-[0.12] rounded-pill bg-current motion-safe:transition-transform motion-safe:duration-(--duration-fast)"
        />
      ))}
    </span>
  );
}

/** The time since it showed, as a clock shows it, written once a second outside React. */
function Elapsed() {
  const shown = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const startedAt = Date.now();
    const write = () => {
      if (shown.current !== null) shown.current.textContent = elapsedWords(Date.now() - startedAt);
    };
    write();
    const timer = setInterval(write, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span ref={shown} className="min-w-7 text-xs text-muted-foreground tabular-nums">
      {elapsedWords(0)}
    </span>
  );
}

/**
 * The composer's microphone. At rest it dictates. While it records it opens
 * into a capsule: Cancel, a red dot, the time, the voice's level, and Stop,
 * in the conversation's tint, which has it written down. While it is written
 * down, the capsule says so, with Cancel.
 */
export function DictationControl({
  dictation,
  unavailable,
}: {
  dictation: DictationView;
  /** The draft takes no change now, and no dictation can start. */
  unavailable: boolean;
}) {
  const { t } = useI18n();
  const { phase, shortcut } = dictation;
  // The field keeps the focus and its caret, where the words go.
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  if (phase === "idle") {
    return (
      <Button
        variant="ghost-muted"
        size="icon-pill"
        data-dictation="idle"
        onPointerDown={keepFocus}
        onClick={() => {
          if (!unavailable) dictation.toggle();
        }}
        aria-disabled={unavailable}
        aria-label={t("dictation.start")}
        aria-keyshortcuts={shortcut.aria}
        title={t("dictation.start.shortcut", { shortcut: shortcut.label })}
      >
        <MicIcon />
      </Button>
    );
  }
  const cancel = (
    <Button
      variant="ghost-muted"
      size="icon-sm"
      onPointerDown={keepFocus}
      onClick={dictation.cancel}
      aria-label={t("dictation.cancel")}
      title={t("dictation.cancel")}
      className="size-7"
    >
      <XIcon />
    </Button>
  );
  return (
    <span
      data-dictation={phase}
      className="appear flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-muted ps-0.5 pe-0.5"
    >
      {cancel}
      {phase === "recording" ? (
        <>
          <span role="status" className="sr-only">
            {t("dictation.listening")}
          </span>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-blocked" />
          <Elapsed />
          <span className="text-muted-foreground">
            <Waveform levels={dictation.levels} label={t("dictation.level")} />
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            data-dictation-stop=""
            onPointerDown={keepFocus}
            onClick={dictation.toggle}
            aria-label={t("dictation.stop")}
            aria-keyshortcuts={shortcut.aria}
            title={t("dictation.stop.shortcut", { shortcut: shortcut.label })}
            className="size-7 bg-(--tint) text-avatar-ink hover:bg-(--tint) hover:text-avatar-ink"
          >
            <CheckIcon />
          </Button>
        </>
      ) : (
        <span
          role="status"
          className="flex items-center gap-1.5 pe-2.5 text-xs text-muted-foreground"
        >
          <LoaderCircleIcon aria-hidden className="size-3.5 motion-safe:animate-spin" />
          {t("dictation.finishing")}
        </span>
      )}
    </span>
  );
}

/**
 * Why the last press or dictation gave no words, inside the composer over
 * the text: Set up when Settings → Voice fixes it, and a way to put it away.
 */
export function DictationNotice({ dictation }: { dictation: DictationView }) {
  const { t } = useI18n();
  const { problem } = dictation;
  return (
    <div role="alert" className="empty:hidden">
      {problem !== null && (
        <div className="appear flex items-start gap-2 ps-2.5 pe-1 pt-1 text-xs">
          <CircleAlertIcon aria-hidden className="mt-1.5 size-3.5 shrink-0 text-blocked" />
          <p className="me-auto py-1 text-foreground">{problem.text}</p>
          {problem.setUp && (
            <Button
              variant="secondary"
              size="sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={dictation.setUp}
              className="h-7 shrink-0"
            >
              {t("dictation.setUp")}
            </Button>
          )}
          <Button
            variant="ghost-muted"
            size="icon-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={dictation.dismiss}
            aria-label={t("dictation.dismiss")}
            title={t("dictation.dismiss")}
            className="size-7 shrink-0"
          >
            <XIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
