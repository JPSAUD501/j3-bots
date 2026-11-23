// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import {
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
import { clockTime } from "@j3-bots/client-runtime/presentation";
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
  DesktopServer,
  DesktopShortcut,
  DesktopUpdate,
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
import { AppUpdate } from "./AppUpdate";
import { ShortcutSetting } from "./ShortcutSetting";
import { ConnectProviders, ProviderRow } from "./EmptyStates";
import { ChangeServer } from "./ServerAddress";
import { PairingQr } from "./PairingQr";
import { Section } from "./SettingsSection";
import { SkeletonRows } from "./ui/skeleton";
import { UsageSection } from "./UsageSection";
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
  | "startPairing"
  | "revokeDevice"
  | "refreshSettings"
  | "refreshDevices"
  | "loadMoreTurns"
  | "retryTurns"
  | "signOut"
  | "server"
  | "update"
  | "shortcut"
>;

interface SettingsButtonProps {
  readonly data: Pick<
    ShellData,
    | "engine"
    | "engineStale"
    | "settings"
    | "settingsSaves"
    | "settingsOpen"
    | "devices"
    | "connected"
    | "roster"
    | "recentTurns"
    | "signInUnencrypted"
  >;
  readonly intents: SettingsIntents;
}

// The profile form's unsaved edits are held outside the dialog: Settings
// closed for the operator, as when a notification opens a conversation,
// keeps them; closing it themselves discards them.

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
          } else {
            profile.discard();
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
              <EngineSection engine={data.engine} stale={data.engineStale} />
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
              {intents.server !== undefined && <ServerSection server={intents.server} />}
              <BrowserSection
                onSignOut={intents.signOut}
                server={intents.server}
                unencrypted={data.signInUnencrypted}
                update={intents.update}
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
 */
function EngineSection({ engine, stale }: { engine: EngineStatus | null; stale: boolean }) {
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
          <p
            className={cn("text-sm font-medium", stale ? "text-muted-foreground" : "text-blocked")}
          >
            {problem.title}
          </p>
          <p className="text-sm text-muted-foreground">{problem.body}</p>
        </div>
      )}
      {engine.providers.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {engine.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} stale={stale} />
          ))}
        </ul>
      )}
      {!stale && <ConnectProviders engine={engine} />}
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

/** In the desktop app, the server it talks to, and leaving it for another. */
function ServerSection({ server }: { server: DesktopServer }) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.server")}>
      <p className="font-mono text-sm break-all">{server.address}</p>
      <ChangeServer
        address={server.address}
        onChange={server.forget}
        paired
        className="items-start"
      />
    </Section>
  );
}

/**
 * Choices kept in this browser only, and signing this device out. In the
 * desktop app, whose server is `server`, the same for this device, with the
 * app's version and its `update`, its global `shortcut`, and that its
 * sign-in is stored `unencrypted` when it is, as that is less safe than the
 * operator would expect.
 */
function BrowserSection({
  onSignOut,
  server,
  unencrypted,
  update,
  shortcut,
}: {
  onSignOut: SettingsIntents["signOut"];
  server: DesktopServer | undefined;
  unencrypted: boolean;
  update: DesktopUpdate | undefined;
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
    <Section title={t(server === undefined ? "settings.browser" : "settings.thisDevice")}>
      {update !== undefined && <AppUpdate update={update} className="items-start" />}
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
      <div className="flex flex-col gap-1.5 pt-1">
        {unencrypted && (
          <p className="text-xs text-muted-foreground">{t("settings.thisDevice.unencrypted")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("settings.signOut.hint")}</p>
        <SignOutDevice onSignOut={onSignOut} />
      </div>
    </Section>
  );
}
