// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NoticeEntry } from "@j3-bots/contracts";
import {
  CircleAlertIcon,
  CircleArrowUpIcon,
  CirclePauseIcon,
  CornerDownRightIcon,
  OctagonPauseIcon,
  UserRoundCheckIcon,
} from "lucide-react";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { noticeText } from "@j3-bots/client-runtime/wording";
import { Button } from "./ui/button";

/**
 * A quiet line where something stopped, or where a bot changed something the
 * operator should know about, with a way to retry when the server still
 * accepts one. It is part of the timeline, not an announcement: the
 * header's live region is what tells a screen reader the state changed.
 */
export function NoticeLine({
  entry,
  onRetry,
  onOpenConversation,
}: {
  entry: NoticeEntry;
  onRetry: () => void;
  onOpenConversation: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { notice } = entry;
  const failed =
    notice._tag === "turn-failed" ||
    notice._tag === "handoff-failed" ||
    notice._tag === "undelivered";
  const Icon =
    notice._tag === "chain-stopped"
      ? OctagonPauseIcon
      : notice._tag === "waiting-in-conversation"
        ? CirclePauseIcon
        : notice._tag === "operator-named"
          ? UserRoundCheckIcon
          : CircleAlertIcon;
  return (
    <div
      className={cn(
        "my-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs",
        failed
          ? "text-blocked"
          : notice._tag === "waiting-in-conversation"
            ? "text-waiting"
            : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{noticeText(notice, ctx)}</span>
      {entry.retryable && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t("notice.retry")}
        </Button>
      )}
      {notice._tag === "waiting-in-conversation" && (
        <Button variant="ghost" size="sm" onClick={onOpenConversation}>
          <CornerDownRightIcon aria-hidden />
          {t("notice.openConversation")}
        </Button>
      )}
    </div>
  );
}

/** In place of an entry, or a notice, of a kind added after this version of the app. */
export function NeedsUpdateLine() {
  const { t } = usePresentation().i18n;
  return (
    <div className="my-2 flex items-center justify-center gap-x-2 text-center text-xs text-muted-foreground">
      <CircleArrowUpIcon aria-hidden className="size-3.5 shrink-0" />
      <span>{t("entry.needsUpdate")}</span>
    </div>
  );
}
