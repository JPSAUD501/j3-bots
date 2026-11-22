// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Loaded } from "@j3-bots/client-runtime";
import {
  useBotFiles,
  useEngineStatus,
  useJ3Client,
  useMemory,
  useRoutines,
} from "@j3-bots/client-runtime/react";
import {
  activityTime,
  botModelName,
  fileSize,
  memoryFileName,
  permissionModeText,
  routineLines,
} from "@j3-bots/client-runtime/wording";
import type { Bot, MemoryFile, Routine } from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import {
  CalendarClock,
  ChevronRight,
  CirclePause,
  FileText,
  NotebookText,
  Webhook,
} from "lucide-react-native";
import { type ReactElement, useMemo } from "react";
import { Pressable, ScrollView, Switch, useWindowDimensions, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/Avatar.tsx";
import { confirm, DeleteButton, Quiet, Section } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import type { Navigation } from "../navigation.tsx";
import { usePresentation } from "../presentation.tsx";
import { useColor } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { FileCard } from "../conversation/FileCard.tsx";
import { EntryWidths } from "../conversation/widths.ts";
import { useBotActions } from "./actions.ts";

/** A read's list once loaded, or null while it loads; a bot that is gone has none. */
const loadedList = <A,>(loaded: Loaded<ReadonlyArray<A>> | null): ReadonlyArray<A> | null =>
  loaded === null || loaded._tag === "loading" ? null : loaded._tag === "ready" ? loaded.value : [];

/**
 * Answers: what is this bot, and what runs without me. Its profile, its
 * routines with a switch to pause each, the files it sent, its memory, the
 * model it runs on, a fresh start, and, last and apart, deleting it.
 */
export function BotDetails({ bot }: { readonly bot: Bot }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const insets = useSafeAreaInsets();
  // The details take the window's width; a section is inset 16 px on each side.
  const column = useWindowDimensions().width - 32;
  const fileWidths = useMemo(
    () => ({ bubble: column, card: column, compactCard: column, column }),
    [column],
  );
  const navigation = useNavigation<Navigation>();
  const actions = useBotActions();
  const engine = useEngineStatus();
  const routines = loadedList(useRoutines(bot.id));
  const files = loadedList(useBotFiles(bot.id));
  const memory = loadedList(useMemory({ _tag: "bot", botId: bot.id }));
  const { name, title, job, avatar } = bot.profile;
  const mode = permissionModeText(bot.permissionMode, ctx.i18n);
  const modelName = botModelName(engine._tag === "ready" ? engine.value : null, bot);
  const loading = <Quiet>{t("details.loading")}</Quiet>;
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      <View className="items-start gap-3 border-b border-border px-4 py-5">
        <BotAvatar avatar={avatar} state={bot.state} size={72} />
        <View>
          <View className="flex-row items-center gap-2">
            <Text accessibilityRole="header" className="text-xl font-medium text-foreground">
              {name}
            </Text>
            {bot.primary && (
              <Text className="rounded-sm bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                {t("details.primary")}
              </Text>
            )}
          </View>
          {title !== "" && <Text className="text-sm text-muted-foreground">{title}</Text>}
        </View>
        <Text className="text-sm text-foreground">
          {job === "" ? t("details.noJob", { name }) : job}
        </Text>
        <Button
          label={t("details.editProfile", { name })}
          onPress={() => navigation.navigate("editBot", { botId: bot.id })}
        />
      </View>

      <Section title={t("details.routines")}>
        {routines === null ? (
          loading
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

      <Section title={t("details.files")}>
        {files === null ? (
          loading
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

      <Section title={t("details.memory")}>
        {memory === null ? (
          loading
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

      <Section title={t("details.model")}>
        <View>
          <Text className="text-xs text-muted-foreground">{t("details.runsOn")}</Text>
          <Text className="text-sm text-foreground">
            {modelName ?? t("details.modelUnavailable")}
          </Text>
        </View>
        <View>
          <Text className="text-xs text-muted-foreground">{t("details.permissionMode")}</Text>
          <Text className="text-sm text-foreground">{mode.name}</Text>
          <Text className="text-xs text-muted-foreground">{mode.description}</Text>
        </View>
      </Section>

      <Section title={t("details.workingContext")}>
        <Quiet>
          {t("details.freshStartHint", { name })} {t("details.freshStartStops", { name })}
        </Quiet>
        <View className="items-start">
          <Button
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
      <View className="items-start px-4 py-4">
        <DeleteButton
          label={t("details.delete", { name })}
          title={t("details.delete.title", { name })}
          body={t("details.delete.body", { name })}
          cancel={t("details.delete.cancel", { name })}
          onDelete={() => actions.remove(bot)}
        />
      </View>
    </ScrollView>
  );
}

/**
 * A routine: its name, its trigger in words, its next run, how its last run
 * went, and a switch that pauses it. The rest of the row opens its runs.
 */
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
  const on = useColor("accent-accent");
  const off = useColor("accent-control-off");
  const thumb = useColor("accent-control-thumb");
  const lines = routineLines(routine, ctx);
  const icon = !routine.enabled
    ? CirclePause
    : routine.trigger._tag === "webhook"
      ? Webhook
      : CalendarClock;
  const last = lines.lastRun;
  return (
    <View className="flex-row items-start gap-3">
      <View className="pt-0.5">
        <Icon icon={icon} color={routine.enabled ? "accent-success" : "accent-muted-foreground"} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("routine.runs.hint")}
        onPress={onOpen}
        className="-my-1 min-w-0 flex-1 gap-0.5 rounded-md py-1 active:bg-muted"
      >
        <Text numberOfLines={1} className="text-base text-foreground">
          {routine.name}
        </Text>
        <Text face={lines.expression ? "mono" : "text"} className="text-sm text-muted-foreground">
          {lines.schedule}
        </Text>
        {lines.status !== null && (
          <Text className="text-xs text-muted-foreground">{lines.status}</Text>
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
      </Pressable>
      <Switch
        accessibilityLabel={routine.name}
        value={routine.enabled}
        onValueChange={(enabled) =>
          void client.setRoutineEnabled(routine.id, enabled).then((result) => {
            if (result._tag === "failed") {
              say(
                t(enabled ? "routine.resumeFailed" : "routine.pauseFailed", { name: routine.name }),
              );
            }
          })
        }
        trackColor={{ true: on, false: off }}
        thumbColor={thumb}
      />
    </View>
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
    <Pressable
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
    </Pressable>
  );
}
