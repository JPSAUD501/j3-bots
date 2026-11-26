// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, LastChange, SkillScope, SkillSource } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
import { activityTime, type TimeContext } from "./time.ts";

/** Who made the latest change and when, as a list's column says it: "You · 8:47 AM", "Scout · Monday". */
export function lastChangeText(
  change: LastChange | null,
  bots: ReadonlyArray<Bot>,
  ctx: TimeContext,
): string | null {
  if (change === null) return null;
  const { t } = ctx.i18n;
  const { by } = change;
  const who =
    by._tag === "operator"
      ? t("change.byYou")
      : (bots.find((bot) => bot.id === by.botId)?.profile.name ?? t("change.byRemovedBot"));
  return t("change.by", { who, when: activityTime(change.at, ctx) });
}

/** Whose a skill is: "Every bot", or the bot's name. */
export function skillScopeText(scope: SkillScope, bots: ReadonlyArray<Bot>, { t }: I18n): string {
  if (scope._tag === "all-bots") return t("skills.scope.all");
  return bots.find((bot) => bot.id === scope.botId)?.profile.name ?? t("change.byRemovedBot");
}

/** Where a skill came from, when it was installed: the repository, its folder and the commit. */
export function skillSourceText(source: SkillSource | null, { t }: I18n): string | null {
  if (source === null || source._tag === "written") return null;
  const where = source.path === "" ? source.repository : `${source.repository} · ${source.path}`;
  return t("skills.source", { where, commit: source.commit.slice(0, 7) });
}

/** Why a change to a skill did not go through, in words. */
export function skillFailureText(failure: IntentFailure, { t }: I18n): string {
  if (failure._tag === "not-paired") return t("skills.failed");
  if (refusedWith(failure, "skill-shipped")) return t("skills.failed.shipped");
  if (refusedWith(failure, "skill-name-taken")) return t("skills.failed.nameTaken");
  if (refusedWith(failure, "skill-limit")) return t("skills.failed.limit");
  if (refusedWith(failure, "skill-text")) return t("skills.failed.text");
  if (refusedWith(failure, "skill-repository")) return t("skills.failed.repository");
  if (refusedWith(failure, "skill-fetch")) return t("skills.failed.fetch");
  if (refusedWith(failure, "private-location")) return t("skills.failed.privateLocation");
  return t("skills.failed");
}
