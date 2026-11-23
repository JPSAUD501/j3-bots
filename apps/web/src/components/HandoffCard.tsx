// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HandoffEntry } from "@j3-bots/contracts";
import { type ReactElement, useState } from "react";
import { handoffPeer } from "@j3-bots/client-runtime/presentation";
import { useBot, useI18n } from "../app/context";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { BotAvatar } from "./avatar/BotAvatar";
import { MessageText } from "./MessageText";

const focusRing = "rounded-sm focus-visible:outline-2 focus-visible:outline-accent";

/**
 * A message between two bots, in either one's conversation: the card of the
 * one this bot sent, or the line and bubble of one it received. The other
 * bot's name goes to its conversation.
 */
export function HandoffCard({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
  return entry.direction === "sent" ? (
    <SentHandoff entry={entry} onOpen={onOpen} />
  ) : (
    <ReceivedHandoff entry={entry} onOpen={onOpen} />
  );
}

/** Where the message stands, when it is anything but sent. */
function HandoffMarks({ entry }: { entry: HandoffEntry }) {
  const { t } = useI18n();
  return (
    <>
      {entry.urgent && (
        <span className="rounded-pill bg-waiting-surface px-2.5 py-0.5 text-2xs font-medium text-waiting">
          {t("handoff.urgent")}
        </span>
      )}
      {entry.state === "not-delivered" && (
        <span className="text-2xs font-medium text-blocked">{t("handoff.notDelivered")}</span>
      )}
      {entry.state === "stopped" && (
        <span className="text-2xs font-medium text-muted-foreground">{t("handoff.stopped")}</span>
      )}
      {entry.state === "unconfirmed" && (
        <span className="text-2xs font-medium text-muted-foreground">
          {t("handoff.unconfirmed")}
        </span>
      )}
    </>
  );
}

/** In the sender's conversation: a compact card whose text opens in full where it is. */
function SentHandoff({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
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
      <span className="mt-0.5 shrink-0">
        {other && (
          <BotAvatar avatar={other.profile.avatar} seed={other.id} state="idle" size={24} still />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-sm">
          <span>{parts("handoff.to", { name })}</span>
          <HandoffMarks entry={entry} />
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

/**
 * In the recipient's conversation: a centred line naming the sender, which
 * goes to its conversation, over the message in a bubble of the sender's tint.
 */
function ReceivedHandoff({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
  const { t, parts } = useI18n();
  const other = useBot(handoffPeer(entry));
  const sender = other ? (
    <span key="name" className="inline-flex items-center gap-1.5">
      <BotAvatar avatar={other.profile.avatar} seed={other.id} state="idle" size={16} still />
      <span className="underline-offset-2 group-hover:underline">{other.profile.name}</span>
    </span>
  ) : (
    <span key="name">{t("bot.unknown")}</span>
  );
  const line = parts<"handoff.messageFrom", ReactElement>("handoff.messageFrom", { name: sender });
  return (
    <div className="mt-3 flex w-full flex-col items-start gap-1">
      <div className="flex w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 py-1 text-2xs text-muted-foreground">
        {/* A deleted teammate has no conversation to go to. */}
        {other ? (
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "group inline-flex items-center gap-1.5 hover:text-foreground",
              focusRing,
            )}
          >
            {line}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5">{line}</span>
        )}
        <HandoffMarks entry={entry} />
      </div>
      <div
        className={cn(
          "max-w-(--layout-bubble-width) rounded-bubble rounded-bl-sm bg-(--tint-bubble) px-3.5 py-2 text-base text-bubble-bot-foreground pointer-coarse:text-lg",
          tintOf(other?.profile.avatar ?? null),
        )}
      >
        <MessageText text={entry.text} />
      </div>
    </div>
  );
}
