// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadedList } from "@j3-bots/client-runtime";
import {
  type QuickMessageState,
  useJ3Client,
  useQuickMessage,
  useRoutines,
} from "@j3-bots/client-runtime/react";
import {
  type CardLines,
  type CardStatus,
  cardLines,
  messageProblemText,
} from "@j3-bots/client-runtime/wording";
import type { Bot, BotId } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { useNavigation } from "@react-navigation/native";
import {
  ChevronRight,
  Clock,
  Info,
  type LucideIcon,
  MessageCircle,
  SendHorizontal,
  Sparkles,
  Users,
} from "lucide-react-native";
import { createContext, type ReactNode, use, useState } from "react";
import { type AccessibilityActionEvent, View } from "react-native";
import { useI18n } from "../i18n.ts";
import { type Navigation, useOpenConversation } from "../navigation.tsx";
import { feelLongPress } from "../platform/haptics.ts";
import { useBots, usePresentation, useRooms } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { LiveBotAvatar } from "./avatar/mood.tsx";
import { Icon } from "./Icon.tsx";
import { useColor } from "../theme.ts";
import { Sheet } from "./Sheet.tsx";

const OpenCard = createContext<((botId: BotId) => void) | null>(null);

/**
 * A bot's card on Android (decision 0102): what the web shows over a bot's
 * face, in a sheet a long press on that face opens. One per screen, under its
 * navigation, so what the card opens opens from where the operator is.
 */
export function BotCardProvider({ children }: { readonly children: ReactNode }) {
  const bots = useBots();
  const [botId, setBotId] = useState<BotId | null>(null);
  // The bot the sheet shows, which stays drawn while the sheet sinks away.
  const [drawn, setDrawn] = useState<BotId | null>(null);
  if (botId !== null && botId !== drawn) setDrawn(botId);
  const shownId = botId ?? drawn;
  const bot = shownId === null ? undefined : bots.get(shownId);
  // A bot deleted while its card shows takes the card with it.
  if (botId !== null && bot === undefined) setBotId(null);
  const close = () => setBotId(null);
  return (
    <OpenCard value={setBotId}>
      {children}
      <Sheet
        open={botId !== null && bot !== undefined}
        title={bot?.profile.name ?? ""}
        lead={bot === undefined ? undefined : <CardFace bot={bot} />}
        onClose={close}
      >
        {bot !== undefined && (
          // Each bot's card starts afresh: its field empty, its answer its own.
          <CardBody key={bot.id} bot={bot} onDone={close} />
        )}
      </Sheet>
    </OpenCard>
  );
}

/**
 * What makes a bot's face or name open its card: a long press, with the
 * system's long-press tick, and for a screen reader an action of its own.
 * Nothing outside a `BotCardProvider`, or for no bot.
 */
export function useBotCardPress(botId: BotId | null, name: string) {
  const open = use(OpenCard);
  const { t } = useI18n();
  if (open === null || botId === null) return null;
  return {
    /** Opens the card, for a long press the caller tells apart itself. */
    open: () => open(botId),
    props: {
      onLongPress: () => {
        feelLongPress();
        open(botId);
      },
      accessibilityActions: [{ name: "card", label: t("card.open", { name }) }],
      onAccessibilityAction: (event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === "card") open(botId);
      },
    },
  };
}

const DOT: Record<CardStatus, string> = {
  working: "bg-success",
  waiting: "bg-waiting",
  free: "bg-muted-foreground/50",
  paused: "bg-blocked",
  stuck: "bg-blocked",
};

const STATUS_TEXT: Record<CardStatus, string> = {
  working: "text-muted-foreground",
  waiting: "text-waiting",
  free: "text-muted-foreground",
  paused: "text-blocked",
  stuck: "text-blocked",
};

/** The face before the sheet's title, with its status dot. */
function CardFace({ bot }: { readonly bot: Bot }) {
  const ctx = usePresentation();
  const { status } = cardLines(bot, [], null, ctx);
  return (
    <View>
      <LiveBotAvatar bot={bot} size={48} ground="surface" />
      <View
        className={`absolute -end-0.5 -bottom-0.5 size-3.5 rounded-pill border-[3px] border-surface ${DOT[status]}`}
      />
    </View>
  );
}

/** Everything under the card's title: as the web's card, top to bottom. */
function CardBody({ bot, onDone }: { readonly bot: Bot; readonly onDone: () => void }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const navigation = useNavigation<Navigation>();
  const openConversation = useOpenConversation();
  const rooms = useRooms();
  const routines = loadedList(useRoutines(bot.id));
  const lines = cardLines(bot, [...rooms.values()], routines, ctx);
  const { name, title } = bot.profile;
  const item = { _tag: "bot", botId: bot.id } as const;
  const act = (action: () => void) => () => {
    onDone();
    action();
  };
  const talk = act(() => openConversation(item));
  // Pushed: a card opened in another bot's details keeps those to go back to.
  const details = act(() => navigation.push("details", { item }));
  return (
    <View className="gap-4">
      <View className="gap-0.5">
        {title !== "" && <Text className="text-sm text-muted-foreground">{title}</Text>}
        {lines.status !== "working" && (
          <Text className={`text-sm ${STATUS_TEXT[lines.status]}`}>{lines.statusText}</Text>
        )}
      </View>
      <View className="-ms-2.5 flex-row gap-1">
        <CardAction icon={MessageCircle} label={t("card.talk", { name })} onPress={talk} />
        <CardAction
          icon={Users}
          label={t("card.startRoom", { name })}
          onPress={act(() =>
            navigation.navigate("roomForm", { form: { _tag: "create", members: [bot.id] } }),
          )}
        />
        <CardAction
          icon={Clock}
          label={t("card.routinesAction", { name })}
          onPress={act(() => navigation.push("details", { item, at: "routines" }))}
        />
        <CardAction icon={Info} label={t("card.detailsAction", { name })} onPress={details} />
      </View>
      <QuickMessage bot={bot} onOpen={talk} />
      {lines.now !== null && <NowBox status={lines.statusText} now={lines.now} />}
      {lines.job !== null && (
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
            {t("card.whatFor")}
          </Text>
          <Text numberOfLines={2} className="text-base text-foreground">
            {lines.job}
          </Text>
        </View>
      )}
      <About lines={lines} />
      <PressScale
        depth="control"
        accessibilityRole="button"
        onPress={details}
        className="min-h-11 flex-row items-center gap-0.5 self-start"
      >
        <Text className="text-sm font-semibold text-foreground">{t("card.seeDetails")}</Text>
        <Icon icon={ChevronRight} size={14} color="accent-foreground" />
      </PressScale>
    </View>
  );
}

function CardAction({
  icon,
  label,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="size-11 items-center justify-center rounded-pill active:bg-muted"
    >
      <Icon icon={icon} size={20} color="accent-muted-foreground" />
    </PressScale>
  );
}

function NowBox({
  status,
  now,
}: {
  readonly status: string;
  readonly now: NonNullable<CardLines["now"]>;
}) {
  return (
    <View className="gap-0.5 rounded-lg border border-border px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <View className="size-2 rounded-pill bg-success" />
        <Text numberOfLines={2} className="min-w-0 flex-1 text-base text-foreground">
          <Text className="font-semibold">{status}</Text> · {now.doing}
        </Text>
      </View>
      <Text className="text-sm text-muted-foreground">{now.detail}</Text>
    </View>
  );
}

function About({ lines }: { readonly lines: CardLines }) {
  const { t } = useI18n();
  const rows: ReadonlyArray<{ readonly icon: LucideIcon; readonly text: string }> = [
    { icon: Sparkles, text: lines.made },
    ...(lines.routines === null ? [] : [{ icon: Clock, text: lines.routines }]),
    ...(lines.rooms === null ? [] : [{ icon: Users, text: lines.rooms.text }]),
  ];
  return (
    <View className="gap-1.5">
      <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
        {t("card.about")}
      </Text>
      {rows.map((row) => (
        <View key={row.text} className="flex-row items-start gap-2.5">
          <View className="pt-0.5">
            <Icon icon={row.icon} size={16} color="accent-muted-foreground" />
          </View>
          <Text className="min-w-0 flex-1 text-base text-foreground">{row.text}</Text>
        </View>
      ))}
    </View>
  );
}

function quickLine(state: QuickMessageState, name: string, i18n: I18n) {
  const { t } = i18n;
  switch (state._tag) {
    case "idle":
      return null;
    case "sending":
      return { text: t("card.quick.sending"), tone: "muted" as const };
    case "sent":
      return { text: t("card.quick.sent", { name }), tone: "muted" as const };
    case "invalid":
      return { text: messageProblemText(state.problem, i18n), tone: "blocked" as const };
    case "gone":
      return { text: t("card.quick.gone", { name }), tone: "blocked" as const };
    case "failed":
      return { text: t("card.quick.failed", { name }), tone: "blocked" as const };
  }
}

/**
 * A line that sends straight to the bot's conversation without opening it,
 * and says where what was sent stands, as the composer's messages do.
 */
function QuickMessage({ bot, onOpen }: { readonly bot: Bot; readonly onOpen: () => void }) {
  const i18n = usePresentation().i18n;
  const { t } = i18n;
  const client = useJ3Client();
  const name = bot.profile.name;
  const quick = useQuickMessage(bot.id, (input) => client.send(input));
  const line = quickLine(quick.state, name, i18n);
  const empty = quick.text.trim() === "";
  const placeholder = useColor("accent-muted-foreground");
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-1 rounded-lg border border-input bg-background ps-3">
        <TextInput
          value={quick.text}
          onChangeText={quick.setText}
          onSubmitEditing={quick.submit}
          submitBehavior="blurAndSubmit"
          returnKeyType="send"
          accessibilityLabel={t("card.quick.label", { name })}
          placeholder={t("card.quick.placeholder")}
          placeholderTextColor={placeholder}
          className="min-h-11 min-w-0 flex-1 text-base text-foreground"
        />
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("card.quick.send")}
          accessibilityState={{ disabled: empty }}
          onPress={quick.submit}
          className="size-11 items-center justify-center rounded-pill"
        >
          <Icon icon={SendHorizontal} size={18} color="accent-muted-foreground" />
        </PressScale>
      </View>
      {line !== null && (
        <View accessibilityLiveRegion="polite" className="flex-row flex-wrap items-center gap-x-1">
          <Text
            className={`text-sm ${line.tone === "blocked" ? "text-blocked" : "text-muted-foreground"}`}
          >
            {line.text}
          </Text>
          {quick.state._tag === "sent" && (
            <PressScale
              depth="control"
              accessibilityRole="button"
              onPress={onOpen}
              className="min-h-11 justify-center"
            >
              <Text className="text-sm font-semibold text-foreground">{t("card.quick.open")}</Text>
            </PressScale>
          )}
        </View>
      )}
    </View>
  );
}
