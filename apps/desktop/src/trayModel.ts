// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryTarget } from "@j3-bots/contracts";
import type { TrayReport } from "@j3-bots/desktop-bridge";
import type { I18n } from "@j3-bots/i18n";

// What the tray shows for the bots and rooms the page says need the
// operator. Which ones need them is the page's to say, from the roster; the
// tray only words it.

export interface TrayModel {
  /** How many need the operator: the icon's badge, and its title where the system shows one. */
  readonly count: number;
  /** Its menu's first line, and its hover text: how many need the operator, or that nothing does. */
  readonly summary: string;
  /** Each bot and room it names, in the roster's order. */
  readonly entries: ReadonlyArray<{ readonly label: string; readonly target: EntryTarget }>;
  /** How many more need the operator than it names, worded; `null` when it names them all. */
  readonly more: string | null;
}

export const trayModel = ({ count, waiting }: TrayReport, i18n: I18n): TrayModel => {
  const rest = count - waiting.length;
  return {
    count,
    summary:
      count === 0 ? i18n.t("desktop.tray.nothing") : i18n.plural("desktop.tray.needYou", count),
    entries: waiting.map(({ name, target }) => ({ label: name, target })),
    more: rest > 0 ? i18n.plural("desktop.tray.more", rest) : null,
  };
};
