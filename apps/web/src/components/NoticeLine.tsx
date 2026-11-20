// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NoticeEntry } from "@j3-bots/contracts";
import { CircleAlertIcon, CirclePauseIcon, CornerDownRightIcon, LinkIcon } from "lucide-react";
import { usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { noticeText } from "../presentation/roster";
import { Button } from "./ui/button";

/** A quiet line where something stopped, with a way to retry when the server still accepts one. */
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
  const failed = notice._tag === "turn-failed" || notice._tag === "undelivered";
  const Icon =
    notice._tag === "chain-stopped"
      ? LinkIcon
      : notice._tag === "waiting-in-conversation"
        ? CirclePauseIcon
        : CircleAlertIcon;
  return (
    <div
      role="status"
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
