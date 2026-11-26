// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  BrowserHelpEntry,
  BrowserTabRef,
  EntryId,
  PairBotIds,
  RosterItem,
  RosterItemKey,
} from "@j3-bots/contracts";
import { runByDesktopApp } from "@j3-bots/client-runtime";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  addressed,
  arrangedOrder,
  arrangeRoster,
  arrivalCounts,
  buildTimeline,
  canStop,
  liveTurn,
  openingHeld,
  orderRoster,
  pairKeyText,
  readThrough,
  rosterKeyOf,
  rosterKeyText,
  rosterTarget,
  teammatesOf,
  withLiveTurn,
} from "@j3-bots/client-runtime/presentation";
import { useArrivals, useConversationEnd } from "@j3-bots/client-runtime/react";
import { RosterProvider, useI18n } from "../app/context";
import { BrowserIndicator } from "../browser/BrowserIndicator";
import { BrowserPanel } from "../browser/BrowserPanel";
import { BrowserViewer, type BrowserViewerHandle } from "../browser/BrowserViewer";
import { BrowserProvider } from "../browser/context";
import type { BrowserSource } from "../browser/source";
import { AvatarConnection } from "../components/avatar/mood";
import { AppShell, type Region } from "../components/AppShell";
import { Composer, type MentionCandidate } from "../components/Composer";
import type { PromptMenu } from "../components/PromptPicker";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import {
  Connecting,
  ConversationGone,
  NoSelection,
  QuietConversation,
  QuietRoom,
} from "../components/EmptyStates";
import { PairConversation } from "../components/PairConversation";
import type { PairIntents } from "../components/PairHeader";
import { Roster } from "../components/Roster";
import { useFoldedSections } from "../components/RosterGroups";
import { StopUsingComputer } from "../components/LocalMode";
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
import { useCardPlace } from "../lib/useCardPlace";
import { useSeenEntries } from "../lib/useSeenEntries";
import { botModelName } from "@j3-bots/client-runtime/wording";
import { useShellLayout } from "./layout";
import { onShellAction, type ShellAction } from "./commands";
import { rosterIntents } from "./rosterIntents";
import { isEditable, shellShortcuts } from "./shortcuts";

interface ShellNavigation {
  readonly selected: RosterItemKey | null;
  readonly detailsOpen: boolean;
  readonly select: (key: RosterItemKey | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
  /** The tab of the bot's browser the viewer shows, or the bot's front tab; null with the viewer closed. */
  readonly browser: BrowserTabRef | "front" | null;
  /** Opens the viewer, closing the details, or closes it. */
  readonly setBrowser: (target: BrowserTabRef | "front" | null) => void;
  /** The element a roster row renders as: a router link in the app, a button in a preview. */
  readonly rowLink: (item: RosterItem) => ReactElement;
  /**
   * The teammate conversation shown, and the card of one of its bots'
   * conversations it was opened at; null when none is. Shown in place of a
   * conversation: `selected` is then null.
   */
  readonly pair: { readonly botIds: PairBotIds; readonly at: EntryId | null } | null;
  /** Shows a teammate conversation, at a card's message when `at` names one. */
  readonly openPair: (botIds: PairBotIds, at: EntryId | null) => void;
  /** The element a pair's roster row renders as, as `rowLink`. */
  readonly pairLink: (botIds: PairBotIds) => ReactElement;
}

/** A touch screen, where a focused composer would raise the keyboard over the conversation. */
const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches;

interface ShellProps {
  readonly data: ShellData;
  readonly intents: ShellIntents;
  /** The bots' browsers. */
  readonly browser: BrowserSource;
  readonly navigation: ShellNavigation;
  /** Window-wide shortcuts. Off where several shells share a page. */
  readonly keyboard?: boolean;
}

/** The whole interface: roster, conversation and details, from data and intents. */
export function Shell({ data, intents, browser, navigation, keyboard = true }: ShellProps) {
  const { selected, pair } = navigation;
  const { t } = useI18n();
  const shortcuts = shellShortcuts();
  const { dictate, editProfile } = intents;
  const composerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const pairTitleRef = useRef<HTMLHeadingElement>(null);
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailsHeadingId = useId();
  // State, not a ref: each conversation mounts its own timeline, and what watches it follows.
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const rosterRef = useRef<HTMLElement>(null);
  const [containerRef, layout] = useShellLayout();

  const rosterItems = data.roster ?? [];
  const pairs = data.pairs ?? [];
  const folded = useFoldedSections(data.sections);
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
  // Beside the conversation, or over it: a bot's browser, or else the details.
  const browserTarget = item?._tag === "bot" ? navigation.browser : null;
  const detailsOpen = navigation.detailsOpen && browserTarget === null;
  const aside = browserTarget !== null ? "browser" : detailsOpen ? "details" : null;
  // On a phone the details take the screen; the browser rises over the conversation as a sheet.
  const active: Region =
    item === null
      ? pair === null
        ? "roster"
        : "conversation"
      : detailsOpen
        ? "details"
        : "conversation";
  // Below `wide` the details and the browser are a modal dialog: it owns focus and every key,
  // Escape included, and the shell's shortcuts wait until it closes.
  const detailsModal = layout === "phone" || layout === "tablet";
  const detailsCover = item !== null && aside !== null && detailsModal;
  const viewerRef = useRef<BrowserViewerHandle>(null);
  const closeAside = () => {
    if (aside === "browser") viewerRef.current?.requestClose();
    else navigation.setDetailsOpen(false);
  };
  const selectionKey =
    item !== null
      ? rosterKeyText(rosterKeyOf(item))
      : pair !== null
        ? pairKeyText(pair.botIds)
        : null;

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
  const shown = useRef({ selectionKey, aside });
  useEffect(() => {
    const before = shown.current;
    shown.current = { selectionKey, aside };
    const moved = before.selectionKey !== selectionKey;
    const focus = (element: HTMLElement | null | undefined) => {
      if (element && !isCovered(element)) element.focus();
    };
    if (before.aside !== aside && (aside !== null || !moved)) {
      if (detailsModal) return;
      focus(aside !== null ? detailsHeadingRef.current : titleRef.current);
    } else if (moved && selectionKey !== null && !coarsePointer()) {
      // A teammate conversation has no composer: its title takes focus.
      focus(composerRef.current ?? pairTitleRef.current);
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
  }, [selectionKey, aside, detailsModal]);

  /** Does `action`; whether it did anything, so a key that did nothing is left to the page. */
  const act = useEffectEvent((action: ShellAction): boolean => {
    switch (action) {
      case "closeDetails":
        if (aside === null) return false;
        closeAside();
        return true;
      case "next":
      case "previous": {
        // In the order the roster draws them, so the keys walk what the operator sees.
        const rows = arrangedOrder(
          arrangeRoster(orderRoster(rosterItems), data.sections ?? []),
          folded.has,
        );
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
    // A key an input method composes with is the input method's.
    if (event.defaultPrevented || event.isComposing || detailsCover) return;
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
    // While the operator types into the bot's page, its keys are the page's, the menus' included.
    if (document.activeElement?.closest("[data-browser-page]")) return;
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
  // In a bot's conversation, its turn under way shows in the timeline, once.
  const shownBot = item?._tag === "bot" ? item.bot : null;
  const shownTurn = useMemo(() => (shownBot === null ? null : liveTurn(shownBot)), [shownBot]);
  const rows = useMemo(
    () => withLiveTurn(buildTimeline(shownItems ?? []), shownTurn),
    [shownItems, shownTurn],
  );
  const folds = useMemo(
    () => (shownItems ?? []).flatMap((entry) => (entry._tag === "work-fold" ? [entry] : [])),
    [shownItems],
  );
  const arrived = useArrivals(
    selectionKey,
    rows.map((row) => row.key),
    shownView?.phase === "ready",
  );
  const end = useConversationEnd(selectionKey, arrived, arrivalCounts(rows, arrived), () =>
    scrollToEnd(timeline),
  );
  useScrollFollow(timeline, end.follow);
  // The card the open conversation's bot waits on, and where it is.
  const waitingOn = shownBot?.state._tag === "waiting" ? shownBot.state.entryId : null;
  const waitingPlace = useCardPlace(timeline, waitingOn);
  // While it is out of view the pill stands over the end: the timeline keeps its last entry clear of it.
  const toCard = waitingPlace === "above" || waitingPlace === "below";

  if (data.roster === null || data.roster.length === 0 || openingFirstBot) {
    // Settings live in the roster's footer; before there is a roster, these are the way out: in
    // the desktop app, to another server too, as when the one it names has moved, and while the
    // bots live on this computer, to a server instead, which is its way of signing out.
    const ways = (
      <div className="flex flex-wrap items-start justify-center gap-2">
        {intents.local !== undefined ? (
          <StopUsingComputer onStop={intents.local.stopUsing} quiet />
        ) : (
          <>
            {intents.server !== undefined && (
              <ChangeServer
                address={intents.server.address}
                onChange={intents.server.forget}
                paired
                className="items-center"
              />
            )}
            <SignOutDevice onSignOut={intents.signOut} quiet />
          </>
        )}
      </div>
    );
    return (
      <div className="flex h-full flex-col pt-(--inset-top) pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        {data.roster === null ? (
          <>
            <Connecting />
            <WayOut>{ways}</WayOut>
          </>
        ) : (
          <Onboarding
            engine={data.engine}
            footer={ways}
            providerSetup={
              intents.providerSetup === undefined
                ? undefined
                : { ...intents.providerSetup, signIns: data.signIns }
            }
            onCreate={({ name, avatar }) => {
              setOpeningFirstBot(true);
              // The first bot is the primary one: there is no other to choose.
              return intents.createBot({ name, primary: true, avatar }).then((result) => {
                if (result._tag === "failed") setOpeningFirstBot(false);
                return result;
              });
            }}
            onArrived={(botId) => navigation.select({ _tag: "bot", botId })}
            providerActions={intents.providerActions}
          />
        )}
      </div>
    );
  }

  const pairIntents: PairIntents = {
    talkTo: intents.openConversation,
    startRoom: intents.startRoomWith,
  };
  const roster = (
    <Roster
      items={data.roster}
      selected={selected}
      rowLink={navigation.rowLink}
      pairs={pairs}
      selectedPair={pair?.botIds ?? null}
      pairLink={navigation.pairLink}
      pairIntents={pairIntents}
      onNewBot={intents.newBot}
      onNewFromTemplate={intents.newBotFromTemplate}
      onNewRoom={intents.newRoom}
      sections={data.sections}
      intents={rosterIntents(intents, navigation)}
      folded={folded}
      footer={<SettingsButton data={data} intents={intents} />}
      ref={rosterRef}
    />
  );

  let conversation: ReactElement = <NoSelection nextShortcut={shortcuts.nextBot.label} />;
  let details: ReactElement | null = null;
  if (item === null && pair !== null) {
    const { botIds } = pair;
    conversation = (
      <PairConversation
        // One per pair: another opens afresh, at its own end.
        key={pairKeyText(botIds)}
        botIds={botIds}
        view={data.pair(botIds)}
        at={pair.at}
        intents={pairIntents}
        onLoadOlder={() => intents.loadOlderPair(botIds)}
        onReveal={(entryId) => intents.revealInPair(botIds, entryId)}
        onBack={() => navigation.select(null)}
        titleRef={pairTitleRef}
      />
    );
  }
  if (item !== null) {
    const key = rosterKeyOf(item);
    const target = rosterTarget(key);
    const view = data.conversation(target);
    const draft = data.draft(target);
    const offer = data.offer(target);
    const recipient = item._tag === "bot" ? item.bot.profile.name : item.room.name;
    // An archived room takes no messages: no composer, and a way to unarchive it.
    const archivedRoom = item._tag === "room" && item.room.status === "archived" ? item.room : null;
    // In a bot's conversation, `/` offers its connectors' prompts, each by its connector's name.
    const promptMenu = (botId: BotId): PromptMenu => ({
      load: () =>
        intents.connectorPrompts(botId).then(
          (prompts) =>
            prompts?.flatMap((prompt) => {
              const connector = data.connectors?.find((one) => one.id === prompt.connectorId);
              return connector === undefined ? [] : [{ ...prompt, connector: connector.name }];
            }) ?? null,
        ),
      render: (prompt, given) => intents.renderPrompt(botId, prompt, given),
    });
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
    const toggleDetails = () =>
      aside === "browser"
        ? viewerRef.current?.requestClose(() => navigation.setDetailsOpen(true))
        : navigation.setDetailsOpen(!detailsOpen);
    const browserBot = item._tag === "bot" ? item.bot : null;
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
          folds={folds}
          titleRef={titleRef}
          onAnnounce={(text) =>
            setAnnouncement((previous) => ({
              selectionKey: rosterKeyText(key),
              id: (previous?.id ?? 0) + 1,
              text,
            }))
          }
          {...(browserBot === null
            ? {}
            : {
                actions: (
                  <BrowserIndicator
                    bot={browserBot}
                    open={browserTarget !== null}
                    onOpen={() =>
                      browserTarget === null ? navigation.setBrowser("front") : closeAside()
                    }
                  />
                ),
              })}
        />
        {view.phase === "not-found" ? (
          <ConversationGone onBack={() => navigation.select(null)} />
        ) : view.phase === "ready" && view.items.length === 0 && item._tag === "bot" ? (
          <QuietConversation
            bot={item.bot}
            engine={data.engine}
            connect={
              intents.providerSetup !== undefined
                ? { _tag: "here", setup: { ...intents.providerSetup, signIns: data.signIns } }
                : intents.serverUpdate !== undefined && runByDesktopApp(intents.serverUpdate.view)
                  ? { _tag: "desktop-app" }
                  : { _tag: "server" }
            }
          />
        ) : view.phase === "ready" &&
          view.items.length === 0 &&
          item._tag === "room" &&
          item.room.status === "active" ? (
          <QuietRoom room={item.room} />
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
              <div
                className={cn(
                  "mx-auto w-full max-w-(--layout-text-column) px-3 py-4 @tablet:px-6",
                  toCard && "pb-14",
                )}
              >
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
                  secrets={{ view: data.secrets, intents: intents.secrets }}
                  arrived={arrived}
                  flyFrom={composerRef}
                  turnBot={
                    item._tag === "bot" ? { bot: item.bot, lastEntry: item.lastEntry } : null
                  }
                  onOpenPair={navigation.openPair}
                  onOpenRoom={(roomId) => navigation.select({ _tag: "room", roomId })}
                  {...(browserBot === null
                    ? {}
                    : {
                        turnExtra: (
                          <BrowserPanel
                            bot={browserBot}
                            onOpen={(tab) => navigation.setBrowser(tab.ref)}
                          />
                        ),
                      })}
                />
              </div>
            </div>
            <ToLatest
              end={end}
              onPress={() => scrollToEnd(timeline)}
              waiting={
                waitingOn === null
                  ? null
                  : { place: waitingPlace, onPress: () => goToEntry(waitingOn) }
              }
            />
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
              onValueChange={(value, picked, order) =>
                intents.setDraftText(target, value, picked, order)
              }
              files={draft.files}
              sending={draft.sending}
              loading={data.draftsLoading}
              {...(data.draftsFailed ? { unread: { onRetry: intents.retryDrafts } } : {})}
              notSaved={data.draftNotSaved(target)}
              onAttachFiles={(files, at) => intents.attachFiles(target, files, at)}
              onDetachFile={(fileKey) => intents.detachFile(target, fileKey)}
              onOpenFile={intents.openAttachment}
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
              {...(item._tag === "bot" ? { prompts: promptMenu(item.bot.id) } : {})}
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
    if (browserBot !== null && browserTarget !== null) {
      // The step the bot asked for in its browser, while it waits on the operator.
      const help = view.items.findLast(
        (entry): entry is BrowserHelpEntry =>
          entry._tag === "browser-help" && entry.status._tag === "pending",
      );
      details = (
        <BrowserViewer
          // One viewer per bot: another bot's browser opens afresh.
          key={browserBot.id}
          bot={browserBot}
          target={browserTarget}
          help={
            help === undefined
              ? null
              : {
                  tab: help.tab,
                  onDone: () => intents.answerBrowserHelp(help.id, "done"),
                  onDecline: () => intents.answerBrowserHelp(help.id, "declined"),
                }
          }
          onClose={() => navigation.setBrowser(null)}
          headingRef={detailsHeadingRef}
          headingId={detailsHeadingId}
          ref={viewerRef}
        />
      );
    } else if (detailsOpen) {
      const close = () => navigation.setDetailsOpen(false);
      if (item._tag === "bot") {
        const { bot } = item;
        details = (
          <BotDetails
            bot={bot}
            routines={data.routines(bot.id)}
            memory={data.memory(bot.id)}
            files={data.files(bot.id)}
            connectors={data.connectors}
            teammates={teammatesOf(bot.id, pairs)}
            modelName={botModelName(data.engine, bot)}
            stopShortcut={shortcuts.stop}
            browserHost={data.engine?.browser ?? null}
            onClose={close}
            headingRef={detailsHeadingRef}
            headingId={detailsHeadingId}
            intents={{
              stop: () => intents.stopBot(bot.id),
              show: () => intents.placeBot(bot.id, { hidden: false }),
              setRoutineEnabled: intents.setRoutineEnabled,
              openRoutine: intents.openRoutine,
              openAttachment: intents.openAttachment,
              openMemoryFile: (path) => intents.openMemoryFile(bot.id, path),
              setBrowser: (enabled) => intents.setBrowser(bot, enabled),
              freshStart: () => intents.freshStart(bot.id, bot.profile.name),
              deleteBot: () => intents.deleteBot(bot.id),
              shareTemplate: () => intents.shareBotTemplate(bot.id),
              openConnectors: (connectorId) =>
                intents.openConnectors({
                  at:
                    connectorId === null
                      ? { _tag: "home" }
                      : { _tag: "connector", connectorId, signIn: false, added: false },
                  forBot: bot.id,
                }),
              openPair: (botIds) => navigation.openPair(botIds, null),
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
              stop: () => intents.stopRoom(room.id),
              show: () => intents.placeRoom(room.id, { hidden: false }),
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
    <RosterProvider roster={rosterItems}>
      <BrowserProvider source={browser}>
        <AvatarConnection connected={data.connected}>
          <AppShell
            roster={roster}
            conversation={conversation}
            details={details}
            asideKind={aside === "browser" ? "browser" : "details"}
            detailsHeadingId={detailsHeadingId}
            detailsHeadingRef={detailsHeadingRef}
            returnFocusRef={titleRef}
            active={active}
            layout={layout}
            containerRef={containerRef}
            conversationRef={setConversationRegion}
            onCloseDetails={closeAside}
          />
        </AvatarConnection>
      </BrowserProvider>
      <span className="sr-only" aria-live="polite">
        {announcement !== null && <span key={announcement.id}>{announcement.text}</span>}
      </span>
    </RosterProvider>
  );
}

/** How long the screen waits on the server before it offers a way out. */
const WAY_OUT_AFTER = 8000;

/**
 * The way out while the server has yet to answer: signing out, and in the
 * desktop app another server. It shows only once the wait has gone on a while,
 * so a load that is merely slow does not invite signing out.
 */
function WayOut({ children }: { children: ReactNode }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), WAY_OUT_AFTER);
    return () => window.clearTimeout(timer);
  }, []);
  // Its room is kept from the start, hidden, so the wait above it does not move when it shows.
  return (
    <div className={cn("shrink-0 px-4 pb-3", waited ? "arrive" : "invisible")}>{children}</div>
  );
}
