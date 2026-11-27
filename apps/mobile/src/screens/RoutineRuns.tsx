// SPDX-License-Identifier: AGPL-3.0-or-later
import { trackTrigger } from "@j3-bots/client-runtime/presentation";
import { useRoutineRuns, useRoutines } from "@j3-bots/client-runtime/react";
import { routineLines, routineRunLines } from "@j3-bots/client-runtime/wording";
import { hasSeveralSteps, type RoutineRun } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleSlash,
  CircleX,
  type LucideIcon,
} from "lucide-react-native";
import { useLayoutEffect } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { MiniRail, RoutineTrackRest } from "../conversation/RoutineTrack.tsx";
import type { Screens } from "../navigation.tsx";
import { usePresentation } from "../presentation.tsx";

const RUN_ICON: Record<RoutineRun["status"], readonly [LucideIcon, string]> = {
  running: [CircleDot, "accent-accent"],
  delivered: [CircleCheck, "accent-success"],
  silent: [CircleMinus, "accent-muted-foreground"],
  failed: [CircleX, "accent-blocked"],
  skipped: [CircleSlash, "accent-muted-foreground"],
};

/**
 * One run: what it did and when, why it failed or was skipped, and what it
 * noted. A run of a routine with several steps shows its mini rail over it.
 */
function RunRow({ run }: { readonly run: RoutineRun }) {
  const ctx = usePresentation();
  const lines = routineRunLines(run, ctx);
  const [icon, color] = RUN_ICON[run.status];
  return (
    <View accessible className="flex-row items-start gap-3 py-2.5">
      <View className="pt-0.5">
        <Icon icon={icon} color={color} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        {run.steps !== undefined && (
          <View className="mt-1 mb-1">
            <MiniRail run={run} />
          </View>
        )}
        <View className="flex-row items-baseline gap-3">
          <Text
            className={`min-w-0 flex-1 text-base ${lines.failed ? "text-blocked" : "text-foreground"}`}
          >
            {lines.status}
          </Text>
          <Text className="text-xs text-muted-foreground">{lines.when}</Text>
        </View>
        {lines.reason !== null && (
          <Text className={`text-sm ${lines.failed ? "text-blocked" : "text-muted-foreground"}`}>
            {lines.reason}
          </Text>
        )}
        {lines.attempts !== null && (
          <Text className="text-xs text-muted-foreground">{lines.attempts}</Text>
        )}
        {run.note !== null && (
          <Text className="mt-1 border-s-2 border-border ps-2 text-sm text-muted-foreground">
            {run.note}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * A routine's recent runs, newest first, under its schedule and when it runs
 * next: whether each reported back, had nothing to say, failed and why, or
 * was skipped. Its bot's routines stay open here, so the list is read again
 * as a run starts or ends. A routine with several steps opens on its track
 * at rest.
 */
export function RoutineRunsScreen({
  navigation,
  route,
}: NativeStackScreenProps<Screens, "routineRuns">) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const insets = useSafeAreaInsets();
  const { botId, routineId } = route.params;
  const routines = useRoutines(botId);
  const runs = useRoutineRuns(routineId);
  const routine =
    routines?._tag === "ready"
      ? (routines.value.find((candidate) => candidate.id === routineId) ?? null)
      : null;
  const name = routine?.name ?? t("routine.runs.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  if (runs?._tag === "not-found") {
    return (
      <View className="flex-1 bg-background">
        <Section>
          <Quiet>{t("routine.runs.gone")}</Quiet>
        </Section>
      </View>
    );
  }
  const lines = routine === null ? null : routineLines(routine, ctx);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
    >
      {lines !== null && (
        <Section>
          <View className="gap-0.5">
            <Text face={lines.expression ? "mono" : "text"} className="text-base text-foreground">
              {lines.schedule}
            </Text>
            {lines.status !== null && (
              <Text
                className={
                  lines.status.blocked ? "text-sm text-blocked" : "text-sm text-muted-foreground"
                }
              >
                {lines.status.text}
              </Text>
            )}
          </View>
        </Section>
      )}
      {routine !== null && hasSeveralSteps(routine.steps, routine.botId) && (
        <Section>
          <RoutineTrackRest
            name={routine.name}
            trigger={trackTrigger(routine.trigger, routine.connectorName ?? null)}
            owner={routine.botId}
            steps={routine.steps}
          />
        </Section>
      )}
      {/* Until the routine is known, the screen's title already says what this is. */}
      <Section title={routine === null ? undefined : t("routine.runs.title")}>
        {runs === null || runs._tag === "loading" ? (
          <SkeletonRows />
        ) : runs.value.runs.length === 0 ? (
          <Quiet>{t("routine.runs.empty")}</Quiet>
        ) : (
          <View>
            {runs.value.runs.map((run, index) => (
              <View key={run.id} className={index === 0 ? "" : "border-t border-border"}>
                <RunRow run={run} />
              </View>
            ))}
            {runs.value.hasOlder && (
              <Text className="pt-2 text-xs text-muted-foreground">
                {t("routine.runs.limit", { count: runs.value.runs.length })}
              </Text>
            )}
          </View>
        )}
      </Section>
    </ScrollView>
  );
}
