// SPDX-License-Identifier: AGPL-3.0-or-later
import { botAccountState } from "@j3-bots/client-runtime/presentation";
import type { Bot, EngineStatus } from "@j3-bots/contracts";
import { useI18n } from "../app/context";
import { Button } from "./ui/button";

/**
 * Above a bot's composer, while the AI account it runs on was removed or is
 * turned off (decision 0108): that it cannot work, and, where the bot can be
 * edited, a way to put it on another AI. Nothing while its account runs.
 */
export function BotAccountNotice({
  bot,
  engine,
  onChoose,
}: {
  readonly bot: Bot;
  readonly engine: EngineStatus | null;
  /** Opens the bot's form with the model picker open; absent where there is no form. */
  readonly onChoose: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const state = botAccountState(engine, bot.model);
  if (state === "ok") return null;
  const { name } = bot.profile;
  const account =
    engine?.providers.find((provider) => provider.id === bot.model.providerId)?.name ??
    bot.model.providerId;
  return (
    <div
      role="status"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2 text-sm"
    >
      <p className="min-w-0 flex-1 text-pretty">
        {state === "gone" ? t("botAccount.gone", { name }) : t("botAccount.off", { account, name })}
      </p>
      {onChoose !== undefined && (
        <Button size="sm" onClick={onChoose}>
          {t("botAccount.choose")}
        </Button>
      )}
    </div>
  );
}
