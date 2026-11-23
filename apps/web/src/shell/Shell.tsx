// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  addressed,
  addresseeOf,
  arrivalCounts,
  buildTimeline,
  canStop,
  filterRoster,
  openingHeld,
  orderRoster,
  readThrough,
  rosterKeyOf,
  rosterKeyText,
  rosterTarget,
} from "@j3-bots/client-runtime/presentation";
import { useArrivals, useConversationEnd } from "@j3-bots/client-runtime/react";
import { BotsProvider, useI18n } from "../app/context";
import { AvatarConnection } from "../components/avatar/mood";
import { AppShell, type Region } from "../components/AppShell";
import { Composer, type MentionCandidate } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import {
  Connecting,
  ConversationGone,
  NoSelection,
  QuietConversation,
} from "../components/EmptyStates";
import { Roster } from "../components/Roster";
import { ChangeServer } from "../components/ServerAddress";
import { SettingsButton, SignOutDevice } from "../components/SettingsDialog";
import { Button } from "../components/ui/button";
import { Timeline } from "../components/Timeline";
import { scrollToEnd, ToLatest, useScrollFollow } from "../components/ToLatest";
import { tintOf } from "../lib/botTint";
import { Onboarding } from "../onboarding/Onboarding";
import type { ShellData, ShellIntents } from "./data";
import { cn } from "../lib/cn";
import { isCovered, useCovered } from "../lib/covered";
import { useSeenEntries } from "../lib/useSeenEntries";
import { addresseeLine, botModelName } from "@j3-bots/client-runtime/wording";
import { useShellLayout } from "./layout";
import { onShellAction, type ShellAction } from "./commands";
import { isEditable, shellShortcuts } from "./shortcuts";

interface ShellNavigation {
  readonly selected: RosterItemKey | null;
  readonly detailsOpen: boolean;
  readonly select: (key: RosterItemKey | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
  /** The element a roster row renders as: a router link in the app, a button in a preview. */
  readonly rowLink: (item: RosterItem) => ReactElement;
}

/** A touch screen, where a focused composer would raise the keyboard over the conversation. */
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

interface ShellProps {
  readonly data: ShellData;
  readonly intents: ShellIntents;
  readonly navigation: ShellNavigation;
  /** Window-wide shortcuts. Off where several shells share a page. */
  readonly keyboard?: boolean;
}

/** The whole interface: roster, conversation and details, from data and intents. */
export function Shell({ data, intents, navigation, keyboard = true }: ShellProps) {
  const { selected, detailsOpen } = navigation;
  const i18n = useI18n();
  const { t } = i18n;
  const shortcuts = shellShortcuts();
  const { dictate, editProfile } = intents;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailsHeadingId = useId();
  // State, not a ref: each conversation mounts its own timeline, and what watches it follows.
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const rosterRef = useRef<HTMLElement>(null);
  const [containerRef, layout] = useShellLayout();

  const rosterItems = data.roster ?? [];
  const bots = rosterItems.flatMap((item) => (item._tag === "bot" ? [item.bot] : []));
  const item =
    selected === null
      ? null
      : (rosterItems.find((i) =>
          i._tag === "bot"
            ? selected._tag === "bot" && i.bot.id === selected.botId
            : selected._tag === "room" && i.room.id === selected.roomId,
        ) ?? null);
  // The first bot's conversation opens straight from the first run: the first run stays from the
  // press of Create, through the bot's arrival, until the new bot is in the roster and open, so
  // the home never shows in between.
  const [openingFirstBot, setOpeningFirstBot] = useState(false);
  if (openingFirstBot && item !== null) setOpeningFirstBot(false);
  const active: Region = item === null ? "roster" : detailsOpen ? "details" : "conversation";
  // Below `wide` the details are a modal dialog: it owns focus and every key, Escape
  // included, and the shell's shortcuts wait until it closes.
  const detailsModal = layout === "phone" || layout === "tablet";
  const detailsCover = item !== null && detailsOpen && detailsModal;
  const selectionKey = item === null ? null : rosterKeyText(rosterKeyOf(item));

  // The conversation the operator can see: the one shown, with no sheet or
  // dialog over it, as read tracking also tells. Any other, and what is
  // covered, notifies when something arrives there.
  const [conversationRegion, setConversationRegion] = useState<HTMLElement | null>(null);
  const covered = useCovered(conversationRegion);
  // What the conversation's header announces, spoken by a region outside the
  // conversation: a modal hides from assistive technology everything but live
  // regions and what holds them, so one inside would keep the conversation
  // uncovered under any dialog. Each announcement belongs to the conversation
  // that made it and ends when another is chosen, so coming back never speaks
  // an old one again. A new one replaces the last, so it is spoken even when
  // the words repeat.
  const [announcement, setAnnouncement] = useState<{
    readonly selectionKey: string;
    readonly id: number;
    readonly text: string;
  } | null>(null);
  if (announcement !== null && announcement.selectionKey !== selectionKey) setAnnouncement(null);
  const { setShown } = intents;
  const visibleBot = !covered && item?._tag === "bot" ? item.bot.id : null;
  const visibleRoom = !covered && item?._tag === "room" ? item.room.id : null;
  useEffect(() => {
    setShown(
      visibleBot !== null
        ? { _tag: "conversation", botId: visibleBot }
        : visibleRoom !== null
          ? { _tag: "room", roomId: visibleRoom }
          : null,
    );
  }, [setShown, visibleBot, visibleRoom]);

  // Moving to another conversation with a mouse or keyboard puts the cursor in its
  // composer; opening or closing the details beside the conversation moves focus
  // with them, as the dialog does below `wide`. When the details close because the
  // conversation changed, the change wins: focus goes where any move would send it,
  // and the title takes it only when the details close on the same conversation.
  // Leaving a conversation for the roster, as Back does on a phone, puts focus on
  // the row of the conversation left, so the operator carries on from there. When
  // that row is gone, or a search hides it, the search takes focus, except on a
  // touch screen, where it would raise the keyboard: there the roster does.
  // None of this happens on the first render, so loading a page never scrolls or
  // steals focus. Nor under a dialog, as the bot editor a notification click
  // leaves open over the conversation it opens: the dialog keeps focus, and the
  // keys typed there never reach what lies under it.
  const shown = useRef({ selectionKey, detailsOpen });
  useEffect(() => {
    const before = shown.current;
    shown.current = { selectionKey, detailsOpen };
    const moved = before.selectionKey !== selectionKey;
    const focus = (element: HTMLElement | null | undefined) => {
      if (element && !isCovered(element)) element.focus();
    };
    if (before.detailsOpen !== detailsOpen && (detailsOpen || !moved)) {
      if (detailsModal) return;
      focus(detailsOpen ? detailsHeadingRef.current : titleRef.current);
    } else if (moved && selectionKey !== null && !coarsePointer()) {
      focus(composerRef.current);
    } else if (moved && selectionKey === null && before.selectionKey !== null) {
      const roster = rosterRef.current;
      const row = roster?.querySelector<HTMLElement>(
        `[data-roster-row="${CSS.escape(before.selectionKey)}"]`,
      );
      const search = coarsePointer()
        ? null
        : roster?.querySelector<HTMLElement>("[data-roster-search]");
      focus(row ?? search ?? roster);
    }
  }, [selectionKey, detailsOpen, detailsModal]);

  /** Does `action`; whether it did anything, so a key that did nothing is left to the page. */
  const act = useEffectEvent((action: ShellAction): boolean => {
    switch (action) {
      case "closeDetails":
        if (!detailsOpen) return false;
        navigation.setDetailsOpen(false);
        return true;
      case "next":
      case "previous": {
        const rows = orderRoster(filterRoster(rosterItems, ""));
        const forward = action === "next";
        const index = item === null ? -1 : rows.indexOf(item);
        // With nothing selected, down starts at the top and up at the bottom.
        const nextIndex =
          index === -1
            ? forward
              ? 0
              : rows.length - 1
            : (index + (forward ? 1 : -1) + rows.length) % rows.length;
        const next = rows[nextIndex];
        if (next === undefined) return false;
        navigation.select(rosterKeyOf(next));
        return true;
      }
      case "composer":
        if (composerRef.current === null) return false;
        composerRef.current.focus();
        return true;
      case "focus": {
        // The open conversation's composer, or the roster's search, or the roster.
        const roster = rosterRef.current;
        const target =
          composerRef.current ??
          roster?.querySelector<HTMLElement>("[data-roster-search]") ??
          roster;
        if (target === null || target === undefined || isCovered(target)) return false;
        target.focus();
        return true;
      }
      case "stop":
        if (item?._tag !== "bot" || !canStop(item.bot)) return false;
        intents.stopBot(item.bot.id);
        return true;
    }
  });
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || detailsCover) return;
    // Keys pressed in a dialog over the shell, such as a confirmation, are that dialog's.
    if (event.target instanceof Element && event.target.closest("[role=alertdialog]")) return;
    const action: ShellAction | null =
      event.key === "Escape"
        ? "closeDetails"
        : shortcuts.nextBot.matches(event)
          ? "next"
          : shortcuts.previousBot.matches(event)
            ? "previous"
            : shortcuts.focusComposer.matches(event) && !isEditable(event.target)
              ? "composer"
              : shortcuts.stop.matches(event)
                ? "stop"
                : null;
    if (action !== null && act(action)) event.preventDefault();
  });
  // The same actions asked for from outside, as the desktop app's menus do,
  // wait for the details' dialog and a confirmation as their keys do; the
  // details' dialog closes as Escape closes it.
  const onAction = useEffectEvent((action: ShellAction) => {
    if (document.querySelector("[role=alertdialog]") !== null) return;
    if (detailsCover && action !== "closeDetails") return;
    act(action);
  });
  useEffect(() => {
    if (!keyboard) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    const stop = onShellAction((action) => onAction(action));
    return () => {
      window.removeEventListener("keydown", listener);
      stop();
    };
  }, [keyboard]);

  // What the operator can see of the open conversation, they have read.
  const shownTarget = item === null ? null : rosterTarget(rosterKeyOf(item));
  const shownView = shownTarget === null ? null : data.conversation(shownTarget);
  const shownItems = shownView?.items ?? null;
  useSeenEntries(timeline, (ids) => {
    if (shownTarget === null || shownItems === null) return;
    const order = readThrough(
      shownItems.map((i) => (i._tag !== "outgoing" && ids.has(i.id) ? i.order : null)),
    );
    if (order !== null) intents.markRead(shownTarget, order);
  });

  // What arrives at the end of the open conversation settles in, and is counted while the
  // operator reads above it.
  const rows = useMemo(() => buildTimeline(shownItems ?? []), [shownItems]);
  const arrived = useArrivals(
    selectionKey,
    rows.map((row) => row.key),
    shownView?.phase === "ready",
  );
  const end = useConversationEnd(selectionKey, arrived, arrivalCounts(rows, arrived), () =>
    scrollToEnd(timeline),
  );
  useScrollFollow(timeline, end.follow);

  if (data.roster === null || data.roster.length === 0 || openingFirstBot) {
    // Settings live in the roster's footer; before there is a roster, these are the way out: in
    // the desktop app, to another server too, as when the one it names has moved.
    const ways = (
      <div className="flex flex-wrap items-start justify-center gap-2">
        {intents.server !== undefined && (
          <ChangeServer
            address={intents.server.address}
            onChange={intents.server.forget}
            paired
            className="items-center"
          />
        )}
        <SignOutDevice onSignOut={intents.signOut} quiet />
      </div>
    );
    return (
      <div className="flex h-full flex-col pt-(--inset-top) pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        {data.roster === null ? (
          <>
            <Connecting />
            <div className="shrink-0 px-4 pb-3">{ways}</div>
          </>
        ) : (
          <Onboarding
            engine={data.engine}
            footer={ways}
            onCreate={({ name, avatar }) => {
              setOpeningFirstBot(true);
              // The first bot is the primary one: there is no other to choose.
              return intents.createBot({ name, primary: true, avatar }).then((result) => {
                if (result._tag === "failed") setOpeningFirstBot(false);
                return result;
              });
            }}
            onArrived={(botId) => navigation.select({ _tag: "bot", botId })}
          />
        )}
      </div>
    );
  }

  const roster = (
    <Roster
      items={data.roster}
      selected={selected}
      rowLink={navigation.rowLink}
      onNewBot={intents.newBot}
      onNewRoom={intents.newRoom}
      footer={<SettingsButton data={data} intents={intents} />}
      ref={rosterRef}
    />
  );

  let conversation: ReactElement = <NoSelection nextShortcut={shortcuts.nextBot.label} />;
  let details: ReactElement | null = null;
  if (item !== null) {
    const key = rosterKeyOf(item);
    const target = rosterTarget(key);
    const view = data.conversation(target);
    const draft = data.draft(target);
    const offer = data.offer(target);
    const recipient = item._tag === "bot" ? item.bot.profile.name : item.room.name;
    // An archived room takes no messages: no composer, and a way to unarchive it.
    const archivedRoom = item._tag === "room" && item.room.status === "archived" ? item.room : null;
    // In a room, `@` mentions its members, by the names the roster shows.
    const mentionable: ReadonlyArray<MentionCandidate> | undefined =
      item._tag === "room"
        ? item.room.members.flatMap((id) => {
            const bot = bots.find((candidate) => candidate.id === id);
            return bot ? [{ id, name: bot.profile.name, avatar: bot.profile.avatar }] : [];
          })
        : undefined;
    // Who the message wakes as the draft stands: only mentions picked, and still standing, count.
    const addressing =
      item._tag === "room" ? addressed(draft.text, draft.mentions, item.room.members) : undefined;
    const addressee =
      item._tag === "room"
        ? addresseeLine(
            addresseeOf(
              addressing?.mentions ?? null,
              item.room.hostId,
              (botId) => bots.find((candidate) => candidate.id === botId)?.profile.name,
              i18n,
            ),
            i18n,
          )
        : null;
    const toggleDetails = () => navigation.setDetailsOpen(!detailsOpen);
    const goToEntry = (entryId: EntryId) => {
      const card = timeline?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
      card?.scrollIntoView({ block: "center" });
      card?.focus({ preventScroll: true });
    };
    conversation = (
      <>
        <ConversationHeader
          // One header per conversation: moving to another announces nothing.
          key={rosterKeyText(key)}
          subject={
            item._tag === "bot" ? { _tag: "bot", bot: item.bot } : { _tag: "room", room: item.room }
          }
          detailsOpen={detailsOpen}
          onToggleDetails={toggleDetails}
          onBack={() => navigation.select(null)}
          onStop={() => {
            if (item._tag === "bot") intents.stopBot(item.bot.id);
            else intents.stopRoom(item.room.id);
          }}
          onGoToWaiting={goToEntry}
          stopShortcut={shortcuts.stop}
          titleRef={titleRef}
          onAnnounce={(text) =>
            setAnnouncement((previous) => ({
              selectionKey: rosterKeyText(key),
              id: (previous?.id ?? 0) + 1,
              text,
            }))
          }
        />
        {view.phase === "not-found" ? (
          <ConversationGone onBack={() => navigation.select(null)} />
        ) : view.phase === "ready" && view.items.length === 0 && item._tag === "bot" ? (
          <QuietConversation bot={item.bot} engine={data.engine} />
        ) : (
          // Reversed, so the view stays pinned to the newest entry as entries arrive. One per
          // conversation, so each opens at its own end rather than where the last one was left,
          // and settles in as it opens.
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              key={`timeline:${rosterKeyText(key)}`}
              ref={setTimeline}
              className="conversation-open flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]"
            >
              <div className="mx-auto w-full max-w-(--layout-text-column) px-3 py-4 @tablet:px-6">
                {view.hasOlder && (
                  <div className="flex justify-center pb-2">
                    <Button
                      variant="ghost-muted"
                      size="sm"
                      aria-disabled={view.loadingOlder}
                      onClick={() => {
                        if (!view.loadingOlder) intents.loadOlder(target);
                      }}
                    >
                      {view.loadingOlder ? t("timeline.loadingOlder") : t("timeline.loadOlder")}
                    </Button>
                  </div>
                )}
                <Timeline
                  rows={rows}
                  room={item._tag === "room" ? item.room : null}
                  workSteps={data.workSteps}
                  submitting={data.submitting}
                  openingHold={item._tag === "bot" ? openingHeld(item.bot, data.engine) : null}
                  intents={intents}
                  arrived={arrived}
                  flyFrom={composerRef}
                />
              </div>
            </div>
            <ToLatest end={end} onPress={() => scrollToEnd(timeline)} />
          </div>
        )}
        <div
          className={cn(
            "mx-auto w-full max-w-(--layout-text-column) px-3 pt-1 pb-[max(--spacing(3),env(safe-area-inset-bottom))] @tablet:px-6",
            tintOf(item._tag === "bot" ? item.bot.profile.avatar : null),
          )}
        >
          {archivedRoom === null ? (
            <Composer
              draftKey={rosterKeyText(rosterKeyOf(item))}
              recipient={recipient}
              value={draft.text}
              mentions={draft.mentions}
              onValueChange={(value, picked) => intents.setDraftText(target, value, picked)}
              files={draft.files}
              sending={draft.sending}
              loading={data.draftsLoading}
              {...(data.draftsFailed ? { unread: { onRetry: intents.retryDrafts } } : {})}
              notSaved={data.draftNotSaved(target)}
              onAttachFiles={(files) => intents.attachFiles(target, files)}
              onDetachFile={(fileKey) => intents.detachFile(target, fileKey)}
              onSend={() => intents.sendDraft(target, addressing)}
              {...(dictate ? { onDictate: () => dictate(target) } : {})}
              {...(offer === null
                ? {}
                : {
                    replaced: {
                      revision: offer,
                      onRestore: () => intents.restoreDraft(target),
                      onDismiss: () => intents.dismissDraftOffer(target),
                    },
                  })}
              inputRef={composerRef}
              {...(mentionable === undefined ? {} : { mentionable })}
              {...(addressee === null ? {} : { addressee })}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-x-2 py-2 text-center text-xs text-muted-foreground">
              <p>{t("room.composerArchived", { name: archivedRoom.name })}</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void intents.unarchiveRoom(archivedRoom.id)}
              >
                {t("room.unarchive", { name: archivedRoom.name })}
              </Button>
            </div>
          )}
        </div>
      </>
    );
    if (detailsOpen) {
      const close = () => navigation.setDetailsOpen(false);
      if (item._tag === "bot") {
        const { bot } = item;
        details = (
          <BotDetails
            bot={bot}
            routines={data.routines(bot.id)}
            memory={data.memory(bot.id)}
            files={data.files(bot.id)}
            modelName={botModelName(data.engine, bot)}
            onClose={close}
            headingRef={detailsHeadingRef}
            headingId={detailsHeadingId}
            intents={{
              setRoutineEnabled: intents.setRoutineEnabled,
              openRoutine: intents.openRoutine,
              openAttachment: intents.openAttachment,
              openMemoryFile: (path) => intents.openMemoryFile(bot.id, path),
              freshStart: () => intents.freshStart(bot.id, bot.profile.name),
              deleteBot: () => intents.deleteBot(bot.id),
              ...(editProfile ? { editProfile: () => editProfile(bot.id) } : {}),
            }}
          />
        );
      } else {
        const { room } = item;
        details = (
          <RoomDetails
            room={item.room}
            intents={{
              editRoom: () => intents.editRoom(room.id),
              archiveRoom: () => intents.archiveRoom(room.id),
              unarchiveRoom: () => intents.unarchiveRoom(room.id),
              deleteRoom: () => intents.deleteRoom(room.id),
            }}
            onClose={close}
            headingRef={detailsHeadingRef}
            headingId={detailsHeadingId}
          />
        );
      }
    }
  }

  return (
    <BotsProvider bots={bots}>
      <AvatarConnection connected={data.connected}>
        <AppShell
          roster={roster}
          conversation={conversation}
          details={details}
          detailsHeadingId={detailsHeadingId}
          detailsHeadingRef={detailsHeadingRef}
          returnFocusRef={titleRef}
          active={active}
          layout={layout}
          containerRef={containerRef}
          conversationRef={setConversationRegion}
          onCloseDetails={() => navigation.setDetailsOpen(false)}
        />
      </AvatarConnection>
      <span className="sr-only" aria-live="polite">
        {announcement !== null && <span key={announcement.id}>{announcement.text}</span>}
      </span>
    </BotsProvider>
  );
}
