// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  J3ClientProvider,
  type MemoryReading,
  type RoomSubmission,
  useBotFiles,
  type SignInRoute,
  useConnection,
  useConnectors,
  useSkills,
  useConversation,
  useDevices,
  useEngineStatus,
  useJ3Client,
  useMemory,
  usePair,
  useReadable,
  useRecentTurns,
  useRoutineRuns,
  useRoutines,
  useSettings,
} from "@j3-bots/client-runtime/react";
import type {
  AvatarChoice,
  Bot,
  BotId,
  DeviceId,
  EntryTarget,
  MemoryPath,
  MemoryScope,
  Notification,
  PairBotIds,
  Room,
  RoomId,
  RoutineId,
} from "@j3-bots/contracts";
import { TEMPLATE_FILE_EXTENSION, TEMPLATE_MEDIA_TYPE, templateFileText } from "@j3-bots/contracts";
import { Dialog } from "@base-ui/react/dialog";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  use,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  behind,
  memorySaveKey,
  refusedWith,
  targetKey,
  type BotChanges,
  type ConnectionState,
  type DraftChangedElsewhere,
  type IntentFailure,
  type IntentResult,
  type J3Client,
  loadedList,
  type MemoryEdit,
  type UpdateResult,
} from "@j3-bots/client-runtime";
import { providerActionsOf } from "./providerActions";
import {
  type ConnectorsPlace,
  notificationOpening,
  type OpenedNotification,
  pairKeyText,
  ROOM_MEMBERS,
  type RoomFormMode,
  roomStopFailed,
  type SettingsPage,
  templateFileName,
  type TemplateRead,
} from "@j3-bots/client-runtime/presentation";
import type { AppLink, Destination, MovedAway } from "@j3-bots/desktop-bridge";
import * as Redacted from "effect/Redacted";
import { memoryFileName, updateResultLine } from "@j3-bots/client-runtime/wording";
import { notificationText } from "@j3-bots/i18n";
import { useI18n } from "../app/context";
import { LaunchUpdate } from "../components/LaunchUpdate";
import { ConnectionBanner, updateHasDetails } from "../components/ConnectionBanner";
import { restartingTo } from "../components/ServerUpdate";
import { UpdatePromptDialog } from "../components/UpdatePrompt";
import {
  ConnectInstead,
  LocalServerFailed,
  LocalServerFailedBody,
  LocalSignIn,
  MovedAwayScreen,
  StoppingLocal,
  StopUsingComputer,
  WhereBotsLive,
} from "../components/LocalMode";
import { alertDialog, dialogBackdrop, dialogTitle } from "../components/ui/dialog";
import { Onboarding } from "../onboarding/Onboarding";
import { writeClipboard } from "../lib/clipboard";
import { cn } from "../lib/cn";
import { ConnectorsDialog } from "../components/connectors/ConnectorsDialog";
import type { ConnectorsIntents } from "../components/connectors/screen";
import { EditBotDialog } from "../components/EditBotDialog";
import { MemoryViewer } from "../components/MemoryViewer";
import type { ProviderSetupIntents } from "../components/ProviderSetup";
import { NewBotDialog } from "../components/NewBotDialog";
import { RoomDialog } from "../components/RoomDialog";
import { RoutineRunsDialog } from "../components/RoutineRuns";
import {
  NewFromTemplateDialog,
  ShareTemplateDialog,
  type TemplateShare,
} from "../components/TemplateDialogs";
import { guessDeviceName, Incompatible, Pairing, StorageFailed } from "../components/Pairing";
import { ServerAddress } from "../components/ServerAddress";
import { useHeldWhileClosing } from "../lib/useHeldWhileClosing";
import { notificationAccess } from "../preferences/notifications";
import type { PairView } from "../components/PairConversation";
import type {
  ConversationView,
  DesktopLocal,
  DesktopServer,
  ShellData,
  ShellIntents,
} from "../shell/data";
import { runShellAction } from "../shell/commands";
import { ShellSourceProvider } from "../shell/source";
import {
  closeNotificationsOf,
  closeNotificationsOutside,
  onNotificationClick,
  showNotification,
} from "./notify";
import { loadRasterizer, notificationIcon, systemTheme } from "./notificationIcon";
import { onAppLink } from "./appLinks";
import { useAttachments } from "./attachments";
import { useCardIntents, useCardSubmitting } from "./cardIntents";
import { client, server } from "./client";
import { useComposerSource } from "./composer";
import { openMicrophone } from "./microphone";
import { isInView, useInView } from "./inView";
import { Notices, useSay } from "./notices";
import { saveText } from "./openFile";
import { useWorkFolds } from "./workFolds";
import { readTemplate, useTemplateDrop } from "./templateFiles";
import { updatable, useDesktopUpdate, useLaunchUpdate, useReportSaving } from "./appUpdate";
import { useDiagnostics } from "./diagnostics";
import { useRemoteServerUpdate } from "./serverUpdate";
import { useUpdatePrompt } from "./updatePrompt";
import { useWhatsNew } from "./whatsNew";
import {
  useDesktopLookingAt,
  useDesktopShortcut,
  useReportAppearance,
  useReportLanguage,
  useReportTray,
} from "./desktopMenus";
import { type Desktop, desktop, systemOf } from "./desktop";
import { useScreenRecordings } from "./recordings";
import {
  asksSilently,
  localScreen,
  type LocalSignIn as LocalSignInState,
  signInAnswer,
} from "./localGate";
import { askLocalDevice, localMode, useLocalServer } from "./localServer";
import { LinkedPairingCode } from "./pairingLink";
import { signInUnencrypted } from "./platform";
import { useSavesUnderWay } from "./savesUnderWay";

/**
 * What the room form is open for. A room is named by id and read from the
 * roster. Each opening is a new value, so what a save of one opening does
 * never reaches another.
 */
type RoomFormTarget =
  | { readonly _tag: "create"; readonly members?: ReadonlyArray<BotId> }
  | { readonly _tag: "edit" | "unarchive"; readonly roomId: RoomId };

/**
 * A secret's value copied: by the desktop app, which takes it off the
 * clipboard after a while if it is still there, or by the page, which cannot
 * read the clipboard back to tell.
 */
const copySecret =
  desktop?.copySecret ??
  ((value: Redacted.Redacted<string>) => writeClipboard(Redacted.value(value)));

/**
 * In the desktop app, the server elsewhere it talks to, a way to leave it for
 * another and, where this computer can run the bots, for this computer; and
 * the data bots that moved from this computer left here, while there is any.
 */
const serverOf = (app: Desktop, at: URL): DesktopServer => ({
  address: at.origin,
  forget: app.forgetServer,
  ...(app.localAvailable ? { chooseThisComputer: app.chooseThisComputer } : {}),
  ...(app.moved === null
    ? {}
    : {
        leftHere: {
          moved: app.moved,
          deleteData: () => app.deleteLocalData().then((answer) => answer === "changed"),
        },
      }),
});

const desktopServer: DesktopServer | undefined =
  desktop === null || server === null || localMode !== null ? undefined : serverOf(desktop, server);

/**
 * The shell's source in a build: the client runtime, connected to the server.
 * Before the shell, it answers whatever stands between the operator and their
 * bots: the desktop app updating itself as it starts, choosing where they
 * live and naming the server (in the desktop app), pairing, a server of
 * another version, storage the browser refuses.
 */
export function LiveSourceProvider({ children }: { children: ReactNode }) {
  useReportLanguage();
  useReportAppearance();
  const launchUpdate = useLaunchUpdate();
  // Nothing opens before the app says whether it is updating first, which it
  // answers at once, nor while it is: what would open goes with the restart.
  if (launchUpdate === "unread") return null;
  if (launchUpdate !== null) {
    return (
      <Screen>
        <LaunchUpdate update={launchUpdate} />
      </Screen>
    );
  }
  // The bots moved away: their server here stays stopped, so nothing connects to it.
  if (localMode !== null && localMode.moved !== null) {
    return (
      <Screen>
        <MovedAwayHere here={localMode} moved={localMode.moved} />
      </Screen>
    );
  }
  if (server === null) return <FirstScreens />;
  return <Connected origin={server}>{children}</Connected>;
}

/**
 * The bots on this computer moved to another server: on to it, which goes
 * to the server address screen with the app no longer starting with the
 * system for them, or back to running them here, or their data deleted.
 */
function MovedAwayHere({ here, moved }: { readonly here: Desktop; readonly moved: MovedAway }) {
  return (
    <MovedAwayScreen
      moved={moved}
      onConnect={() =>
        (here.startWithSystem ? here.setStartWithSystem(false) : Promise.resolve(null))
          .then(() => here.connectToServerInstead())
          .then((answer) => answer === "changed")
      }
      onRunHere={() => here.runHereAgain().then((answer) => answer === "changed")}
      onDelete={() => here.deleteLocalData().then((answer) => answer === "changed")}
    />
  );
}

/**
 * The desktop app's first screens, before it has a server: where the bots
 * live, where this computer can run them and the operator has not chosen,
 * then the server address screen. A link to the app that arrives first lands
 * here: a pairing link goes to the server address screen and fills in its
 * server, for the operator to check, and once that server is kept its code
 * starts the pairing screen; a link to a conversation or a room cannot open
 * yet, which the screen says.
 */
function FirstScreens() {
  const { t } = useI18n();
  const [link, setLink] = useState<AppLink | null>(null);
  const choosing = desktop !== null && desktop.localAvailable && desktop.mode === null;
  const [where, setWhere] = useState<"choice" | "address">(choosing ? "choice" : "address");
  useEffect(
    () =>
      onAppLink((arrived) => {
        setLink(arrived);
        if (arrived._tag === "pair") setWhere("address");
        return true;
      }),
    [],
  );
  const pairing = link?._tag === "pair" ? { server: link.server, code: link.code } : null;
  if (where === "choice" && desktop !== null) {
    return (
      <Screen>
        <WhereBotsLive
          onUseThisComputer={desktop.chooseThisComputer}
          onConnectToServer={() => setWhere("address")}
          notice={link === null ? null : t("links.chooseFirst")}
        />
      </Screen>
    );
  }
  return (
    <Screen>
      <ServerAddress
        onBack={desktop?.localAvailable === true ? () => setWhere("choice") : undefined}
        // The field starts over with each pairing link.
        key={pairing === null ? "" : `${pairing.server} ${pairing.code}`}
        initialAddress={pairing?.server ?? ""}
        notice={
          link === null
            ? null
            : pairing === null
              ? t("links.nameServerFirst")
              : t("links.pairingServer", { address: pairing.server })
        }
        onConnect={(address) => desktop?.connect(address, pairing) ?? Promise.resolve(null)}
      />
    </Screen>
  );
}

function Connected({ origin, children }: { origin: URL; children: ReactNode }) {
  return (
    <J3ClientProvider client={use(client(origin))}>
      <Notices>
        <Gate origin={origin}>{children}</Gate>
      </Notices>
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

function Gate({ origin, children }: { origin: URL; children: ReactNode }) {
  const j3 = useJ3Client();
  const i18n = useI18n();
  const { t } = i18n;
  const say = useSay();
  const connection = useConnection();
  // An update offered beside what the app cannot do with this server.
  const update = updatable(useDesktopUpdate());
  const pairing = useReadable(j3.pairing);
  const linked = use(LinkedPairingCode);
  const linkedCode = useSyncExternalStore(linked.subscribe, linked.current);
  useEffect(() => linked.follow(connection), [linked, connection]);
  // In the desktop app, a pairing link fills in the pairing screen with its
  // code, for this server only; the operator still presses Pair. A device
  // that holds a pairing here keeps it and is told so, whether it is
  // connected yet or not; one whose pairing the server refused is unpaired.
  const takePairingLink = useEffectEvent((link: AppLink) => {
    if (link._tag !== "pair") return false;
    if (link.server !== origin.origin) say(t("links.otherServer", { address: link.server }));
    else if (connection._tag === "unpaired" || pairing === null) linked.offer(link.code);
    else say(t("links.alreadyPaired", { address: origin.origin }));
    return true;
  });
  useEffect(() => onAppLink(takePairingLink), []);
  // A link to a conversation or a room waits until this device is paired,
  // then opens (`LiveShell`); the pairing screen says so.
  const unpaired = connection._tag === "unpaired";
  const sayPairFirst = useEffectEvent((link: AppLink) => {
    if (link._tag === "open") say(t("links.pairFirst"));
    return false;
  });
  useEffect(() => (unpaired ? onAppLink(sayPairFirst) : undefined), [unpaired]);
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
    closeNotificationsOf(ended, desktop).catch(unlisted);
  }, [j3, pairing]);

  const local = useLocalHere(origin);
  // Updating a server this device does not run; the app updates the one it runs.
  const remote = useRemoteServerUpdate();
  const serverUpdate = local === null ? remote : undefined;
  const updatingTo = serverUpdate === undefined ? null : restartingTo(serverUpdate);
  // How an update this device saw under way ended, said once as it comes in.
  // It stays in Settings until the operator closes Settings after it.
  const ended = serverUpdate?.ended ?? null;
  const tellEnded = useEffectEvent((result: UpdateResult) => {
    say(updateResultLine(result, i18n).text);
  });
  useEffect(() => {
    if (ended !== null) tellEnded(ended);
  }, [ended]);
  if (local !== null) {
    const screen = local.screen(connection);
    if (screen !== null) return <Screen>{screen}</Screen>;
  }

  switch (connection._tag) {
    case "starting":
      return null;
    case "unpaired":
      return (
        <Screen>
          <Pairing
            // Its fields start over once the link's code is dropped, so a
            // page put aside holds no code for Back to bring back.
            key={linkedCode ?? ""}
            reason={connection.reason}
            defaultName={guessDeviceName(navigator.userAgent, t)}
            initialCode={linkedCode}
            address={origin.origin}
            onPair={j3.pair}
            server={desktopServer}
            restart={desktop?.relaunch}
            update={update}
          />
        </Screen>
      );
    case "incompatible":
      // An update of the server on this computer rolled back to a release the
      // app does not speak with still says so, with its Try again and details.
      return (
        <ConnectionBanner
          state={connection}
          local={local?.line}
          everConnected={everConnected}
          onRetryNow={j3.reconnectNow}
        >
          <Screen>
            <Incompatible
              server={desktopServer}
              update={update}
              mismatch={{
                behind: behind(connection.serverProtocol),
                serverVersion: connection.serverVersion,
              }}
              serverUpdate={serverUpdate}
            />
          </Screen>
          {local?.details}
          {/* An update under way goes on over this screen; nothing new opens here. */}
          <UpdatePromptHost blocked />
        </ConnectionBanner>
      );
    case "storage-failed":
      return (
        <Screen>
          <StorageFailed
            onRetry={j3.reconnectNow}
            desktop={
              desktop === null
                ? undefined
                : local !== null
                  ? { _tag: "local", leave: local.leave, restart: desktop.relaunch }
                  : desktopServer === undefined
                    ? undefined
                    : { _tag: "server", server: desktopServer, restart: desktop.relaunch }
            }
          />
        </Screen>
      );
    case "offline":
    // Never here: a browser stays in the foreground for the runtime.
    case "background":
    case "connecting":
    case "waiting":
    case "connected":
      return (
        <ConnectionBanner
          state={connection}
          local={local?.line}
          updatingTo={updatingTo}
          everConnected={everConnected}
          onRetryNow={j3.reconnectNow}
        >
          {/* Mounted afresh for each pairing: nothing open or typed under one shows under the next. */}
          <LiveShell
            key={pairing ?? "none"}
            origin={origin}
            pairing={pairing}
            local={local?.intents}
          >
            {children}
          </LiveShell>
          {local?.details}
          <UpdatePromptHost blocked={false} />
        </ConnectionBanner>
      );
  }
}

/**
 * The update prompt over the screen the operator is on. Its runner belongs
 * to the client, so an update under way carries on when this screen gives
 * way to another, as when the server comes back on a protocol this app no
 * longer speaks.
 */
function UpdatePromptHost({ blocked }: { blocked: boolean }) {
  const { view } = useUpdatePrompt(blocked);
  return <UpdatePromptDialog view={view} />;
}

/**
 * While the bots live on this computer, the providers sign in from here. The
 * page a sign-in waits on opens in the system's browser: the desktop app hands
 * it a page `window.open` names. `undefined` when the bots live elsewhere.
 */
const localProviderSetup = (j3: J3Client): ProviderSetupIntents | undefined =>
  desktop?.mode === "local"
    ? {
        signIn: (harness) =>
          j3.signIn(harness, (url) => {
            window.open(url, "_blank", "noopener");
          }),
        cancelSignIn: j3.cancelSignIn,
        harnesses: j3.harnessLocations,
        connectEndpoint: j3.connectEndpoint,
      }
    : undefined;

/**
 * In local mode, what stands between the operator and the bots on this
 * computer, before the shell: signing this computer in, with no code, the
 * first time after it was chosen, and only when asked after it was signed
 * out; the first run, which goes on while the server starts, only the first
 * bot waiting for it; a server that did not start; and stopping using this
 * computer. Also the connection line's words for that server, and what the
 * shell offers for it. `null` outside local mode.
 */
function useLocalHere(origin: URL) {
  const j3 = useJ3Client();
  const { t } = useI18n();
  const say = useSay();
  const navigate = useNavigate();
  const connection = useConnection();
  const roster = useReadable(j3.roster);
  const engine = useEngineStatus();
  const signIns = useReadable(j3.signIns);
  const view = useLocalServer();
  const [signIn, setSignIn] = useState<LocalSignInState>({ _tag: "idle" });
  // The first run on this computer: from a sign-in without a code until the
  // first bot arrives, or the bots this computer had come back.
  const [firstRun, setFirstRun] = useState(false);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [startWithSystem, setStartWithSystem] = useState(localMode?.startWithSystem ?? false);
  const ready = view?.server.state === "ready";
  // Read when an answer comes, after the render that asked.
  const readyNow = useRef(ready);
  useEffect(() => {
    readyNow.current = ready;
  }, [ready]);
  // A server that spoke another protocol is not asked again by itself: once
  // the one on this computer is ready anew, as after Try again of an update
  // that rolled back, the page tries it.
  const wakeIncompatible = useEffectEvent(() => {
    if (connection._tag === "incompatible") j3.reconnectNow();
  });
  useEffect(() => {
    if (ready) wakeIncompatible();
  }, [ready]);

  const fresh = localMode !== null && connection._tag === "unpaired" && connection.reason === "new";
  if (fresh && !firstRun) setFirstRun(true);
  const hasBots = roster._tag === "ready" && roster.value.length > 0;
  if (firstRun && hasBots && !creating && !fresh) setFirstRun(false);

  /** Signs this computer in to its own server; resolves with whether it is. */
  const signInHere = (again: boolean): Promise<boolean> =>
    askLocalDevice(again).then((result) => {
      const answer = signInAnswer(result, {
        origin: origin.origin,
        serverReady: readyNow.current,
        again,
      });
      if (answer._tag !== "keep") {
        setSignIn(answer);
        return false;
      }
      return j3.adopt({ deviceId: answer.deviceId, token: answer.token }).then((kept) => {
        setSignIn(kept ? { _tag: "idle" } : { _tag: "failed" });
        return kept;
      });
    });
  // Asked once each time it becomes due: a second ask under way shares the first's answer.
  const askSilently = useEffectEvent(
    () => void signInHere(signIn._tag === "waiting" && signIn.again),
  );
  const shouldAsk = localMode !== null && asksSilently(connection, signIn, ready);
  useEffect(() => {
    if (shouldAsk) askSilently();
  }, [shouldAsk]);

  // The first bot waits for the server, connected with its roster read: one
  // asked for before then is created once it is.
  const reached = connection._tag === "connected" && roster._tag === "ready";
  const waitingToCreate = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!reached || waitingToCreate.current === null) return;
    waitingToCreate.current();
    waitingToCreate.current = null;
  }, [reached]);

  if (localMode === null) return null;
  const desktopLocal = localMode;

  const providerSetup = localProviderSetup(j3);

  const stopUsing = (): Promise<boolean> => {
    setStopping(true);
    // Signed out first, while the server runs, so the device it was ends there.
    const signedOut =
      j3.pairing.get() === null
        ? Promise.resolve(true)
        : j3.signOut().then((result) => result._tag !== "failed");
    return signedOut
      .then((out) =>
        out
          ? // The app starts with the system only while the bots live here: off
            // first, and on the way to a server whatever it answered.
            (startWithSystem ? desktopLocal.setStartWithSystem(false) : Promise.resolve(null)).then(
              () => desktopLocal.connectToServerInstead(),
            )
          : null,
      )
      .then((answer) => {
        // Once it changed, the app loads the page again on the server address screen.
        if (answer === "changed") return true;
        setStopping(false);
        say(t("local.stop.failed"));
        return false;
      });
  };
  const connectInstead = <ConnectInstead onConnect={() => void stopUsing()} />;
  // Signed out, the bots this computer has are still here: leaving them asks first.
  const stopInstead = <StopUsingComputer quiet onStop={stopUsing} />;
  const failed = view !== null && view.server.state === "failed" ? view.server : null;
  const update = view?.server.state === "ready" ? view.server.update : undefined;
  const rolledBack = update?._tag === "rolled-back" && updateHasDetails(update) ? update : null;
  /** What the details dialog explains: the start that failed, or the update that was rolled back. */
  const explained =
    failed !== null
      ? {
          title: t("local.failed.title"),
          lead: null,
          failure: failed,
          retry: desktopLocal.retryLocalServer,
        }
      : rolledBack !== null
        ? {
            title: t("local.update.title", { failed: rolledBack.failed }),
            lead: t("local.update.body", { running: rolledBack.running }),
            failure: rolledBack,
            retry: desktopLocal.retryServerUpdate,
          }
        : null;

  const intents: DesktopLocal = {
    stopUsing,
    moveAway: desktopLocal.moveAway,
    serverUpdate: view?.server.update,
    retryServerUpdate: desktopLocal.retryServerUpdate,
    showUpdateDetails: () => setDetailsOpen(true),
    startWithSystem,
    setStartWithSystem: (on) =>
      desktopLocal.setStartWithSystem(on).then((change) => {
        const held = change?.on ?? !on;
        setStartWithSystem(held);
        return held;
      }),
    phone: {
      access: desktopLocal.phoneAccess,
      follow: desktopLocal.onPhoneAccess,
      system: systemOf(navigator.userAgent),
      set: desktopLocal.setPhoneAccess,
      pairingLink: desktopLocal.localPairingLink,
    },
  };

  const createFirst = ({ name, avatar }: { name: string; avatar: AvatarChoice }) => {
    setCreating(true);
    const whenReached = reached
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waitingToCreate.current = resolve;
        });
    return whenReached
      .then(() => {
        // The bots this computer had are back: there is no first bot to make.
        const listed = j3.roster.get();
        if (listed._tag === "ready" && listed.value.length > 0) {
          setCreating(false);
          return new Promise<never>(() => {});
        }
        // The first bot is the primary one: there is no other to choose.
        return j3.createBot({ name, primary: true, avatar });
      })
      .then((result): IntentResult<BotId> => {
        if (result._tag === "done") return { _tag: "done", value: result.value.id };
        setCreating(false);
        return result;
      });
  };

  /** The screen in place of the shell, or `null` for the shell under the connection line. */
  const screen = (state: ConnectionState): ReactNode => {
    const onboarding = (
      <Onboarding
        engine={engine._tag === "ready" ? engine.value : null}
        footer={connectInstead}
        providerSetup={providerSetup === undefined ? undefined : { ...providerSetup, signIns }}
        starting={!reached}
        onCreate={createFirst}
        providerActions={providerActionsOf(j3)}
        onArrived={(botId) => {
          setCreating(false);
          setFirstRun(false);
          void navigate({ to: "/bots/$botId", params: { botId } });
        }}
      />
    );
    switch (
      localScreen({ stopping, signIn, connection: state, firstRun, serverFailed: failed !== null })
    ) {
      case "stopping":
        return <StoppingLocal />;
      case "sign-in-failed":
        return (
          <LocalSignIn reason="failed" onSignIn={() => signInHere(true)} footer={stopInstead} />
        );
      case "signed-out":
        return (
          <LocalSignIn reason="signed-out" onSignIn={() => signInHere(true)} footer={stopInstead} />
        );
      case "first-run":
        return onboarding;
      case "first-run-failed":
        return (
          <>
            {failed !== null && (
              <LocalServerFailed
                server={failed}
                onRetry={desktopLocal.retryLocalServer}
                footer={connectInstead}
              />
            )}
            {/* Kept while a failure shows, so what the operator chose so far stays. */}
            <div className="hidden">{onboarding}</div>
          </>
        );
      case "shell":
        return null;
    }
  };

  const details = (
    <Dialog.Root open={detailsOpen && explained !== null} onOpenChange={setDetailsOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup className={cn(alertDialog, "max-w-md gap-3 p-5")}>
          {explained !== null && (
            <>
              <Dialog.Title className={dialogTitle}>{explained.title}</Dialog.Title>
              {explained.lead !== null && (
                <Dialog.Description className="text-sm text-pretty text-muted-foreground">
                  {explained.lead}
                </Dialog.Description>
              )}
              <LocalServerFailedBody
                server={explained.failure}
                onRetry={() => {
                  setDetailsOpen(false);
                  explained.retry();
                }}
              />
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return {
    screen,
    leave: stopInstead,
    line:
      view === null
        ? undefined
        : {
            server: view.server,
            restartAt: view.restartAt,
            onRetry: desktopLocal.retryLocalServer,
            onDetails: () => setDetailsOpen(true),
            onRetryUpdate: desktopLocal.retryServerUpdate,
          },
    intents,
    details,
  };
}

const loadingView: ConversationView = {
  phase: "loading",
  items: [],
  hasOlder: false,
  loadingOlder: false,
};
const loadingPair: PairView = {
  phase: "loading",
  messages: [],
  hasOlder: false,
  loadingOlder: false,
};

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

function LiveShell({
  origin,
  pairing,
  local,
  children,
}: {
  /** The server this page talks to. */
  origin: URL;
  pairing: DeviceId | null;
  /** In local mode, what the shell offers for the bots on this computer. */
  local: DesktopLocal | undefined;
  children: ReactNode;
}) {
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
  // The whole roster, hidden bots and rooms included: the shell leaves them
  // out of its list, and still shows one opened from a search, a notification
  // or a mention.
  const listedRoster = useReadable(j3.roster);
  const roster = listedRoster._tag === "ready" ? listedRoster.value : null;
  const sections = useReadable(j3.sections);
  const bots = (roster ?? []).flatMap((row) => (row._tag === "bot" ? [row.bot] : []));
  const engine = useEngineStatus();
  const settings = useSettings();
  const profileSave = useReadable(j3.settingsSaves.profile);
  const notificationsSave = useReadable(j3.settingsSaves.notifications);
  const harnessesSave = useReadable(j3.settingsSaves.harnesses);
  const voiceSave = useReadable(j3.settingsSaves.voice);
  const usageDataSave = useReadable(j3.settingsSaves["usage-data"]);
  const devices = useDevices();
  const conversation = useConversation(target);
  // The teammate conversation the address names, and every pair the roster lists.
  const shownPair: PairBotIds | null =
    params.a !== undefined && params.b !== undefined ? [params.a, params.b] : null;
  const pairKey = shownPair === null ? null : pairKeyText(shownPair);
  const pairConversation = usePair(shownPair);
  const listedPairs = useReadable(j3.pairs);
  const files = useBotFiles(detailsBotId);
  const memory = useMemory(detailsBotId === null ? null : { _tag: "bot", botId: detailsBotId });
  const routines = useRoutines(detailsBotId);
  // The bot whose card shows: its routines are read while it does, unless its details hold them.
  const [cardBotId, setCardBot] = useState<BotId | null>(null);
  const cardRoutines = useRoutines(cardBotId === detailsBotId ? null : cardBotId);
  // The routine whose runs show over its bot's details, as the address names it.
  const runsOf: RoutineId | null = detailsBotId === null ? null : (search.routine ?? null);
  // Kept while its dialog fades out.
  const runsShown = useHeldWhileClosing(runsOf);
  const runsId = runsShown.held?.value ?? null;
  const routineRuns = useRoutineRuns(runsId);
  const runsRoutine =
    runsId === null
      ? null
      : (loadedList(routines)?.find((routine) => routine.id === runsId) ?? null);
  const inView = useInView();

  const folds = useWorkFolds();
  const [newBot, setNewBot] = useState(false);
  // The bot being shared as a template, and the template file opened to make a bot from.
  const [sharing, setSharing] = useState<{
    readonly botId: BotId;
    readonly share: TemplateShare;
  } | null>(null);
  const [opened, setOpened] = useState<TemplateRead | null>(null);
  const templatePicker = useRef<HTMLInputElement>(null);
  const openTemplate = (file: File) => void readTemplate(file).then(setOpened);
  useTemplateDrop(openTemplate);
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
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  // The connectors screen, and what opened it; null while it is closed.
  const [connectorsOpening, setConnectorsOpening] = useState<ConnectorsPlace | null>(null);
  const openConnectors = (opening: ConnectorsPlace) => {
    setSettingsOpen(false);
    // A screen put aside under Settings comes back as it was, with what opened it.
    if (connectorsOpening === null) setConnectorsOpening(opening);
  };
  const connectorsState = useConnectors();
  const connectors = connectorsState._tag === "ready" ? connectorsState.value : null;
  const skillsState = useSkills();
  const skills = skillsState._tag === "ready" ? skillsState.value : null;
  // Without a roster, Settings has no button and closes without saying so.
  if (settingsOpen && (roster === null || roster.length === 0)) setSettingsOpen(false);
  // Read each time Settings shows its usage, and on every socket while it does.
  const recentTurns = useRecentTurns(settingsOpen && settingsPage === "usage");
  // What the shell shows with nothing over it.
  const [shown, setShown] = useState<EntryTarget | null>(null);
  const botSaves = useReadable(j3.botSaves);
  const memorySaves = useReadable(j3.memorySaves);
  // In the desktop app, a restart into an update waits until no save is under way.
  const update = useDesktopUpdate();
  // The server's own update, for a server this device does not run: in local mode the app updates it.
  const serverUpdate = useRemoteServerUpdate();
  // The way back to the update prompt after "Later", in the roster's footer.
  const updatePrompt = useUpdatePrompt(false);
  const diagnostics = useDiagnostics();
  const whatsNew = useWhatsNew();
  const shortcut = useDesktopShortcut();
  const lookingAt = useDesktopLookingAt();
  useReportSaving(useSavesUnderWay(j3));
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
  /** The roster shows a change once the server has it: one that did not take says so. */
  const rosterChanged = (result: IntentResult<unknown>) => {
    if (result._tag === "failed" && stillPaired()) say(t("roster.changeFailed"));
  };
  const attachments = useAttachments(j3, say);
  const composer = useComposerSource(j3, say, () => {
    setSettingsPage("voice");
    setSettingsOpen(true);
  });
  const cardSubmitting = useCardSubmitting();

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
  // window still follows the pairing that received it and the roster still
  // lists what it is about. Settings, the details and the dialogs over it
  // close, and the profile form in Settings keeps what the operator typed.
  // New bot holding a name, and the bot editor or the memory viewer holding
  // an edit, stay open, with the conversation opened under them: the click
  // never throws typing away, and closing the dialog lands on what the
  // notification was about. A save under way is not given up on.
  const openTarget = useEffectEvent((opened: Destination) => {
    setSettingsOpen(false);
    if (!newBotUnsaved) setNewBot(false);
    if (!botEditUnsaved) setEditingBot(null);
    if (!memoryEditing) setMemoryView(null);
    if (!roomFormUnsaved) setRoomForm(null);
    switch (opened._tag) {
      // Opening it drops the details from the address, which closes them.
      case "conversation":
        return void navigate({ to: "/bots/$botId", params: { botId: opened.botId } });
      case "room":
        return void navigate({ to: "/rooms/$roomId", params: { roomId: opened.roomId } });
      // What quick access hands over: where a card or a line of its conversation leads.
      case "browser":
        return void navigate({
          to: "/bots/$botId",
          params: { botId: opened.botId },
          search: { browser: opened.tab },
        });
      case "pair": {
        const [a, b] = opened.botIds;
        return void navigate({
          to: "/pairs/$a/$b",
          params: { a, b },
          search: opened.at === null ? {} : { at: opened.at },
        });
      }
      case "routine":
        return void navigate({
          to: "/bots/$botId",
          params: { botId: opened.botId },
          search: { details: true, routine: opened.routineId },
        });
      case "connector":
        // Whatever the connectors screen showed, it shows this sign-in now: the
        // operator asked for it from where the screen was not in the way.
        return setConnectorsOpening({
          _tag: "connector",
          connectorId: opened.connectorId,
          signIn: true,
        });
      // What a bot's card in quick access leads to.
      case "details":
        return void navigate({
          to: "/bots/$botId",
          params: { botId: opened.botId },
          search: { details: true },
        });
      case "new-room":
        return setRoomForm({ _tag: "create", members: opened.members });
    }
  });
  // A link to a conversation or a room opens it as a notification click does,
  // once the roster says whether this server has it: one it does not have
  // leaves the screen as it is, and says so.
  const takeOpenLink = useEffectEvent((link: AppLink, rows: NonNullable<typeof roster>) => {
    if (link._tag !== "open") return false;
    const { target } = link;
    const listed = rows.some((row) =>
      target._tag === "conversation"
        ? row._tag === "bot" && row.bot.id === target.botId
        : row._tag === "room" && row.room.id === target.roomId,
    );
    if (listed) openTarget(target);
    else say(t(target._tag === "conversation" ? "links.noBot" : "links.noRoom"));
    return true;
  });
  useEffect(
    () => (roster === null ? undefined : onAppLink((link) => takeOpenLink(link, roster))),
    [roster],
  );

  const notify = useEffectEvent((notification: Notification) => {
    if (pairing === null || !stillPaired() || notificationAccess() !== "granted") return;
    // What is on screen here never notifies, even when the server sent it
    // before it heard this window's view, as right after a reconnection. In
    // that moment a window in the background can still show a notification
    // about what another window has in view, which this one cannot know.
    // That is accepted: it is brief, and the click opens what is already open.
    if (isInView() && shown !== null && targetKey(notification.target) === targetKey(shown)) return;
    // Names come from the whole roster, hidden ones included: the shell lists
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
    // In the theme the system is in as it shows, since the system draws it.
    // The desktop app overrides the theme Electron reports, which may reach
    // `prefers-color-scheme`, so there the app says which one the system is in.
    const theme = desktop === null ? Promise.resolve(null) : desktop.systemTheme();
    theme
      .then((system) => notificationIcon(notification, rows, system ?? systemTheme()))
      .then((icon) =>
        showNotification(
          {
            ...content,
            icon,
            entryId: notification.entryId,
            target: notification.target,
            pairing,
          },
          () => j3.pairing.get(),
          desktop,
        ),
      )
      .catch(() => {
        // It was not shown, as when the browser refused it because the
        // permission was withdrawn meanwhile. The entry still shows as unread
        // in the roster.
      });
  });
  useEffect(() => j3.onNotification(notify), [j3]);
  // Fetched once the app has started, not when the first notification
  // arrives: by then the server may have been upgraded and the old build's
  // files deleted, and a failed fetch reloads the page (main.tsx).
  useEffect(() => {
    if (pairing !== null && notificationAccess() === "granted") void loadRasterizer();
  }, [pairing]);
  // A click opens what the runtime decides (`notificationOpening`). One that
  // came before the roster loaded, as in a window opened for it, waits for it.
  const waitingClick = useRef<OpenedNotification | null>(null);
  const openClicked = useEffectEvent((click: OpenedNotification) => {
    const opening = notificationOpening(click, stillPaired() ? pairing : null, j3.roster.get());
    waitingClick.current = opening._tag === "wait" ? click : null;
    if (opening._tag === "open") openTarget(opening.target);
  });
  useEffect(() => onNotificationClick(openClicked), []);
  useEffect(() => {
    const waiting = waitingClick.current;
    if (waiting !== null && listedRoster._tag === "ready") openClicked(waiting);
  }, [listedRoster]);
  // In the desktop app: its tray lists what needs the operator here. A bot
  // or room chosen there opens as a notification click does, while this
  // window still follows the pairing whose roster listed it; its menus and
  // its shortcut ask the shell for the shell's own actions.
  useReportTray(roster, pairing);
  const recordings = useScreenRecordings({
    j3,
    app: desktop,
    pairing,
    recipientOf: (asked) => {
      for (const row of roster ?? []) {
        if (asked._tag === "room" && row._tag === "room" && row.room.id === asked.roomId) {
          return { name: row.room.name, face: null };
        }
        if (asked._tag === "conversation" && row._tag === "bot" && row.bot.id === asked.botId) {
          const { bot } = row;
          return { name: bot.profile.name, face: { avatar: bot.profile.avatar, seed: bot.id } };
        }
      }
      return null;
    },
    openTarget,
    say,
  });
  const recordFrom = useEffectEvent((asked: EntryTarget) => recordings.recordScreen?.(asked));
  useEffect(
    () =>
      desktop?.onCommand((command) => {
        switch (command._tag) {
          case "open":
            if (command.pairing === pairing && j3.pairing.get() === pairing) {
              openTarget(command.target);
            }
            return;
          // From quick access: the sheet opens over the conversation it records for.
          case "record":
            if (command.pairing === pairing && j3.pairing.get() === pairing) {
              openTarget(command.target);
              recordFrom(command.target);
            }
            return;
          default:
            runShellAction(command._tag);
        }
      }),
    [j3, pairing],
  );

  // Another window sent or changed a draft under this one, and this one shows
  // it as stored. Text of this window's that the device never kept is offered
  // back beside the composer, for as long as the operator wants it.
  const changedElsewhere = useEffectEvent(({ whileSending }: DraftChangedElsewhere) => {
    // A draft another window keeps simply shows here: every window holds the
    // same draft. Only a Send that sent nothing for it is worth a word.
    if (whileSending) say(t("composer.changedElsewhereWhileSending"));
  });
  useEffect(() => j3.onDraftChangedElsewhere(changedElsewhere), [j3]);

  const storedUnencrypted = useReadable(signInUnencrypted);

  const signIns = useReadable(j3.signIns);
  const providerSetup = localProviderSetup(j3);
  const secrets = useReadable(j3.secrets.view);

  // A connector's sign-in comes back to the desktop app through its loopback; to a
  // browser, through a server reached over https, else as an address the operator pastes.
  const desktopApp = desktop;
  const signInRoute: SignInRoute =
    desktopApp !== null
      ? {
          _tag: "relay",
          listen: () => desktopApp.catchSignIn(i18n.locale),
          expect: desktopApp.expectSignIn,
          onReturn: desktopApp.onSignInReturn,
          stop: desktopApp.stopCatchingSignIn,
        }
      : window.location.protocol === "https:"
        ? { _tag: "server" }
        : { _tag: "paste" };
  const cards = useCardIntents(j3, say, origin, signInRoute._tag === "server");
  const { state: _connectorsState, ...connectorsClient } = j3.connectors;
  const { state: _skillsState, ...skillsIntents } = j3.skills;
  const connectorsIntents: ConnectorsIntents = {
    ...connectorsClient,
    signInRoute,
    openPage: (url) => {
      window.open(url, "_blank", "noopener");
    },
    // Secrets are on their page of Settings, over the connectors, which wait as they were.
    openSecrets: () => {
      setSettingsPage("secrets");
      setSettingsOpen(true);
    },
  };

  const data: ShellData = {
    engine: engine._tag === "ready" ? engine.value : null,
    engineStale: engine._tag === "ready" && engine.stale,
    signIns,
    secrets,
    roster,
    sections,
    conversation: (asked) =>
      viewKey !== null && targetKey(asked) === viewKey ? view : loadingView,
    pairs: listedPairs._tag === "ready" ? listedPairs.value : null,
    pair: (asked) =>
      pairConversation.state !== null && pairKeyText(asked) === pairKey
        ? pairConversation.state
        : loadingPair,
    ...composer.data,
    submitting: cardSubmitting,
    workSteps: folds.steps,
    routines: (botId) =>
      botId === detailsBotId
        ? loadedList(routines)
        : botId === cardBotId
          ? loadedList(cardRoutines)
          : null,
    files: (botId) => (botId === detailsBotId ? loadedList(files) : null),
    memory: (botId) => (botId === detailsBotId ? loadedList(memory) : null),
    connectors,
    settings: settings._tag === "ready" ? settings.value : null,
    settingsSaves: {
      profile: profileSave,
      notifications: notificationsSave,
      harnesses: harnessesSave,
      voice: voiceSave,
      "usage-data": usageDataSave,
    },
    settingsOpen,
    settingsPage,
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
    const title = memoryFileName(path, i18n);
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
    // A room deleting bots left too small needs members before it can take messages.
    if (room.members.length < ROOM_MEMBERS.min) {
      askForMembers();
      return Promise.resolve();
    }
    return j3.updateRoom(roomId, { archived: false }).then((result) => {
      if (result._tag === "done" || !stillPaired()) return;
      if (refusedWith(result, "room-members")) {
        askForMembers();
      } else {
        say(t("room.unarchiveFailed", { name: room.name }));
      }
    });
  };

  const intents: ShellIntents = {
    ...cards,
    ...(recordings.recordScreen === undefined ? {} : { recordScreen: recordings.recordScreen }),
    // The viewer opens over the bot's conversation, on the tab the address names.
    openBrowser: (botId, tab) =>
      void navigate({ to: "/bots/$botId", params: { botId }, search: { browser: tab } }),
    openWorkFold: folds.open,
    closeWorkFold: folds.close,
    openAttachment: attachments.open,
    openWorkImage: attachments.openWorkImage,
    // Over its bot's details, which list it with the bot's other routines.
    openRoutine: (routineId) =>
      void navigate({
        to: ".",
        search: (prev) => ({ ...prev, details: true, routine: routineId }),
      }),
    openConversation: (botId) => void goToBot(botId),
    signInConnector: (entry) =>
      openConnectors({ _tag: "connector", connectorId: entry.connectorId, signIn: true }),
    openConnectors,
    ...composer.intents,
    setRoutineEnabled: (routineId, enabled) => void j3.setRoutineEnabled(routineId, enabled),
    loadOlder: (asked) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.loadOlder();
    },
    revealEntry: (asked, entryId) =>
      viewKey !== null && targetKey(asked) === viewKey
        ? conversation.reveal(entryId)
        : Promise.resolve("unreachable"),
    loadOlderPair: (asked) => {
      if (pairKeyText(asked) === pairKey) pairConversation.loadOlder();
    },
    revealInPair: (asked, entryId) =>
      pairKeyText(asked) === pairKey ? pairConversation.reveal(entryId) : Promise.resolve(null),
    markRead: (asked, through) => {
      if (viewKey !== null && targetKey(asked) === viewKey) conversation.markRead(through);
    },
    markRosterRead: (asked, through) => void j3.markRosterRead(asked, through).then(rosterChanged),
    markUnread: (asked) => void j3.markUnread(asked).then(rosterChanged),
    placeBot: (botId, placement) => void j3.placeBot(botId, placement).then(rosterChanged),
    placeRoom: (roomId, placement) => void j3.updateRoom(roomId, placement).then(rosterChanged),
    createSection: (name, botId) =>
      j3.createSection(name, botId).then((result) => {
        rosterChanged(result);
        return result._tag === "done" ? result.value.id : null;
      }),
    updateSection: (sectionId, changes) =>
      void j3.updateSection(sectionId, changes).then(rosterChanged),
    deleteSection: (sectionId) => void j3.deleteSection(sectionId).then(rosterChanged),
    setShown,
    stopBot: (botId) => void j3.stopBot(botId),
    stopRoom: (roomId) => {
      const name = roomOf(roomId)?.name ?? "";
      void j3.stopRoom(roomId).then((result) => {
        if (roomStopFailed(result) && stillPaired()) say(t("room.stopFailed", { name }));
      });
    },
    forceStopBot: (botId) => void j3.forceStopBot(botId),
    forceStopRoom: (roomId) => {
      const name = roomOf(roomId)?.name ?? "";
      void j3.forceStopRoom(roomId).then((result) => {
        if (roomStopFailed(result) && stillPaired()) say(t("room.stopFailed", { name }));
      });
    },
    createBot: (draft) =>
      j3
        .createBot(draft)
        .then((result) =>
          result._tag === "done" ? { _tag: "done", value: result.value.id } : result,
        ),
    newBot: () => setNewBot(true),
    newBotFromTemplate: () => templatePicker.current?.click(),
    shareBotTemplate: (botId) => shareTemplate(botId),
    newRoom: () => setRoomForm({ _tag: "create" }),
    startRoomWith: (botIds) => setRoomForm({ _tag: "create", members: botIds }),
    sendQuickMessage: (input) => j3.send(input),
    setCardBot,
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
    setBrowser: (bot, enabled) =>
      void j3.updateBot(bot.id, { browser: enabled }).then((result) => {
        if (result._tag !== "failed") return;
        // The switch shows the bot as the server has it, so a failure leaves nothing to keep.
        j3.dismissBotSave(bot.id);
        if (stillPaired()) say(t("details.browser.failed", { name: bot.profile.name }));
      }),
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
    showSettingsPage: setSettingsPage,
    startPairing: () =>
      j3
        .startPairing()
        .then((result) =>
          result._tag === "done" ? { _tag: "started", ...result.value } : { _tag: "failed" },
        ),
    revokeDevice: (deviceId) => j3.revokeDevice(deviceId).then((result) => result._tag === "done"),
    refreshSettings: j3.refreshSettings,
    signOutBrowser: () => j3.signOutBrowser().then((result) => result._tag === "done"),
    usageData: {
      sent: () =>
        j3.usageDataSent().then((result) => (result._tag === "done" ? result.value : null)),
      record: j3.recordUsage,
    },
    providerActions: providerActionsOf(j3),
    secrets: { ...j3.secrets, copy: copySecret },
    voice: {
      ...j3.voice,
      microphone: openMicrophone,
      app: desktopApp === null ? "browser" : "desktop",
    },
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
    ...(local === undefined ? { serverUpdate } : { local }),
    ...(update === undefined ? {} : { update }),
    updatePrompt: { entry: updatePrompt.entry, reopen: updatePrompt.reopen },
    ...(diagnostics === undefined ? {} : { diagnostics }),
    whatsNew,
    ...(shortcut === undefined ? {} : { shortcut }),
    ...(lookingAt === undefined ? {} : { lookingAt }),
    ...(providerSetup === undefined ? {} : { providerSetup }),
  };

  /** Reads the bot as a template for the share sheet, which shows it loading meanwhile. */
  function shareTemplate(botId: BotId) {
    const name = bots.find((bot) => bot.id === botId)?.profile.name ?? "";
    setSharing({ botId, share: { _tag: "loading", name } });
    void j3.botTemplate(botId).then((result) =>
      setSharing((current) =>
        current?.botId !== botId
          ? current
          : {
              botId,
              share:
                result._tag === "done"
                  ? { _tag: "ready", template: result.value }
                  : result._tag === "too-large"
                    ? { _tag: "too-large", name, error: result.error }
                    : { _tag: "failed", name },
            },
      ),
    );
  }

  return (
    <ShellSourceProvider source={{ data, intents, browser: j3 }}>
      {attachments.host(children)}
      {recordings.sheet}
      {folds.readers}
      <NewBotDialog
        bots={bots}
        open={newBot}
        onOpenChange={setNewBot}
        onUnsavedChange={setNewBotUnsaved}
        onCreate={(bot) =>
          intents.createBot(bot).then((result) => {
            if (result._tag === "failed") throw new Error("The bot was not created");
            setNewBot(false);
            void goToBot(result.value);
          })
        }
      />
      <ShareTemplateDialog
        share={sharing?.share ?? null}
        onRetry={() => {
          if (sharing !== null) shareTemplate(sharing.botId);
        }}
        onDownload={(template) =>
          saveText(
            templateFileName(template.profile.name),
            templateFileText(template),
            TEMPLATE_MEDIA_TYPE,
          )
        }
        onCopy={(template) =>
          navigator.clipboard.writeText(templateFileText(template)).then(
            () => true,
            () => false,
          )
        }
        onClose={() => setSharing(null)}
      />
      <NewFromTemplateDialog
        opened={opened}
        engine={data.engine}
        connected={data.connected}
        onCreate={(draft) =>
          j3.createBotFromTemplate(draft).then((result) => {
            if (result._tag === "done") {
              setOpened(null);
              void goToBot(result.value.id);
              return "done";
            }
            return refusedWith(result, "schedule") ? "schedule" : "failed";
          })
        }
        onClose={() => setOpened(null)}
      />
      <input
        ref={templatePicker}
        type="file"
        hidden
        accept={`${TEMPLATE_FILE_EXTENSION},${TEMPLATE_MEDIA_TYPE},application/json`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Cleared, so picking the same file again opens it again.
          event.currentTarget.value = "";
          if (file !== undefined) openTemplate(file);
        }}
      />
      <ConnectorsDialog
        opening={connectorsOpening}
        aside={settingsOpen}
        connectors={connectors}
        bots={bots}
        skills={skills}
        connected={data.connected}
        intents={connectorsIntents}
        skillsIntents={skillsIntents}
        onClose={() => setConnectorsOpening(null)}
      />
      <RoomDialog
        mode={roomFormMode}
        bots={bots}
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
      <RoutineRunsDialog
        open={runsOf !== null}
        name={runsRoutine?.name ?? t("routine.runs.title")}
        routine={runsRoutine}
        runs={routineRuns}
        onClose={() => void navigate({ to: ".", search: { details: true } })}
        onClosed={runsShown.closed}
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
