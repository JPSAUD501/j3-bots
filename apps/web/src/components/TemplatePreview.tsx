// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotTemplate, RoutineTrigger, TemplateRoutine } from "@j3-bots/contracts";
import { scheduleInWords } from "@j3-bots/client-runtime/wording";
import { CalendarClockIcon, ChevronRightIcon, ScrollTextIcon, WebhookIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePresentation } from "../app/context";
import { BotAvatar } from "./avatar/BotAvatar";

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

/** A part of the template under its heading, with what it says when it holds nothing. */
function Part({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** One skill or routine: its name, a line under it, and its whole text when opened. */
function Folded({
  icon,
  name,
  line,
  text,
}: {
  readonly icon: ReactNode;
  readonly name: string;
  readonly line?: string;
  readonly text: string;
}) {
  return (
    <details className="group rounded-md border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-sm marker:hidden [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-muted-foreground [&>svg]:size-4">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{name}</span>
          {line !== undefined && (
            <span className="truncate text-xs text-muted-foreground">{line}</span>
          )}
        </span>
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast) group-open:rotate-90"
        />
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
        {text}
      </pre>
    </details>
  );
}

/**
 * Everything a template makes a bot be and do, in full: who it is, its job,
 * each skill's text and each routine's instruction, a click away. Nothing in
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
  const triggerOf = (routine: TemplateRoutine): RoutineTrigger =>
    routine.trigger._tag === "webhook"
      ? routine.trigger
      : { _tag: "schedule", cron: routine.trigger.cron, timeZone: ctx.timeZone };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <BotAvatar avatar={avatar} seed={`template:${name}`} state="idle" size={48} still />
        <div className="flex min-w-0 flex-col">
          <span className="display-type truncate text-lg">{name}</span>
          {title !== "" && <span className="truncate text-sm text-muted-foreground">{title}</span>}
        </div>
      </div>

      <Part title={t("template.job")}>
        <p className="text-sm whitespace-pre-wrap">{job === "" ? t("template.job.empty") : job}</p>
      </Part>

      <Part title={t("template.skills")}>
        {template.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("template.skills.none")}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {template.skills.map((skill) => (
              <Folded
                key={skill.name}
                icon={<ScrollTextIcon />}
                name={skill.name}
                text={skill.text}
              />
            ))}
          </div>
        )}
      </Part>

      <Part title={t("template.routines")}>
        {template.routines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("template.routines.none")}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {keyed(template.routines).map(({ routine, key }) => {
              const trigger = triggerOf(routine);
              return (
                <Folded
                  key={key}
                  icon={trigger._tag === "webhook" ? <WebhookIcon /> : <CalendarClockIcon />}
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
              <p className="text-xs text-muted-foreground">{routinesNote}</p>
            )}
          </div>
        )}
      </Part>

      {children}
    </div>
  );
}
