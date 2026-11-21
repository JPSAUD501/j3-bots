// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type { SettingsSaves } from "@j3-bots/client-runtime";
import {
  type Device,
  type DeviceId,
  type EngineStatus,
  type NotificationSettingsChange,
  type PairingCode,
  type Settings,
} from "@j3-bots/contracts";
import type * as DateTime from "effect/DateTime";
import { SettingsIcon, XIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import type { KeyWith } from "../i18n/i18n";
import {
  setAppearance,
  setLanguage,
  usePreferences,
  type Appearance,
  type Language,
} from "../preferences/preferences";
import {
  requestNotificationAccess,
  useNotificationAccess,
  type NotificationAccess,
} from "../preferences/notifications";
import {
  editsAfterFailedSave,
  noEdits,
  settingsPatch,
  type SettingsEdits,
} from "../presentation/settings";
import type { ShellData, ShellIntents } from "../shell/data";
import { cn } from "../lib/cn";
import { activityTime, clockTime } from "../lib/time";
import { ConnectProviders, engineProblem, ProviderRow } from "./EmptyStates";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { Switch } from "./ui/switch";

type SettingsIntents = Pick<
  ShellIntents,
  | "updateSettings"
  | "setSettingsOpen"
  | "startPairing"
  | "revokeDevice"
  | "refreshSettings"
  | "refreshDevices"
  | "signOut"
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
  >;
  readonly intents: SettingsIntents;
}

/**
 * The profile form's unsaved edits, held outside the dialog: Settings closed
 * for the operator, as when a notification opens a conversation, keeps them;
 * closing it themselves discards them. A save of the form that ends saved
 * leaves nothing unsaved; one that failed leaves what it sent, so reopening
 * Settings never loses it.
 */
function useProfileEdits(save: SettingsSaves["profile"]) {
  const kept = () =>
    save._tag === "failed" ? editsAfterFailedSave(noEdits, save.changes) : noEdits;
  const [edits, setEdits] = useState(kept);
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save._tag === "saved") setEdits(noEdits);
    if (save._tag === "failed") setEdits((current) => editsAfterFailedSave(current, save.changes));
  }
  return { edits, setEdits, discard: () => setEdits(kept()) };
}

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
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup
            aria-labelledby={titleId}
            className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground outline-none transition-opacity duration-(--duration-slow) data-ending-style:opacity-0 data-starting-style:opacity-0 tablet:inset-x-4 tablet:top-12 tablet:bottom-12 tablet:mx-auto tablet:max-w-lg tablet:rounded-lg tablet:border tablet:border-border tablet:shadow-xl"
          >
            <header className="flex h-14 shrink-0 items-center border-b border-border ps-4 pe-2">
              <Dialog.Title id={titleId} className="text-sm font-medium">
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
              <EngineSection engine={data.engine} stale={data.engineStale} />
              <YouSection
                settings={data.settings}
                save={data.settingsSaves.profile}
                edits={profile.edits}
                onEdit={profile.setEdits}
                connected={data.connected}
                onSave={intents.updateSettings}
              />
              <NotificationsSection
                settings={data.settings}
                save={data.settingsSaves.notifications}
                connected={data.connected}
                onSave={intents.updateSettings}
              />
              <DevicesSection
                devices={data.devices}
                connected={data.connected}
                onStartPairing={intents.startPairing}
                onRevoke={intents.revokeDevice}
              />
              <BrowserSection onSignOut={intents.signOut} />
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Loading() {
  const { t } = useI18n();
  return <p className="text-xs text-muted-foreground">{t("details.loading")}</p>;
}

const fieldClass =
  "h-9 w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11";

/**
 * Whether the engine runs, and if not, why and what to do; then each provider.
 * Disconnected, it is what the server last reported, muted and said to be so.
 */
function EngineSection({ engine, stale }: { engine: EngineStatus | null; stale: boolean }) {
  const { t } = useI18n();
  if (engine === null) {
    return (
      <Section title={t("settings.engine")}>
        <Loading />
      </Section>
    );
  }
  const problem = engineProblem(engine, t);
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
      {settings === null ? <Loading /> : <YouForm settings={settings} {...form} />}
    </Section>
  );
}

interface YouFormProps {
  readonly settings: Settings;
  readonly save: SettingsSaves["profile"];
  /** What the operator changed and has not saved, kept by `useProfileEdits`. */
  readonly edits: SettingsEdits;
  readonly onEdit: (update: (edits: SettingsEdits) => SettingsEdits) => void;
  readonly connected: boolean;
  readonly onSave: SettingsIntents["updateSettings"];
}

/**
 * Saving needs the server: offline, Save says why it is unavailable. A save
 * sends only the fields the operator changed. While the form's save is under
 * way, even one started before Settings last closed, the form shows what it
 * sends and takes no edit. A field the operator left alone shows the saved
 * value as it arrives; one they changed keeps their edit until the form saves
 * it.
 */
function YouForm({ settings, save, edits, onEdit, connected, onSave }: YouFormProps) {
  const { t } = useI18n();
  const nameId = useId();
  const zoneId = useId();
  const offlineId = useId();
  // How a save ended shows only for one this form saw under way, until the next edit.
  const [watching, setWatching] = useState(save._tag === "saving");
  const saving = save._tag === "saving";
  const sending = saving ? save.changes : null;
  const name =
    edits.name ??
    (sending?.operatorName === undefined ? settings.operatorName : sending.operatorName) ??
    "";
  const zone = edits.zone ?? sending?.timeZone ?? settings.timeZone;
  const patch = settingsPatch(settings, edits);
  const status = watching && !saving ? save._tag : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (patch._tag !== "changes" || saving || !connected) return;
        setWatching(true);
        onSave({ section: "profile", changes: patch.changes });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs">
          {t("settings.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={200}
          autoComplete="name"
          placeholder={t("settings.name.placeholder")}
          readOnly={saving}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onEdit((current) => ({ ...current, name: value }));
            setWatching(false);
          }}
          className={fieldClass}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={zoneId} className="text-xs">
          {t("settings.timeZone")}
        </label>
        <select
          id={zoneId}
          value={zone}
          aria-readonly={saving}
          onChange={(event) => {
            if (saving) return;
            const value = event.currentTarget.value;
            onEdit((current) => ({ ...current, zone: value }));
            setWatching(false);
          }}
          className={fieldClass}
        >
          {timeZones(zone).map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <p className="text-2xs text-muted-foreground">{t("settings.timeZone.hint")}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          size="sm"
          aria-disabled={patch._tag !== "changes" || saving || !connected}
          aria-describedby={connected ? undefined : offlineId}
        >
          {t("settings.save")}
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {status === "saved" && t("settings.saved")}
          {status === "failed" && <span className="text-blocked">{t("settings.saveFailed")}</span>}
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
        <Loading />
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
  | { readonly _tag: "started"; readonly code: PairingCode; readonly expiresAt: DateTime.Utc }
  | { readonly _tag: "failed" };

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
        <Loading />
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
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">{t("settings.pair.instructions")}</p>
              <p className="font-mono text-lg tracking-wider">{shownCode(pairing.code)}</p>
              <p className="text-2xs text-muted-foreground">
                {t("settings.pair.expires", { time: clockTime(pairing.expiresAt, ctx) })}
              </p>
            </div>
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

/** Choices kept in this browser only, and signing this device out. */
function BrowserSection({ onSignOut }: { onSignOut: SettingsIntents["signOut"] }) {
  const { t } = useI18n();
  const { appearance, language } = usePreferences();
  const appearanceId = useId();
  const languageId = useId();
  const appearances: ReadonlyArray<{ value: Appearance; label: string }> = [
    { value: "system", label: t("settings.system") },
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
  ];
  // Each language is named in itself, so it can be found from any other.
  const languages: ReadonlyArray<{ value: Language; label: string }> = [
    { value: "system", label: t("settings.system") },
    { value: "en", label: "English" },
    { value: "pt-BR", label: "Português (Brasil)" },
  ];
  return (
    <Section title={t("settings.browser")}>
      <div className="flex flex-col gap-1">
        <label htmlFor={appearanceId} className="text-xs">
          {t("settings.appearance")}
        </label>
        <select
          id={appearanceId}
          value={appearance}
          onChange={(event) => {
            const picked = appearances.find((a) => a.value === event.currentTarget.value);
            if (picked) setAppearance(picked.value);
          }}
          className={fieldClass}
        >
          {appearances.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
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
          className={fieldClass}
        >
          {languages.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5 pt-1">
        <p className="text-xs text-muted-foreground">{t("settings.signOut.hint")}</p>
        <SignOutDevice onSignOut={onSignOut} />
      </div>
    </Section>
  );
}
