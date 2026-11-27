// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import {
  Cell,
  type DictationHandle,
  type DictationState,
  type DraftMention,
  type LoadedHandle,
} from "@j3-bots/client-runtime";
import type { VoiceSettings, VoiceStatus } from "@j3-bots/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useDictationSource } from "../live/dictation";
import { fieldSelection, selectInField } from "./ChipField";
import { Composer } from "./Composer";
import type { DictationReach, DictationSource, OpenMicrophone } from "./Dictation";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** What the composer asked of the draft, the server and the microphone. */
interface Told {
  readonly values: Array<string>;
  readonly sent: Array<true>;
  readonly dictations: Array<FakeDictation>;
  microphones: number;
  microphonesStopped: number;
}

/** A dictation on a server the test plays: its state is the test's to set. */
interface FakeDictation {
  readonly state: Cell<DictationState>;
  readonly finished: Array<{ text: string; start: number; end: number } | undefined>;
  cancelled: boolean;
}

let told: Told;

const dictate = (): DictationHandle => {
  const dictation: FakeDictation = {
    state: new Cell<DictationState>({ _tag: "connecting" }),
    finished: [],
    cancelled: false,
  };
  told.dictations.push(dictation);
  return {
    state: dictation.state,
    audio: () => {},
    finish: (draft) => {
      dictation.finished.push(draft);
      dictation.state.set({ _tag: "finishing", committed: "", tentative: "" });
    },
    cancel: () => {
      dictation.cancelled = true;
    },
  };
};

const microphone: OpenMicrophone = () => {
  told.microphones += 1;
  return Promise.resolve({
    _tag: "open",
    stop: () => {
      told.microphonesStopped += 1;
    },
  });
};

const source = (reach: DictationReach = { _tag: "server" }): DictationSource => ({
  reach,
  dictate,
  microphone,
  app: "browser",
});

/** A composer on a draft the test reads back, dictating with `dictation`. */
function Harness({
  initial,
  dictation,
}: {
  initial: string;
  dictation: DictationSource | undefined;
}) {
  const [value, setValue] = useState(initial);
  const [mentions, setMentions] = useState<ReadonlyArray<DraftMention>>([]);
  return (
    <Composer
      draftKey="draft"
      recipient="Wren"
      value={value}
      mentions={mentions}
      onValueChange={(text, picked) => {
        told.values.push(text);
        setValue(text);
        setMentions(picked);
      }}
      onSend={() => told.sent.push(true)}
      dictation={dictation}
    />
  );
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  told = { values: [], sent: [], dictations: [], microphones: 0, microphonesStopped: 0 };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const field = () => {
  const found = container.querySelector<HTMLElement>("[data-composer]");
  if (found === null) throw new Error("No composer field");
  return found;
};
const microphoneButton = () => container.querySelector<HTMLElement>("[data-dictation]");
const alert = () => container.querySelector("[role=alert]")?.textContent ?? "";
const playing = () => {
  const dictation = told.dictations.at(-1);
  if (dictation === undefined) throw new Error("Nothing dictates");
  return dictation;
};

/** The composer on `initial`, with the caret at `caret` as the operator left it. */
const render = (initial: string, caret: number, dictation = source()) => {
  act(() => root.render(<Harness initial={initial} dictation={dictation} />));
  act(() => {
    field().focus();
    selectInField(field(), caret);
    // A key the field takes remembers where the operator left the caret.
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
  });
};
const press = async () => {
  await act(async () => {
    microphoneButton()?.click();
  });
};
const hear = (state: DictationState) => act(() => playing().state.set(state));

describe("dictation in the composer", () => {
  it("shows the settled words in the text's color and the open ones lighter, at the caret, and sends nothing", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening", live: true, committed: "book the venue", tentative: "for Friday" });

    expect(field().textContent).toBe("Dear Ana, book the venue for Friday thanks.");
    const open = field().querySelector("[data-run]");
    expect(open?.getAttribute("data-run")).toBe("for Friday");
    expect(open?.querySelector(".text-muted-foreground")?.textContent).toBe("for Friday");
    // The draft takes the words only once dictation ends, and nothing goes.
    expect(told.values).toEqual([]);
    expect(told.sent).toEqual([]);
  });

  it("on Stop, sends the draft and where the words go, then puts the final words in with the caret after them", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening", live: true, committed: "book the venue", tentative: "for Friday" });
    await press();

    expect(playing().finished).toEqual([{ text: "Dear Ana, thanks.", start: 9, end: 9 }]);
    expect(told.microphonesStopped).toBe(1);

    hear({ _tag: "done", text: "Book the venue for Friday," });

    expect(told.values).toEqual(["Dear Ana, Book the venue for Friday, thanks."]);
    expect(field().textContent).toBe("Dear Ana, Book the venue for Friday, thanks.");
    expect(fieldSelection(field())).toEqual([36, 36]);
    expect(playing().cancelled).toBe(true);
    expect(told.sent).toEqual([]);
  });

  it("on Escape, cancels the dictation and leaves the draft exactly as it was", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening", live: true, committed: "book the venue", tentative: "for" });
    act(() => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(playing().cancelled).toBe(true);
    expect(told.microphonesStopped).toBe(1);
    expect(field().textContent).toBe("Dear Ana, thanks.");
    expect(fieldSelection(field())).toEqual([9, 9]);
    expect(told.values).toEqual([]);
  });

  it("cancels a dictation and lets the microphone go once dictation is no longer offered, as in a window put away", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening", live: true, committed: "book the venue", tentative: "for" });
    act(() => root.render(<Harness initial="Dear Ana, thanks." dictation={undefined} />));

    expect(playing().cancelled).toBe(true);
    expect(told.microphonesStopped).toBe(1);
    expect(told.values).toEqual([]);
  });

  it("keeps the words already settled when dictation fails, and says why", async () => {
    render("", 0);
    await press();
    hear({ _tag: "listening", live: true, committed: "Call the bank", tentative: "tomor" });
    hear({ _tag: "failed", reason: "busy" });

    expect(told.values).toEqual(["Call the bank"]);
    expect(alert()).toBe("Someone is dictating on another device. Try again once they’re done.");
    expect(told.microphonesStopped).toBe(1);
  });

  it("on a page served over plain http, explains how to dictate and records nothing", async () => {
    render("", 0, source({ _tag: "blocked", block: "insecure-page" }));
    await press();

    expect(alert()).toContain(
      "Use the desktop app or the Android app, or open J3 Bots at an https address.",
    );
    expect(told.dictations).toEqual([]);
    expect(told.microphones).toBe(0);
  });
});

describe("dictation's source", () => {
  const voiceSettings: VoiceSettings = {
    place: "automatic",
    language: "auto",
    words: [],
    removeFillers: true,
    cleanUp: false,
    model: null,
    openRouterModel: null,
  };

  /** The composer with dictation as a server's `settings` offer it, telling each status held. */
  function FromServer({ settings, held }: { settings: VoiceSettings | null; held: Array<true> }) {
    const [voice] = useState(() => ({
      openStatus: (): LoadedHandle<VoiceStatus> => {
        held.push(true);
        return { state: new Cell({ _tag: "loading" }), release: () => {} };
      },
      dictate,
    }));
    const dictation = useDictationSource({ voice, settings, microphone, app: "browser" });
    return <Harness initial="" dictation={dictation} />;
  }

  it("offers no microphone from a server older than dictation, and asks it nothing", () => {
    const held: Array<true> = [];
    act(() => root.render(<FromServer settings={null} held={held} />));

    expect(microphoneButton()).toBeNull();
    expect(held).toEqual([]);
  });

  it("offers the microphone from a server that dictates", () => {
    const held: Array<true> = [];
    act(() => root.render(<FromServer settings={voiceSettings} held={held} />));

    expect(microphoneButton()).not.toBeNull();
    expect(held).toEqual([true]);
  });
});
