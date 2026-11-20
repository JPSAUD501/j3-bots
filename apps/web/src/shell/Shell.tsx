// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  EngineStatus,
  Entry,
  EntryId,
  EntryTarget,
  RosterItem,
  RosterItemKey,
} from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactElement } from "react";
import { BotsProvider, useI18n } from "../app/context";
import { AppShell, type Region } from "../components/AppShell";
import { Composer } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import {
  Connecting,
  ConversationGone,
  FirstRun,
  NoSelection,
  QuietConversation,
} from "../components/EmptyStates";
import { Roster } from "../components/Roster";
import { SettingsButton, SignOutDevice } from "../components/SettingsDialog";
import { Button } from "../components/ui/button";
import { Timeline } from "../components/Timeline";
import { filterRoster, orderRoster, rosterKeyOf, rosterKeyText } from "../presentation/roster";
import type { ShellData, ShellIntents } from "./data";
import { useNewestSeen } from "../lib/useNewestSeen";
import { useShellLayout } from "./layout";
import { isEditable, shellShortcuts } from "./shortcuts";

interface ShellNavigation {
  readonly selected: RosterItemKey | null;
  readonly detailsOpen: boolean;
  readonly select: (key: RosterItemKey | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
  /** The element a roster row renders as: a router link in the app, a button in a preview. */
  readonly rowLink: (item: RosterItem) => ReactElement;
}

const targetOf = (key: RosterItemKey): EntryTarget =>
  key._tag === "bot"
    ? { _tag: "conversation", botId: key.botId }
    : { _tag: "room", roomId: key.roomId };

function modelName(engine: EngineStatus | null, bot: Bot): string | null {
  const provider = engine?.providers.find((p) => p.id === bot.model.providerId);
  const model = provider?.models.find((m) => m.id === bot.model.modelId);
  return provider && model ? `${provider.name} · ${model.name}` : null;
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
  const { t } = useI18n();
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
  const active: Region = item === null ? "roster" : detailsOpen ? "details" : "conversation";
  // Below `wide` the details are a modal dialog: it owns focus and every key, Escape
  // included, and the shell's shortcuts wait until it closes.
  const detailsModal = layout === "phone" || layout === "tablet";
  const detailsCover = item !== null && detailsOpen && detailsModal;

  const selectionKey = item === null ? null : rosterKeyText(rosterKeyOf(item));
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
  // steals focus.
  const shown = useRef({ selectionKey, detailsOpen });
  useEffect(() => {
    const before = shown.current;
    shown.current = { selectionKey, detailsOpen };
    const moved = before.selectionKey !== selectionKey;
    if (before.detailsOpen !== detailsOpen && (detailsOpen || !moved)) {
      if (detailsModal) return;
      if (detailsOpen) detailsHeadingRef.current?.focus();
      else titleRef.current?.focus();
    } else if (moved && selectionKey !== null && !coarsePointer()) {
      composerRef.current?.focus();
    } else if (moved && selectionKey === null && before.selectionKey !== null) {
      const roster = rosterRef.current;
      const row = roster?.querySelector<HTMLElement>(
        `[data-roster-row="${CSS.escape(before.selectionKey)}"]`,
      );
      const search = coarsePointer()
        ? null
        : roster?.querySelector<HTMLElement>("[data-roster-search]");
      (row ?? search ?? roster)?.focus();
    }
  }, [selectionKey, detailsOpen, detailsModal]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || detailsCover) return;
    // Keys pressed in a dialog over the shell, such as a confirmation, are that dialog's.
    if (event.target instanceof Element && event.target.closest("[role=alertdialog]")) return;
    if (event.key === "Escape" && detailsOpen) {
      event.preventDefault();
      navigation.setDetailsOpen(false);
    } else if (shortcuts.nextBot.matches(event) || shortcuts.previousBot.matches(event)) {
      const rows = orderRoster(filterRoster(rosterItems, ""));
      if (rows.length === 0) return;
      const forward = shortcuts.nextBot.matches(event);
      const index = item === null ? -1 : rows.indexOf(item);
      // With nothing selected, down starts at the top and up at the bottom.
      const nextIndex =
        index === -1
          ? forward
            ? 0
            : rows.length - 1
          : (index + (forward ? 1 : -1) + rows.length) % rows.length;
      const next = rows[nextIndex];
      if (next) {
        event.preventDefault();
        navigation.select(rosterKeyOf(next));
      }
    } else if (shortcuts.focusComposer.matches(event) && !isEditable(event.target)) {
      event.preventDefault();
      composerRef.current?.focus();
    } else if (shortcuts.stop.matches(event) && item?._tag === "bot") {
      const running = item.bot.state._tag === "thinking" || item.bot.state._tag === "working";
      if (running) {
        event.preventDefault();
        intents.stopBot(item.bot.id);
      }
    }
  });
  useEffect(() => {
    if (!keyboard) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [keyboard]);

  // What the operator can see of the open conversation, they have read.
  const shownTarget = item === null ? null : targetOf(rosterKeyOf(item));
  const shownItems = shownTarget === null ? null : data.conversation(shownTarget).items;
  useNewestSeen(timeline, (id) => {
    const seen = shownItems?.find((i): i is Entry => i._tag !== "outgoing" && i.id === id);
    if (shownTarget !== null && seen !== undefined) intents.markRead(shownTarget, seen.order);
  });

  if (data.roster === null || data.roster.length === 0) {
    return (
      <div className="flex h-full flex-col pt-(--inset-top) pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
        {data.roster === null ? (
          <Connecting />
        ) : (
          <FirstRun
            engine={data.engine}
            onCreateBot={(name, primary) =>
              intents
                .createBot(name, primary)
                .then((botId) => navigation.select({ _tag: "bot", botId }))
            }
          />
        )}
        {/* Settings live in the roster's footer; before there is a roster, this is the way out. */}
        <div className="flex shrink-0 justify-center px-4 pb-3">
          <SignOutDevice onSignOut={intents.signOut} quiet />
        </div>
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
    const target = targetOf(key);
    const view = data.conversation(target);
    const draft = data.draft(target);
    const recipient = item._tag === "bot" ? item.bot.profile.name : item.room.name;
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
          }}
          onGoToWaiting={goToEntry}
          stopShortcut={shortcuts.stop}
          titleRef={titleRef}
        />
        {view.phase === "not-found" ? (
          <ConversationGone onBack={() => navigation.select(null)} />
        ) : view.phase === "ready" && view.items.length === 0 && item._tag === "bot" ? (
          <QuietConversation bot={item.bot} />
        ) : (
          // Reversed, so the view stays pinned to the newest entry as entries arrive. One per
          // conversation, so each opens at its own end rather than where the last one was left.
          <div
            key={`timeline:${rosterKeyText(key)}`}
            ref={setTimeline}
            className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]"
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
                entries={view.items}
                inRoom={item._tag === "room"}
                workSteps={data.workSteps}
                submitting={data.submitting}
                intents={intents}
              />
            </div>
          </div>
        )}
        <div className="mx-auto w-full max-w-(--layout-text-column) px-3 pt-1 pb-[max(--spacing(3),env(safe-area-inset-bottom))] @tablet:px-6">
          <Composer
            draftKey={rosterKeyText(rosterKeyOf(item))}
            recipient={recipient}
            value={draft.text}
            onValueChange={(value) => intents.setDraftText(target, value)}
            files={draft.files}
            sending={draft.sending}
            onAttachFiles={(files) => intents.attachFiles(target, files)}
            onDetachFile={(fileKey) => intents.detachFile(target, fileKey)}
            onSend={() => intents.sendDraft(target)}
            {...(dictate ? { onDictate: () => dictate(target) } : {})}
            {...(data.restorable(target)
              ? {
                  replaced: {
                    onRestore: () => intents.restoreDraft(target),
                    onDismiss: () => intents.dismissDraftOffer(target),
                  },
                }
              : {})}
            inputRef={composerRef}
          />
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
            modelName={modelName(data.engine, bot)}
            onClose={close}
            headingRef={detailsHeadingRef}
            headingId={detailsHeadingId}
            intents={{
              setRoutineEnabled: intents.setRoutineEnabled,
              openAttachment: intents.openAttachment,
              openMemoryFile: (path) => intents.openMemoryFile(bot.id, path),
              freshStart: () => intents.freshStart(bot.id),
              deleteBot: () => intents.deleteBot(bot.id),
              ...(editProfile ? { editProfile: () => editProfile(bot.id) } : {}),
            }}
          />
        );
      } else {
        details = (
          <RoomDetails
            room={item.room}
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
        onCloseDetails={() => navigation.setDetailsOpen(false)}
      />
    </BotsProvider>
  );
}
