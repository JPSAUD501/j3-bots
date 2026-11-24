// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot } from "@j3-bots/contracts";
import { GlobeIcon } from "lucide-react";
import { useI18n } from "../app/context";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { actsInBrowser } from "./BrowserPanel";
import { useBrowserTabs } from "./context";
import { statusKey } from "./status";
import { frontTab } from "@j3-bots/client-runtime/presentation";

/**
 * In the conversation's header while the bot has a tab: a globe that opens
 * the viewer. Its mark breathes while the bot acts in the browser, and holds
 * still in the waiting color while this device has control.
 */
export function BrowserIndicator({
  bot,
  open,
  onOpen,
}: {
  readonly bot: Bot;
  /** The viewer is open. */
  readonly open: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const tabs = useBrowserTabs(bot.id);
  const tab = tabs === null ? null : frontTab(tabs);
  if (tab === null) return null;
  const yours = tabs?.some((each) => each.controller === "you") === true;
  const acting = !yours && actsInBrowser(bot);
  return (
    <Button
      variant="ghost-muted"
      size="icon"
      onClick={onOpen}
      aria-pressed={open}
      aria-label={t("browser.header.open", { name: bot.profile.name })}
      aria-description={t(statusKey(yours ? "you" : tab.controller))}
      className="pop-in relative"
    >
      <GlobeIcon />
      {(acting || yours) && (
        <span
          aria-hidden
          className={cn(
            "absolute end-1.5 top-1.5 size-2 rounded-pill ring-2 ring-background",
            yours ? "bg-waiting" : "live-mark bg-foreground",
          )}
        />
      )}
    </Button>
  );
}
