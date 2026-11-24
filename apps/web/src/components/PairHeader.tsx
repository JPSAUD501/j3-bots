// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, PairBotIds } from "@j3-bots/contracts";
import { pairOrder, pairTitle } from "@j3-bots/client-runtime/wording";
import { ChevronLeftIcon, EllipsisIcon, MessageSquareIcon, UsersIcon } from "lucide-react";
import type { RefObject } from "react";
import { useBots, usePresentation } from "../app/context";
import { PairAvatar } from "./avatar/TeamAvatars";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";

/** What a teammate conversation leads to: either bot's own conversation, or a room with both. */
export interface PairIntents {
  readonly talkTo: (botId: BotId) => void;
  /** Opens the form for a new room with the two bots in it. */
  readonly startRoom: (botIds: PairBotIds) => void;
}

/**
 * A teammate conversation's menu rows: talk to either bot, in the order the
 * title names them, or start a room with both. A bot deleted since has no conversation to open, and no room
 * can take it.
 */
export function PairMenuRows({ botIds, intents }: { botIds: PairBotIds; intents: PairIntents }) {
  const ctx = usePresentation();
  const bots = useBots();
  const present = pairOrder(botIds, ctx).flatMap((id) => {
    const bot = bots.get(id);
    return bot === undefined ? [] : [bot];
  });
  return (
    <>
      {present.map((bot) => (
        <MenuItem key={bot.id} icon={<MessageSquareIcon />} onClick={() => intents.talkTo(bot.id)}>
          {ctx.i18n.t("pairs.talkTo", { name: bot.profile.name })}
        </MenuItem>
      ))}
      {present.length === 2 && (
        <>
          <MenuSeparator />
          <MenuItem icon={<UsersIcon />} onClick={() => intents.startRoom(botIds)}>
            {ctx.i18n.t("pairs.startRoom")}
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * Whom a teammate conversation is between: their two faces and names, and a
 * menu to talk to either of them or bring both into a room. It has no
 * details: everything about each bot is in that bot's own.
 */
export function PairHeader({
  botIds,
  intents,
  onBack,
  titleRef,
}: {
  botIds: PairBotIds;
  intents: PairIntents;
  /** Phones only: back to the roster. */
  onBack: () => void;
  /** The title, which takes focus as the conversation opens from the keyboard. */
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const title = pairTitle(botIds, ctx);
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
      <div className="flex min-w-0 items-center gap-2.5 px-1.5 py-1">
        <PairAvatar botIds={botIds} size={32} />
        <h2 ref={titleRef} tabIndex={-1} className="truncate text-sm font-medium outline-none">
          {title}
        </h2>
      </div>
      <span className="ms-auto flex shrink-0 items-center">
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon"
                aria-label={t("roster.menu", { name: title })}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <PairMenuRows botIds={botIds} intents={intents} />
          </MenuPopup>
        </Menu>
      </span>
    </header>
  );
}
