// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ConnectionState, targetKey } from "@j3-bots/client-runtime";
import {
  J3ClientProvider,
  useConnection,
  useConnectors,
  useConversation,
  useEngineStatus,
  useJ3Client,
  useReadable,
  useSettings,
} from "@j3-bots/client-runtime/react";
import type { EntryTarget } from "@j3-bots/contracts";
import type { Destination } from "@j3-bots/desktop-bridge";
import { use, useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from "react";
import { OperatorTimeZone } from "../app/clock";
import { useReportSaving } from "../live/appUpdate";
import { useAttachments } from "../live/attachments";
import { useCardIntents, useCardSubmitting } from "../live/cardIntents";
import { client, server } from "../live/client";
import { useComposerSource } from "../live/composer";
import type { Desktop } from "../live/desktop";
import { useInView } from "../live/inView";
import { useNotice } from "../live/notices";
import { useSavesUnderWay } from "../live/savesUnderWay";
import { themesIntents, useThemesView } from "../live/themes";
import { useWorkFolds } from "../live/workFolds";
import type { ConversationView } from "../shell/data";
import { ThemeRuntime } from "../themes/ThemeRuntime";
import { QuickAccess, type QuickAccessData, type QuickAccessIntents } from "./QuickAccess";
import { useWindowContext } from "./windowContext";

/**
 * Marks the page as quick access's for as long as it is one: its background
 * is the window's see-through part, or the card's color where the window is
 * not see-through, and what the page opens over the card shows only while
 * the card does (index.css).
 */
function useQuickPage(solid: boolean, shown: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["quick"] = solid ? "solid" : "clear";
    return () => {
      delete root.dataset["quick"];
    };
  }, [solid]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (shown) delete root.dataset["quickOut"];
    else root.dataset["quickOut"] = "";
    return () => {
      delete root.dataset["quickOut"];
    };
  }, [shown]);
}

/** Tells the app that quick access has nothing to show, for as long as this is on the page. */
function Unavailable({ app, solid }: { app: Desktop; solid: boolean }) {
  useQuickPage(solid, false);
  useEffect(() => app.quickAccess.report(false), [app]);
  return null;
}

/**
 * The page of the desktop app's quick access window, on the server the app
 * is on. It keeps its own connection, as another tab does, so the window
 * opens on a conversation that is already there; and it tells the app
 * whether it has one to show: a primary bot, on a server it has reached. Until
 * then it draws nothing, and the app's shortcut shows the main window.
 */
export function QuickAccessLive({ app, solid }: { app: Desktop; solid: boolean }) {
  // No server named yet, or the bots moved away from this computer: nothing connects.
  if (server === null || app.moved !== null) return <Unavailable app={app} solid={solid} />;
  return (
    <J3ClientProvider client={use(client(server))}>
      <Connected app={app} origin={server} solid={solid} />
    </J3ClientProvider>
  );
}

const loadingView: ConversationView = {
  phase: "loading",
  items: [],
  hasOlder: false,
  loadingOlder: false,
};

/**
 * How long the card has to go out before the window is hidden anyway, in ms:
 * its way out is drawn frame by frame, and a page that draws no frame, as one
 * the system has covered, would never say it has left.
 */
const LEAVE_WITHIN = 600;

/** Whether the server is reached now: what quick access needs to open on. */
const reached = (connection: ConnectionState) => connection._tag === "connected";

function Connected({ app, origin, solid }: { app: Desktop; origin: URL; solid: boolean }) {
  const j3 = useJ3Client();
  const connection = useConnection();
  const pairing = useReadable(j3.pairing);
  const recordsScreens = useReadable(j3.screenRecordings);
  const listed = useReadable(j3.roster);
  const roster = listed._tag === "ready" ? listed.value : null;
  const primary =
    roster?.flatMap((row) => (row._tag === "bot" && row.bot.primary ? [row] : []))[0] ?? null;
  const botId = primary?.bot.id ?? null;
  const conversation = useConversation(botId === null ? null : { _tag: "conversation", botId });
  const engine = useEngineStatus();
  const settings = useSettings();
  const connectors = useConnectors();
  const secrets = useReadable(j3.secrets.view);
  const themes = useThemesView(j3);
  const themeIntents = useMemo(() => themesIntents(j3), [j3]);
  const folds = useWorkFolds();
  const { say, toast } = useNotice();
  const attachments = useAttachments(j3, say);
  // A connector's sign-in comes back to the desktop app, never to the server itself.
  const cards = useCardIntents(j3, say, origin, false);
  const submitting = useCardSubmitting();
  const composer = useComposerSource(j3, say);
  const windowContext = useWindowContext(app);
  // A restart into an update waits for what this page still saves, as for the main window's.
  useReportSaving(useSavesUnderWay(j3));

  // The app shows the window and asks the page to go out; the page says when
  // it has, naming the showing it went out of (`asked`, the latest one's number).
  const [shown, setShown] = useState(false);
  const [asked, setAsked] = useState(0);
  // With no bot to draw, as once the primary bot is deleted or this device's
  // pairing ends, nothing of it may stay up: the window would be an unseen
  // thing over the operator's other apps.
  const drawable = primary !== null && pairing !== null;
  if (shown && !drawable) setShown(false);
  useEffect(() => {
    if (!drawable) app.quickAccess.hide(asked);
  }, [app, drawable, asked]);
  useQuickPage(solid, shown);
  // What was open over the card, as an image, goes with it: asked for again, it is the conversation.
  const putAway = useEffectEvent(attachments.close);
  useEffect(() => {
    if (!shown) putAway();
  }, [shown]);
  useEffect(
    () =>
      app.quickAccess.onCue((cue) => {
        if (cue._tag === "seen") return;
        setShown(cue._tag === "open");
        if (cue._tag === "open") setAsked(cue.opening);
      }),
    [app],
  );

  useEffect(() => {
    if (shown) return;
    const timer = window.setTimeout(() => app.quickAccess.hide(asked), LEAVE_WITHIN);
    return () => window.clearTimeout(timer);
  }, [app, shown, asked]);

  const available = reached(connection) && pairing !== null && botId !== null;
  useEffect(() => {
    app.quickAccess.report(available);
  }, [app, available]);
  useEffect(() => () => app.quickAccess.report(false), [app]);

  // The conversation is on screen here only while the card shows it with
  // nothing over it (which the card tells), in a window the operator is
  // looking at: the server keeps its notifications quiet for it then, as for
  // the main window's.
  const inView = useInView();
  const viewKey = botId === null ? null : targetKey({ _tag: "conversation", botId });
  const [onScreen, setOnScreen] = useState<EntryTarget | null>(null);
  useEffect(() => {
    j3.setView(inView ? onScreen : null);
  }, [j3, inView, onScreen]);

  if (primary === null || pairing === null) return null;

  /** The main window, at `target`: where everything quick access does not hold opens. */
  const openInMain = (target: Destination) => app.quickAccess.openInMain(target, pairing);
  const conversationOf = { _tag: "conversation", botId: primary.bot.id } as const;
  const view: ConversationView =
    conversation.state === null
      ? loadingView
      : {
          phase: conversation.state.phase,
          items: conversation.state.items,
          hasOlder: conversation.state.hasOlder,
          loadingOlder: conversation.state.loadingOlder,
        };
  const data: QuickAccessData = {
    ...composer.data,
    roster,
    conversation: (asked) =>
      viewKey !== null && targetKey(asked) === viewKey ? view : loadingView,
    connectors: connectors._tag === "ready" ? connectors.value : null,
    submitting,
    workSteps: folds.steps,
    secrets,
    engine: engine._tag === "ready" ? engine.value : null,
    connected: reached(connection),
  };
  const intents: QuickAccessIntents = {
    ...cards,
    ...composer.intents,
    // The window the operator was in goes with what they send from here.
    sendDraft: (asked, addressing) => {
      const going = windowContext.send();
      void composer.send(asked, addressing, going.context).then((result) => {
        if (result === "sent") going.sent();
      });
    },
    openWorkFold: folds.open,
    closeWorkFold: folds.close,
    openAttachment: attachments.open,
    openWorkImage: attachments.openWorkImage,
    // A bot's browser, a routine's runs, another bot's conversation and a
    // connector's sign-in need the whole window, which opens on each.
    openBrowser: (bot, tab) => openInMain({ _tag: "browser", botId: bot, tab }),
    openRoutine: (routineId) => openInMain({ _tag: "routine", botId: primary.bot.id, routineId }),
    openConversation: (bot) => openInMain({ _tag: "conversation", botId: bot }),
    signInConnector: (entry) => openInMain({ _tag: "connector", connectorId: entry.connectorId }),
    // The sheet before a recording opens in the main window, which hides as it starts.
    ...(recordsScreens
      ? { recordScreen: (asked: EntryTarget) => app.recording.openInMain(asked, pairing) }
      : {}),
    setShown: setOnScreen,
    loadOlder: (asked) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.loadOlder();
    },
    revealEntry: (asked, entryId) =>
      viewKey !== null && targetKey(asked) === viewKey
        ? conversation.reveal(entryId)
        : Promise.resolve("unreachable"),
    markRead: (asked, through) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.markRead(through);
    },
    stopBot: (bot) => void j3.stopBot(bot),
    forceStopBot: (bot) => void j3.forceStopBot(bot),
    secrets: { ...j3.secrets, copy: app.copySecret },
  };
  return (
    // Every time in the operator's time zone, and the theme, as the main window shows them.
    <ThemeRuntime themes={themes} intents={themeIntents}>
      <OperatorTimeZone timeZone={settings._tag === "ready" ? settings.value.timeZone : null}>
        {attachments.host(
          <QuickAccess
            // One per bot: another primary bot opens afresh, at its own end.
            key={primary.bot.id}
            bot={primary.bot}
            lastEntry={primary.lastEntry}
            data={data}
            intents={intents}
            solid={solid}
            shown={shown}
            asked={asked}
            onOpenConversation={() => openInMain(conversationOf)}
            onOpenPair={(botIds, at) => openInMain({ _tag: "pair", botIds, at })}
            onOpenRoom={(roomId) => openInMain({ _tag: "room", roomId })}
            onOpenBot={(botId) => openInMain({ _tag: "conversation", botId })}
            onClose={() => setShown(false)}
            onLeft={() => app.quickAccess.hide(asked)}
            overlay={toast}
            window={
              windowContext.view === null
                ? null
                : { view: windowContext.view, intents: windowContext.intents }
            }
          />,
        )}
        {folds.readers}
      </OperatorTimeZone>
    </ThemeRuntime>
  );
}
