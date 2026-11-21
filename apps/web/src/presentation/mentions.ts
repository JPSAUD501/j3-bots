// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Addressee } from "@j3-bots/client-runtime/presentation";
import type { I18n } from "../i18n/i18n";

/**
 * Who a room message wakes, in the quiet line under the composer. A message
 * for nobody goes to whoever hosts when it arrives, so the line says the
 * host, and who that is now.
 */
export function addresseeLine(to: Addressee, { t }: I18n): string | null {
  if (to === null) return null;
  switch (to._tag) {
    case "host":
      return t("composer.to.host", { name: to.name });
    case "everyone":
      return t("composer.to.everyone");
    case "bots":
      return t("composer.to", { names: to.names });
  }
}

/**
 * What Send again says for a room message that goes again to `to`, without
 * the members who left: to the host when none of those it mentioned is left.
 */
export function resendLabel(to: Addressee, { t }: I18n): string {
  if (to === null || to._tag === "everyone") return t("message.retry");
  return to._tag === "host"
    ? t("message.retry.host", { name: to.name })
    : t("message.retry.to", { names: to.names });
}
