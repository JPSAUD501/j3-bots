// SPDX-License-Identifier: AGPL-3.0-or-later
import { tabFaces, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import { botNames, presenceLine } from "@j3-bots/client-runtime/wording";
import type { Bot, BotId } from "@j3-bots/contracts";
import { MessageCircle } from "lucide-react-native";
import { View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { QuickMessage } from "../components/QuickMessage.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { Faces } from "./Faces.tsx";

/**
 * Who is on the tab, from its line: each bot with what it is doing and a way
 * to its conversation, Wait for me (or Continue, once asked), and a field to
 * answer the bot the person came from without leaving the page.
 */
export function TabSheet({
  open,
  tab,
  from,
  waiting,
  waitsForPerson,
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
        <Text className="text-base text-muted-foreground">{t("browser.sheet.nobody")}</Text>
      ) : (
        <View className="gap-4">
          {onIt.map((bot) => (
            <OnTab
              key={bot.id}
              bot={bot}
              light={tab.acting === bot.id}
              onConversation={() => onConversation(bot.id)}
            />
          ))}
          <View className="gap-1.5 border-t border-border pt-4">
            {waiting ? (
              <Button
                variant="primary"
                label={t("browser.line.continue")}
                onPress={() => {
                  onContinue();
                  onClose();
                }}
              />
            ) : (
              <>
                <Button
                  variant="outline"
                  label={t("browser.sheet.waitForMe")}
                  onPress={() => {
                    onWaitForMe();
                    onClose();
                  }}
                />
                <Text className="text-center text-sm text-muted-foreground">
                  {plural("browser.sheet.waitForMe.line", onIt.length, { names })}
                </Text>
              </>
            )}
          </View>
          {answered !== null && (
            <QuickMessage
              bot={answered}
              placeholder={t("browser.sheet.reply", { name: answered.profile.name })}
              onOpen={() => onConversation(answered.id)}
            />
          )}
        </View>
      )}
    </Sheet>
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
    <View className="flex-row items-center gap-3">
      <BotAvatar
        avatar={bot.profile.avatar}
        seed={bot.id}
        state={light ? "working" : bot.state._tag === "waiting" ? "waiting" : "idle"}
        size={36}
        still
      />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-medium text-foreground">
          {bot.profile.name}
        </Text>
        {doing !== null && (
          <Text numberOfLines={2} className="text-sm text-muted-foreground">
            {doing.text}
          </Text>
        )}
      </View>
      <PressScale
        depth="control"
        accessibilityRole="button"
        accessibilityLabel={`${ctx.i18n.t("browser.sheet.conversation")}, ${bot.profile.name}`}
        onPress={onConversation}
        className="min-h-11 flex-row items-center gap-1.5 rounded-pill border border-input px-3"
      >
        <Icon icon={MessageCircle} size={16} color="accent-foreground" />
        <Text className="text-sm font-medium text-foreground">
          {ctx.i18n.t("browser.sheet.conversation")}
        </Text>
      </PressScale>
    </View>
  );
}
