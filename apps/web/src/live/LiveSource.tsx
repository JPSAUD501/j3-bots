// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionState,
  cardAction,
  createJ3Client,
  type Draft,
  type J3Client,
  type Loaded,
  retryAction,
  targetKey,
} from "@j3-bots/client-runtime";
import {
  J3ClientProvider,
  useActions,
  useBotFiles,
  useConnection,
  useConversation,
  useDevices,
  useEngineStatus,
  useJ3Client,
  useMemory,
  useReadable,
  useRoster,
  useRoutines,
  useSettings,
  useWorkSteps,
} from "@j3-bots/client-runtime/react";
import type { BotId, EntryId, EntryTarget, MemoryPath, RoomId, WorkStep } from "@j3-bots/contracts";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  use,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useI18n } from "../app/context";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { memoryLabel } from "../components/DetailsPanel";
import { MemoryViewer, type MemoryReading } from "../components/MemoryViewer";
import { NewBotDialog } from "../components/NewBotDialog";
import { guessDeviceName, Incompatible, Pairing, StorageFailed } from "../components/Pairing";
import { type Notice, Toast } from "../components/Toast";
import type { ConversationView, ShellData, ShellIntents } from "../shell/data";
import { ShellSourceContext } from "../shell/source";
import { deliverFile, reserveWindow } from "./openFile";
import { platform } from "./platform";

let started: Promise<J3Client> | null = null;
/** One client for the page, made on first use. */
const client = () => (started ??= createJ3Client(platform));

/**
 * The shell's source in a build: the client runtime, connected to the server
 * that serves this page. Before the shell, it answers whatever stands between
 * the operator and their bots: pairing, a server of another version, storage
 * the browser refuses.
 */
export function LiveSourceProvider({ children }: { children: ReactNode }) {
  return (
    <J3ClientProvider client={use(client())}>
      <Gate>{children}</Gate>
    </J3ClientProvider>
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      {children}
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const j3 = useJ3Client();
  const connection = useConnection();
  const [everConnected, setEverConnected] = useState(false);
  if (connection._tag === "connected" && !everConnected) setEverConnected(true);
  switch (connection._tag) {
    case "starting":
      return null;
    case "unpaired":
      return (
        <Screen>
          <Pairing
            reason={connection.reason}
            defaultName={guessDeviceName(navigator.userAgent)}
            onPair={j3.pair}
          />
        </Screen>
      );
    case "incompatible":
      return (
        <Screen>
          <Incompatible />
        </Screen>
      );
    case "storage-failed":
      return (
        <Screen>
          <StorageFailed onRetry={j3.reconnectNow} />
        </Screen>
      );
    case "offline":
    case "connecting":
    case "waiting":
    case "connected":
      return (
        <ConnectionBanner
          state={connection}
          everConnected={everConnected}
          onRetryNow={j3.reconnectNow}
        >
          <LiveShell>{children}</LiveShell>
        </ConnectionBanner>
      );
  }
}

const loadingView: ConversationView = {
  phase: "loading",
  items: [],
  hasOlder: false,
  loadingOlder: false,
};
const blankDraft: Draft = { text: "", files: [], sending: false };

const submitting = (state: ActionState | undefined) => state?._tag === "submitting";

/** A read's value once loaded; a list that is gone reads as empty. */
const loadedList = <A,>(loaded: Loaded<ReadonlyArray<A>> | null): ReadonlyArray<A> | null =>
  loaded === null || loaded._tag === "loading" ? null : loaded._tag === "ready" ? loaded.value : [];

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const isVisible = () => document.visibilityState === "visible";

/** Reads one open work fold's steps for as long as it stays open. */
function FoldReader({
  foldId,
  onSteps,
}: {
  foldId: EntryId;
  onSteps: (foldId: EntryId, steps: ReadonlyArray<WorkStep>) => void;
}) {
  const state = useWorkSteps(foldId);
  const report = useEffectEvent(onSteps);
  useEffect(() => {
    if (state !== null && state.phase !== "loading") report(foldId, state.steps);
  }, [foldId, state]);
  return null;
}

/** The conversation or room the URL names. */
const targetOf = (botId: BotId | null, roomId: RoomId | null): EntryTarget | null =>
  botId !== null
    ? { _tag: "conversation", botId }
    : roomId !== null
      ? { _tag: "room", roomId }
      : null;

interface MemoryView {
  readonly botId: BotId;
  readonly path: MemoryPath;
  readonly title: string;
  readonly reading: MemoryReading;
}

function LiveShell({ children }: { children: ReactNode }) {
  const j3 = useJ3Client();
  const { t } = useI18n();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const botId = params.botId ?? null;
  const roomId = params.roomId ?? null;
  const target = targetOf(botId, roomId);
  const detailsBotId: BotId | null = search.details === true && params.botId ? params.botId : null;

  const connection = useConnection();
  const roster = useRoster();
  const engine = useEngineStatus();
  const settings = useSettings();
  const devices = useDevices();
  const actions = useActions();
  const drafts = useReadable(j3.drafts);
  const conversation = useConversation(target);
  const files = useBotFiles(detailsBotId);
  const memory = useMemory(detailsBotId === null ? null : { _tag: "bot", botId: detailsBotId });
  const routines = useRoutines(detailsBotId);
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, isVisible);

  const [openFolds, setOpenFolds] = useState<ReadonlySet<EntryId>>(new Set());
  const [steps, setSteps] = useState<ReadonlyMap<EntryId, ReadonlyArray<WorkStep>>>(new Map());
  const [newBot, setNewBot] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const view: ConversationView =
    conversation.state === null
      ? loadingView
      : {
          phase: conversation.state.phase,
          items: conversation.state.items,
          hasOlder: conversation.state.hasOlder,
          loadingOlder: conversation.state.loadingOlder,
        };

  // The server tells the operator's other devices what is on screen here, and
  // keeps notifications for it quiet. A hidden page shows nothing.
  const viewKey = target === null ? null : targetKey(target);
  useEffect(() => {
    j3.setView(visible ? targetOf(botId, roomId) : null);
  }, [j3, botId, roomId, visible]);

  const say = (text: string, action: Notice["action"] = null) =>
    setNotice((previous) => ({ id: (previous?.id ?? 0) + 1, text, action }));

  // Another tab sent or changed a draft under this one: this tab shows it as
  // stored, and the operator decides whether their text goes back in.
  const changedElsewhere = useEffectEvent((asked: EntryTarget) =>
    say(t("composer.changedElsewhere"), {
      label: t("composer.restoreMine"),
      run: () => j3.restoreDraft(asked),
    }),
  );
  useEffect(() => j3.onDraftChangedElsewhere(changedElsewhere), [j3]);

  const data: ShellData = {
    engine: engine._tag === "ready" ? engine.value : null,
    engineStale: engine._tag === "ready" && engine.stale,
    roster: roster?.rows ?? null,
    conversation: (asked) =>
      viewKey !== null && targetKey(asked) === viewKey ? view : loadingView,
    draft: (asked) => drafts.get(targetKey(asked)) ?? blankDraft,
    submitting: (entryId) =>
      submitting(actions.get(cardAction(entryId))) || submitting(actions.get(retryAction(entryId))),
    workSteps: (entryId) => steps.get(entryId) ?? null,
    routines: (botId) => (botId === detailsBotId ? loadedList(routines) : null),
    files: (botId) => (botId === detailsBotId ? loadedList(files) : null),
    memory: (botId) => (botId === detailsBotId ? loadedList(memory) : null),
    settings: settings._tag === "ready" ? settings.value : null,
    devices: devices._tag === "ready" ? devices.value : null,
    connected: connection._tag === "connected",
  };

  const openMemoryFile = (botId: BotId, path: MemoryPath) => {
    const title = memoryLabel(path, t);
    setMemoryView({ botId, path, title, reading: { _tag: "reading" } });
    // Two files can share a title, and two bots a path: a late answer for another file is dropped.
    j3.readMemory({ _tag: "bot", botId }, path).then((result) =>
      setMemoryView((current) =>
        current?.botId !== botId || current.path !== path
          ? current
          : {
              ...current,
              reading:
                result._tag === "done"
                  ? { _tag: "read", document: result.value }
                  : { _tag: "failed" },
            },
      ),
    );
  };

  const goToBot = (botId: BotId) => navigate({ to: "/bots/$botId", params: { botId } });

  const intents: ShellIntents = {
    answerQuestion: (entryId, answers) =>
      void j3.answerCard(entryId, { _tag: "question", answers }),
    dismissQuestion: (entryId) => void j3.answerCard(entryId, { _tag: "dismiss" }),
    decideApproval: (entryId, decision) =>
      void j3.answerCard(entryId, { _tag: "approval", decision }),
    provideSecret: (entryId, value) => void j3.provideSecret(entryId, { _tag: "provide", value }),
    declineSecret: (entryId) => void j3.provideSecret(entryId, { _tag: "decline" }),
    retryNotice: (entryId) => void j3.retryNotice(entryId),
    retryMessage: (entryId) => void j3.retryMessage(entryId),
    resendMessage: (commandId) => void j3.resend(commandId),
    discardMessage: j3.discard,
    openWorkFold: (entryId) => setOpenFolds((open) => new Set(open).add(entryId)),
    closeWorkFold: (entryId) =>
      setOpenFolds((open) => new Set([...open].filter((id) => id !== entryId))),
    openAttachment: (attachment) => {
      // Reserved now, while the click still lets the page open a window.
      const reserved = reserveWindow(attachment);
      j3.download(attachment).then((result) => {
        if (result._tag === "done") {
          deliverFile(attachment, result.value.body, reserved);
          return;
        }
        reserved?.close();
        say(
          result.reason === "not-found"
            ? t("file.gone", { name: attachment.name })
            : t("file.unreachable", { name: attachment.name }),
        );
      });
    },
    openHandoff: (entryId) => {
      const handoff = view.items.find((item) => item._tag === "handoff" && item.id === entryId);
      if (handoff?._tag === "handoff") goToBot(handoff.recipientId);
    },
    // A routine has no screen of its own yet: its bot's details list it.
    openRoutine: () => void navigate({ to: ".", search: (prev) => ({ ...prev, details: true }) }),
    openConversation: (botId) => void goToBot(botId),
    setRoutineEnabled: (routineId, enabled) => void j3.setRoutineEnabled(routineId, enabled),
    setDraftText: j3.setDraftText,
    attachFiles: (asked, picked) =>
      j3.attachFiles(
        asked,
        picked.map((file) => ({ name: file.name, body: file })),
      ),
    detachFile: j3.detachFile,
    sendDraft: (asked) =>
      void j3.sendDraft(asked).then((result) => {
        if (result === "not-kept") say(t("composer.notKept"));
      }),
    loadOlder: (asked) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.loadOlder();
    },
    markRead: (asked, through) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.markRead(through);
    },
    stopBot: (botId) => void j3.stopBot(botId),
    createBot: (name, primary) =>
      j3.createBot({ name, primary }).then((result) => {
        if (result._tag === "failed") throw new Error("The bot was not created");
        return result.value.id;
      }),
    newBot: () => setNewBot(true),
    openMemoryFile,
    freshStart: (botId) => void j3.freshStart(botId),
    deleteBot: (botId) =>
      void j3.deleteBot(botId, false).then((result) => {
        if (result._tag === "done") void navigate({ to: "/" });
        else say(t("details.deleteFailed"));
      }),
    updateSettings: (changes) =>
      j3.updateSettings(changes).then((result) => result._tag === "done"),
    startPairing: () =>
      j3
        .startPairing()
        .then((result) =>
          result._tag === "done"
            ? { _tag: "started", code: result.value.code, expiresAt: result.value.expiresAt }
            : { _tag: "failed" },
        ),
    revokeDevice: (deviceId) => j3.revokeDevice(deviceId).then((result) => result._tag === "done"),
    refreshDevices: j3.refreshDevices,
    signOut: () => j3.signOut().then((result) => result !== "failed"),
  };

  return (
    <ShellSourceContext value={{ data, intents }}>
      {children}
      {[...openFolds].map((foldId) => (
        <FoldReader
          key={foldId}
          foldId={foldId}
          onSteps={(id, list) => setSteps((held) => new Map(held).set(id, list))}
        />
      ))}
      <NewBotDialog
        open={newBot}
        onOpenChange={setNewBot}
        onCreate={(name, primary) =>
          intents.createBot(name, primary).then((botId) => {
            setNewBot(false);
            void goToBot(botId);
          })
        }
      />
      <MemoryViewer
        title={memoryView?.title ?? null}
        reading={memoryView?.reading ?? { _tag: "reading" }}
        onClose={() => setMemoryView(null)}
      />
      <Toast notice={notice} onDone={() => setNotice(null)} />
    </ShellSourceContext>
  );
}
