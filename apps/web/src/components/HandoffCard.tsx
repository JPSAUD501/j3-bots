// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HandoffEntry } from "@j3-bots/contracts";
import { useState } from "react";
import { handoffPeer } from "@j3-bots/client-runtime/presentation";
import { useBot, useI18n } from "../app/context";
import { cn } from "../lib/cn";
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
    <div className="mt-3 flex w-full max-w-(--layout-compact-card-width) items-start gap-2.5 self-start rounded-bubble border border-border bg-surface p-3.5 shadow-raised">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted [--avatar-cutout:var(--muted)]">
        {other && <AvatarShape avatar={other.profile.avatar} size={18} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-sm">
          <span>{parts(entry.direction === "sent" ? "handoff.to" : "handoff.from", { name })}</span>
          {entry.urgent && (
            <span className="rounded-pill bg-waiting-surface px-2.5 py-0.5 text-2xs font-medium text-waiting">
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
          {entry.state === "unconfirmed" && (
            <span className="text-2xs font-medium text-muted-foreground">
              {t("handoff.unconfirmed")}
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
