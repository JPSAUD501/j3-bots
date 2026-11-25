// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Mentions } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";

/**
 * What Send again says for a room message that goes again with `mentions`,
 * those of the members it mentioned who are still in the room: to them, by
 * their names now; to the room, which every member reads, when none of them
 * is left. Plain Send again where the names are not known.
 */
export function resendLabel(
  mentions: Mentions,
  nameOf: (botId: BotId) => string | undefined,
  { t, locale }: I18n,
): string {
  if (mentions._tag === "everyone") return t("message.retry");
  if (mentions.ids.length === 0) return t("message.retry.room");
  const names = mentions.ids.flatMap((id) => nameOf(id) ?? []);
  if (names.length === 0) return t("message.retry");
  return t("message.retry.to", {
    names: new Intl.ListFormat(locale, { type: "conjunction" }).format(names),
  });
}
