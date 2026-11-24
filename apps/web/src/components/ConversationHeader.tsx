// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, Room, WorkFoldEntry } from "@j3-bots/contracts";
import { ChevronLeftIcon, ChevronRightIcon, PanelRightIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTurnAnnouncement } from "@j3-bots/client-runtime/react";
import { useI18n, usePresentation } from "../app/context";
import { useLanding } from "../onboarding/handoff";
import { memberList } from "@j3-bots/client-runtime/wording";
import { MemberStack } from "./avatar/TeamAvatars";
import { LiveBotAvatar, useOffline } from "./avatar/mood";
import { PrimaryBadge } from "./avatar/PrimaryBadge";
import { Button } from "./ui/button";

interface ConversationHeaderProps {
  readonly subject:
    | { readonly _tag: "bot"; readonly bot: Bot }
    | { readonly _tag: "room"; readonly room: Room };
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  /** Phones only: back to the roster. */
  readonly onBack: () => void;
  /** The conversation's work folds: when a turn ends, the line it folds into is said aloud. */
  readonly folds: ReadonlyArray<WorkFoldEntry>;
  /** The name's button, which opens the details. */
  readonly titleRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Told what the bot is doing at each change of state and each new line, then
   * the line a turn folds into, for screen readers (`useTurnAnnouncement`). The
   * region that speaks it lies outside the conversation, so a dialog over the
   * conversation hides all of it from assistive technology (see `isCovered`).
   */
  readonly onAnnounce: (text: string) => void;
  /** Before the details' toggle: in a bot's conversation, the way into its browser while it has a tab. */
  readonly actions?: ReactNode;
}

/**
 * Who this is: a bot's face and name on one line, or a room's members, its
 * name and, under it, who is in it. What a bot is doing is the conversation's
 * to show, in the turn under way and its cards; the header only says it to
 * screen readers, through `onAnnounce`, once at each change. The name opens
 * the details, where Stop is while there is work to stop.
 *
 * Mount one per conversation, so moving to another conversation announces nothing.
 */
export function ConversationHeader({
  subject,
  detailsOpen,
  onToggleDetails,
  onBack,
  folds,
  titleRef,
  onAnnounce,
  actions,
}: ConversationHeaderProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const name = subject._tag === "bot" ? subject.bot.profile.name : subject.room.name;
  // Each change of state and each new line is said once, then how the turn ended; not the first.
  const offline = useOffline();
  // A first bot arriving from the first run lands here.
  const landing = useLanding(subject._tag === "bot" ? subject.bot.id : null);
  useTurnAnnouncement(subject._tag === "bot" ? subject.bot : null, folds, offline, ctx, onAnnounce);

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
      {/* The title button stretches over the whole block, so a click anywhere opens the details. On a
          phone, where it is the only way to the details, the block is a full touch target. */}
      <div className="relative flex min-w-0 items-center @max-tablet:min-h-(--layout-touch-target) gap-2.5 rounded-md px-1.5 py-1 has-[[data-title]:hover]:bg-muted has-[[data-title]:hover]:[--avatar-cutout:var(--muted)] has-[[data-title]:focus-visible]:outline-2 has-[[data-title]:focus-visible]:outline-accent">
        {subject._tag === "bot" ? (
          <PrimaryBadge primary={subject.bot.primary} size={32}>
            <span className="inline-flex" style={{ viewTransitionName: landing }}>
              <LiveBotAvatar bot={subject.bot} size={32} />
            </span>
          </PrimaryBadge>
        ) : (
          <MemberStack members={subject.room.members} size={28} />
        )}
        <span className="flex min-w-0 flex-col items-start">
          <button
            ref={titleRef}
            type="button"
            data-title=""
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            aria-label={t("conversation.openDetails", { name })}
            className="flex min-w-0 items-center gap-0.5 text-start text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md"
          >
            <span className="truncate">{name}</span>
            {/* Phones have no pane button: the chevron says the name opens more. */}
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground @tablet:hidden"
            />
          </button>
          {subject._tag === "room" && (
            <span className="block max-w-full truncate text-2xs text-muted-foreground">
              {t("room.members", { names: memberList(subject.room, ctx) })}
            </span>
          )}
        </span>
      </div>
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {actions}
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
