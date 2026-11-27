// SPDX-License-Identifier: AGPL-3.0-or-later
import { tabFaces, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import { type QuickSend, useQuickMessage } from "@j3-bots/client-runtime/react";
import { botNames, presenceLine } from "@j3-bots/client-runtime/wording";
import type { Bot, BotId } from "@j3-bots/contracts";
import { MessageCircleIcon } from "lucide-react";
import { useBots, usePresentation } from "../../app/context";
import { BotAvatar } from "../../components/avatar/BotAvatar";
import { QuickMessageField } from "../../components/BotCard";
import { Button } from "../../components/ui/button";
import { Faces } from "../Faces";
import { Sheet } from "./Sheet";

/**
 * Who is on the tab, from its line, as on the phone: each bot with what it
 * is doing and a way to its conversation, Wait for me (or Continue, once
 * asked), and a field to answer the bot the person came from without
 * leaving the page.
 */
export function TabSheet({
  open,
  tab,
  from,
  waiting,
  waitsForPerson,
  send,
  onClose,
  onWaitForMe,
  onContinue,
  onConversation,
}: {
  readonly open: boolean;
  readonly tab: ViewerTab;
  /** The bot whose conversation the live view was opened from. */
  readonly from: BotId | null;
  /** The person asked the tab's bots to wait for them. */
  readonly waiting: boolean;
  readonly waitsForPerson: ReadonlySet<BotId>;
  /** Sends a message straight to a bot's conversation. */
  readonly send: QuickSend;
  readonly onClose: () => void;
  readonly onWaitForMe: () => void;
  readonly onContinue: () => void;
  readonly onConversation: (botId: BotId) => void;
}) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const bots = useBots();
  const onIt = tab.onIt.flatMap((botId) => {
    const bot = bots.get(botId);
    return bot === undefined ? [] : [bot];
  });
  const answered =
    onIt.find((bot) => bot.id === from) ?? (onIt.length === 1 ? (onIt[0] ?? null) : null);
  const names = botNames(
    onIt.map((bot) => bot.id),
    (botId) => bots.get(botId)?.profile.name ?? "",
    ctx.i18n,
  );
  return (
    <Sheet
      open={open}
      title={t("browser.sheet.title")}
      lead={<Faces faces={tabFaces(tab, waitsForPerson)} size={24} />}
      onClose={onClose}
    >
      {onIt.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("browser.sheet.nobody")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-4">
            {onIt.map((bot) => (
              <OnTab
                key={bot.id}
                bot={bot}
                light={tab.acting === bot.id}
                onConversation={() => onConversation(bot.id)}
              />
            ))}
          </ul>
          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            {waiting ? (
              <Button
                variant="primary"
                onClick={() => {
                  onContinue();
                  onClose();
                }}
              >
                {t("browser.line.continue")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    onWaitForMe();
                    onClose();
                  }}
                >
                  {t("browser.sheet.waitForMe")}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  {plural("browser.sheet.waitForMe.line", onIt.length, { names })}
                </p>
              </>
            )}
          </div>
          {answered !== null && (
            <Reply
              key={answered.id}
              bot={answered}
              send={send}
              onOpen={() => onConversation(answered.id)}
            />
          )}
        </div>
      )}
    </Sheet>
  );
}

/** The field that answers a bot from the sheet, straight to its conversation. */
function Reply({
  bot,
  send,
  onOpen,
}: {
  readonly bot: Bot;
  readonly send: QuickSend;
  readonly onOpen: () => void;
}) {
  const { t } = usePresentation().i18n;
  const quick = useQuickMessage(bot.id, send);
  return (
    <QuickMessageField
      name={bot.profile.name}
      quick={quick}
      placeholder={t("browser.sheet.reply", { name: bot.profile.name })}
      onOpen={onOpen}
    />
  );
}

/** One bot on the tab: its face, its name, what it is doing, and its conversation a press away. */
function OnTab({
  bot,
  light,
  onConversation,
}: {
  readonly bot: Bot;
  readonly light: boolean;
  readonly onConversation: () => void;
}) {
  const ctx = usePresentation();
  const doing = presenceLine(bot, ctx);
  return (
    <li className="flex items-center gap-3">
      <BotAvatar
        avatar={bot.profile.avatar}
        seed={bot.id}
        state={light ? "working" : bot.state._tag === "waiting" ? "waiting" : "idle"}
        size={36}
        still
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{bot.profile.name}</p>
        {doing !== null && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{doing.text}</p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onConversation}
        aria-label={`${ctx.i18n.t("browser.sheet.conversation")}, ${bot.profile.name}`}
      >
        <MessageCircleIcon />
        {ctx.i18n.t("browser.sheet.conversation")}
      </Button>
    </li>
  );
}
