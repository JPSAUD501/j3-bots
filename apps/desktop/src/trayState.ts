// SPDX-License-Identifier: AGPL-3.0-or-later
import { LocalServerState, TrayReport } from "@j3-bots/desktop-bridge";
import type { I18n } from "@j3-bots/i18n";
import * as Schema from "effect/Schema";
import { type TrayModel, trayModel } from "./trayModel.ts";

// What the tray shows, kept apart from Electron's `Tray` so that what feeds
// it (the page's report, the server on this computer, the language) can be
// followed to what it draws without a window.

const sameTray = Schema.toEquivalence(TrayReport);
const sameLocalServer = Schema.toEquivalence(Schema.NullOr(LocalServerState));

const NOTHING_REPORTED: TrayReport = { pairing: null, count: 0, waiting: [] };

/** What the tray draws: its model, and the pairing its entries open in. */
export interface TrayView {
  readonly model: TrayModel;
  readonly pairing: TrayReport["pairing"];
}

export interface TrayState {
  /** What the page reports it lists; drawn when it changed, so a menu open on screen stays open. */
  readonly report: (next: TrayReport) => void;
  /** The page that reported was replaced: nothing is listed until the new one reports. */
  readonly pageReplaced: () => void;
  /** The server this computer runs, in local mode (`null` in any other); drawn when it changed. */
  readonly followLocalServer: (next: LocalServerState | null) => void;
  /** The language the tray speaks. */
  readonly language: (next: I18n) => void;
  /** Draws again, as when the system's theme changed. */
  readonly redraw: () => void;
}

/** The tray's state, drawn through `draw` now and on each change. */
export const makeTrayState = (options: {
  readonly i18n: I18n;
  readonly draw: (view: TrayView) => void;
}): TrayState => {
  let i18n = options.i18n;
  let reported = NOTHING_REPORTED;
  let local: LocalServerState | null = null;
  const redraw = () =>
    options.draw({ model: trayModel(reported, local, i18n), pairing: reported.pairing });
  redraw();
  return {
    report: (next) => {
      if (sameTray(reported, next)) return;
      reported = next;
      redraw();
    },
    pageReplaced: () => {
      reported = NOTHING_REPORTED;
      redraw();
    },
    followLocalServer: (next) => {
      if (sameLocalServer(local, next)) return;
      local = next;
      redraw();
    },
    language: (next) => {
      i18n = next;
      redraw();
    },
    redraw,
  };
};
