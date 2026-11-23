// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserController } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";

/** Who acts on a tab, as the viewer's status line says it. */
export const statusKey = (controller: BrowserController): KeyWith => {
  switch (controller) {
    case "bot":
      return "browser.status.bot";
    case "you":
      return "browser.status.you";
    case "another-device":
      return "browser.status.anotherDevice";
    case "nobody":
      return "browser.status.nobody";
  }
};
