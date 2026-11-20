// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionState,
  type BotChanges,
  cardAction,
  createJ3Client,
  type Draft,
  type DraftChangedElsewhere,
  type J3Client,
  type Loaded,
  type MemoryEdit,
  memorySaveKey,
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
import type {
  Bot,
  BotId,
  DeviceId,
  EntryId,
  EntryTarget,
  MemoryPath,
  MemoryScope,
  RoomId,
  WorkStep,
} from "@j3-bots/contracts";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useI18n } from "../app/context";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { memoryLabel } from "../components/DetailsPanel";
import { EditBotDialog } from "../components/EditBotDialog";
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
      <Notices>
        <Gate>{children}</Gate>
      </Notices>
    </J3ClientProvider>
  );
}

const SayContext = createContext<((text: string) => void) | null>(null);

/** Shows a short sentence in the page's one toast. */
const useSay = () => {
  const say = use(SayContext);
  if (say === null) throw new Error("useSay needs Notices above it.");
  return say;
};

/**
 * The page's toast, above the gate: a notice outlives the screen that asked
 * for it, as when signing out leaves the shell and another tab's pairing
 * brings it back.
 */
function Notices({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = useCallback(
    (text: string) => setNotice((previous) => ({ id: (previous?.id ?? 0) + 1, text })),
    [],
  );
  return (
    <SayContext value={say}>
      {children}
      <Toast notice={notice} onDone={() => setNotice(null)} />
    </SayContext>
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
  const pairing = useReadable(j3.pairing);
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
          {/* Mounted afresh for each pairing: nothing open or typed under one shows under the next. */}
          <LiveShell key={pairing ?? "none"} pairing={pairing}>
            {children}
          </LiveShell>
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

const memoryScopeOf = (view: MemoryView): MemoryScope => ({ _tag: "bot", botId: view.botId });

function LiveShell({ pairing, children }: { pairing: DeviceId | null; children: ReactNode }) {
  const j3 = useJ3Client();
  // An answer that arrives after the pairing changed belongs to the one that ended.
  const stillPaired = () => j3.pairing.get() === pairing;
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
  const settingsSave = useReadable(j3.settingsSave);
  const devices = useDevices();
  const actions = useActions();
  const drafts = useReadable(j3.drafts);
  const draftOffers = useReadable(j3.draftOffers);
  const draftsLoading = useReadable(j3.draftsSwitching);
  const draftsFailed = useReadable(j3.draftsReadFailed);
  const draftsNotSaved = useReadable(j3.draftsNotSaved);
  const conversation = useConversation(target);
  const files = useBotFiles(detailsBotId);
  const memory = useMemory(detailsBotId === null ? null : { _tag: "bot", botId: detailsBotId });
  const routines = useRoutines(detailsBotId);
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, isVisible);

  const [openFolds, setOpenFolds] = useState<ReadonlySet<EntryId>>(new Set());
  const [steps, setSteps] = useState<ReadonlyMap<EntryId, ReadonlyArray<WorkStep>>>(new Map());
  const [newBot, setNewBot] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryView | null>(null);
  const [editingBot, setEditingBot] = useState<BotId | null>(null);
  const botSaves = useReadable(j3.botSaves);
  const memorySaves = useReadable(j3.memorySaves);
  const openMemoryKey =
    memoryView === null ? null : memorySaveKey(memoryScopeOf(memoryView), memoryView.path);
  // What is open now, for a save that ends after its form closed.
  const open = useRef<{ bot: BotId | null; memory: string | null }>({ bot: null, memory: null });
  useEffect(() => {
    open.current = { bot: editingBot, memory: openMemoryKey };
  }, [editingBot, openMemoryKey]);
  const say = useSay();

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

  // Another tab sent or changed a draft under this one, and this tab shows it
  // as stored. Text of this tab's that the device never kept is offered back
  // beside the composer, for as long as the operator wants it: when this
  // change put it there, that notice says the draft changed, so the toast
  // does not, unless Send sent nothing.
  const changedElsewhere = useEffectEvent(({ whileSending, displaced }: DraftChangedElsewhere) => {
    if (whileSending) say(t("composer.changedElsewhereWhileSending"));
    else if (!displaced) say(t("composer.changedElsewhere"));
  });
  useEffect(() => j3.onDraftChangedElsewhere(changedElsewhere), [j3]);

  const data: ShellData = {
    engine: engine._tag === "ready" ? engine.value : null,
    engineStale: engine._tag === "ready" && engine.stale,
    roster: roster?.rows ?? null,
    conversation: (asked) =>
      viewKey !== null && targetKey(asked) === viewKey ? view : loadingView,
    draft: (asked) => drafts.get(targetKey(asked)) ?? blankDraft,
    offer: (asked) => draftOffers.get(targetKey(asked)) ?? null,
    draftsLoading,
    draftsFailed,
    draftNotSaved: (asked) => draftsNotSaved.has(targetKey(asked)),
    submitting: (entryId) =>
      submitting(actions.get(cardAction(entryId))) || submitting(actions.get(retryAction(entryId))),
    workSteps: (entryId) => steps.get(entryId) ?? null,
    routines: (botId) => (botId === detailsBotId ? loadedList(routines) : null),
    files: (botId) => (botId === detailsBotId ? loadedList(files) : null),
    memory: (botId) => (botId === detailsBotId ? loadedList(memory) : null),
    settings: settings._tag === "ready" ? settings.value : null,
    settingsSave,
    devices: devices._tag === "ready" ? devices.value : null,
    connected: connection._tag === "connected",
  };

  // The latest memory read owns the viewer: each read, opening and closing
  // moves this on, and an answer is applied only while its read still owns it.
  const memoryRead = useRef(0);

  /**
   * Reads a memory file into the viewer, and resolves with whether this read
   * put the file there. A read that fails after one succeeded keeps the
   * version already read.
   */
  const readMemoryFile = (botId: BotId, path: MemoryPath) => {
    const read = ++memoryRead.current;
    return j3.readMemory({ _tag: "bot", botId }, path).then((result) => {
      if (memoryRead.current !== read || !stillPaired()) return false;
      setMemoryView(
        (current) =>
          current && {
            ...current,
            reading:
              result._tag === "done"
                ? { _tag: "read", document: result.value }
                : current.reading._tag === "read"
                  ? current.reading
                  : { _tag: "failed" },
          },
      );
      return result._tag === "done";
    });
  };

  const openMemoryFile = (botId: BotId, path: MemoryPath) => {
    const title = memoryLabel(path, t);
    setMemoryView({ botId, path, title, reading: { _tag: "reading" } });
    void readMemoryFile(botId, path);
  };

  const closeMemoryFile = () => {
    memoryRead.current++;
    if (memoryView !== null) j3.dismissMemorySave(memoryScopeOf(memoryView), memoryView.path);
    setMemoryView(null);
  };

  const writeMemoryFile = (view: MemoryView, edit: MemoryEdit) => {
    const scope = memoryScopeOf(view);
    const key = memorySaveKey(scope, view.path);
    void j3.writeMemory(scope, view.path, edit).then((result) => {
      if (!stillPaired()) return;
      if (result._tag === "done") {
        setMemoryView((current) =>
          current?.botId !== view.botId || current.path !== view.path
            ? current
            : { ...current, reading: { _tag: "read", document: result.value } },
        );
      } else if (result._tag === "failed" && open.current.memory !== key) {
        say(t("memory.failedClosed", { file: view.title }));
      }
    });
  };

  const editingBotValue: Bot | null =
    editingBot === null
      ? null
      : (roster?.rows.flatMap((row) =>
          row._tag === "bot" && row.bot.id === editingBot ? [row.bot] : [],
        )[0] ?? null);

  const closeBotEditor = () => {
    if (editingBot !== null) j3.dismissBotSave(editingBot);
    setEditingBot(null);
  };

  // A bot that leaves the roster while its editor is open, deleted or hidden,
  // closes the editor for good. Its save is not dismissed: the operator did not
  // give up on it, so a failure is announced, and kept to show if they reopen it.
  if (editingBot !== null && roster !== null && editingBotValue === null) setEditingBot(null);

  const updateBot = (bot: Bot, changes: BotChanges) =>
    void j3.updateBot(bot.id, changes).then((result) => {
      if (!stillPaired()) return;
      if (open.current.bot !== bot.id) {
        if (result._tag === "failed") say(t("editBot.failedClosed", { name: bot.profile.name }));
      } else if (result._tag === "done") {
        setEditingBot(null);
      }
    });

  const goToBot = (botId: BotId) => navigate({ to: "/bots/$botId", params: { botId } });

  const intents: ShellIntents = {
    // An answer too long to reach the bot leaves the card open, with what was typed, to shorten.
    answerQuestion: (entryId, answers) =>
      void j3.answerCard(entryId, { _tag: "question", answers }).then((result) => {
        if (
          result._tag === "failed" &&
          result.failure._tag === "refused" &&
          result.failure.error._tag === "Invalid" &&
          result.failure.error.reason === "answer-length"
        ) {
          say(t("question.tooLong"));
        }
      }),
    dismissQuestion: (entryId) => void j3.answerCard(entryId, { _tag: "dismiss" }),
    decideApproval: (entryId, decision) =>
      void j3.answerCard(entryId, { _tag: "approval", decision }),
    provideSecret: (entryId, value) => void j3.provideSecret(entryId, { _tag: "provide", value }),
    declineSecret: (entryId) => void j3.provideSecret(entryId, { _tag: "decline" }),
    retryNotice: (entryId) => void j3.retryNotice(entryId),
    retryMessage: (entryId) => void j3.retryMessage(entryId),
    resendMessage: (commandId) =>
      void j3.resend(commandId).then((result) => {
        if (result._tag === "not-kept") say(t("message.changeNotKept"));
      }),
    discardMessage: (commandId) =>
      void j3.discard(commandId).then((discarded) => {
        if (!discarded) say(t("message.changeNotKept"));
      }),
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
    restoreDraft: j3.restoreDraft,
    retryDrafts: j3.retryDrafts,
    dismissDraftOffer: j3.dismissDraftOffer,
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
    editProfile: setEditingBot,
    openMemoryFile,
    freshStart: (botId, name) =>
      void j3
        .freshStart(botId)
        .then((result) =>
          say(
            result._tag === "done"
              ? t("details.freshStart.done", { name })
              : t("details.freshStart.failed"),
          ),
        ),
    deleteBot: (botId) =>
      void j3.deleteBot(botId, false).then((result) => {
        if (result._tag === "done") void navigate({ to: "/" });
        else say(t("details.deleteFailed"));
      }),
    updateSettings: (changes) => void j3.updateSettings(changes),
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
    signOut: () =>
      j3.signOut().then((result) => {
        // Another tab paired this browser again meanwhile: it stays signed in
        // under that pairing. The old one ended unless the server never said so.
        if (result._tag === "paired-anew") {
          say(
            t(
              result.revoked
                ? "settings.signOut.pairedAnew"
                : "settings.signOut.pairedAnewStillListed",
            ),
          );
        }
        return result._tag !== "failed";
      }),
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
      <EditBotDialog
        bot={editingBotValue}
        engine={data.engine}
        save={editingBot === null ? undefined : botSaves.get(editingBot)}
        connected={data.connected}
        onSave={(changes) => {
          if (editingBotValue !== null) updateBot(editingBotValue, changes);
        }}
        onClose={closeBotEditor}
      />
      <MemoryViewer
        file={memoryView}
        save={openMemoryKey === null ? undefined : memorySaves.get(openMemoryKey)}
        connected={data.connected}
        onSave={(edit) => {
          if (memoryView !== null) writeMemoryFile(memoryView, edit);
        }}
        onDiscard={() => {
          if (memoryView !== null) j3.dismissMemorySave(memoryScopeOf(memoryView), memoryView.path);
        }}
        onLoadNewer={() => {
          if (memoryView === null) return Promise.resolve(false);
          const { botId, path } = memoryView;
          // The conflict holds until the newer version is in hand. A read that
          // lost the viewer, or its pairing, resolves false and dismisses nothing.
          return readMemoryFile(botId, path).then((read) => {
            if (read) j3.dismissMemorySave(memoryScopeOf(memoryView), path);
            return read;
          });
        }}
        onClose={closeMemoryFile}
      />
    </ShellSourceContext>
  );
}
