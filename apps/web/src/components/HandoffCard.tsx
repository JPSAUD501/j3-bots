// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HandoffEntry } from "@j3-bots/contracts";
import { useState } from "react";
import { useBot, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { handoffPeer } from "../presentation/timeline";
import { AvatarShape } from "./BotAvatar";

const focusRing = "rounded-sm focus-visible:outline-2 focus-visible:outline-accent";

/**
 * A message between two bots, in either one's conversation: the one this bot
 * sent, or one it received. The other bot's name goes to its conversation;
 * the text opens in full where it is.
 */
export function HandoffCard({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
  const { t, parts } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const other = useBot(handoffPeer(entry));
  // A deleted teammate has no conversation to go to.
  const name = other ? (
    <button
      key="name"
      type="button"
      onClick={onOpen}
      className={cn("font-medium underline-offset-2 hover:underline", focusRing)}
    >
      {other.profile.name}
    </button>
  ) : (
    <span key="name" className="font-medium">
      {t("bot.unknown")}
    </span>
  );
  return (
    <div className="mt-2 flex w-full max-w-(--layout-compact-card-width) items-start gap-2.5 self-start rounded-md border border-border bg-surface px-3 py-2.5">
      <span className="mt-0.5 [--avatar-cutout:var(--surface)]">
        {other && <AvatarShape avatar={other.profile.avatar} size={18} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span>{parts(entry.direction === "sent" ? "handoff.to" : "handoff.from", { name })}</span>
          {entry.urgent && (
            <span className="rounded-sm bg-waiting-surface px-1 text-2xs font-medium text-waiting">
              {t("handoff.urgent")}
            </span>
          )}
          {entry.state === "not-delivered" && (
            <span className="text-2xs font-medium text-blocked">{t("handoff.notDelivered")}</span>
          )}
          {entry.state === "stopped" && (
            <span className="text-2xs font-medium text-muted-foreground">
              {t("handoff.stopped")}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className={cn(
            "text-start text-sm whitespace-pre-wrap break-words text-muted-foreground",
            !expanded && "line-clamp-2",
            focusRing,
          )}
        >
          {entry.text}
        </button>
      </div>
    </div>
  );
}
