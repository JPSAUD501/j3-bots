// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import {
  Cell,
  type DictationHandle,
  type DictationState,
  type DraftMention,
  type LoadedHandle,
} from "@j3-bots/client-runtime";
import type { CloudVoiceKeys, VoiceSettings } from "@j3-bots/contracts";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { createTestRoot } from "../app/testRoot";
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
  setUps: number;
  /** Changes the draft as another tab or the operator's typing would. */
  edit: (text: string) => void;
}

/** A dictation on a server the test plays: its state is the test's to set. */
interface FakeDictation {
  readonly state: Cell<DictationState>;
  finished: number;
  cancelled: boolean;
}

let told: Told;

const dictate = (): DictationHandle => {
  const dictation: FakeDictation = {
    state: new Cell<DictationState>({ _tag: "connecting" }),
    finished: 0,
    cancelled: false,
  };
  told.dictations.push(dictation);
  return {
    state: dictation.state,
    audio: () => {},
    finish: () => {
      dictation.finished += 1;
      dictation.state.set({ _tag: "finishing" });
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

const source = (
  reach: DictationReach = { _tag: "server" },
  settingsAtHand = true,
): DictationSource => ({
  reach,
  dictate,
  microphone,
  app: "browser",
  setUp: settingsAtHand
    ? () => {
        told.setUps += 1;
      }
    : undefined,
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
  useEffect(() => {
    told.edit = setValue;
  }, []);
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
  root = createTestRoot(container);
  told = {
    values: [],
    sent: [],
    dictations: [],
    microphones: 0,
    microphonesStopped: 0,
    setUps: 0,
    edit: () => {},
  };
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
const microphoneButton = () => container.querySelector<HTMLElement>("[data-dictation=idle]");
const stopButton = () => container.querySelector<HTMLElement>("[data-dictation-stop]");
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
const stop = () => act(() => stopButton()?.click());
const button = (name: string) =>
  [...container.querySelectorAll<HTMLElement>("button")].find((one) => one.textContent === name);
const hear = (state: DictationState) => act(() => playing().state.set(state));

describe("dictation in the composer", () => {
  it("records inside the composer, leaves the field open to typing, and sends nothing", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening" });

    expect(container.querySelector("[data-dictation=recording]")).not.toBeNull();
    expect(stopButton()).not.toBeNull();
    expect(field().hasAttribute("aria-readonly")).toBe(false);
    expect(told.values).toEqual([]);
    expect(told.sent).toEqual([]);
  });

  it("on Stop, has it written down in place, then puts the words where the caret was, the caret after them", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening" });
    stop();

    expect(playing().finished).toBe(1);
    expect(told.microphonesStopped).toBe(1);
    expect(container.querySelector("[data-dictation=finishing]")?.textContent).toContain(
      "Writing it down…",
    );

    hear({ _tag: "done", text: "Book the venue for Friday," });

    expect(told.values).toEqual(["Dear Ana, Book the venue for Friday, thanks."]);
    expect(fieldSelection(field())).toEqual([36, 36]);
    expect(playing().cancelled).toBe(true);
    expect(told.sent).toEqual([]);
  });

  it("puts the words where the caret was, moved along with what was typed meanwhile", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening" });
    act(() => told.edit("Hi! Dear Ana, thanks."));
    act(() => told.edit("Hi! Dear Ana, thanks. Bye"));
    stop();
    hear({ _tag: "done", text: "book the venue" });

    expect(told.values).toEqual(["Hi! Dear Ana, book the venue thanks. Bye"]);
  });

  it("on Escape, cancels the dictation and leaves the draft as it was", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening" });
    act(() => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(playing().cancelled).toBe(true);
    expect(told.microphonesStopped).toBe(1);
    expect(microphoneButton()).not.toBeNull();
    expect(told.values).toEqual([]);
  });

  it("cancels a dictation and lets the microphone go once dictation is no longer offered, as in a window put away", async () => {
    render("Dear Ana, thanks.", 9);
    await press();
    hear({ _tag: "listening" });
    act(() => root.render(<Harness initial="Dear Ana, thanks." dictation={undefined} />));

    expect(playing().cancelled).toBe(true);
    expect(told.microphonesStopped).toBe(1);
    expect(told.values).toEqual([]);
  });

  it("says inside the composer why the service gave no words, with Set up when Settings fixes it", async () => {
    render("", 0);
    await press();
    hear({ _tag: "listening" });
    hear({ _tag: "failed", reason: "cloud-refused" });

    expect(alert()).toContain("The dictation service didn’t accept your key.");
    expect(told.microphonesStopped).toBe(1);
    expect(told.values).toEqual([]);
    act(() => button("Set up")?.click());
    expect(told.setUps).toBe(1);
    expect(alert()).toBe("");
  });

  it("opens Settings → Voice on a press before set-up, and says what it needs where Settings is not at hand", async () => {
    render("", 0, source({ _tag: "blocked", block: "setup" }));
    await press();
    expect(told.setUps).toBe(1);
    expect(alert()).toBe("");

    render("", 0, source({ _tag: "blocked", block: "setup" }, false));
    await press();
    expect(alert()).toContain("To dictate, choose a dictation service and add its key.");
    expect(told.dictations).toEqual([]);
    expect(told.microphones).toBe(0);
  });

  it("on a page served over plain http, explains how to dictate and records nothing", async () => {
    render("", 0, source({ _tag: "blocked", block: "insecure-page" }));
    await press();

    expect(alert()).toContain(
      "Use the desktop or Android app, or open J3 Bots at an https address.",
    );
    expect(told.dictations).toEqual([]);
    expect(told.microphones).toBe(0);
  });
});

describe("dictation's source", () => {
  const voiceSettings: VoiceSettings = {
    place: "automatic",
    provider: "openai",
    language: "auto",
    words: [],
    removeFillers: true,
    cleanUp: false,
    model: null,
    openRouterModel: null,
  };

  /** The composer with dictation as a server's `settings` offer it, telling each key list held. */
  function FromServer({ settings, held }: { settings: VoiceSettings | null; held: Array<true> }) {
    const [voice] = useState(() => ({
      openCloudKeys: (): LoadedHandle<CloudVoiceKeys> => {
        held.push(true);
        return { state: new Cell({ _tag: "loading" }), release: () => {} };
      },
      dictate,
    }));
    const dictation = useDictationSource({ voice, settings, microphone, app: "browser" });
    return <Harness initial="" dictation={dictation} />;
  }

  it("offers no microphone from a server older than dictation through a service, and asks it nothing", () => {
    const held: Array<true> = [];
    const { provider: _, ...older } = voiceSettings;
    act(() => root.render(<FromServer settings={null} held={held} />));
    expect(microphoneButton()).toBeNull();
    act(() => root.render(<FromServer settings={older} held={held} />));
    expect(microphoneButton()).toBeNull();
    expect(held).toEqual([]);
  });

  it("offers the microphone from a server that dictates through a service, and follows its keys", () => {
    const held: Array<true> = [];
    act(() => root.render(<FromServer settings={voiceSettings} held={held} />));

    expect(microphoneButton()).not.toBeNull();
    expect(held).toEqual([true]);
  });
});
