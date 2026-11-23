// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget } from "@j3-bots/contracts";
import type { LocalServerState, TrayReport } from "@j3-bots/desktop-bridge";
import type { I18n } from "@j3-bots/i18n";

// What the tray shows for the bots and rooms the page says need the
// operator. Which ones need them is the page's to say, from the roster; the
// tray only words it. In local mode, while the server on this computer is
// not running, the tray says so first, since no bot works until it runs.

export interface TrayModel {
  /**
   * How many need the operator: the icon's Pip lights while any do, and its
   * title shows the count where the system shows one.
   */
  readonly count: number;
  /**
   * Its menu's first line, and its hover text: that the bots on this computer
   * are not running, while they are not; otherwise how many need the
   * operator, or that nothing does.
   */
  readonly summary: string;
  /** Each bot and room it names, in the roster's order. */
  readonly entries: ReadonlyArray<{ readonly label: string; readonly target: EntryTarget }>;
  /** How many more need the operator than it names, worded; `null` when it names them all. */
  readonly more: string | null;
}

/** What the tray says of the server on this computer, or `null` while it runs. */
const localLine = (local: LocalServerState, i18n: I18n): string | null => {
  switch (local.state) {
    case "ready":
      return null;
    case "starting":
      return local.update?._tag === "updating"
        ? i18n.t("desktop.tray.local.updating")
        : i18n.t("desktop.tray.local.starting");
    case "stopped":
      return i18n.t("desktop.tray.local.stopped");
    case "restarting":
      return local.retryInSeconds === undefined || local.retryInSeconds === 0
        ? i18n.t("desktop.tray.local.restartingNow")
        : i18n.t("desktop.tray.local.restarting", { seconds: local.retryInSeconds });
    case "failed":
      return i18n.t("desktop.tray.local.failed");
  }
};

/**
 * The tray for what the page reported and, in local mode, the server this
 * computer runs (`null` in remote mode, or before a mode is chosen).
 */
export const trayModel = (
  { count, waiting }: TrayReport,
  local: LocalServerState | null,
  i18n: I18n,
): TrayModel => {
  const rest = count - waiting.length;
  const notRunning = local === null ? null : localLine(local, i18n);
  return {
    count,
    summary:
      notRunning ??
      (count === 0 ? i18n.t("desktop.tray.nothing") : i18n.plural("desktop.tray.needYou", count)),
    entries: waiting.map(({ name, target }) => ({ label: name, target })),
    more: rest > 0 ? i18n.plural("desktop.tray.more", rest) : null,
  };
};
