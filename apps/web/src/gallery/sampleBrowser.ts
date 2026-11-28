// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserCursor,
  type BrowserProbe,
  type BrowserViewHandle,
  type BrowserViewState,
  Cell,
  type Loaded,
} from "@j3-bots/client-runtime";
import { usesPage } from "@j3-bots/client-runtime/presentation";
import {
  type BotId,
  BROWSER_PERSON_HOLD_MS,
  type BrowserController,
  type BrowserInput,
  type BrowserTab,
  type BrowserTabHolder,
  BrowserTabRef,
  DeviceId,
  type SharedBrowserTab,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import type { BrowserSource } from "../browser/source";

/** The sample page's size in CSS pixels. */
const PAGE = { width: 1280, height: 800 } as const;
/** How long the sample waits after an acknowledgement before it sends the next picture. */
const PICTURE_EVERY = 800;
/** How often the sample bot moves its pointer while it holds the tab. */
const CURSOR_EVERY = 1_400;

interface SampleTab {
  readonly ref: BrowserTabRef;
  /** The bot on the tab; null on one the person opened. */
  readonly botId: BotId | null;
  url: string;
  title: string;
  /** Who controls it, on a server from before shared tabs. */
  controller: BrowserController;
  /** The person asked the tab's bots to wait for them, on a sharing server. */
  waiting: boolean;
  /** When the person last used the page, on a sharing server. */
  lastInputAt: number | null;
  /** What the operator typed into the page's search field. */
  typed: string;
  /** The row the bot looks at, which moves as it reads. */
  row: number;
}

const shopTab = (ref: BrowserTabRef, botId: BotId | null): SampleTab => ({
  ref,
  botId,
  url: "https://www.trailhead.example/search?q=trail+runner",
  title: "Trail runner – Trailhead Outfitters",
  controller: "bot",
  waiting: false,
  lastInputAt: null,
  typed: "",
  row: 0,
});

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
  // A tab the person opened with no address is a blank page.
  if (sample.url === "") return encoded(canvas, quality);
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
  return encoded(canvas, quality);
};

const encoded = async (canvas: OffscreenCanvas, quality: number): Promise<Uint8Array> => {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
};

/** The device the gallery's sharing sample takes itself to be. */
const SAMPLE_DEVICE = DeviceId.make("sample-device");

/**
 * Development's and the gallery's stand-in for the server's browser. Each
 * bot in `botIds` has a tab on a sample shop, which it reads, moving its
 * pointer over the rows, until the person uses the page; then what they type
 * shows in the page's search field. With `shared`, it is a server that
 * shares its tabs: every tab is listed, the first bot has a second one, and
 * the person opens and closes tabs; without, one from before, where a tab is
 * taken and given back.
 */
export function sampleBrowser(
  botIds: ReadonlyArray<BotId>,
  { shared = false }: { readonly shared?: boolean } = {},
): BrowserSource {
  const samples = new Map<BrowserTabRef, SampleTab>();
  const add = (sample: SampleTab) => samples.set(sample.ref, sample);
  for (const botId of botIds) add(shopTab(BrowserTabRef.make(`tab_sample_${botId}`), botId));
  const [first] = botIds;
  if (shared && first !== undefined) {
    add({
      ...shopTab(BrowserTabRef.make(`tab_sample_${first}_2`), first),
      url: "https://www.trailhead.example/delivery",
      title: "Delivery – Trailhead Outfitters",
      row: 1,
    });
  }
  // Anything that changes a tab ticks this, which every list and view reads.
  const changed = new Cell(0);
  const change = () => changed.update((n) => n + 1);
  let opened = 0;

  const heldBy = (sample: SampleTab): BrowserTabHolder | null => {
    if (sample.waiting) return { kind: "person", device: SAMPLE_DEVICE, until: null };
    if (sample.lastInputAt === null || Date.now() >= sample.lastInputAt + BROWSER_PERSON_HOLD_MS) {
      return null;
    }
    return {
      kind: "person",
      device: SAMPLE_DEVICE,
      until: DateTime.makeUnsafe(sample.lastInputAt + BROWSER_PERSON_HOLD_MS),
    };
  };
  const held = (sample: SampleTab) =>
    shared ? heldBy(sample) !== null : sample.controller !== "bot";
  const sharedTab = (sample: SampleTab): SharedBrowserTab => ({
    ref: sample.ref,
    url: sample.url,
    title: sample.title,
    loading: false,
    where: { kind: "server" },
    openedBy:
      sample.botId === null
        ? { kind: "person", device: SAMPLE_DEVICE }
        : { kind: "bot", botId: sample.botId },
    onIt: sample.botId === null ? [] : [sample.botId],
    acting: sample.botId !== null && !held(sample) ? sample.botId : null,
    heldBy: heldBy(sample),
    dialog: null,
    private: false,
  });
  const botTab = (sample: SampleTab, botId: BotId, front: boolean): BrowserTab => ({
    ref: sample.ref,
    botId,
    url: sample.url,
    title: sample.title,
    loading: false,
    controller: sample.controller,
    front,
  });
  const botTabs = (botId: BotId): ReadonlyArray<BrowserTab> => {
    const own = [...samples.values()].filter((sample) => sample.botId === botId);
    return own.map((sample, index) => botTab(sample, botId, index === own.length - 1));
  };
  /** A list that reads the samples again on every change, until released. */
  const listOf = <A>(read: () => ReadonlyArray<A>) => {
    const state = new Cell<Loaded<ReadonlyArray<A>>>({
      _tag: "ready",
      value: read(),
      stale: false,
    });
    const stop = changed.subscribe(() => state.set({ _tag: "ready", value: read(), stale: false }));
    return { state, release: stop };
  };

  return {
    pairing: new Cell<DeviceId | null>(shared ? SAMPLE_DEVICE : null),
    sharedBrowser: new Cell(shared),
    openBrowserTabs: (botId) => listOf(() => botTabs(botId)),
    openAllBrowserTabs: () => listOf(() => [...samples.values()].map(sharedTab)),
    openBrowserTab: (url) => {
      opened += 1;
      const ref = BrowserTabRef.make(`tab_sample_opened_${opened}`);
      add({ ...shopTab(ref, null), url: url ?? "", title: "" });
      change();
      return Promise.resolve({ _tag: "done", value: ref });
    },
    closeBrowserTab: (ref) => {
      samples.delete(ref);
      change();
      return Promise.resolve({ _tag: "done", value: undefined });
    },
    openBrowserView: ({ ref, size }): BrowserViewHandle => {
      const sample = samples.get(ref) ?? null;
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
      const controllerHere = (): BrowserController =>
        shared ? (heldBy(sample) === null ? "bot" : "you") : sample.controller;
      const showControl = () => {
        // A tab closed while the view is open is gone.
        if (!samples.has(sample.ref)) {
          state.set({ ...state.get(), status: { _tag: "gone" } });
          return;
        }
        state.set({
          status: { _tag: "live" },
          viewport: PAGE,
          control: { controller: controllerHere(), generation, dialog: null },
        });
      };
      stopTab = changed.subscribe(showControl);
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
      // The bot reads the rows one after another while nobody else holds the tab.
      const read = () => {
        if (sample.botId !== null && !held(sample)) {
          sample.row = (sample.row + 1) % rowsOf.length;
          cursor.set({
            botId: sample.botId,
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
            if (shared && usesPage(input)) {
              // The person's hold lasts from each input; once it ends, the lists say so.
              sample.lastInputAt = Date.now();
              later(change, BROWSER_PERSON_HOLD_MS + 50);
            }
            switch (input.type) {
              case "take":
                generation += 1;
                if (shared) sample.waiting = true;
                else sample.controller = "you";
                change();
                return;
              case "release":
                generation += 1;
                if (shared) {
                  sample.waiting = false;
                  if (input.idle !== true) sample.lastInputAt = null;
                } else sample.controller = "bot";
                change();
                return;
              case "text":
                sample.typed += input.text;
                change();
                return;
              case "key":
                if (input.action === "down" && input.key === "Backspace") {
                  sample.typed = sample.typed.slice(0, -1);
                }
                change();
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
                change();
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
