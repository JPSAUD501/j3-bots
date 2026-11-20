// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room } from "@j3-bots/contracts";
import { ChevronLeftIcon, PanelRightIcon, SquareIcon } from "lucide-react";
import type { Ref } from "react";
import { useBots, useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { presenceLine } from "../presentation/roster";
import { BotAvatar, RoomAvatar } from "./BotAvatar";
import { toneClass } from "./RosterRow";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";

interface ConversationHeaderProps {
  readonly subject:
    | { readonly _tag: "bot"; readonly bot: Bot }
    | { readonly _tag: "room"; readonly room: Room };
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  /** Phones only: back to the roster. */
  readonly onBack: () => void;
  readonly onStop: () => void;
  readonly stopShortcut: string;
  readonly titleRef?: Ref<HTMLButtonElement>;
}

/** Who this is, and one line saying what it is doing now. The name opens the details. */
export function ConversationHeader({
  subject,
  detailsOpen,
  onToggleDetails,
  onBack,
  onStop,
  stopShortcut,
  titleRef,
}: ConversationHeaderProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const bots = useBots();
  const name = subject._tag === "bot" ? subject.bot.profile.name : subject.room.name;
  const line =
    subject._tag === "bot"
      ? presenceLine(subject.bot, ctx)
      : {
          text: t("room.members", {
            names: new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(
              subject.room.members.map((id) => bots.get(id)?.profile.name ?? t("bot.unknown")),
            ),
          }),
          tone: "muted" as const,
        };
  const running =
    subject._tag === "bot" &&
    (subject.bot.state._tag === "thinking" || subject.bot.state._tag === "working");
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2 @tablet:px-3">
      <Button
        variant="ghost"
        size="icon"
        className="@tablet:hidden"
        onClick={onBack}
        aria-label={t("conversation.back")}
      >
        <ChevronLeftIcon />
      </Button>
      <button
        ref={titleRef}
        type="button"
        onClick={onToggleDetails}
        aria-expanded={detailsOpen}
        aria-label={t("conversation.openDetails", { name })}
        className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 text-start hover:bg-muted"
      >
        {subject._tag === "bot" ? (
          <BotAvatar avatar={subject.bot.profile.avatar} state={subject.bot.state} size={28} />
        ) : (
          <RoomAvatar
            size={28}
            members={subject.room.members.flatMap((id) => {
              const bot = bots.get(id);
              return bot ? [bot.profile.avatar] : [];
            })}
          />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          {line && (
            <span className={cn("truncate text-2xs", toneClass[line.tone])} aria-live="polite">
              {line.text}
            </span>
          )}
        </span>
      </button>
      <span className="ms-auto flex items-center gap-1">
        {running && (
          <Button size="sm" onClick={onStop} aria-keyshortcuts={stopShortcut}>
            <SquareIcon className="size-3 fill-current" aria-hidden />
            {t("conversation.stop")}
            <Kbd className="hidden pointer-fine:inline-flex">{stopShortcut}</Kbd>
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon"
          onClick={onToggleDetails}
          aria-pressed={detailsOpen}
          aria-label={t("conversation.details")}
          className="hidden @tablet:inline-flex"
        >
          <PanelRightIcon />
        </Button>
      </span>
    </header>
  );
}
