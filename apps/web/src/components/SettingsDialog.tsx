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
import { SettingsIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { PairingOffer, SettingsSaves } from "@j3-bots/client-runtime";
import {
  clockTime,
  connectCommand,
  connectorNeedsYou,
  connectorTone,
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
import {
  activityTime,
  deviceZoneOffer,
  engineProblem,
  timeZoneHint,
} from "@j3-bots/client-runtime/wording";
import { AppUpdate, appUpdateWaiting } from "./AppUpdate";
import { updateHasDetails } from "./ConnectionBanner";
import { ServerUpdateRow, serverUpdateOffered } from "./ServerUpdate";
import { ShortcutSetting } from "./ShortcutSetting";
import { ConnectProviders, ProviderRow } from "./EmptyStates";
import type { Recheck } from "./ProviderFix";
import {
  engineFindings,
  HarnessLocations,
  type LocalProviderSetup,
  LocalSignIn,
} from "./ProviderSetup";
import { ChangeServer } from "./ServerAddress";
import { StartWithSystem, StopUsingComputer, UseThisComputer } from "./LocalMode";
import { PairingQr } from "./PairingQr";
import { PhoneAccessSetting } from "./PhoneAccess";
import { Section } from "./SettingsSection";
import { SkeletonRows } from "./ui/skeleton";
import { UsageSection } from "./UsageSection";
import { VaultSection } from "./vault/VaultSection";
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
  | "openConnectors"
  | "startPairing"
  | "revokeDevice"
  | "refreshSettings"
  | "refreshDevices"
  | "loadMoreTurns"
  | "retryTurns"
  | "signOut"
  | "signOutBrowser"
  | "recheckProvider"
  | "server"
  | "local"
  | "update"
  | "serverUpdate"
  | "shortcut"
  | "providerSetup"
  | "vault"
>;

interface SettingsButtonProps {
  readonly data: Pick<
    ShellData,
    | "engine"
    | "engineStale"
    | "signIns"
    | "settings"
    | "settingsSaves"
    | "settingsOpen"
    | "devices"
    | "connected"
    | "roster"
    | "recentTurns"
    | "signInUnencrypted"
    | "vault"
    | "connectors"
  >;
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

/**
 * The roster's footer: opens everything that is not about one bot. Opening
 * reads the settings and devices again, for what another device changed.
 */
export function SettingsButton({ data, intents }: SettingsButtonProps) {
  const { t } = useI18n();
  const titleId = useId();
  const profile = useProfileEdits(data.settingsSaves.profile);
  return (
    <div className="border-t border-border p-2">
      <Dialog.Root
        open={data.settingsOpen}
        onOpenChange={(open) => {
          if (open) {
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
          {updateWaiting(intents) && (
            <span className="ms-auto flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              {t("updates.notice")}
            </span>
          )}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className={dialogBackdrop} />
          <Dialog.Popup
            aria-labelledby={titleId}
            className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-lg`}
          >
            <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              <YouSection
                settings={data.settings}
                save={data.settingsSaves.profile}
                profile={profile}
                connected={data.connected}
                onSave={intents.updateSettings}
              />
              <NotificationsSection
                settings={data.settings}
                save={data.settingsSaves.notifications}
                connected={data.connected}
                onSave={intents.updateSettings}
              />
              <VaultSection vault={{ view: data.vault, intents: intents.vault }} />
              <EngineSection
                engine={data.engine}
                stale={data.engineStale}
                onRecheck={intents.recheckProvider}
                {...(intents.providerSetup === undefined
                  ? {}
                  : { providerSetup: { ...intents.providerSetup, signIns: data.signIns } })}
              />
              <ConnectorsSection
                connectors={data.connectors}
                onOpen={() =>
                  intents.openConnectors({ at: { _tag: "home" }, forBot: null, suggestion: null })
                }
              />
              <UsageSection
                engine={data.engine}
                engineStale={data.engineStale}
                recent={data.recentTurns}
                roster={data.roster}
                onLoadMore={intents.loadMoreTurns}
                onRetry={intents.retryTurns}
              />
              <DevicesSection
                devices={data.devices}
                connected={data.connected}
                onStartPairing={intents.startPairing}
                onRevoke={intents.revokeDevice}
              />
              <BotBrowserSection connected={data.connected} onSignOut={intents.signOutBrowser} />
              {(intents.server !== undefined || intents.local !== undefined) && (
                <WhereSection server={intents.server} local={intents.local} />
              )}
              {(intents.serverUpdate !== undefined || intents.update !== undefined) && (
                <UpdatesSection
                  server={intents.serverUpdate}
                  app={intents.update}
                  local={intents.local}
                />
              )}
              <BrowserSection
                onSignOut={intents.signOut}
                desktop={intents.server !== undefined || intents.local !== undefined}
                local={intents.local !== undefined}
                unencrypted={data.signInUnencrypted}
                shortcut={intents.shortcut}
              />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/**
 * Whether the engine runs, and if not, why and what to do; then each provider.
 * Disconnected, it is what the server last reported, muted and said to be so.
 * While the server runs on this computer (`providerSetup`), also where it
 * finds each harness, and the providers sign in from here.
 */
export function EngineSection({
  engine,
  stale,
  onRecheck,
  providerSetup,
}: {
  engine: EngineStatus | null;
  stale: boolean;
  onRecheck: Recheck;
  providerSetup?: LocalProviderSetup;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (engine === null) {
    return (
      <Section title={t("settings.engine")}>
        <SkeletonRows />
      </Section>
    );
  }
  const problem = engineProblem(engine, i18n);
  return (
    <Section title={t("settings.engine")}>
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
      {engine.providers.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {engine.providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              place={providerSetup === undefined ? "server" : "this-computer"}
              onRecheck={onRecheck}
              stale={stale}
            />
          ))}
        </ul>
      )}
      {providerSetup !== undefined && (
        <HarnessLocations setup={providerSetup} findings={engineFindings(engine)} />
      )}
      {!stale &&
        (providerSetup !== undefined && connectCommand(engine) !== null ? (
          <LocalSignIn
            setup={providerSetup}
            fallback={<ConnectProviders engine={engine} />}
            findings={engineFindings(engine)}
          />
        ) : (
          <ConnectProviders engine={engine} />
        ))}
    </Section>
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
    <Section title={t("settings.connectors")}>
      <p className="text-sm text-muted-foreground">{t("settings.connectors.hint")}</p>
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
  const { t } = useI18n();
  return (
    <Section title={t("settings.you")}>
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
      <Section title={t("settings.notifications")}>
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
    <Section title={t("settings.notifications")}>
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
    <Section title={t("settings.devices")}>
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
          {pairing._tag === "started" && <PairingCodeShown offer={pairing} />}
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
 * link carries the first origin the offer lists unless the operator picks
 * another of them.
 */
function PairingCodeShown({ offer }: { offer: PairingOffer }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const addressId = useId();
  const [picked, setPicked] = useState<ServerOrigin | null>(null);
  // A new code may come with other addresses: the pick holds while it is one of them.
  const server =
    picked !== null && offer.origins.includes(picked) ? picked : (offer.origins[0] ?? null);
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
                  if (chosen !== undefined) setPicked(chosen);
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
  return (
    <Section title={t("settings.where")}>
      {local !== undefined ? (
        <>
          <div className="flex flex-col gap-0.5">
            <p className="text-sm">{t("settings.where.local")}</p>
            <p className="text-2xs text-muted-foreground">{t("where.thisComputer.hint")}</p>
          </div>
          <StartWithSystem on={local.startWithSystem} onChange={local.setStartWithSystem} />
          <PhoneAccessSetting phone={local.phone} />
          <StopUsingComputer onStop={local.stopUsing} />
        </>
      ) : (
        server !== undefined && (
          <>
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
          </>
        )
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
}: {
  server: RemoteServerUpdate | undefined;
  app: DesktopUpdate | undefined;
  /** The bots on this computer, in local mode. */
  local: DesktopLocal | undefined;
}) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.about")}>
      {server !== undefined && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium">{t("serverUpdate.title")}</h4>
          <ServerUpdateRow update={server} />
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

/**
 * Choices kept in this browser only, and signing this device out. In the
 * `desktop` app, the same for this device, with its global `shortcut`, and
 * that its sign-in is stored
 * `unencrypted` when it is, as that is less safe than the operator would
 * expect. In `local` mode, signing out is stopping using this computer, in
 * the section above: there is no other server to sign in to.
 */
function BrowserSection({
  onSignOut,
  desktop,
  local,
  unencrypted,
  shortcut,
}: {
  onSignOut: SettingsIntents["signOut"];
  desktop: boolean;
  local: boolean;
  unencrypted: boolean;
  shortcut: DesktopShortcut | undefined;
}) {
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
    <Section title={t(desktop ? "settings.thisDevice" : "settings.browser")}>
      {shortcut !== undefined && <ShortcutSetting shortcut={shortcut} />}
      <div className="flex flex-col gap-1.5">
        <span id={appearanceId} className="text-xs">
          {t("settings.appearance")}
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
      {(unencrypted || !local) && (
        <div className="flex flex-col gap-1.5 pt-1">
          {unencrypted && (
            <p className="text-xs text-muted-foreground">{t("settings.thisDevice.unencrypted")}</p>
          )}
          {!local && (
            <>
              <p className="text-xs text-muted-foreground">{t("settings.signOut.hint")}</p>
              <SignOutDevice onSignOut={onSignOut} />
            </>
          )}
        </div>
      )}
    </Section>
  );
}
