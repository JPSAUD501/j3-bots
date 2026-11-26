// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import type { Plan } from "@j3-bots/contracts";
import {
  liveLine,
  type PlanLine,
  planLines,
  planProgress,
  planWindow,
} from "@j3-bots/client-runtime/presentation";
import { planStepText, planTitle } from "@j3-bots/client-runtime/wording";
import type { BotColor } from "@j3-bots/design-tokens";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { sprung, type Sprung } from "../lib/sprung";
import { touchTarget } from "../lib/touchTarget";
import { SwapText } from "./SwapText";

/** How tall one step's line is in the running card, in px: the live mark travels by it. */
const LINE = 26;

/**
 * A step's mark: a ring for one still to do, a check for one done. A step
 * that ends while its card is on screen draws its check and pops. The step
 * being done now shows no mark of its own: the card's live mark stands on it.
 */
function StepMark({ line, live }: { readonly line: PlanLine; readonly live: boolean }) {
  // Whether it was done when first drawn: only one that ends in front of the operator draws itself.
  const [doneAtFirst] = useState(line.state === "done");
  if (line.state === "done") {
    return (
      <span className={cn("plan-mark plan-mark-done", !doneAtFirst && "pop-in")}>
        <CheckIcon aria-hidden className={cn("size-2.5", !doneAtFirst && "draw-check")} />
      </span>
    );
  }
  return <span className="plan-mark plan-mark-open" data-live={live || undefined} />;
}

/**
 * The one live mark of a running plan: a ring in the bot's color with a dot
 * that breathes, on the step being done now. It goes from the step that ended
 * to the one that starts on `slide`, from where it is and at the speed it has,
 * so a plan that moves on fast never stops it. It pops in where the first
 * step runs, and goes while none does.
 */
function LiveMark({ at }: { readonly at: number | null }) {
  const mark = useRef<HTMLSpanElement>(null);
  const travel = useRef<Sprung<"y"> | null>(null);
  const placed = useRef(false);
  useEffect(() => {
    const element = mark.current;
    if (element === null) return;
    const moving = sprung({ y: 0 }, "slide", ({ y }) => {
      element.style.transform = `translateY(${Math.round(y * 4) / 4}px)`;
    });
    travel.current = moving;
    return () => {
      moving.stop();
      travel.current = null;
    };
  }, []);
  useEffect(() => {
    if (at === null) {
      placed.current = false;
      return;
    }
    // Where it first shows it is simply there; after that it travels.
    if (placed.current) travel.current?.to({ y: at * LINE });
    else travel.current?.jump({ y: at * LINE });
    placed.current = true;
  }, [at]);
  return (
    <span ref={mark} aria-hidden className="plan-live" data-on={at !== null}>
      <span className="plan-live-ring">
        <span className="plan-live-dot live-mark" />
      </span>
    </span>
  );
}

/**
 * A running turn's plan: a short card under the turn's line, each step one
 * line, the done ones checked, the one being done now carrying the live mark.
 * A long plan shows around where the bot is, with a line that counts the steps
 * before and one for those after. `tint` is the bot's color, which the live
 * mark takes.
 */
export function PlanCard({ plan, tint }: { readonly plan: Plan; readonly tint: BotColor }) {
  const i18n = useI18n();
  const { plural } = i18n;
  const shown = planWindow(plan);
  const lead = shown.before > 0 ? 1 : 0;
  const live = liveLine(shown.lines);
  return (
    <div
      role="group"
      aria-label={planTitle(planProgress(plan), i18n)}
      className="plan-card arrive origin-top-left"
      style={{ "--plan-live": `var(--bot-${tint})` } as CSSProperties}
    >
      <ol className="flex flex-col">
        {shown.before > 0 && <li className="plan-count">{plural("plan.before", shown.before)}</li>}
        {shown.lines.map((line, at) => (
          <li key={line.index} className="plan-step" data-state={line.state}>
            <StepMark line={line} live={live === at} />
            <span className="sr-only">{planStepText(line.state, i18n)}: </span>
            <SwapText text={line.text} className="min-w-0 flex-1" />
          </li>
        ))}
        {shown.after > 0 && <li className="plan-count">{plural("plan.after", shown.after)}</li>}
      </ol>
      <LiveMark at={live === null ? null : live + lead} />
    </div>
  );
}

/**
 * What a turn's plan settles into once the turn is over: one quiet line,
 * "Plan done, 4 of 4", that opens every step. `folding` when the turn ended
 * while on screen: the line pops in, as the turn's own line does.
 */
export function PlanLine({ plan, folding }: { readonly plan: Plan; readonly folding: boolean }) {
  const i18n = useI18n();
  return (
    <Collapsible.Root className="self-start">
      <Collapsible.Trigger
        className={cn(
          "pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
          touchTarget,
          folding && "arrive-pop origin-left",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90"
        />
        <span>{planTitle(planProgress(plan), i18n)}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
        <ol className="mt-1.5 ms-1.5 flex flex-col border-s border-border ps-3">
          {planLines(plan).map((line) => (
            <li key={line.index} className="plan-step plan-step-whole" data-state={line.state}>
              <StepMark line={line} live={false} />
              <span className="sr-only">{planStepText(line.state, i18n)}: </span>
              <span className="min-w-0 flex-1 wrap-break-word">{line.text}</span>
            </li>
          ))}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
