// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserCursor,
  type BrowserProbe,
  type BrowserViewHandle,
  type BrowserViewState,
  Cell,
  type Loaded,
} from "@j3-bots/client-runtime";
import {
  type BotId,
  type BrowserController,
  type BrowserInput,
  type BrowserTab,
  BrowserTabRef,
} from "@j3-bots/contracts";
import type { BrowserSource } from "../browser/source";

/** The sample page's size in CSS pixels. */
const PAGE = { width: 1280, height: 800 } as const;
/** How long the sample waits after an acknowledgement before it sends the next picture. */
const PICTURE_EVERY = 800;
/** How often the sample bot moves its pointer while it holds the tab. */
const CURSOR_EVERY = 1_400;

interface SampleTab {
  readonly tab: Cell<BrowserTab>;
  /** What the operator typed into the page's search field. */
  typed: string;
  /** The row the bot looks at, which moves as it reads. */
  row: number;
}

const rowsOf = ["Trail runner 2, size 42", "Trail runner 2, size 43", "Trail runner 3, size 42"];

/** The sample page, drawn as the browser would show it, as a JPEG at `scale`. */
const drawPage = async (
  sample: SampleTab,
  scale: number,
  quality: number,
): Promise<Uint8Array | null> => {
  if (typeof OffscreenCanvas === "undefined") return null;
  const width = Math.round(PAGE.width * scale);
  const height = Math.round(PAGE.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PAGE.width, PAGE.height);
  context.fillStyle = "#1f2a44";
  context.fillRect(0, 0, PAGE.width, 72);
  context.fillStyle = "#ffffff";
  context.font = "600 26px sans-serif";
  context.fillText("Trailhead Outfitters", 40, 46);
  // The search field the operator can type into once they take control.
  context.fillStyle = "#f1f3f6";
  context.fillRect(40, 104, 720, 52);
  context.fillStyle = sample.typed === "" ? "#8a93a3" : "#141821";
  context.font = "20px sans-serif";
  context.fillText(sample.typed === "" ? "Search the shop" : sample.typed, 60, 137);
  context.font = "22px sans-serif";
  rowsOf.forEach((label, index) => {
    const top = 196 + index * 96;
    context.fillStyle = index === sample.row ? "#e8f0ff" : "#f7f8fa";
    context.fillRect(40, top, 1200, 76);
    context.fillStyle = "#141821";
    context.fillText(label, 64, top + 46);
    context.fillStyle = index === 1 ? "#b42318" : "#067647";
    context.fillText(index === 1 ? "Out of stock" : "In stock", 1000, top + 46);
  });
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
};

/**
 * Development's and the gallery's stand-in for the server's browser: each bot
 * in `botIds` has one tab on a sample shop. The sample bot reads it, moving
 * its pointer over the rows, until the operator takes control; then what
 * they type shows in the page's search field.
 */
export function sampleBrowser(botIds: ReadonlyArray<BotId>): BrowserSource {
  const tabs = new Map<BotId, SampleTab>(
    botIds.map((botId) => [
      botId,
      {
        tab: new Cell<BrowserTab>({
          ref: BrowserTabRef.make(`tab_sample_${botId}`),
          botId,
          url: "https://www.trailhead.example/search?q=trail+runner",
          title: "Trail runner – Trailhead Outfitters",
          loading: false,
          controller: "bot",
          front: true,
        }),
        typed: "",
        row: 0,
      },
    ]),
  );
  const byRef = (ref: BrowserTabRef) =>
    [...tabs.values()].find((sample) => sample.tab.get().ref === ref) ?? null;
  const setController = (sample: SampleTab, controller: BrowserController) =>
    sample.tab.update((tab) => ({ ...tab, controller }));

  return {
    openBrowserTabs: (botId) => {
      const sample = tabs.get(botId);
      const state = new Cell<Loaded<ReadonlyArray<BrowserTab>>>({
        _tag: "ready",
        value: sample === undefined ? [] : [sample.tab.get()],
        stale: false,
      });
      const stop =
        sample === undefined
          ? () => {}
          : sample.tab.subscribe(() =>
              state.set({ _tag: "ready", value: [sample.tab.get()], stale: false }),
            );
      return { state, release: stop };
    },
    openBrowserView: ({ ref, size }): BrowserViewHandle => {
      const sample = byRef(ref);
      const state = new Cell<BrowserViewState>({
        status: { _tag: "connecting" },
        viewport: null,
        control: null,
      });
      const picture = new Cell<{ readonly jpeg: Uint8Array; readonly sequence: number } | null>(
        null,
      );
      const probe = new Cell<BrowserProbe | null>(null);
      const cursor = new Cell<BrowserCursor | null>(null);
      const timers = new Set<number>();
      let stopTab = () => {};
      let closed = false;
      let sequence = 0;
      let generation = 1;
      const later = (run: () => void, ms: number) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (!closed) run();
        }, ms);
        timers.add(timer);
      };
      if (sample === null) {
        later(() => state.set({ ...state.get(), status: { _tag: "gone" } }), 0);
        return handle();
      }
      const asked = size();
      const scale = Math.min(
        (asked.maxWidth ?? PAGE.width) / PAGE.width,
        (asked.maxHeight ?? PAGE.height) / PAGE.height,
        1,
      );
      const controllerHere = (): BrowserController => sample.tab.get().controller;
      const showControl = () =>
        state.set({
          status: { _tag: "live" },
          viewport: PAGE,
          control: { controller: controllerHere(), generation, dialog: null },
        });
      stopTab = sample.tab.subscribe(showControl);
      const sendPicture = () =>
        void drawPage(sample, scale, asked.quality ?? 70).then((jpeg) => {
          if (closed || jpeg === null) return;
          sequence += 1;
          picture.set({ jpeg, sequence });
        });
      later(() => {
        showControl();
        sendPicture();
      }, 300);
      // The bot reads the rows one after another while it holds the tab.
      const read = () => {
        if (controllerHere() === "bot") {
          sample.row = (sample.row + 1) % rowsOf.length;
          cursor.set({
            action: sample.row === 2 ? "click" : "move",
            x: 400 + sample.row * 60,
            y: 234 + sample.row * 96,
            sequence: (cursor.get()?.sequence ?? 0) + 1,
          });
        }
        later(read, CURSOR_EVERY);
      };
      later(read, CURSOR_EVERY);

      function handle(): BrowserViewHandle {
        const each =
          <A>(readable: Cell<A | null>) =>
          (listener: (value: A) => void) =>
            readable.subscribe(() => {
              const value = readable.get();
              if (value !== null) listener(value);
            });
        return {
          state,
          picture,
          probe,
          cursor,
          onProbe: each(probe),
          onCursor: each(cursor),
          ack: (acked) => {
            if (acked === sequence) later(sendPicture, PICTURE_EVERY);
          },
          send: (input: BrowserInput) => {
            if (sample === null) return;
            switch (input.type) {
              case "take":
                generation += 1;
                setController(sample, "you");
                return;
              case "release":
                generation += 1;
                setController(sample, "bot");
                return;
              case "text":
                sample.typed += input.text;
                return;
              case "key":
                if (input.action === "down" && input.key === "Backspace") {
                  sample.typed = sample.typed.slice(0, -1);
                }
                return;
              case "probe":
                probe.set({
                  x: input.x,
                  y: input.y,
                  editable: input.y >= 104 && input.y <= 156,
                  sequence: (probe.get()?.sequence ?? 0) + 1,
                });
                return;
              default:
                return;
            }
          },
          close: () => {
            closed = true;
            stopTab();
            for (const timer of timers) window.clearTimeout(timer);
          },
        };
      }
      return handle();
    },
  };
}
