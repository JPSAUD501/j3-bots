// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  DictationHandle,
  DictationState,
  DraftMention,
  HeardWords,
} from "@j3-bots/client-runtime";
import {
  type DictationPath,
  followFieldEdit,
  levelOf,
  placeHeard,
} from "@j3-bots/client-runtime/presentation";
import {
  dictationBlockWords,
  dictationFailureWords,
  dictationStateWords,
} from "@j3-bots/client-runtime/wording";
import { MAX_VOICE_DRAFT_LENGTH } from "@j3-bots/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import {
  type CSSProperties,
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
import { cn } from "../lib/cn";
import { shellShortcuts } from "../shell/shortcuts";
import { selectInField } from "./ChipField";
import { Button } from "./ui/button";

// Dictation in the composer (decision 0096): the microphone records, the
// server turns the recording into words, and the words land where the caret
// was. The operator reads them, fixes them and sends them: nothing is sent by
// itself.

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
}

/** The draft as dictation found it, and where its words go: `start` to `end`. */
interface Into {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  readonly start: number;
  readonly end: number;
}

interface Session {
  readonly handle: DictationHandle;
  /** The draft it dictates into. */
  readonly draft: string;
  readonly into: Into;
}

/** What the field shows while dictation runs. */
interface Preview {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  /** The words still open to change, drawn lighter; null when there are none. */
  readonly open: { readonly at: number; readonly text: string } | null;
  /** Where the caret stands: after the heard words. */
  readonly caret: number;
}

/**
 * Where the words go in the draft as it is now: where the caret was, when the
 * draft is still what dictation found; after it, when another tab changed it
 * meanwhile, since the caret then stood in other text.
 */
const intoNow = (into: Into, value: string, mentions: ReadonlyArray<DraftMention>): Into =>
  value === into.text ? into : { text: value, mentions, start: value.length, end: value.length };

/** The draft with `heard` in place, and the mentions moved along with the text after it. */
const placed = (into: Into, heard: HeardWords) => {
  const place = placeHeard(into, heard);
  const mentions = followFieldEdit(
    {
      _tag: "change",
      before: into.text,
      after: place.text,
      over: into.start < into.end ? [into.start, into.end] : null,
      written: place.text.slice(place.from, place.tentative),
      caret: place.tentative,
    },
    into.mentions,
  );
  return { ...place, mentions };
};

/** The draft with the words heard so far in place, as the field shows it while dictation runs. */
const previewOf = (into: Into, heard: HeardWords): Preview => {
  const place = placed(into, heard);
  // The open words start at the first of them, past the space that parts them from the settled.
  let at = place.committed;
  while (place.text[at] === " " && at < place.tentative) at += 1;
  return {
    text: place.text,
    mentions: place.mentions,
    open: at < place.tentative ? { at, text: place.text.slice(at, place.tentative) } : null,
    caret: place.tentative,
  };
};

/**
 * The draft the AI's tidy-up reads the words in: all of it, or, past what a
 * `finish` frame carries, as much as fits around where the words go.
 */
const draftAround = ({ text, start, end }: Into) => {
  if (text.length <= MAX_VOICE_DRAFT_LENGTH) return { text, start, end };
  const room = Math.max(0, MAX_VOICE_DRAFT_LENGTH - (end - start));
  const from = Math.min(
    Math.max(0, start - Math.floor(room / 2)),
    text.length - MAX_VOICE_DRAFT_LENGTH,
  );
  const to = from + MAX_VOICE_DRAFT_LENGTH;
  return { text: text.slice(from, to), start: start - from, end: Math.min(end, to) - from };
};

/** A piece of the recording as the voice socket takes it: 32-bit floats, little-endian. */
const littleEndian = (samples: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, sample] of samples.entries()) view.setFloat32(index * 4, sample, true);
  return bytes;
};

const isOver = (state: DictationState) => state._tag === "done" || state._tag === "failed";

const noState = () => null;
const noChange = () => () => {};

/**
 * Dictation in one composer. A press starts it where the caret is; while it
 * runs, the field shows the draft with the heard words in place, the settled
 * ones in the text's own color and those still open to change lighter, and
 * takes no edit. A second press stops it: once the server has the last words,
 * they replace the heard ones in the draft and the caret goes after them.
 * Escape cancels: the draft is as it was, its selection too. A dictation that
 * fails keeps the words already settled and says why under the composer; one
 * that hears nothing leaves the draft as it was. The microphone records from
 * the press until it stops, is cancelled, fails or the composer goes, and the
 * draft takes the words only as it ends, so another tab never sees them half
 * heard. Where dictation cannot run, a press says why and records nothing.
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
  /** Whether the draft takes a change now: a dictation starts only then. */
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
  // The words the session under way last settled, which a failure keeps.
  const settled = useRef("");
  // Where the selection goes once the field shows `text`.
  const pending = useRef<{ readonly text: string; readonly start: number; readonly end: number }>(
    null,
  );
  const [level, setLevel] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
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

  const letMicrophoneGo = () => {
    microphone.current?.();
    microphone.current = null;
    setLevel(0);
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
      setProblem(dictationBlockWords(source.reach.block, i18n));
      return;
    }
    const [from, to] = selection() ?? [value.length, value.length];
    const handle = source.dictate();
    const started: Session = {
      handle,
      draft: draftKey,
      into: { text: value, mentions, start: from, end: to },
    };
    current.current = started;
    settled.current = "";
    pending.current = null;
    setSession(started);
    void source
      .microphone({
        samples: (samples) => {
          if (current.current !== started) return;
          setLevel(levelOf(samples));
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
        setProblem(
          opening.reason === "denied"
            ? i18n.t(
                source.app === "desktop" ? "dictation.denied.desktop" : "dictation.denied.browser",
              )
            : i18n.t(
                opening.reason === "no-microphone"
                  ? "dictation.noMicrophone"
                  : "dictation.microphoneFailed",
              ),
        );
      });
  };

  /** The operator is done speaking: the server works out the last words. */
  const stop = (stopped: Session) => {
    if (current.current !== stopped) return;
    const now = stopped.handle.state.get();
    if (now._tag === "finishing" || now._tag === "tidying" || isOver(now)) return;
    letMicrophoneGo();
    stopped.handle.finish(draftAround(stopped.into));
  };

  const cancel = () => {
    const under = current.current;
    if (under === null) return;
    end(under);
    pending.current = { text: value, start: under.into.start, end: under.into.end };
  };

  /** What the server says of `heard`: the words it settles, and its end, which puts them in the draft. */
  const told = useEffectEvent((heard: Session) => {
    if (current.current !== heard) return;
    const now = heard.handle.state.get();
    if ("committed" in now) settled.current = now.committed;
    if (!isOver(now)) return;
    const into = intoNow(heard.into, value, mentions);
    const words = now._tag === "done" ? now.text : settled.current;
    end(heard);
    if (now._tag === "failed") setProblem(dictationFailureWords(now.reason, i18n));
    if (words.trim() === "") {
      pending.current = { text: into.text, start: into.start, end: into.end };
      return;
    }
    const final = placed(into, { committed: words, tentative: "" });
    pending.current = { text: final.text, start: final.committed, end: final.committed };
    onValueChange(final.text, final.mentions);
  });
  useEffect(() => {
    if (session === null) return;
    // What it tells from now on, and where it stands already: it may have moved before this.
    const look = () => told(session);
    const unsubscribe = session.handle.state.subscribe(look);
    look();
    return unsubscribe;
  }, [session]);

  /** The composer leaving `draft`, for another or for good: a dictation into it ends. */
  const left = useEffectEvent((draft: string) => {
    const under = current.current;
    if (under !== null && under.draft === draft) end(under);
  });
  useEffect(() => () => left(draftKey), [draftKey]);

  const heard: HeardWords | null =
    state !== null && "committed" in state
      ? { committed: state.committed, tentative: state.tentative }
      : null;
  const preview =
    session === null
      ? null
      : previewOf(
          intoNow(session.into, value, mentions),
          heard ?? { committed: "", tentative: "" },
        );

  // The caret stays after the heard words while they come, and goes where dictation left it once over.
  const shown = preview?.text ?? value;
  const caret = preview?.caret ?? null;
  useLayoutEffect(() => {
    const element = field.current;
    if (element === null || element.ownerDocument.activeElement !== element) return;
    if (caret !== null) {
      selectInField(element, caret);
      return;
    }
    const after = pending.current;
    if (after === null || after.text !== shown) return;
    pending.current = null;
    selectInField(element, after.start, after.end);
  }, [field, shown, caret]);

  const toggle = () => {
    if (current.current === null) start();
    else stop(current.current);
  };

  const recording =
    state?._tag === "connecting" || state?._tag === "installing" || state?._tag === "listening";
  return {
    /** Whether this composer offers dictation at all. */
    offered: source !== undefined,
    /** A dictation is under way: the draft takes no edit. */
    running: session !== null,
    /** Recording: a press stops it. */
    recording,
    preview,
    level: state?._tag === "listening" ? level : 0,
    /** What dictation is doing, while that is not plain from the words arriving. */
    status:
      state === null || isOver(state) || (state._tag === "listening" && state.live)
        ? null
        : dictationStateWords(state, i18n),
    /** Why the last press or dictation did not give words. */
    problem,
    shortcut,
    toggle,
    cancel,
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

export type DictationView = ReturnType<typeof useDictation>;

/**
 * The composer's microphone. At rest it dictates; while it records it stops,
 * filled in the conversation's tint, with a ring that swells with what the
 * microphone hears; while the server works out the last words it takes no
 * press.
 */
export function DictationButton({
  dictation,
  unavailable,
}: {
  dictation: DictationView;
  /** The draft takes no change now, and no dictation can start. */
  unavailable: boolean;
}) {
  const { t } = useI18n();
  const { running, recording, shortcut } = dictation;
  const label = recording ? t("dictation.stop") : t("dictation.start");
  return (
    <Button
      variant="ghost-muted"
      size="icon-pill"
      data-dictation={recording ? "recording" : running ? "working" : "idle"}
      // The field keeps the focus and its caret, where the words go.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (recording || (!running && !unavailable)) dictation.toggle();
      }}
      aria-disabled={(running && !recording) || (!running && unavailable)}
      aria-label={label}
      aria-keyshortcuts={shortcut.aria}
      title={
        recording
          ? t("dictation.stop.shortcut", { shortcut: shortcut.label })
          : t("dictation.start.shortcut", { shortcut: shortcut.label })
      }
      className={cn(
        "relative isolate",
        running && "bg-(--tint) text-avatar-ink hover:bg-(--tint) hover:text-avatar-ink",
      )}
    >
      {running && (
        <span
          aria-hidden
          style={{ "--level": dictation.level } as CSSProperties}
          className="absolute -inset-1 -z-10 rounded-full bg-(--tint) opacity-[calc(0.2+var(--level)*0.4)] transition-[opacity,scale] duration-(--duration-fast) ease-out motion-safe:scale-[calc(0.8+var(--level)*0.35)]"
        />
      )}
      {running ? <SquareIcon className="size-3 fill-current" /> : <MicIcon />}
    </Button>
  );
}
