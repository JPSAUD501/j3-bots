// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Addressee } from "../presentation/mentions.ts";
import type { I18n } from "@j3-bots/i18n";

/** Who a room message wakes, in the quiet line under the composer. */
export function addresseeLine(to: Addressee, { t }: I18n): string | null {
  if (to === null) return null;
  switch (to._tag) {
    case "everyone":
      return t("composer.to.everyone");
    case "bots":
      return t("composer.to", { names: to.names });
  }
}

/**
 * What Send again says for a room message that goes again to `to`, without
 * the members who left: to every member when none of those it mentioned is left.
 */
export function resendLabel(to: Addressee, { t }: I18n): string {
  if (to === null || to._tag === "everyone") return t("message.retry");
  return t("message.retry.to", { names: to.names });
}
