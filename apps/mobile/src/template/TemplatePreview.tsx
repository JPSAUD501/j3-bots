// SPDX-License-Identifier: AGPL-3.0-or-later
import { scheduleInWords } from "@j3-bots/client-runtime/wording";
import type { BotTemplate, OwnTrigger, TemplateRoutine } from "@j3-bots/contracts";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
  ScrollText,
  Webhook,
} from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Quiet, Section } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { displaySpacing, Text } from "../text.tsx";

/**
 * Each routine with a key from what it says, and how often the same routine
 * came before it: a template may repeat one, and its list never reorders.
 */
const keyed = (routines: ReadonlyArray<TemplateRoutine>) => {
  const seen = new Map<string, number>();
  return routines.map((routine) => {
    const said = JSON.stringify([routine.name, routine.trigger, routine.instruction]);
    const before = seen.get(said) ?? 0;
    seen.set(said, before + 1);
    return { routine, key: `${before}:${said}` };
  });
};

/** One skill or routine: its name and a line under it; pressed, its whole text. */
function Folded({
  icon,
  name,
  line,
  text,
}: {
  readonly icon: LucideIcon;
  readonly name: string;
  readonly line?: string;
  readonly text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="rounded-md border border-border bg-surface">
      <PressScale
        depth="row"
        accessibilityRole="button"
        accessibilityLabel={line === undefined ? name : `${name}, ${line}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-11 flex-row items-center gap-3 rounded-md px-3 py-2 active:bg-muted"
      >
        <Icon icon={icon} color="accent-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base text-foreground">
            {name}
          </Text>
          {line !== undefined && (
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {line}
            </Text>
          )}
        </View>
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} color="accent-muted-foreground" />
      </PressScale>
      {open && (
        <Text
          selectable
          face="mono"
          className="border-t border-border px-3 py-2 text-xs text-foreground"
        >
          {text}
        </Text>
      )}
    </View>
  );
}

/**
 * Everything a template makes a bot be and do, in full: who it is, its job,
 * each skill's text and each routine's instruction, a press away. Nothing in
 * a template is left out of it, so what the operator approves is all there is.
 */
export function TemplatePreview({
  template,
  routinesNote,
  children,
}: {
  readonly template: BotTemplate;
  /** Under the routines, when there are any: what happens to them. */
  readonly routinesNote?: string;
  /** What follows the template's own parts, such as the settings a new bot starts with. */
  readonly children?: ReactNode;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { name, title, job, avatar } = template.profile;
  const triggerOf = (routine: TemplateRoutine): OwnTrigger =>
    routine.trigger._tag === "webhook"
      ? routine.trigger
      : { _tag: "schedule", cron: routine.trigger.cron, timeZone: ctx.timeZone };
  return (
    <View>
      <View className="items-center px-6 pt-2 pb-2">
        <BotAvatar avatar={avatar} seed={`template:${name}`} state="idle" size={72} still />
        <Text
          accessibilityRole="header"
          face="display"
          numberOfLines={1}
          className="mt-3 text-2xl text-foreground"
          style={{ letterSpacing: displaySpacing(24) }}
        >
          {name}
        </Text>
        {title !== "" && (
          <Text className="mt-1 text-center text-sm text-muted-foreground">{title}</Text>
        )}
      </View>

      <Section open title={t("template.job")}>
        <Text selectable className="text-base text-foreground">
          {job === "" ? t("template.job.empty") : job}
        </Text>
      </Section>

      <Section open title={t("template.skills")}>
        {template.skills.length === 0 ? (
          <Quiet>{t("template.skills.none")}</Quiet>
        ) : (
          template.skills.map((skill) => (
            <Folded key={skill.name} icon={ScrollText} name={skill.name} text={skill.text} />
          ))
        )}
      </Section>

      <Section open title={t("template.routines")}>
        {template.routines.length === 0 ? (
          <Quiet>{t("template.routines.none")}</Quiet>
        ) : (
          <>
            {keyed(template.routines).map(({ routine, key }) => {
              const trigger = triggerOf(routine);
              return (
                <Folded
                  key={key}
                  icon={trigger._tag === "webhook" ? Webhook : CalendarClock}
                  name={routine.name}
                  line={
                    scheduleInWords(trigger, ctx) ??
                    (trigger._tag === "schedule" ? trigger.cron : "")
                  }
                  text={routine.instruction}
                />
              );
            })}
            {routinesNote !== undefined && (
              <Text className="text-xs text-muted-foreground">{routinesNote}</Text>
            )}
          </>
        )}
      </Section>

      {children}
    </View>
  );
}
