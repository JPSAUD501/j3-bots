// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TabLine } from "@j3-bots/client-runtime/presentation";
import { tabLineWords } from "@j3-bots/client-runtime/wording";
import type { BotId } from "@j3-bots/contracts";
import { useBots, useI18n } from "../app/context";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

/**
 * The tab's one quiet line, by its address: who is on it and who acts, that
 * they wait for the person, the countdown with Now, or Continue after Wait
 * for me. It is the only word that changes; nothing else on the screen
 * blinks. `line` is what `tabLine` (or `usePageUse`) gives. Where the person
 * cannot give the tab back from here, as on the desktop's own browser, whose
 * hold ends only as they stop using the page, the words come without Now or
 * Continue.
 */
export function QuietLine({
  line,
  onNow,
  onContinue,
  className,
}: {
  readonly line: TabLine;
  readonly onNow?: (() => void) | undefined;
  readonly onContinue?: (() => void) | undefined;
  readonly className?: string;
}) {
  const i18n = useI18n();
  const bots = useBots();
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name ?? i18n.t("bot.unknown");
  const { text, action } = tabLineWords(line, nameOf, i18n);
  const act = action === "now" ? onNow : action === "continue" ? onContinue : undefined;
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span role="status" className="min-w-0 truncate text-xs text-muted-foreground">
        {text}
      </span>
      {act !== undefined && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={act}>
          {i18n.t(action === "now" ? "browser.line.now" : "browser.line.continue")}
        </Button>
      )}
    </span>
  );
}
