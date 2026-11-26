// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import {
  type Connector,
  type Device,
  type DeviceId,
  type EngineStatus,
  LANGUAGES,
  type NotificationSettingsChange,
  type PairingCode,
  PairingLink,
  type ServerOrigin,
  type Settings,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import {
  BellIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CpuIcon,
  GaugeIcon,
  KeyRoundIcon,
  type LucideIcon,
  MonitorSmartphoneIcon,
  PaletteIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  type HarnessSettingsChanges,
  type PairingOffer,
  qrOrigin,
  type SettingsSaves,
} from "@j3-bots/client-runtime";
import {
  aiAccountProvider,
  aiAccounts,
  clockTime,
  connectorNeedsYou,
  connectorTone,
  installsHarnesses,
  ownHarness,
  providersNeedYou,
  type SettingsPage,
  settingsGroups,
} from "@j3-bots/client-runtime/presentation";
import { type ProfileEdits, useProfileEdits, useProfileForm } from "@j3-bots/client-runtime/react";
import { useI18n, usePresentation } from "../app/context";
import { type KeyWith, LANGUAGE_NAMES } from "@j3-bots/i18n";
import {
  setAppearance,
  setLanguage,
  usePreferences,
  type Appearance,
  type LanguageChoice,
} from "../preferences/preferences";
import {
  requestNotificationAccess,
  useNotificationAccess,
  type NotificationAccess,
} from "../preferences/notifications";
import type {
  DesktopLocal,
  DesktopServer,
  DesktopShortcut,
  DesktopUpdate,
  RemoteServerUpdate,
  ShellData,
  ShellIntents,
} from "../shell/data";
import { cn } from "../lib/cn";
import { systemTimeZone } from "../lib/timeZone";
import { useTabletUp } from "../lib/useTabletUp";
import {
  activityTime,
  deviceZoneOffer,
  engineProblem,
  settingsPageWords,
  timeZoneHint,
} from "@j3-bots/client-runtime/wording";
import { AppUpdate, appUpdateWaiting } from "./AppUpdate";
import { updateHasDetails } from "./ConnectionBanner";
import { ServerUpdateRow, serverUpdateOffered } from "./ServerUpdate";
import { UpdatePromptEntryButton } from "./UpdatePrompt";
import { ShortcutSetting } from "./ShortcutSetting";
import {
  AdvancedEndpoint,
  AiAccountCard,
  type ConnectPlace,
  connectPlaceOf,
  useWebAiConnect,
} from "./AiConnect";
import { ProviderRow } from "./EmptyStates";
import { OwnHarnessLine, type ProviderActions } from "./ProviderFix";
import { ProviderUpdate } from "./ProviderUpdate";
import { ChangeServer } from "./ServerAddress";
import {
  LeftHere,
  MoveToAnotherServer,
  StartWithSystem,
  StopUsingComputer,
  UseThisComputer,
} from "./LocalMode";
import { PairingQr } from "./PairingQr";
import { PhoneAccessSetting } from "./PhoneAccess";
import { Section } from "./SettingsSection";
import { SkeletonRows } from "./ui/skeleton";
import { UsageSection } from "./UsageSection";
import { SecretsSection } from "./secrets/SecretsSection";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { Segmented } from "./ui/segmented";
import { Switch } from "./ui/switch";
import { dialogBackdrop, screenDialog } from "./ui/dialog";
import { lineField } from "./ui/field";

type SettingsIntents = Pick<
  ShellIntents,
  | "updateSettings"
  | "setSettingsOpen"
  | "showSettingsPage"
  | "openConnectors"
  | "startPairing"
  | "revokeDevice"
  | "refreshSettings"
  | "refreshDevices"
  | "loadMoreTurns"
  | "retryTurns"
  | "signOut"
  | "signOutBrowser"
  | "providerActions"
  | "server"
  | "local"
  | "update"
  | "serverUpdate"
  | "updatePrompt"
  | "shortcut"
  | "providerSetup"
  | "secrets"
>;

type SettingsData = Pick<
  ShellData,
  | "engine"
  | "engineStale"
  | "signIns"
  | "settings"
  | "settingsSaves"
  | "settingsOpen"
  | "settingsPage"
  | "devices"
  | "connected"
  | "roster"
  | "recentTurns"
  | "signInUnencrypted"
  | "secrets"
  | "connectors"
>;

interface SettingsButtonProps {
  readonly data: SettingsData;
  readonly intents: SettingsIntents;
}

// The profile form's unsaved edits are held outside the dialog: Settings
// closed for the operator, as when a notification opens a conversation,
// keeps them; closing it themselves discards them.

/**
 * Whether an update waits for the operator: the server's, on offer to a
 * device that can start it, or the app's, downloaded and ready, or out for
 * a build that does not install it itself.
 */
const updateWaiting = ({ serverUpdate, update }: SettingsIntents): boolean =>
  (serverUpdate !== undefined && serverUpdateOffered(serverUpdate)) ||
  (update !== undefined && appUpdateWaiting(update));

const pageIcons: Record<SettingsPage, LucideIcon> = {
  you: UserRoundIcon,
  notifications: BellIcon,
  appearance: PaletteIcon,
  providers: CpuIcon,
  usage: GaugeIcon,
  connectors: PlugIcon,
  secrets: KeyRoundIcon,
  devices: MonitorSmartphoneIcon,
  where: ServerIcon,
  updates: RefreshCwIcon,
};

/**
 * Settings' pages this window has something for: where the bots live only in
 * the desktop app, and updates only where one can be followed from here.
 */
const pagesFor = (intents: SettingsIntents): ReadonlyArray<ReadonlyArray<SettingsPage>> =>
  settingsGroups
    .map((group) =>
      group.filter((page) => {
        switch (page) {
          case "where":
            return intents.server !== undefined || intents.local !== undefined;
          case "updates":
            return intents.serverUpdate !== undefined || intents.update !== undefined;
          default:
            return true;
        }
      }),
    )
    .filter((group) => group.length > 0);

/**
 * The roster's footer: opens everything that is not about one bot, at the
 * list of its pages. Opening reads the settings and devices again, for what
 * another device changed.
 */
export function SettingsButton({ data, intents }: SettingsButtonProps) {
  const { t } = useI18n();
  const titleId = useId();
  const profile = useProfileEdits(data.settingsSaves.profile);
  const updateEntry = intents.updatePrompt?.entry ?? null;
  const wide = useTabletUp();
  return (
    <div className="flex flex-col border-t border-border p-2">
      {updateEntry !== null && intents.updatePrompt !== undefined && (
        <UpdatePromptEntryButton entry={updateEntry} onOpen={intents.updatePrompt.reopen} />
      )}
      <Dialog.Root
        open={data.settingsOpen}
        onOpenChange={(open) => {
          if (open) {
            intents.showSettingsPage(null);
            intents.refreshSettings();
            intents.refreshDevices();
            intents.serverUpdate?.refresh();
          } else {
            profile.discard();
            // The operator has seen how the update this device followed ended.
            intents.serverUpdate?.dismissEnded();
          }
          intents.setSettingsOpen(open);
        }}
      >
        <Dialog.Trigger
          render={<Button variant="ghost-muted" className="w-full justify-start px-2" />}
        >
          <SettingsIcon aria-hidden />
          {t("settings.title")}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className={dialogBackdrop} />
          <Dialog.Popup
            aria-labelledby={titleId}
            className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-3xl`}
          >
            <SettingsPanel
              data={data}
              intents={intents}
              profile={profile}
              titleId={titleId}
              wide={wide}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/**
 * Settings' pages, listed by name. At the tablet layout and up (`wide`) the
 * list stays beside the page it shows, the first one until the operator picks
 * another; narrower, the list is a screen of its own, a page replaces it, and
 * Back returns to it. Moving between them there, focus goes to the page's
 * title, and back to the row it came from.
 */
export function SettingsPanel({
  data,
  intents,
  profile,
  titleId,
  wide,
}: SettingsButtonProps & {
  readonly profile: ProfileEdits;
  /** Labels the dialog the panel fills. */
  readonly titleId: string;
  readonly wide: boolean;
}) {
  const { t } = useI18n();
  const groups = pagesFor(intents);
  const page =
    data.settingsPage !== null && groups.some((group) => group.includes(data.settingsPage!))
      ? data.settingsPage
      : null;
  const shown: SettingsPage | null = page ?? (wide ? (groups[0]?.[0] ?? null) : null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLElement>(null);
  // The page the narrow list was left for, whose row takes focus as the list comes back.
  const left = useRef<SettingsPage | null>(null);
  useEffect(() => {
    if (wide) return;
    if (page !== null) heading.current?.focus();
    else if (left.current !== null) {
      list.current?.querySelector<HTMLElement>(`[data-page="${left.current}"]`)?.focus();
      left.current = null;
    }
  }, [page, wide]);
  const needsYou = (item: SettingsPage): boolean => {
    switch (item) {
      case "providers":
        return !data.engineStale && providersNeedYou(data.engine);
      case "connectors":
        return data.connectors?.some(connectorNeedsYou) ?? false;
      case "devices":
        // Stored unencrypted until it pairs again, which the operator can do.
        return data.signInUnencrypted;
      case "updates":
        return updateWaiting(intents);
      default:
        return false;
    }
  };
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
        {!wide && page !== null && (
          <Button
            variant="ghost-muted"
            size="icon"
            className="-ms-2"
            aria-label={t("settings.back")}
            onClick={() => {
              left.current = page;
              intents.showSettingsPage(null);
            }}
          >
            <ChevronLeftIcon className="rtl:-scale-x-100" />
          </Button>
        )}
        <Dialog.Title id={titleId} className="display-type text-lg">
          {t("settings.title")}
        </Dialog.Title>
        <Dialog.Close
          render={
            <Button
              variant="ghost-muted"
              size="icon"
              className="ms-auto"
              aria-label={t("settings.close")}
            />
          }
        >
          <XIcon />
        </Dialog.Close>
      </header>
      <div className="flex min-h-0 flex-1">
        {(wide || shown === null) && (
          <nav
            ref={list}
            aria-label={t("settings.sections")}
            className={cn(
              "flex flex-col gap-4 overflow-y-auto p-2",
              wide ? "w-56 shrink-0 border-e border-border" : "w-full",
            )}
          >
            {groups.map((group) => (
              <ul key={group[0]} className="flex flex-col gap-0.5">
                {group.map((item) => (
                  <li key={item}>
                    <PageRow
                      page={item}
                      current={item === shown}
                      needsYou={needsYou(item)}
                      chevron={!wide}
                      onPick={() => {
                        // Read again each time it shows: a phone may have paired
                        // elsewhere since, as with a code from "Use from your phone".
                        if (item === "devices") intents.refreshDevices();
                        intents.showSettingsPage(item);
                      }}
                    />
                  </li>
                ))}
              </ul>
            ))}
          </nav>
        )}
        {shown !== null && (
          <div key={shown} className="conversation-open min-w-0 flex-1 overflow-y-auto">
            <PageView page={shown} heading={heading}>
              <PageBody page={shown} data={data} intents={intents} profile={profile} />
            </PageView>
          </div>
        )}
      </div>
    </>
  );
}

/** A page's row in Settings' list: its icon and name, a dot while it waits on the operator. */
function PageRow({
  page,
  current,
  needsYou,
  chevron,
  onPick,
}: {
  page: SettingsPage;
  current: boolean;
  needsYou: boolean;
  /** On a narrow screen, where the row leads to a page of its own. */
  chevron: boolean;
  onPick: () => void;
}) {
  const i18n = useI18n();
  const Icon = pageIcons[page];
  return (
    <button
      type="button"
      data-page={page}
      aria-current={current ? "page" : undefined}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 text-start text-sm transition-colors duration-(--duration-state) outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        chevron ? "min-h-11" : "min-h-9",
        current ? "bg-muted font-medium text-foreground" : "text-foreground",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{settingsPageWords(page, i18n).title}</span>
      {needsYou && (
        <span className="size-1.5 shrink-0 rounded-full bg-accent">
          <span className="sr-only">{i18n.t("settings.needsYou")}</span>
        </span>
      )}
      {chevron && (
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
        />
      )}
    </button>
  );
}

/** A page of Settings: its name in the display face, the line that says what it holds, its groups. */
function PageView({
  page,
  heading,
  children,
}: {
  page: SettingsPage;
  heading: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const words = settingsPageWords(page, useI18n());
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 px-5 pt-6 pb-10">
      <header className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="display-type text-xl outline-none">
          {words.title}
        </h2>
        <p className="text-sm text-muted-foreground">{words.description}</p>
      </header>
      {children}
    </div>
  );
}

/** What one page of Settings holds. */
function PageBody({
  page,
  data,
  intents,
  profile,
}: SettingsButtonProps & { readonly page: SettingsPage; readonly profile: ProfileEdits }) {
  switch (page) {
    case "you":
      return (
        <YouSection
          settings={data.settings}
          save={data.settingsSaves.profile}
          profile={profile}
          connected={data.connected}
          onSave={intents.updateSettings}
        />
      );
    case "notifications":
      return (
        <NotificationsSection
          settings={data.settings}
          save={data.settingsSaves.notifications}
          connected={data.connected}
          onSave={intents.updateSettings}
        />
      );
    case "appearance":
      return <AppearanceSection />;
    case "providers":
      return (
        <EngineSection
          engine={data.engine}
          stale={data.engineStale}
          actions={intents.providerActions}
          harnessSettings={{
            settings: data.settings,
            save: data.settingsSaves.harnesses,
            connected: data.connected,
            onSave: intents.updateSettings,
          }}
          connect={connectPlaceOf(
            intents.providerSetup === undefined
              ? undefined
              : { ...intents.providerSetup, signIns: data.signIns },
            intents.serverUpdate?.view,
          )}
        />
      );
    case "usage":
      return (
        <UsageSection
          engine={data.engine}
          engineStale={data.engineStale}
          recent={data.recentTurns}
          roster={data.roster}
          onLoadMore={intents.loadMoreTurns}
          onRetry={intents.retryTurns}
        />
      );
    case "connectors":
      return (
        <ConnectorsSection
          connectors={data.connectors}
          onOpen={() => intents.openConnectors({ _tag: "home" })}
        />
      );
    case "secrets":
      return (
        <>
          <SecretsSection secrets={{ view: data.secrets, intents: intents.secrets }} />
          <BotBrowserSection connected={data.connected} onSignOut={intents.signOutBrowser} />
        </>
      );
    case "devices":
      return (
        <>
          <ThisDeviceSection
            desktop={intents.server !== undefined || intents.local !== undefined}
            unencrypted={data.signInUnencrypted}
            shortcut={intents.shortcut}
          />
          <DevicesSection
            devices={data.devices}
            connected={data.connected}
            onStartPairing={intents.startPairing}
            onRevoke={intents.revokeDevice}
          />
          {/* On this computer, signing out is stopping using it, where the bots live. */}
          {intents.local === undefined && <SignOutSection onSignOut={intents.signOut} />}
        </>
      );
    case "where":
      return <WhereSection server={intents.server} local={intents.local} />;
    case "updates":
      return (
        <UpdatesSection
          server={intents.serverUpdate}
          app={intents.update}
          local={intents.local}
          onUpdate={intents.updatePrompt?.reopen}
        />
      );
  }
}

/**
 * Whether J3 Bots can run bots, and if not, why and what to do; then each AI
 * account, with the same way to connect it as the first run, where it
 * connects (`connect`), and any other provider. Disconnected, it is what the
 * server last reported, muted and said to be so.
 */
export function EngineSection({
  engine,
  stale,
  actions,
  harnessSettings,
  connect = { _tag: "server" },
}: {
  engine: EngineStatus | null;
  stale: boolean;
  actions: ProviderActions;
  harnessSettings?: HarnessSettingsProps;
  connect?: ConnectPlace;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (engine === null) {
    return (
      <Section>
        <SkeletonRows />
      </Section>
    );
  }
  const problem = engineProblem(engine, i18n);
  const others = engine.providers.filter((provider) => provider.harness === "other");
  return (
    <Section>
      {stale && <p className="text-xs text-muted-foreground">{t("settings.engine.lastKnown")}</p>}
      {problem === null ? (
        <p className={cn("text-sm", stale && "text-muted-foreground")}>
          {t("settings.engine.ready", { version: engine.pinnedVersion })}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {/* Starting, or downloading, is on its way rather than blocked. */}
          <p
            className={cn(
              "text-sm font-medium tabular-nums",
              stale
                ? "text-muted-foreground"
                : engine.state._tag === "starting"
                  ? "text-foreground"
                  : "text-blocked",
            )}
          >
            {problem.title}
          </p>
          <p className="text-sm text-muted-foreground">{problem.body}</p>
        </div>
      )}
      <AiAccounts engine={engine} stale={stale} actions={actions} connect={connect} />
      {others.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {others.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              place={connect._tag === "here" ? "this-computer" : "server"}
              actions={actions}
              stale={stale}
            />
          ))}
        </ul>
      )}
      {harnessSettings !== undefined && installsHarnesses(engine) && (
        <HarnessSwitch setting="autoUpdateHarnesses" {...harnessSettings} />
      )}
      {harnessSettings !== undefined && (
        <HarnessSwitch setting="suggestReplies" {...harnessSettings} />
      )}
    </Section>
  );
}

/**
 * Each AI account, one card each: where it stands and its one button, then
 * the version it runs, with Update when a newer one is out; and, in the app
 * on the server's own computer, an endpoint instead, folded away.
 */
function AiAccounts({
  engine,
  stale,
  actions,
  connect,
}: {
  engine: EngineStatus;
  stale: boolean;
  actions: ProviderActions;
  connect: ConnectPlace;
}) {
  const ai = useWebAiConnect({ engine, connect, actions });
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-sm">
        {aiAccounts.map((account) => {
          const provider = aiAccountProvider(engine, account);
          const own = provider === undefined ? null : ownHarness(provider);
          return (
            <AiAccountCard key={account} ai={ai} account={account} stale={stale}>
              {provider !== undefined &&
                (own === null ? (
                  <ProviderUpdate provider={provider} onUpdate={actions.update} />
                ) : (
                  <OwnHarnessLine own={own} actions={actions} />
                ))}
            </AiAccountCard>
          );
        })}
      </ul>
      {!stale && <AdvancedEndpoint ai={ai} />}
    </>
  );
}

/**
 * The services bots can use: how many work and how many wait on the
 * operator, and the screen that manages them.
 */
export function ConnectorsSection({
  connectors,
  onOpen,
}: {
  connectors: ReadonlyArray<Connector> | null;
  onOpen: () => void;
}) {
  const { t, plural } = useI18n();
  const working =
    connectors?.filter((connector) => connectorTone(connector) === "connected").length ?? 0;
  const needYou = connectors?.filter(connectorNeedsYou).length ?? 0;
  return (
    <Section>
      {connectors === null ? (
        <SkeletonRows count={1} />
      ) : connectors.length === 0 ? (
        <p className="text-sm">{t("settings.connectors.none")}</p>
      ) : (
        <p className="text-sm">
          {plural("settings.connectors.connected", working)}
          {needYou > 0 && (
            <span className="text-waiting">
              {" "}
              · {plural("settings.connectors.needsYou", needYou)}
            </span>
          )}
        </p>
      )}
      <Button size="sm" className="self-start" onClick={onOpen}>
        {t("settings.connectors.open")}
      </Button>
    </Section>
  );
}

const timeZones = (current: string): ReadonlyArray<string> => {
  const known = Intl.supportedValuesOf("timeZone");
  return known.includes(current) ? known : [current, ...known];
};

/** What bots call the operator, and the time zone routines and times follow. */
function YouSection({
  settings,
  ...form
}: Omit<YouFormProps, "settings"> & { settings: Settings | null }) {
  return (
    <Section>
      {settings === null ? <SkeletonRows /> : <YouForm settings={settings} {...form} />}
    </Section>
  );
}

interface YouFormProps {
  readonly settings: Settings;
  readonly save: SettingsSaves["profile"];
  /** What the operator changed and has not saved, held by `SettingsButton`. */
  readonly profile: ProfileEdits;
  readonly connected: boolean;
  readonly onSave: SettingsIntents["updateSettings"];
}

/**
 * Saving needs the server: offline, Save says why it is unavailable. A save
 * sends only the fields the operator changed. While the form's save is under
 * way, even one started before Settings last closed, the form shows what it
 * sends and takes no edit. A field the operator left alone shows the saved
 * value as it arrives; one they changed keeps their edit until the form saves
 * it. This computer's own zone is one press away.
 */
function YouForm({ settings, save, profile, connected, onSave }: YouFormProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const nameId = useId();
  const zoneId = useId();
  const offlineId = useId();
  const form = useProfileForm({ settings, save, profile, connected });
  const computerZone = deviceZoneOffer(systemTimeZone(), ctx);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        form.submit((changes) => onSave({ section: "profile", changes }));
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs">
          {t("settings.name")}
        </label>
        <input
          id={nameId}
          value={form.name}
          maxLength={200}
          autoComplete="name"
          placeholder={t("settings.name.placeholder")}
          readOnly={form.saving}
          onChange={(event) => form.editName(event.currentTarget.value)}
          className={lineField}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={zoneId} className="text-xs">
          {t("settings.timeZone")}
        </label>
        <select
          id={zoneId}
          value={form.zone}
          aria-readonly={form.saving}
          onChange={(event) => form.editZone(event.currentTarget.value)}
          className={lineField}
        >
          {timeZones(form.zone).map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <p className="text-2xs text-muted-foreground">{timeZoneHint(form.zone, ctx)}</p>
        {computerZone !== null && computerZone.zone !== form.zone && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1 self-start"
            aria-disabled={form.saving}
            onClick={() => {
              if (!form.saving) form.editZone(computerZone.zone);
            }}
          >
            {t("settings.timeZone.useComputer", { zone: computerZone.name })}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          aria-disabled={!form.canSave}
          aria-describedby={connected ? undefined : offlineId}
        >
          {t("settings.save")}
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {form.status === "saved" && t("settings.saved")}
          {form.status === "failed" && (
            <span className="text-blocked">{t("settings.saveFailed")}</span>
          )}
        </p>
      </div>
      {!connected && (
        <p id={offlineId} className="text-xs text-muted-foreground">
          {t("settings.save.offline")}
        </p>
      )}
    </form>
  );
}

/** What this browser can do about notifications, in words. */
const accessLine: Record<Exclude<NotificationAccess, "default">, KeyWith> = {
  granted: "settings.notifications.browser.granted",
  denied: "settings.notifications.browser.denied",
  unsupported: "settings.notifications.browser.unsupported",
  "home-screen": "settings.notifications.browser.homeScreen",
  insecure: "settings.notifications.browser.insecure",
};

/**
 * Whether J3 Bots notifies the operator and how much a notification says,
 * which hold for every device, and whether this browser may show them. The
 * browser asks its permission only when the operator presses the button:
 * never on its own. A switch saves at once; offline, or while a switch's save
 * is under way, it shows the value it holds and takes no change. How a save
 * ended shows only for one this section saw under way, so reopening Settings
 * clears it.
 */
function NotificationsSection({
  settings,
  save,
  connected,
  onSave,
}: {
  settings: Settings | null;
  save: SettingsSaves["notifications"];
  connected: boolean;
  onSave: SettingsIntents["updateSettings"];
}) {
  const { t } = useI18n();
  const access = useNotificationAccess();
  const saving = save._tag === "saving";
  const [watching, setWatching] = useState(saving);
  if (settings === null) {
    return (
      <Section>
        <SkeletonRows />
      </Section>
    );
  }
  const shown = { ...settings.notifications, ...(saving ? save.changes : undefined) };
  const failed = watching && save._tag === "failed";
  // Only the switch that changed: another device may have changed the other one.
  const change = (changes: NotificationSettingsChange) => {
    if (saving || !connected) return;
    setWatching(true);
    onSave({ section: "notifications", changes });
  };
  return (
    <Section>
      <SwitchRow
        label={t("settings.notifications.enabled")}
        hint={t("settings.notifications.enabled.hint")}
        checked={shown.enabled}
        readOnly={saving || !connected}
        onChange={(enabled) => change({ enabled })}
      />
      {shown.enabled && (
        <>
          {access === "default" ? (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-xs text-muted-foreground">
                {t("settings.notifications.browser.default")}
              </p>
              <Button size="sm" onClick={() => void requestNotificationAccess()}>
                {t("settings.notifications.allow")}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t(accessLine[access])}</p>
          )}
          <SwitchRow
            label={t("settings.notifications.previews")}
            hint={t("settings.notifications.previews.hint")}
            checked={shown.previews}
            readOnly={saving || !connected}
            onChange={(previews) => change({ previews })}
          />
        </>
      )}
      {/* Exposed while empty, so a failure that arrives later is announced. */}
      <p role="status" className="text-xs text-blocked empty:sr-only">
        {failed && t("settings.saveFailed")}
      </p>
      {!connected && <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>}
    </Section>
  );
}

interface HarnessSettingsProps {
  readonly settings: Settings | null;
  readonly save: SettingsSaves["harnesses"];
  readonly connected: boolean;
  readonly onSave: SettingsIntents["updateSettings"];
}

/** The harness settings the AI page offers as switches, and the words of each. */
const harnessSwitches = {
  autoUpdateHarnesses: {
    label: "settings.engine.autoUpdate",
    hint: "settings.engine.autoUpdate.body",
  },
  suggestReplies: {
    label: "settings.engine.suggestReplies",
    hint: "settings.engine.suggestReplies.body",
  },
} as const;

/**
 * One of what the harnesses do on their own: whether the server keeps its
 * own copies of Claude Code and Codex up to date, or whether they guess the
 * operator's next message. Saves at once, as the notification switches do; a
 * server that predates the setting shows nothing.
 */
function HarnessSwitch({
  setting,
  settings,
  save,
  connected,
  onSave,
}: HarnessSettingsProps & { readonly setting: keyof HarnessSettingsChanges }) {
  const { t } = useI18n();
  const saving = save._tag === "saving";
  // A save under way when Settings opened is followed by the switch it changes.
  const [watching, setWatching] = useState(saving && save.changes[setting] !== undefined);
  const current = settings === null ? null : settings[setting];
  if (current === null) return null;
  const words = harnessSwitches[setting];
  return (
    <div className="flex flex-col gap-1">
      <SwitchRow
        label={t(words.label)}
        hint={t(words.hint)}
        checked={(saving ? save.changes[setting] : undefined) ?? current}
        readOnly={saving || !connected}
        onChange={(on) => {
          if (saving || !connected) return;
          setWatching(true);
          onSave({ section: "harnesses", changes: { [setting]: on } });
        }}
      />
      <p role="status" className="text-xs text-blocked empty:sr-only">
        {watching && save._tag === "failed" && t("settings.saveFailed")}
      </p>
    </div>
  );
}

/** A setting that is on or off: its name and what it does, beside the switch. */
function SwitchRow({
  label,
  hint,
  checked,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  readOnly: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="text-sm">
          {label}
        </span>
        <span id={hintId} className="text-2xs text-muted-foreground">
          {hint}
        </span>
      </span>
      <Switch
        checked={checked}
        readOnly={readOnly}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onCheckedChange={onChange}
      />
    </div>
  );
}

const shownCode = (code: PairingCode) => `${code.slice(0, 5)}-${code.slice(5)}`;

type Pairing =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting" }
  | ({ readonly _tag: "started" } & PairingOffer)
  | { readonly _tag: "failed" };

const encodeLink = Schema.encodeSync(PairingLink);

/** Every paired device, and a code to pair one more, which takes the server. */
function DevicesSection({
  devices,
  connected,
  onStartPairing,
  onRevoke,
}: {
  devices: ReadonlyArray<Device> | null;
  connected: boolean;
  onStartPairing: SettingsIntents["startPairing"];
  onRevoke: SettingsIntents["revokeDevice"];
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const offlineId = useId();
  const [pairing, setPairing] = useState<Pairing>({ _tag: "idle" });
  // The address the operator picked for the QR code. Kept here, since the code
  // shown goes while a new one is fetched, and the pick holds while it is one
  // of the new code's addresses.
  const [picked, setPicked] = useState<ServerOrigin | null>(null);
  // Revocations under way or not confirmed. One the server confirms leaves the list with its
  // device; for the others the list is read again, and shows whether the device is still there.
  const [revoking, setRevoking] = useState<ReadonlyMap<DeviceId, "pending" | "failed">>(new Map());
  const revoke = (deviceId: DeviceId) => {
    setRevoking((held) => new Map(held).set(deviceId, "pending"));
    onRevoke(deviceId).then((done) =>
      setRevoking((held) => {
        const next = new Map(held);
        if (done) next.delete(deviceId);
        else next.set(deviceId, "failed");
        return next;
      }),
    );
  };
  return (
    <Section title={t("settings.devices.paired")}>
      {devices === null ? (
        <SkeletonRows />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {devices.map((device) => {
            const state = revoking.get(device.id);
            return (
              <li
                key={device.id}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{device.name}</span>
                  <span className="text-2xs text-muted-foreground">
                    {device.current
                      ? t("settings.device.current")
                      : device.lastSeenAt === null
                        ? t("settings.device.neverSeen")
                        : t("settings.device.lastSeen", {
                            when: activityTime(device.lastSeenAt, ctx),
                          })}
                    {device.pushRegistered && ` · ${t("settings.device.pushOn")}`}
                  </span>
                  <span role="alert" className="text-2xs text-blocked empty:hidden">
                    {state === "failed" &&
                      t("settings.device.revoke.failed", { name: device.name })}
                  </span>
                </span>
                {state === "failed" ? (
                  <Button size="sm" variant="destructive-outline" onClick={() => revoke(device.id)}>
                    {t("settings.device.revoke.retry")}
                  </Button>
                ) : (
                  !device.current && (
                    <Confirm
                      trigger={
                        <Button
                          size="sm"
                          variant="destructive-outline"
                          aria-disabled={state === "pending"}
                        />
                      }
                      busy={state === "pending"}
                      title={t("settings.device.revoke.title", { name: device.name })}
                      body={t("settings.device.revoke.body", { name: device.name })}
                      cancel={t("settings.device.revoke.cancel")}
                      confirm={t("settings.device.revoke")}
                      onConfirm={() => revoke(device.id)}
                    >
                      {state === "pending"
                        ? t("settings.device.revoke.pending")
                        : t("settings.device.revoke")}
                    </Confirm>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button
          size="sm"
          aria-disabled={!connected || pairing._tag === "starting"}
          aria-describedby={connected ? undefined : offlineId}
          onClick={() => {
            if (!connected || pairing._tag === "starting") return;
            setPairing({ _tag: "starting" });
            onStartPairing().then(setPairing);
          }}
        >
          {pairing._tag === "started" ? t("settings.pair.again") : t("settings.pair")}
        </Button>
        {!connected && (
          <p id={offlineId} className="text-xs text-muted-foreground">
            {t("settings.pair.offline")}
          </p>
        )}
        <div role="status" className="text-sm">
          {pairing._tag === "started" && (
            <PairingCodeShown offer={pairing} picked={picked} onPick={setPicked} />
          )}
          {pairing._tag === "failed" && (
            <p className="text-xs text-blocked">{t("settings.pair.failed")}</p>
          )}
        </div>
      </div>
    </Section>
  );
}

/**
 * The code to enter on the other device and, when the server can be reached
 * from another device, a QR code of the pairing link for a phone's camera. The
 * link carries `picked` while the offer lists it, else the first origin the
 * offer lists. Under the QR code, what a sign-in gate in front of the server
 * would do to it.
 */
function PairingCodeShown({
  offer,
  picked,
  onPick,
}: {
  offer: PairingOffer;
  picked: ServerOrigin | null;
  onPick: (origin: ServerOrigin) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const addressId = useId();
  const server = qrOrigin(offer, picked);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {server === null ? t("settings.pair.instructions") : t("settings.pair.scanOrEnter")}
      </p>
      <div className="flex flex-wrap items-start gap-4">
        {server !== null && (
          <PairingQr
            text={encodeLink({ server, code: offer.code })}
            label={t("settings.pair.qr", { address: server })}
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-lg tracking-wider">{shownCode(offer.code)}</p>
          <p className="text-2xs text-muted-foreground">
            {t("settings.pair.expires", { time: clockTime(offer.expiresAt, ctx) })}
          </p>
          {server !== null && (
            <p className="max-w-xs text-2xs text-pretty text-muted-foreground">
              {t("settings.pair.gate")}
            </p>
          )}
          {server !== null && offer.origins.length > 1 && (
            <div className="flex flex-col gap-1 pt-2">
              <label htmlFor={addressId} className="text-xs">
                {t("settings.pair.address")}
              </label>
              <select
                id={addressId}
                value={server}
                onChange={(event) => {
                  const chosen = offer.origins.find(
                    (origin) => origin === event.currentTarget.value,
                  );
                  if (chosen !== undefined) onPick(chosen);
                }}
                className={lineField}
              >
                {offer.origins.map((origin) => (
                  <option key={origin} value={origin}>
                    {origin}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Signs this device out once the operator confirms, after a question that
 * says what goes and what stays. `quiet`: a plain text button, for the
 * screens before the roster, where it is not what the operator came for.
 */
export function SignOutDevice({
  onSignOut,
  quiet = false,
}: {
  onSignOut: SettingsIntents["signOut"];
  quiet?: boolean;
}) {
  const { t } = useI18n();
  // Success leaves the app for pairing, or tells of another tab's new pairing
  // in a notice, so only a failure is ever shown here.
  const [signOut, setSignOut] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <div className={cn("flex flex-col gap-1.5", quiet ? "items-center" : "items-start")}>
      <Confirm
        trigger={
          <Button
            size="sm"
            variant={quiet ? "ghost-muted" : "destructive-outline"}
            aria-disabled={signOut === "pending"}
          />
        }
        busy={signOut === "pending"}
        title={t("settings.signOut.title")}
        body={t("settings.signOut.body")}
        cancel={t("settings.signOut.cancel")}
        confirm={t("settings.signOut")}
        onConfirm={() => {
          setSignOut("pending");
          onSignOut().then((done) => setSignOut(done ? "idle" : "failed"));
        }}
      >
        {signOut === "pending" ? t("settings.signOut.pending") : t("settings.signOut")}
      </Confirm>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {signOut === "failed" && t("settings.signOut.failed")}
      </p>
    </div>
  );
}

/**
 * The browser bots use keeps the operator's sign-ins; signing it out of every
 * site asks first, since it ends all of them at once, for every bot.
 */
function BotBrowserSection({
  connected,
  onSignOut,
}: {
  connected: boolean;
  onSignOut: SettingsIntents["signOutBrowser"];
}) {
  const { t } = useI18n();
  const [signOut, setSignOut] = useState<"idle" | "pending" | "done" | "failed">("idle");
  return (
    <Section title={t("settings.botBrowser")}>
      <p className="text-xs text-muted-foreground">{t("settings.botBrowser.hint")}</p>
      <div className="flex flex-col items-start gap-1.5">
        <Confirm
          trigger={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!connected}
              aria-disabled={signOut === "pending"}
            />
          }
          busy={signOut === "pending"}
          title={t("settings.botBrowser.signOut.title")}
          body={t("settings.botBrowser.signOut.body")}
          cancel={t("settings.botBrowser.signOut.cancel")}
          confirm={t("settings.botBrowser.signOut.confirm")}
          onConfirm={() => {
            setSignOut("pending");
            void onSignOut().then((done) => setSignOut(done ? "done" : "failed"));
          }}
        >
          {t("settings.botBrowser.signOut")}
        </Confirm>
        <p
          role={signOut === "failed" ? "alert" : "status"}
          className={cn(
            "text-xs empty:hidden",
            signOut === "failed" ? "text-blocked" : "text-muted-foreground",
          )}
        >
          {signOut === "done" && t("settings.botBrowser.signOut.done")}
          {signOut === "failed" && t("settings.botBrowser.signOut.failed")}
        </p>
      </div>
    </Section>
  );
}

/**
 * In the desktop app, where the bots live, and moving them: on this computer,
 * whether the app starts with the system, whether phones on the network reach
 * the bots, and stopping using it; on a server,
 * its address, changing it and using this computer instead.
 */
export function WhereSection({
  server,
  local,
}: {
  server: DesktopServer | undefined;
  local: DesktopLocal | undefined;
}) {
  const { t } = useI18n();
  const [leftHereDeleted, setLeftHereDeleted] = useState(false);
  if (local !== undefined) {
    return (
      <>
        <Section>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm">{t("settings.where.local")}</p>
            <p className="text-2xs text-muted-foreground">{t("where.thisComputer.hint")}</p>
          </div>
          <StartWithSystem on={local.startWithSystem} onChange={local.setStartWithSystem} />
          <PhoneAccessSetting phone={local.phone} />
        </Section>
        {/* Moving and stopping take the bots off this computer: ruled off from the rest. */}
        <Section apart>
          <div className="flex flex-wrap items-start gap-2">
            <MoveToAnotherServer onMove={local.moveAway} />
            <StopUsingComputer onStop={local.stopUsing} />
          </div>
        </Section>
      </>
    );
  }
  if (server === undefined) return null;
  return (
    <Section>
      <div className="flex flex-col gap-0.5">
        <p className="text-sm">{t("settings.where.server")}</p>
        <p className="font-mono text-2xs break-all text-muted-foreground">{server.address}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {server.chooseThisComputer !== undefined && (
          <UseThisComputer address={server.address} onUse={server.chooseThisComputer} />
        )}
        <ChangeServer
          address={server.address}
          onChange={server.forget}
          paired
          className="items-start"
        />
      </div>
      {server.leftHere !== undefined && !leftHereDeleted && (
        <LeftHere
          moved={server.leftHere.moved}
          onDelete={() =>
            server.leftHere === undefined
              ? Promise.resolve(false)
              : server.leftHere.deleteData().then((deleted) => {
                  if (deleted) setLeftHereDeleted(true);
                  return deleted;
                })
          }
        />
      )}
    </Section>
  );
}

/**
 * What the server runs and updating it, and in the desktop app, the app's
 * version and its update. In local mode the app runs the server, so updating
 * the app updates both, and the server has no row of its own.
 */
export function UpdatesSection({
  server,
  app,
  local,
  onUpdate,
}: {
  server: RemoteServerUpdate | undefined;
  app: DesktopUpdate | undefined;
  /** Opens the update prompt, which updates the server first and this app after it. */
  onUpdate: (() => void) | undefined;
  /** The bots on this computer, in local mode. */
  local: DesktopLocal | undefined;
}) {
  const { t } = useI18n();
  return (
    <Section>
      {server !== undefined && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium">{t("serverUpdate.title")}</h4>
          <ServerUpdateRow update={server} onUpdate={onUpdate} />
        </div>
      )}
      {app !== undefined && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium">{t("updates.app.heading")}</h4>
          {local !== undefined && (
            <p className="text-2xs text-muted-foreground">{t("updates.app.local")}</p>
          )}
          <AppUpdate update={app} channel className="items-start" />
          {local?.serverUpdate !== undefined && <LocalServerUpdateLine local={local} />}
        </div>
      )}
    </Section>
  );
}

/**
 * Where the bots on this computer stand after the app moved them to the
 * release it carries, as the connection line says it: moving, rolled back
 * with Try again and why, or on a release newer than the app.
 */
function LocalServerUpdateLine({ local }: { local: DesktopLocal }) {
  const { t } = useI18n();
  const update = local.serverUpdate;
  switch (update?._tag) {
    case undefined:
      return null;
    case "updating":
      return (
        <p role="status" className="text-xs text-muted-foreground">
          {t("local.line.update.updating", { version: update.to })}
        </p>
      );
    case "older-app":
      return (
        <p className="text-xs text-muted-foreground">
          {t("local.line.update.olderApp", { running: update.running })}
        </p>
      );
    case "rolled-back":
      return (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-xs">
            {t("local.line.update.rolledBack", { failed: update.failed, running: update.running })}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={local.retryServerUpdate}>
              {t("local.line.update.retry")}
            </Button>
            {updateHasDetails(update) && (
              <Button size="sm" variant="ghost" onClick={local.showUpdateDetails}>
                {t("local.failed.details")}
              </Button>
            )}
          </div>
        </div>
      );
  }
}

/** The theme and the language, kept on this device only. */
function AppearanceSection() {
  const { t } = useI18n();
  const { appearance, language } = usePreferences();
  const appearanceId = useId();
  const languageId = useId();
  const appearances: ReadonlyArray<{ value: Appearance; label: string }> = [
    { value: "system", label: t("settings.system.short") },
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
  ];
  // Each language is named in itself, so it can be found from any other.
  const languages: ReadonlyArray<{ value: LanguageChoice; label: string }> = [
    { value: "system", label: t("settings.system") },
    ...LANGUAGES.map((language) => ({ value: language, label: LANGUAGE_NAMES[language] })),
  ];
  return (
    <Section>
      <div className="flex flex-col gap-1.5">
        <span id={appearanceId} className="text-xs">
          {t("settings.theme")}
        </span>
        <Segmented
          value={appearance}
          options={appearances}
          onChange={setAppearance}
          labelledBy={appearanceId}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={languageId} className="text-xs">
          {t("settings.language")}
        </label>
        <select
          id={languageId}
          value={language}
          onChange={(event) => {
            const picked = languages.find((l) => l.value === event.currentTarget.value);
            if (picked) setLanguage(picked.value);
          }}
          className={lineField}
        >
          {languages.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}

/**
 * What holds for this device alone, in the `desktop` app: its global
 * `shortcut`, and that its sign-in is stored `unencrypted` when it is, as
 * that is less safe than the operator would expect. Nothing in a browser.
 */
function ThisDeviceSection({
  desktop,
  unencrypted,
  shortcut,
}: {
  desktop: boolean;
  unencrypted: boolean;
  shortcut: DesktopShortcut | undefined;
}) {
  const { t } = useI18n();
  if (shortcut === undefined && !unencrypted) return null;
  return (
    <Section title={t(desktop ? "settings.thisDevice" : "settings.browser")}>
      {shortcut !== undefined && <ShortcutSetting shortcut={shortcut} />}
      {unencrypted && (
        <p className="text-xs text-muted-foreground">{t("settings.thisDevice.unencrypted")}</p>
      )}
    </Section>
  );
}

/**
 * Signing this device out, ruled off at the end of the devices. In local mode
 * there is none: signing out is stopping using this computer, where the bots
 * live, as there is no other server to sign in to.
 */
function SignOutSection({ onSignOut }: { onSignOut: SettingsIntents["signOut"] }) {
  const { t } = useI18n();
  return (
    <Section apart>
      <p className="text-xs text-muted-foreground">{t("settings.signOut.hint")}</p>
      <SignOutDevice onSignOut={onSignOut} />
    </Section>
  );
}
