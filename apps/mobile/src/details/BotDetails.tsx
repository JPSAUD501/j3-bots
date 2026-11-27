// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Loaded } from "@j3-bots/client-runtime";
import {
  asksYou,
  botStop,
  connectorsOf,
  type Teammate,
  teammatesOf,
  trackCast,
} from "@j3-bots/client-runtime/presentation";
import {
  useBotFiles,
  useConnectors,
  useEngineStatus,
  useJ3Client,
  useMemory,
  usePairs,
  useRoutines,
} from "@j3-bots/client-runtime/react";
import {
  activityTime,
  botModelName,
  fileSize,
  memoryFileName,
  pairLine,
  permissionModeText,
  routineLines,
} from "@j3-bots/client-runtime/wording";
import {
  type Bot,
  type Connector,
  hasSeveralSteps,
  type MemoryFile,
  type Routine,
  type RoutineStep,
} from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import {
  CalendarClock,
  ChevronRight,
  CirclePause,
  Cpu,
  FileText,
  Globe,
  NotebookText,
  PlugZap,
  ShieldCheck,
  Webhook,
} from "lucide-react-native";
import { type ReactElement, useMemo } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { LiveBotAvatar } from "../components/avatar/mood.tsx";
import { DeleteButton, Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { PressScale } from "../press.tsx";
import { Apart, Profile, ProfileLine } from "./Profile.tsx";
import { Icon } from "../components/Icon.tsx";
import type { Navigation } from "../navigation.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { useSay } from "../toast.tsx";
import { Button, Switch } from "../ui.tsx";
import { FileCard } from "../conversation/FileCard.tsx";
import { RoutineSentence } from "../conversation/RoutineTrack.tsx";
import { EntryWidths } from "../conversation/widths.ts";
import { useShareBotTemplate } from "../template/share.ts";
import { useBotPlacing } from "../screens/placing.ts";
import { HiddenNotice } from "./HiddenNotice.tsx";
import { useBotActions } from "./actions.ts";
import { useOpenConnectors } from "../connectors/intents.ts";
import { ConnectorTile, StatusWord } from "../connectors/parts.tsx";
import { StopRow, useFocusAfterStop } from "./StopRow.tsx";

/** A read's list once loaded, or null while it loads; a bot that is gone has none. */
const loadedList = <A,>(loaded: Loaded<ReadonlyArray<A>> | null): ReadonlyArray<A> | null =>
  loaded === null || loaded._tag === "loading" ? null : loaded._tag === "ready" ? loaded.value : [];

/**
 * Answers: what is this bot, and what runs without me. Its profile, Stop
 * while it has work to stop, that it is hidden while it is, its routines
 * with a switch to pause each, the files it sent, its memory, its
 * connectors, the teammates it wrote with, the model it runs on, a fresh
 * start, and, last and apart, deleting it.
 */
export function BotDetails({ bot }: { readonly bot: Bot }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  // The details take the window's width; a section is inset 20 px on each side.
  const column = useWindowDimensions().width - 40;
  const fileWidths = useMemo(() => ({ bubble: column, card: column, column }), [column]);
  const navigation = useNavigation<Navigation>();
  const actions = useBotActions();
  const placing = useBotPlacing();
  const shareTemplate = useShareBotTemplate();
  const engine = useEngineStatus();
  const routines = loadedList(useRoutines(bot.id));
  const files = loadedList(useBotFiles(bot.id));
  const memory = loadedList(useMemory({ _tag: "bot", botId: bot.id }));
  const connectors = useConnectors();
  const pairs = usePairs();
  const teammates = pairs._tag === "ready" ? teammatesOf(bot.id, pairs.value) : [];
  const { name, title, job } = bot.profile;
  const mode = permissionModeText(bot.permissionMode, ctx.i18n);
  const modelName = botModelName(engine._tag === "ready" ? engine.value : null, bot);
  const browserNeedsSetup =
    engine._tag === "ready" && engine.value.browser?._tag === "setup-required";
  const skeleton = (count: number) => <SkeletonRows count={count} />;
  const stop = botStop(bot);
  const stopFocus = useFocusAfterStop(stop !== "hidden");
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <Profile
        picture={<LiveBotAvatar bot={bot} size={96} markPrimary />}
        name={name}
        headingRef={stopFocus.heading}
        badge={bot.primary ? t("details.primary") : null}
        lines={
          <>
            {title !== "" && <ProfileLine>{title}</ProfileLine>}
            <ProfileLine>{job === "" ? t("details.noJob", { name }) : job}</ProfileLine>
          </>
        }
      >
        <Button
          variant="secondary"
          label={t("details.editProfile", { name })}
          onPress={() => navigation.navigate("editBot", { botId: bot.id })}
        />
        <Button
          variant="secondary"
          label={t("details.shareTemplate")}
          onPress={() => shareTemplate(bot.id)}
        />
      </Profile>

      {stop === "offered" && (
        <StopRow label={t("details.stop")} onPress={() => stopFocus.stopped(actions.stop(bot))} />
      )}
      {stop === "force" && (
        <StopRow
          label={t("details.forceStop")}
          why={t("details.forceStop.why")}
          onPress={() => stopFocus.stopped(actions.forceStop(bot))}
        />
      )}

      {bot.hidden && <HiddenNotice name={name} onShow={() => placing.unhide(bot)} />}

      <Section open title={t("details.routines")}>
        {routines === null ? (
          skeleton(2)
        ) : routines.length === 0 ? (
          <Quiet>{t("details.noRoutines", { name })}</Quiet>
        ) : (
          routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              onOpen={() =>
                navigation.navigate("routineRuns", { botId: bot.id, routineId: routine.id })
              }
            />
          ))
        )}
      </Section>

      <Section open title={t("details.files")}>
        {files === null ? (
          skeleton(1)
        ) : files.length === 0 ? (
          <Quiet>{t("details.noFiles", { name })}</Quiet>
        ) : (
          // The cards the conversation shows, as wide as the section lets them be.
          <EntryWidths value={fileWidths}>
            {files.map(({ attachment }) => (
              <FileCard key={attachment.id} attachment={attachment} />
            ))}
          </EntryWidths>
        )}
      </Section>

      <Section open title={t("details.memory")}>
        {memory === null ? (
          skeleton(1)
        ) : memory.length === 0 ? (
          <Quiet>{t("details.noMemory", { name })}</Quiet>
        ) : (
          memory.map((file) => (
            <MemoryRow
              key={file.path}
              file={file}
              onOpen={() => navigation.navigate("memoryFile", { botId: bot.id, path: file.path })}
            />
          ))
        )}
      </Section>

      <Section open title={t("details.connectors")}>
        {connectors._tag === "loading" ? (
          skeleton(1)
        ) : (
          <BotConnectors bot={bot} connectors={connectorsOf(connectors.value, bot.id)} />
        )}
      </Section>

      {/* Only a bot that wrote with a teammate has this section. */}
      {teammates.length > 0 && (
        <Section open title={t("pairs.teammates")}>
          {teammates.map((teammate) => (
            <TeammateRow
              key={teammate.peer}
              teammate={teammate}
              onOpen={() => navigation.navigate("pair", { botIds: teammate.pair.botIds })}
            />
          ))}
        </Section>
      )}

      <Section open title={t("details.model")}>
        <View className="flex-row items-start gap-3">
          <Icon icon={Cpu} color="accent-muted-foreground" />
          <Text
            accessibilityLabel={`${t("details.runsOn")}: ${modelName ?? t("details.modelUnavailable")}`}
            className="min-w-0 flex-1 text-base text-foreground"
          >
            {modelName ?? t("details.modelUnavailable")}
          </Text>
        </View>
        <View className="flex-row items-start gap-3">
          <Icon icon={ShieldCheck} color="accent-muted-foreground" />
          <View
            accessible
            accessibilityLabel={`${t("details.permissionMode")}: ${mode.name}. ${mode.description}`}
            className="min-w-0 flex-1"
          >
            <Text className="text-base text-foreground">{mode.name}</Text>
            <Text className="text-sm text-muted-foreground">{mode.description}</Text>
          </View>
        </View>
      </Section>

      <Section open title={t("details.browser")}>
        <BrowserRow bot={bot} needsSetup={browserNeedsSetup} />
      </Section>

      <Section open title={t("details.workingContext")}>
        <Quiet>
          {t("details.freshStartHint", { name })} {t("details.freshStartStops", { name })}
        </Quiet>
        <View className="items-start">
          <Button
            variant="secondary"
            label={t("details.freshStart")}
            onPress={() =>
              confirm({
                title: t("details.freshStart.title", { name }),
                body: t("details.freshStart.body", { name }),
                cancel: t("details.freshStart.cancel"),
                confirm: t("details.freshStart"),
                onConfirm: () => actions.freshStart(bot),
              })
            }
          />
        </View>
      </Section>

      {/* Last and on its own, so the one action that cannot be undone is never next to another. */}
      <Apart>
        <DeleteButton
          label={t("details.delete", { name })}
          title={t("details.delete.title", { name })}
          body={t("details.delete.body", { name })}
          cancel={t("details.delete.cancel", { name })}
          onDelete={() => actions.remove(bot)}
        />
      </Apart>
    </ScrollView>
  );
}

/**
 * A routine: its name, its trigger in words, its next run, how its last run
 * went, and a switch that pauses it. The rest of the row opens its runs.
 */
/** Who does a routine's steps, as small faces, and an amber dot when it stops for the operator's yes. */
function RoutineCast({ steps }: { readonly steps: ReadonlyArray<RoutineStep> }) {
  const bots = useBots();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-0.5"
    >
      {trackCast(steps).flatMap((botId) => {
        const bot = bots.get(botId);
        return bot === undefined
          ? []
          : [
              <BotAvatar
                key={botId}
                avatar={bot.profile.avatar}
                seed={bot.id}
                state="idle"
                size={16}
                still
              />,
            ];
      })}
      {asksYou(steps) && <View className="ms-0.5 size-1.5 rounded-pill bg-waiting" />}
    </View>
  );
}

function RoutineRow({
  routine,
  onOpen,
}: {
  readonly routine: Routine;
  readonly onOpen: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const say = useSay();
  const lines = routineLines(routine, ctx);
  // A routine with several steps reads back as its sentence, with who does it.
  const steps = hasSeveralSteps(routine.steps, routine.botId) ? routine.steps : null;
  const icon = !routine.enabled
    ? CirclePause
    : routine.trigger._tag === "webhook"
      ? Webhook
      : routine.trigger._tag === "event"
        ? PlugZap
        : CalendarClock;
  const last = lines.lastRun;
  return (
    <View className="flex-row items-start gap-3">
      <View className="pt-0.5">
        <Icon icon={icon} color={routine.enabled ? "accent-success" : "accent-muted-foreground"} />
      </View>
      <PressScale
        depth="row"
        frame={{ flex: 1, minWidth: 0 }}
        accessibilityRole="button"
        accessibilityHint={t("routine.runs.hint")}
        onPress={onOpen}
        className="-my-1 gap-0.5 rounded-md py-1 active:bg-muted"
      >
        {steps === null ? (
          <>
            <Text numberOfLines={1} className="text-base text-foreground">
              {routine.name}
            </Text>
            <Text
              face={lines.expression ? "mono" : "text"}
              className="text-sm text-muted-foreground"
            >
              {lines.schedule}
            </Text>
          </>
        ) : (
          <>
            <View className="flex-row items-center gap-2">
              <Text numberOfLines={1} className="min-w-0 shrink text-base text-foreground">
                {routine.name}
              </Text>
              <RoutineCast steps={steps} />
            </View>
            <RoutineSentence
              trigger={routine.trigger}
              steps={steps}
              className="text-sm"
              lines={2}
            />
          </>
        )}
        {lines.status !== null && (
          <Text
            className={
              lines.status.blocked ? "text-xs text-blocked" : "text-xs text-muted-foreground"
            }
          >
            {lines.status.text}
          </Text>
        )}
        {last !== null && (
          // Only what went wrong is drawn in the blocked color; the run count stays quiet.
          <Text className="text-xs text-muted-foreground">
            {ctx.i18n.pluralParts<"routine.lastRunWithCount", ReactElement>(
              "routine.lastRunWithCount",
              routine.runCount,
              {
                lastRun: (
                  <Text key="lastRun" className={last.failed ? "text-blocked" : ""}>
                    {last.text}
                  </Text>
                ),
              },
            )}
          </Text>
        )}
      </PressScale>
      <Switch
        accessibilityLabel={routine.name}
        value={routine.enabled}
        onChange={(enabled) =>
          void client.setRoutineEnabled(routine.id, enabled).then((result) => {
            if (result._tag === "failed") {
              say(
                t(enabled ? "routine.resumeFailed" : "routine.pauseFailed", { name: routine.name }),
              );
            }
          })
        }
      />
    </View>
  );
}

/**
 * Whether the bot may use the browser on the server's computer, with the
 * operator's sign-ins there, from its next turn; and, while it may, whether
 * that computer still needs setting up for it.
 */
function BrowserRow({ bot, needsSetup }: { readonly bot: Bot; readonly needsSetup: boolean }) {
  const { t } = usePresentation().i18n;
  const client = useJ3Client();
  const say = useSay();
  const { name } = bot.profile;
  return (
    <View className="flex-row items-start gap-3">
      <View className="pt-0.5">
        <Icon icon={Globe} color="accent-muted-foreground" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base text-foreground">{t("details.browser.use")}</Text>
        <Text className="text-sm text-muted-foreground">{t("details.browser.hint", { name })}</Text>
        {bot.browser && needsSetup && (
          <Text className="text-sm text-blocked">{t("details.browser.setup")}</Text>
        )}
      </View>
      <Switch
        accessibilityLabel={t("details.browser.use")}
        value={bot.browser}
        onChange={(enabled) =>
          void client.updateBot(bot.id, { browser: enabled }).then((result) => {
            if (result._tag !== "failed") return;
            // The switch shows the bot as the server has it, so a failure leaves nothing to keep.
            client.dismissBotSave(bot.id);
            say(t("details.browser.failed", { name }));
          })
        }
      />
    </View>
  );
}

/**
 * A teammate the bot wrote with: its face and name, then the latest message
 * between them after who wrote it, and when. It opens their conversation.
 * A deleted teammate is named so, its face left blank.
 */
function TeammateRow({
  teammate,
  onOpen,
}: {
  readonly teammate: Teammate;
  readonly onOpen: () => void;
}) {
  const ctx = usePresentation();
  const peer = useBots().get(teammate.peer);
  const name = peer?.profile.name ?? ctx.i18n.t("bot.unknown");
  const line = pairLine(teammate.pair, ctx);
  const time = activityTime(teammate.pair.lastMessage.createdAt, ctx);
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={[name, time, line].join(", ")}
      onPress={onOpen}
      className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 py-1 active:bg-muted"
    >
      {peer === undefined ? (
        <View className="size-7 rounded-pill bg-muted" />
      ) : (
        <BotAvatar avatar={peer.profile.avatar} seed={peer.id} state="idle" size={28} still />
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
            {name}
          </Text>
          <Text className="text-xs text-muted-foreground">{time}</Text>
        </View>
        <Text numberOfLines={1} className="text-sm text-muted-foreground">
          {line}
        </Text>
      </View>
      <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
    </PressScale>
  );
}

/** A memory file: the profile note or a period's log, with its size and when it changed. */
function MemoryRow({ file, onOpen }: { readonly file: MemoryFile; readonly onOpen: () => void }) {
  const ctx = usePresentation();
  const name = memoryFileName(file.path, ctx.i18n);
  const detail = ctx.i18n.t("memory.sizeAndDate", {
    size: fileSize(file.size, ctx.i18n.locale),
    time: activityTime(file.updatedAt, ctx),
  });
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={detail}
      onPress={onOpen}
      className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 active:bg-muted"
    >
      <Icon
        icon={file.path === "profile.md" ? NotebookText : FileText}
        color="accent-muted-foreground"
      />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
        {name}
      </Text>
      <Text className="text-xs text-muted-foreground">{detail}</Text>
      <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
    </PressScale>
  );
}

/**
 * The connectors the bot may use, each with its status, opening its page;
 * then the connectors screen, where the operator connects more for it.
 */
function BotConnectors({
  bot,
  connectors,
}: {
  readonly bot: Bot;
  readonly connectors: ReadonlyArray<Connector>;
}) {
  const { t } = usePresentation().i18n;
  const open = useOpenConnectors();
  return (
    <>
      {connectors.length === 0 ? (
        <Quiet>{t("details.noConnectors", { name: bot.profile.name })}</Quiet>
      ) : (
        connectors.map((connector) => (
          <PressScale
            key={connector.id}
            depth="row"
            accessibilityRole="button"
            accessibilityLabel={connector.name}
            onPress={() => open({ _tag: "connector", connectorId: connector.id, signIn: false })}
            className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 py-1 active:bg-muted"
          >
            <ConnectorTile name={connector.name} glyph={connector.glyph} />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text numberOfLines={1} className="text-base text-foreground">
                {connector.name}
              </Text>
              <StatusWord connector={connector} />
            </View>
            <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
          </PressScale>
        ))
      )}
      <View className="items-start">
        <Button
          variant="secondary"
          label={t("details.connectors.manage")}
          onPress={() => open({ _tag: "home" })}
        />
      </View>
    </>
  );
}
