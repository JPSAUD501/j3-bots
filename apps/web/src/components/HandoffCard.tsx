// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HandoffEntry } from "@j3-bots/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import { useBot, useI18n } from "../app/context";
import { AvatarShape } from "./BotAvatar";

/** A bot sent a teammate a message. Opening it shows the exchange. */
export function HandoffCard({ entry, onOpen }: { entry: HandoffEntry; onOpen: () => void }) {
  const { t } = useI18n();
  const recipient = useBot(entry.recipientId);
  const name = recipient?.profile.name ?? t("bot.unknown");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group mt-2 flex w-full max-w-[min(28rem,92%)] items-start gap-2.5 self-start rounded-md border border-border bg-surface px-3 py-2.5 text-start transition-colors duration-(--duration-fast) hover:bg-muted"
    >
      <span className="mt-0.5 [--avatar-cutout:var(--surface)]">
        {recipient && <AvatarShape avatar={recipient.profile.avatar} size={18} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {t("handoff.asked", { name })}
          {entry.urgent && (
            <span className="rounded-sm bg-waiting-surface px-1 text-2xs font-medium text-waiting">
              {t("handoff.urgent")}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{entry.text}</span>
      </span>
      <ArrowUpRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
      />
    </button>
  );
}
