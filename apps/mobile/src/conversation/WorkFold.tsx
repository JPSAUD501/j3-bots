// SPDX-License-Identifier: AGPL-3.0-or-later
import { millisBetween, shortDuration } from "@j3-bots/client-runtime/presentation";
import { useWorkSteps } from "@j3-bots/client-runtime/react";
import { workFoldTitle } from "@j3-bots/client-runtime/wording";
import type { WorkFoldEntry, WorkStep } from "@j3-bots/contracts";
import {
  Bot,
  Check,
  ChevronRight,
  Ellipsis,
  FileText,
  Globe,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { usePresentation } from "../presentation.tsx";
import { monospace } from "./MessageText.tsx";

const stepIcon = {
  command: Terminal,
  edit: Pencil,
  read: FileText,
  search: Search,
  web: Globe,
  tool: Wrench,
  delegation: Bot,
  other: Ellipsis,
} as const satisfies Record<WorkStep["kind"], LucideIcon>;

/**
 * A turn's work in one line, "Worked for 2m", that opens to every step.
 * Never opens by itself; its steps are read only while it is open.
 */
export function WorkFold({ entry }: { readonly entry: WorkFoldEntry }) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const { status } = entry;
  const [open, setOpen] = useState(false);
  const failed = status._tag === "finished" && status.ending === "failed";
  const title =
    status._tag === "running"
      ? t("presence.working")
      : workFoldTitle(status.ending, millisBetween(entry.createdAt, status.finishedAt), ctx);
  const count = entry.stepCount > 0 ? plural("work.steps", entry.stepCount) : null;
  return (
    <View className="mt-2 px-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={count === null ? title : `${title}, ${count}`}
        onPress={() => setOpen((was) => !was)}
        className="min-h-11 flex-row items-center gap-1.5 self-start"
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon
            icon={ChevronRight}
            size={14}
            color={failed ? "accent-blocked" : "accent-muted-foreground"}
          />
        </View>
        <Text className={`text-xs ${failed ? "text-blocked" : "text-muted-foreground"}`}>
          {title}
        </Text>
        {count !== null && <Text className="text-xs text-muted-foreground">· {count}</Text>}
      </Pressable>
      {open && <Steps foldId={entry.id} />}
    </View>
  );
}

function Steps({ foldId }: { readonly foldId: WorkFoldEntry["id"] }) {
  const { t } = usePresentation().i18n;
  const state = useWorkSteps(foldId);
  if (state === null || state.phase === "loading") {
    return <Text className="py-2 ps-5 text-xs text-muted-foreground">{t("work.loading")}</Text>;
  }
  return (
    <View className="ms-1.5 border-s border-border ps-3">
      {state.steps.map((step) => (
        <View key={step.id} className="min-h-7 flex-row items-start gap-2 py-1">
          <View className="mt-px">
            <Icon icon={stepIcon[step.kind]} size={14} color="accent-muted-foreground" />
          </View>
          {/* Long commands and paths wrap: every step reads in full. */}
          {step.kind === "command" ? (
            <Text
              selectable
              className="flex-1 text-2xs text-foreground"
              style={{ fontFamily: monospace }}
            >
              {step.label}
            </Text>
          ) : (
            <Text selectable className="flex-1 text-xs text-foreground">
              {step.label}
            </Text>
          )}
          <StepStatus step={step} />
        </View>
      ))}
    </View>
  );
}

function StepStatus({ step }: { readonly step: WorkStep }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  switch (step.status) {
    case "running":
      return <Text className="text-2xs text-muted-foreground">{t("work.stepRunning")}</Text>;
    case "failed":
      return (
        <View accessible accessibilityLabel={t("work.stepFailed")}>
          <Icon icon={X} size={14} color="accent-blocked" />
        </View>
      );
    case "completed":
      return (
        <View
          accessible
          accessibilityLabel={t("work.stepDone")}
          className="flex-row items-center gap-1.5"
        >
          {step.finishedAt !== null && (
            <Text className="text-2xs text-muted-foreground">
              {shortDuration(millisBetween(step.startedAt, step.finishedAt), ctx.i18n)}
            </Text>
          )}
          <Icon icon={Check} size={14} color="accent-muted-foreground" />
        </View>
      );
  }
}
