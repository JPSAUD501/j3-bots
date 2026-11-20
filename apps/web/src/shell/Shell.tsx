// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, EntryTarget, RosterItem, RosterItemKey } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from "react";
import { BotsProvider } from "../app/context";
import { AppShell, type Region } from "../components/AppShell";
import { Composer } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import { FirstRun, NoSelection, QuietConversation } from "../components/EmptyStates";
import { Roster } from "../components/Roster";
import { SettingsMenu } from "../components/SettingsMenu";
import { Timeline } from "../components/Timeline";
import { filterRoster, orderRoster } from "../presentation/roster";
import type { ShellData, ShellIntents } from "./data";
import { isEditable, shellShortcuts } from "./shortcuts";

interface ShellNavigation {
  readonly selected: RosterItemKey | null;
  readonly detailsOpen: boolean;
  readonly select: (key: RosterItemKey | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
  /** The element a roster row renders as: a router link in the app, a button in a preview. */
  readonly rowLink: (item: RosterItem) => ReactElement;
}

const keyOf = (item: RosterItem): RosterItemKey =>
  item._tag === "bot"
    ? { _tag: "bot", botId: item.bot.id }
    : { _tag: "room", roomId: item.room.id };

const targetOf = (key: RosterItemKey): EntryTarget =>
  key._tag === "bot"
    ? { _tag: "conversation", botId: key.botId }
    : { _tag: "room", roomId: key.roomId };

const draftKey = (key: RosterItemKey) =>
  key._tag === "bot" ? `bot:${key.botId}` : `room:${key.roomId}`;

function modelName(engine: EngineStatus | null, bot: Bot): string | null {
  const provider = engine?.providers.find((p) => p.id === bot.model.providerId);
  const model = provider?.models.find((m) => m.id === bot.model.modelId);
  return provider && model ? `${provider.name} · ${model.name}` : null;
}

const finePointer = () => window.matchMedia("(pointer: fine)").matches;

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
  const shortcuts = shellShortcuts();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);

  const bots = data.roster.flatMap((item) => (item._tag === "bot" ? [item.bot] : []));
  const item =
    selected === null
      ? null
      : (data.roster.find((i) =>
          i._tag === "bot"
            ? selected._tag === "bot" && i.bot.id === selected.botId
            : selected._tag === "room" && i.room.id === selected.roomId,
        ) ?? null);
  const active: Region = item === null ? "roster" : detailsOpen ? "details" : "conversation";

  const selectionKey = item === null ? null : draftKey(keyOf(item));
  // Moving to another conversation with a mouse or keyboard puts the cursor in its
  // composer; opening or closing the details moves focus with them. Neither happens
  // on the first render, so loading a page never scrolls or steals focus.
  const shown = useRef({ selectionKey, detailsOpen });
  useEffect(() => {
    const before = shown.current;
    shown.current = { selectionKey, detailsOpen };
    if (before.detailsOpen !== detailsOpen) {
      if (detailsOpen) detailsHeadingRef.current?.focus();
      else titleRef.current?.focus();
    } else if (before.selectionKey !== selectionKey && selectionKey !== null && finePointer()) {
      composerRef.current?.focus();
    }
  }, [selectionKey, detailsOpen]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (shortcuts.nextBot.matches(event) || shortcuts.previousBot.matches(event)) {
      const rows = orderRoster(filterRoster(data.roster, ""));
      if (rows.length === 0) return;
      const index = item === null ? -1 : rows.indexOf(item);
      const step = shortcuts.nextBot.matches(event) ? 1 : -1;
      const next = rows[(index + step + rows.length) % rows.length];
      if (next) {
        event.preventDefault();
        navigation.select(keyOf(next));
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
    } else if (event.key === "Escape" && detailsOpen) {
      event.preventDefault();
      navigation.setDetailsOpen(false);
    }
  });
  useEffect(() => {
    if (!keyboard) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [keyboard]);

  if (data.roster.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <FirstRun engine={data.engine} onCreateBot={intents.createBot} />
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
      footer={<SettingsMenu />}
    />
  );

  let conversation: ReactElement = <NoSelection nextShortcut={shortcuts.nextBot.label} />;
  let details: ReactElement | null = null;
  if (item !== null) {
    const key = keyOf(item);
    const target = targetOf(key);
    const entries = data.entries(target);
    const draft = drafts[draftKey(key)] ?? "";
    const recipient = item._tag === "bot" ? item.bot.profile.name : item.room.name;
    const toggleDetails = () => navigation.setDetailsOpen(!detailsOpen);
    conversation = (
      <>
        <ConversationHeader
          subject={
            item._tag === "bot" ? { _tag: "bot", bot: item.bot } : { _tag: "room", room: item.room }
          }
          detailsOpen={detailsOpen}
          onToggleDetails={toggleDetails}
          onBack={() => navigation.select(null)}
          onStop={() => {
            if (item._tag === "bot") intents.stopBot(item.bot.id);
          }}
          stopShortcut={shortcuts.stop.label}
          titleRef={titleRef}
        />
        {entries.length === 0 && item._tag === "bot" ? (
          <QuietConversation bot={item.bot} />
        ) : (
          // Reversed, so the view stays pinned to the newest entry as entries arrive.
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]">
            <div className="mx-auto w-full max-w-(--layout-text-column) px-3 py-4 @tablet:px-6">
              <Timeline
                entries={entries}
                inRoom={item._tag === "room"}
                workSteps={data.workSteps}
                intents={intents}
              />
            </div>
          </div>
        )}
        <div className="mx-auto w-full max-w-(--layout-text-column) px-3 pt-1 pb-3 @tablet:px-6">
          <Composer
            recipient={recipient}
            value={draft}
            onValueChange={(value) => setDrafts((d) => ({ ...d, [draftKey(key)]: value }))}
            onSend={() => {
              intents.sendMessage(target, draft.trim());
              setDrafts((d) => ({ ...d, [draftKey(key)]: "" }));
            }}
            onAttach={() => intents.attach(target)}
            onDictate={() => intents.dictate(target)}
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
            intents={{
              ...intents,
              editProfile: () => intents.editProfile(bot.id),
              freshStart: () => intents.freshStart(bot.id),
              deleteBot: () => intents.deleteBot(bot.id),
            }}
          />
        );
      } else {
        details = <RoomDetails room={item.room} onClose={close} headingRef={detailsHeadingRef} />;
      }
    }
  }

  return (
    <BotsProvider bots={bots}>
      <AppShell
        roster={roster}
        conversation={conversation}
        details={details}
        active={active}
        onCloseDetails={() => navigation.setDetailsOpen(false)}
      />
    </BotsProvider>
  );
}
