// SPDX-License-Identifier: AGPL-3.0-or-later
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
  useRecentTurns,
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
  Notification,
  Room,
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
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  cardAction,
  createJ3Client,
  memorySaveKey,
  retryAction,
  targetKey,
  type ActionState,
  type BotChanges,
  type Draft,
  type DraftChangedElsewhere,
  type IntentFailure,
  type J3Client,
  type Loaded,
  type MemoryEdit,
} from "@j3-bots/client-runtime";
import { handoffPeer, type RoomFormMode } from "@j3-bots/client-runtime/presentation";
import { notificationText } from "@j3-bots/i18n";
import { useI18n } from "../app/context";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { memoryLabel } from "../components/DetailsPanel";
import { EditBotDialog } from "../components/EditBotDialog";
import { MemoryViewer, type MemoryReading } from "../components/MemoryViewer";
import { NewBotDialog } from "../components/NewBotDialog";
import { RoomDialog, type RoomSubmission } from "../components/RoomDialog";
import { guessDeviceName, Incompatible, Pairing, StorageFailed } from "../components/Pairing";
import { ServerAddress } from "../components/ServerAddress";
import { type Notice, Toast } from "../components/Toast";
import { notificationAccess } from "../preferences/notifications";
import type { ConversationView, DesktopServer, ShellData, ShellIntents } from "../shell/data";
import { ShellSourceProvider } from "../shell/source";
import {
  closeNotificationsOf,
  closeNotificationsOutside,
  onNotificationClick,
  showNotification,
} from "./notify";
import { deliverFile, reserveWindow } from "./openFile";
import { desktop } from "./desktop";
import { makePlatform, signInUnencrypted } from "./platform";

let started: Promise<J3Client> | null = null;

/**
 * What the room form is open for. A room is named by id and read from the
 * roster. Each opening is a new value, so what a save of one opening does
 * never reaches another.
 */
type RoomFormTarget =
  | { readonly _tag: "create" }
  | { readonly _tag: "edit" | "unarchive"; readonly roomId: RoomId };

/**
 * The server this page talks to: the one that serves it in a browser, the one
 * the operator named in the desktop app. `null` in the desktop app until they
 * have named one.
 */
const server = desktop === null ? new URL(window.location.origin) : desktop.server;

/** In the desktop app, the server it talks to and a way to leave it. */
const desktopServer: DesktopServer | undefined =
  desktop === null || server === null
    ? undefined
    : { address: server.origin, forget: desktop.forgetServer };

/** One client for the page, made on first use. */
const client = (origin: URL) => (started ??= createJ3Client(makePlatform(origin)));

/**
 * The shell's source in a build: the client runtime, connected to the server.
 * Before the shell, it answers whatever stands between the operator and their
 * bots: naming the server (in the desktop app), pairing, a server of another
 * version, storage the browser refuses.
 */
export function LiveSourceProvider({ children }: { children: ReactNode }) {
  if (server === null) {
    return (
      <Screen>
        <ServerAddress
          onConnect={(address) => desktop?.connect(address) ?? Promise.resolve(null)}
        />
      </Screen>
    );
  }
  return <Connected origin={server}>{children}</Connected>;
}

function Connected({ origin, children }: { origin: URL; children: ReactNode }) {
  return (
    <J3ClientProvider client={use(client(origin))}>
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
  // A pairing this window followed ends, signed out or revoked, here or in
  // another tab: what it received leaves the screen, its words with it. The
  // first pairing the window knows also closes what any other pairing
  // received, for a window closed before it finished sweeping one that ended.
  const followed = useRef(pairing);
  const sweptOthers = useRef(false);
  useEffect(() => {
    const ended = followed.current;
    followed.current = pairing;
    const unlisted = () => {
      // The browser would not list them; they close when the operator dismisses them.
    };
    if (pairing !== null && !sweptOthers.current) {
      sweptOthers.current = true;
      closeNotificationsOutside(pairing, () => j3.pairing.get()).catch(unlisted);
    }
    if (ended === null || ended === pairing) return;
    closeNotificationsOf(ended).catch(unlisted);
  }, [j3, pairing]);
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
            server={desktopServer}
            restart={desktop?.relaunch}
          />
        </Screen>
      );
    case "incompatible":
      return (
        <Screen>
          <Incompatible server={desktopServer} />
        </Screen>
      );
    case "storage-failed":
      return (
        <Screen>
          <StorageFailed
            onRetry={j3.reconnectNow}
            desktop={
              desktop === null || desktopServer === undefined
                ? undefined
                : { server: desktopServer, restart: desktop.relaunch }
            }
          />
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
const blankDraft: Draft = { text: "", mentions: [], files: [], sending: false };

const submitting = (state: ActionState | undefined) => state?._tag === "submitting";

/** A read's value once loaded; a list that is gone reads as empty. */
const loadedList = <A,>(loaded: Loaded<ReadonlyArray<A>> | null): ReadonlyArray<A> | null =>
  loaded === null || loaded._tag === "loading" ? null : loaded._tag === "ready" ? loaded.value : [];

const subscribeInView = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
};
/** Whether the operator is looking at this window: it shows, and it has focus. */
const isInView = () => document.visibilityState === "visible" && document.hasFocus();

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
  const i18n = useI18n();
  const { t } = i18n;
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const botId = params.botId ?? null;
  const roomId = params.roomId ?? null;
  const target = targetOf(botId, roomId);
  const detailsBotId: BotId | null = search.details === true && params.botId ? params.botId : null;

  const connection = useConnection();
  // The whole roster, hidden bots included: the shell leaves hidden bots out
  // of its list, and still shows one opened from a search or a notification.
  const listedRoster = useReadable(j3.roster);
  const roster = listedRoster._tag === "ready" ? listedRoster.value : null;
  const engine = useEngineStatus();
  const settings = useSettings();
  const profileSave = useReadable(j3.settingsSaves.profile);
  const notificationsSave = useReadable(j3.settingsSaves.notifications);
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
  const inView = useSyncExternalStore(subscribeInView, isInView, isInView);

  const [openFolds, setOpenFolds] = useState<ReadonlySet<EntryId>>(new Set());
  const [steps, setSteps] = useState<ReadonlyMap<EntryId, ReadonlyArray<WorkStep>>>(new Map());
  const [newBot, setNewBot] = useState(false);
  const [memoryView, setMemoryView] = useState<MemoryView | null>(null);
  const [editingBot, setEditingBot] = useState<BotId | null>(null);
  const [roomForm, setRoomForm] = useState<RoomFormTarget | null>(null);
  // Whether New bot, the bot editor and the memory viewer hold what the
  // operator typed and has not saved yet, as they report.
  const [newBotUnsaved, setNewBotUnsaved] = useState(false);
  const [botEditUnsaved, setBotEditUnsaved] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [roomFormUnsaved, setRoomFormUnsaved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Without a roster, Settings has no button and closes without saying so.
  if (settingsOpen && (roster === null || roster.length === 0)) setSettingsOpen(false);
  // Read each time Settings opens, and on every socket while it stays open.
  const recentTurns = useRecentTurns(settingsOpen);
  // What the shell shows with nothing over it.
  const [shown, setShown] = useState<EntryTarget | null>(null);
  const botSaves = useReadable(j3.botSaves);
  const memorySaves = useReadable(j3.memorySaves);
  const openMemoryKey =
    memoryView === null ? null : memorySaveKey(memoryScopeOf(memoryView), memoryView.path);
  // What is open now, for a save that ends after its form closed.
  // And the conversation on screen, for a deletion that ends after the operator moved on.
  const open = useRef<{
    bot: BotId | null;
    memory: string | null;
    room: RoomFormTarget | null;
    onScreen: string | null;
  }>({ bot: null, memory: null, room: null, onScreen: null });
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

  // The server keeps notifications quiet for what is on screen here: what the
  // shell shows with nothing over it, in a window that is visible and has
  // focus. A window that is hidden or in the background shows the operator
  // nothing.
  const viewKey = target === null ? null : targetKey(target);
  useEffect(() => {
    open.current = { bot: editingBot, memory: openMemoryKey, room: roomForm, onScreen: viewKey };
  }, [editingBot, openMemoryKey, roomForm, viewKey]);
  /** Leaves a conversation that was just deleted, unless the operator already moved on. */
  const leaveDeleted = (deleted: EntryTarget) => {
    if (open.current.onScreen === targetKey(deleted)) void navigate({ to: "/" });
  };
  useEffect(() => {
    j3.setView(inView ? shown : null);
  }, [j3, inView, shown]);

  // What the server says no device has in view, shown by the browser once the
  // operator allowed it. A click focuses a window and opens the conversation
  // or room, whose newest entry is what the notification was about, if the
  // window still follows the pairing that received it. Settings, the details
  // and the dialogs over it close, and the profile form in Settings keeps what
  // the operator typed. New bot holding a name, and the bot editor or the
  // memory viewer holding an edit, stay open, with the conversation opened
  // under them: the click never throws typing away, and closing the dialog
  // lands on what the notification was about. A save under way is not given up on.
  const openTarget = useEffectEvent((opened: EntryTarget) => {
    setSettingsOpen(false);
    if (!newBotUnsaved) setNewBot(false);
    if (!botEditUnsaved) setEditingBot(null);
    if (!memoryEditing) setMemoryView(null);
    if (!roomFormUnsaved) setRoomForm(null);
    // Opening it drops the details from the address, which closes them.
    if (opened._tag === "conversation") {
      void navigate({ to: "/bots/$botId", params: { botId: opened.botId } });
    } else {
      void navigate({ to: "/rooms/$roomId", params: { roomId: opened.roomId } });
    }
  });
  const notify = useEffectEvent((notification: Notification) => {
    if (pairing === null || !stillPaired() || notificationAccess() !== "granted") return;
    // What is on screen here never notifies, even when the server sent it
    // before it heard this window's view, as right after a reconnection. In
    // that moment a window in the background can still show a notification
    // about what another window has in view, which this one cannot know.
    // That is accepted: it is brief, and the click opens what is already open.
    if (isInView() && shown !== null && targetKey(notification.target) === targetKey(shown)) return;
    // Names come from the whole roster, hidden bots included: the shell lists
    // bots for what it draws, below this source. Before the roster first
    // loads there is no name to show, so the notification is dropped on
    // purpose; the entry still shows as unread once the roster loads.
    const listed = j3.roster.get();
    const rows = listed._tag === "ready" ? listed.value : [];
    const botName = (id: BotId) =>
      rows.flatMap((row) =>
        row._tag === "bot" && row.bot.id === id ? [row.bot.profile.name] : [],
      )[0] ?? null;
    const roomName = (id: RoomId) =>
      rows.flatMap((row) =>
        row._tag === "room" && row.room.id === id ? [row.room.name] : [],
      )[0] ?? null;
    const content = notificationText(notification, { botName, roomName }, i18n);
    if (content === null) return;
    showNotification(
      { ...content, tag: notification.entryId, target: notification.target, pairing },
      () => j3.pairing.get(),
    ).catch(() => {
      // The browser refused it, as when the permission was withdrawn meanwhile.
      // The entry still shows as unread in the roster.
    });
  });
  useEffect(() => j3.onNotification(notify), [j3]);
  useEffect(
    () =>
      onNotificationClick((click) => {
        if (click.pairing === pairing && j3.pairing.get() === pairing) openTarget(click.target);
      }),
    [j3, pairing],
  );

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

  const storedUnencrypted = useReadable(signInUnencrypted);
  const data: ShellData = {
    engine: engine._tag === "ready" ? engine.value : null,
    engineStale: engine._tag === "ready" && engine.stale,
    roster,
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
    settingsSaves: { profile: profileSave, notifications: notificationsSave },
    settingsOpen,
    devices: devices._tag === "ready" ? devices.value : null,
    recentTurns: recentTurns.state,
    connected: connection._tag === "connected",
    signInUnencrypted: storedUnencrypted,
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
      : (roster?.flatMap((row) =>
          row._tag === "bot" && row.bot.id === editingBot ? [row.bot] : [],
        )[0] ?? null);

  const closeBotEditor = () => {
    if (editingBot !== null) j3.dismissBotSave(editingBot);
    setEditingBot(null);
  };

  // A bot deleted while its editor is open closes the editor for good. Its save
  // is not dismissed: the operator did not give up on it, so a failure is
  // announced, and kept to show if they reopen it.
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

  const roomOf = (roomId: RoomId): Room | null =>
    roster?.flatMap((row) =>
      row._tag === "room" && row.room.id === roomId ? [row.room] : [],
    )[0] ?? null;
  const roomFormRoom =
    roomForm === null || roomForm._tag === "create" ? null : roomOf(roomForm.roomId);
  // The room the form was last open on, which it keeps showing once the room is deleted.
  const [lastFormRoom, setLastFormRoom] = useState<Room | null>(null);
  if (roomFormRoom !== null && roomFormRoom !== lastFormRoom) setLastFormRoom(roomFormRoom);
  const formRoom =
    roomFormRoom ??
    (roomForm !== null && roomForm._tag !== "create" && lastFormRoom?.id === roomForm.roomId
      ? lastFormRoom
      : null);
  // A room deleted while its form is open leaves the form open, saying so.
  const formRoomGone = roomFormRoom === null && roster !== null;
  // Kept while the target and the room stay the same, as the dialog asks.
  const roomFormMode = useMemo(
    (): RoomFormMode | null =>
      roomForm === null
        ? null
        : roomForm._tag === "create"
          ? roomForm
          : formRoom && { _tag: roomForm._tag, room: formRoom, gone: formRoomGone },
    [roomForm, formRoom, formRoomGone],
  );

  /**
   * Sends what the room form holds. Once the server has it the form closes,
   * and a new room opens while its form is still open; a failure stays in the
   * form, or, once it has closed, a toast says so. Only the opening that
   * sent it is closed or followed.
   */
  const submitRoom = (
    asked: RoomFormTarget,
    submission: RoomSubmission,
  ): Promise<IntentFailure | null> => {
    const stillOpen = () => open.current.room === asked;
    const close = () => setRoomForm((current) => (current === asked ? null : current));
    if (submission._tag === "create") {
      return j3.createRoom(submission.draft).then((result) => {
        if (!stillPaired()) return null;
        if (result._tag === "done") {
          if (stillOpen()) {
            close();
            void navigate({ to: "/rooms/$roomId", params: { roomId: result.value.id } });
          }
          return null;
        }
        if (!stillOpen()) say(t("roomForm.createFailedClosed", { name: submission.draft.name }));
        return result.failure;
      });
    }
    if (asked._tag === "create") return Promise.resolve(null);
    const name = roomOf(asked.roomId)?.name ?? "";
    return j3.updateRoom(asked.roomId, submission.changes).then((result) => {
      if (!stillPaired()) return null;
      if (result._tag === "done") {
        close();
        return null;
      }
      if (!stillOpen()) say(t("roomForm.failedClosed", { name }));
      return result.failure;
    });
  };

  const unarchiveRoom = (roomId: RoomId): Promise<void> => {
    const room = roomOf(roomId);
    if (room === null) return Promise.resolve();
    // Opens the form to give the room what it needs. A form already open stays
    // the operator's: what the room needs is said instead.
    const askForMembers = () => {
      if (open.current.room === null) setRoomForm({ _tag: "unarchive", roomId });
      else say(t("room.unarchiveNeedsMembers", { name: room.name }));
    };
    // A room deleting bots left too small needs members and a host before it can take messages.
    if (room.members.length < 2 || room.hostId === null) {
      askForMembers();
      return Promise.resolve();
    }
    return j3.updateRoom(roomId, { archived: false }).then((result) => {
      if (result._tag === "done" || !stillPaired()) return;
      const { failure } = result;
      if (
        failure._tag === "refused" &&
        failure.error._tag === "Invalid" &&
        failure.error.reason === "room-members"
      ) {
        askForMembers();
      } else {
        say(t("room.unarchiveFailed", { name: room.name }));
      }
    });
  };

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
    resendMessage: (commandId, mentions) =>
      void j3.resend(commandId, mentions).then((result) => {
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
      if (handoff?._tag === "handoff") goToBot(handoffPeer(handoff));
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
    sendDraft: (asked, addressing) =>
      void j3.sendDraft(asked, addressing).then((result) => {
        if (result === "not-kept") say(t("composer.notKept"));
      }),
    loadOlder: (asked) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.loadOlder();
    },
    markRead: (asked, through) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.markRead(through);
    },
    setShown,
    stopBot: (botId) => void j3.stopBot(botId),
    createBot: (name, primary) =>
      j3.createBot({ name, primary }).then((result) => {
        if (result._tag === "failed") throw new Error("The bot was not created");
        return result.value.id;
      }),
    newBot: () => setNewBot(true),
    newRoom: () => setRoomForm({ _tag: "create" }),
    editRoom: (roomId) => setRoomForm({ _tag: "edit", roomId }),
    archiveRoom: (roomId) =>
      j3.updateRoom(roomId, { archived: true }).then((result) => {
        if (result._tag === "failed" && stillPaired()) {
          say(t("room.archiveFailed", { name: roomOf(roomId)?.name ?? "" }));
        }
      }),
    unarchiveRoom,
    deleteRoom: (roomId) => {
      const name = roomOf(roomId)?.name ?? "";
      void j3.deleteRoom(roomId).then((result) => {
        if (!stillPaired()) return;
        if (result._tag === "done") leaveDeleted({ _tag: "room", roomId });
        else say(t("room.deleteFailed", { name }));
      });
    },
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
        if (result._tag === "done") leaveDeleted({ _tag: "conversation", botId });
        else say(t("details.deleteFailed"));
      }),
    updateSettings: (change) => void j3.updateSettings(change),
    setSettingsOpen,
    startPairing: () =>
      j3
        .startPairing()
        .then((result) =>
          result._tag === "done"
            ? { _tag: "started", code: result.value.code, expiresAt: result.value.expiresAt }
            : { _tag: "failed" },
        ),
    revokeDevice: (deviceId) => j3.revokeDevice(deviceId).then((result) => result._tag === "done"),
    refreshSettings: j3.refreshSettings,
    refreshDevices: j3.refreshDevices,
    loadMoreTurns: recentTurns.loadMore,
    retryTurns: recentTurns.retry,
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
    ...(desktopServer === undefined ? {} : { server: desktopServer }),
  };

  return (
    <ShellSourceProvider source={{ data, intents }}>
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
        onUnsavedChange={setNewBotUnsaved}
        onCreate={(name, primary) =>
          intents.createBot(name, primary).then((botId) => {
            setNewBot(false);
            void goToBot(botId);
          })
        }
      />
      <RoomDialog
        mode={roomFormMode}
        bots={(roster ?? []).flatMap((row) => (row._tag === "bot" ? [row.bot] : []))}
        defaultHopLimit={data.settings?.budgets.hops ?? null}
        connected={data.connected}
        unsaved={roomFormUnsaved}
        onUnsavedChange={setRoomFormUnsaved}
        onSubmit={(submission) =>
          roomForm === null ? Promise.resolve(null) : submitRoom(roomForm, submission)
        }
        onClose={() => setRoomForm(null)}
      />
      <EditBotDialog
        bot={editingBotValue}
        engine={data.engine}
        save={editingBot === null ? undefined : botSaves.get(editingBot)}
        connected={data.connected}
        unsaved={botEditUnsaved}
        onUnsavedChange={setBotEditUnsaved}
        onSave={(changes) => {
          if (editingBotValue !== null) updateBot(editingBotValue, changes);
        }}
        onClose={closeBotEditor}
      />
      <MemoryViewer
        file={memoryView}
        save={openMemoryKey === null ? undefined : memorySaves.get(openMemoryKey)}
        connected={data.connected}
        editing={memoryEditing}
        onEditingChange={setMemoryEditing}
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
    </ShellSourceProvider>
  );
}
