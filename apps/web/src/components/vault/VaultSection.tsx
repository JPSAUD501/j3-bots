// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure, VaultResult } from "@j3-bots/client-runtime";
import { clockTime, typedOrigins } from "@j3-bots/client-runtime/presentation";
import { activityTime } from "@j3-bots/client-runtime/wording";
import {
  type BotId,
  type Credential,
  type CredentialDraft,
  CredentialDraft as CredentialDraftSchema,
  type CredentialField,
  CredentialOrigins,
  type CredentialId,
  MAX_LABEL_LENGTH,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { useEffect, useId, useState } from "react";
import { useBots, useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { Section } from "../SettingsSection";
import { Button } from "../ui/button";
import { Confirm } from "../ui/confirm";
import { lineField, textField } from "../ui/field";
import { SkeletonRows } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import {
  ChangePasswordForm,
  PasswordField,
  useVaultFailureText,
  type VaultAccess,
  VaultGate,
} from "./VaultForms";

/** How long a value shown stays on screen, in ms. */
const SHOWN_FOR = 30_000;

const decodeDraft = Schema.decodeUnknownOption(CredentialDraftSchema);

/**
 * The vault in Settings: its state, locking it, its password, and every saved
 * login with what can be done to one. Values show only on request, for a
 * while, and the server records each time one is shown.
 */
export function VaultSection({ vault }: { readonly vault: VaultAccess }) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const { view, intents } = vault;
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const [adding, setAdding] = useState(false);
  const unlocked = view._tag === "ready" && view.status.state === "unlocked";
  const state =
    view._tag === "ready" && (view.status.state === "locked" || view.status.state === "unlocked")
      ? view.status.state
      : null;
  return (
    <Section>
      {state !== null && (
        <div className="flex items-center justify-between gap-3">
          <span
            className={cn(
              "flex items-center gap-2 text-sm font-medium",
              state === "unlocked" ? "text-success" : "text-muted-foreground",
            )}
          >
            <span aria-hidden className="size-2 rounded-full bg-current" />
            {t(state === "unlocked" ? "vault.state.unlocked" : "vault.state.locked")}
          </span>
          {unlocked && (
            <Button size="sm" onClick={() => void intents.lock()}>
              {t("vault.lock")}
            </Button>
          )}
        </div>
      )}
      <VaultGate vault={vault} />
      {view._tag === "ready" && unlocked && (
        <>
          {changing ? (
            <ChangePasswordForm
              intents={intents}
              onCancel={() => setChanging(false)}
              onDone={() => {
                setChanging(false);
                setChanged(true);
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p role="status" className="text-xs text-muted-foreground">
                {changed ? t("vault.changed") : null}
              </p>
              <Button
                size="sm"
                variant="ghost-muted"
                onClick={() => {
                  setChanged(false);
                  setChanging(true);
                }}
              >
                {t("vault.changePassword")}
              </Button>
            </div>
          )}
          <h4 className="mt-2 text-sm font-medium">{t("vault.logins")}</h4>
          {view.listFailure !== null ? (
            <p role="alert" className="text-sm text-blocked">
              {failureText(view.listFailure)}
            </p>
          ) : view.credentials === null ? (
            <SkeletonRows />
          ) : view.credentials.length === 0 && !adding ? (
            <p className="text-sm text-muted-foreground">{t("vault.empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {view.credentials.map((credential) => (
                <CredentialRow key={credential.id} credential={credential} vault={vault} />
              ))}
            </ul>
          )}
          {adding ? (
            <CredentialEditor vault={vault} credential={null} onDone={() => setAdding(false)} />
          ) : (
            <div>
              <Button size="sm" onClick={() => setAdding(true)}>
                {t("vault.add")}
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** One saved login: its name and sites, then what can be done to it. */
function CredentialRow({
  credential,
  vault,
}: {
  readonly credential: Credential;
  readonly vault: VaultAccess;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fields: ReadonlyArray<CredentialField> = credential.hasTotp
    ? ["username", "password", "totp"]
    : ["username", "password"];
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{credential.name}</span>
          <span className="text-xs break-all text-muted-foreground">
            {credential.origins.join(" · ")}
          </span>
          {credential.lastReveal !== null && (
            <span className="text-xs text-muted-foreground">
              {t("vault.lastShown", { when: activityTime(credential.lastReveal.at, ctx) })}
            </span>
          )}
        </div>
        <span className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost-muted" onClick={() => setEditing((now) => !now)}>
            {t("vault.edit")}
          </Button>
          <Confirm
            trigger={<Button size="sm" variant="ghost-muted" />}
            title={t("vault.deleteTitle", { name: credential.name })}
            body={t("vault.deleteBody")}
            cancel={t("vault.cancel")}
            confirm={t("vault.delete")}
            busy={deleting}
            onConfirm={() => {
              setDeleting(true);
              void vault.intents.remove(credential.id).finally(() => setDeleting(false));
            }}
          >
            {t("vault.delete")}
          </Confirm>
        </span>
      </div>
      {fields.map((field) => (
        <ShownValue key={field} id={credential.id} field={field} vault={vault} />
      ))}
      {credential.hasTotp && <CodeNow id={credential.id} vault={vault} />}
      <AllowedBots credential={credential} vault={vault} />
      {editing && (
        <CredentialEditor vault={vault} credential={credential} onDone={() => setEditing(false)} />
      )}
    </li>
  );
}

const fieldLabel = {
  username: "vault.field.username",
  password: "vault.field.password",
  totp: "vault.field.totp",
} as const;

/**
 * One value of a login, hidden until asked for. Shown, it stays for
 * `SHOWN_FOR` and then goes, as it does when the operator hides it, the
 * page is hidden, or the row goes away with Settings.
 */
function ShownValue({
  id,
  field,
  vault,
}: {
  readonly id: CredentialId;
  readonly field: CredentialField;
  readonly vault: VaultAccess;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const [value, setValue] = useState<Redacted.Redacted<string> | null>(null);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (value === null) return;
    const hide = window.setTimeout(() => setValue(null), SHOWN_FOR);
    // Like leaving Settings, leaving the page hides it.
    const hidden = () => {
      if (document.visibilityState === "hidden") setValue(null);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearTimeout(hide);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [value]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs text-muted-foreground">{t(fieldLabel[field])}</span>
      <span className="flex min-w-0 items-center gap-1">
        {value !== null && (
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {Redacted.value(value)}
          </code>
        )}
        {failure !== null && <span className="text-xs text-blocked">{failureText(failure)}</span>}
        {value !== null && (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() =>
              void navigator.clipboard.writeText(Redacted.value(value)).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? t("vault.copied") : t("vault.copy")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() => {
            if (value !== null) {
              setValue(null);
              return;
            }
            setFailure(null);
            void vault.intents.reveal(id, field).then((result) => {
              if (result._tag === "done") setValue(result.value);
              else setFailure(result.failure);
            });
          }}
        >
          {value === null ? t("vault.show") : t("vault.hide")}
        </Button>
      </span>
    </div>
  );
}

/** The login's one-time code now, to check it against the site's, until it is no longer valid. */
function CodeNow({ id, vault }: { readonly id: CredentialId; readonly vault: VaultAccess }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [code, setCode] = useState<{
    readonly code: Redacted.Redacted<string>;
    readonly validUntil: DateTime.Utc;
  } | null>(null);
  const valid = code !== null && DateTime.isLessThan(ctx.now, code.validUntil);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{t("vault.code")}</span>
      {valid ? (
        <span className="flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm tracking-widest">
            {Redacted.value(code.code)}
          </code>
          <span className="text-xs text-muted-foreground">{clockTime(code.validUntil, ctx)}</span>
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() =>
            void vault.intents.totpPreview(id).then((result) => {
              if (result._tag === "done") setCode(result.value);
            })
          }
        >
          {t("vault.codeShow")}
        </Button>
      )}
    </div>
  );
}

/** Which bots may use the login: none until the operator allows one. */
function AllowedBots({
  credential,
  vault,
}: {
  readonly credential: Credential;
  readonly vault: VaultAccess;
}) {
  const { t } = useI18n();
  const bots = useBots();
  if (bots.size === 0) return null;
  const allowed = new Set<BotId>(credential.allowedBots);
  const toggle = (botId: BotId, on: boolean) => {
    const next = on
      ? [...credential.allowedBots, botId]
      : credential.allowedBots.filter((id) => id !== botId);
    void vault.intents.setAllowedBots(credential.id, next);
  };
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs text-muted-foreground">{t("vault.bots")}</legend>
      {[...bots.values()].map((bot) => (
        <BotSwitch
          key={bot.id}
          name={bot.profile.name}
          checked={allowed.has(bot.id)}
          onChange={(on) => toggle(bot.id, on)}
        />
      ))}
      <p className="text-xs text-muted-foreground">{t("vault.botsHint")}</p>
    </fieldset>
  );
}

function BotSwitch({
  name,
  checked,
  onChange,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {name}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Adds a login, or changes one (`credential`). Changing, the values left
 * empty keep what the login has; its one-time code key can be removed.
 */
function CredentialEditor({
  vault,
  credential,
  onDone,
}: {
  readonly vault: VaultAccess;
  readonly credential: Credential | null;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const nameId = useId();
  const sitesId = useId();
  const sitesHintId = useId();
  const userId = useId();
  const totpId = useId();
  const problemId = useId();
  const [name, setName] = useState<string>(credential?.name ?? "");
  const [sites, setSites] = useState(credential?.origins.join("\n") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const origins = typedOrigins(sites);
  const editing = credential !== null;

  const settle = (result: VaultResult<unknown>) => {
    setBusy(false);
    if (result._tag === "failed") setFailure(result.failure);
    else onDone();
  };

  const submit = () => {
    setTried(true);
    if (busy || Option.isNone(origins) || name.trim() === "") return;
    const typedTotp = totp.trim() === "" ? null : Redacted.make(totp.trim());
    if (!editing) {
      const draft: Option.Option<CredentialDraft> = decodeDraft({
        name: name.trim(),
        origins: origins.value,
        username: Redacted.make(username),
        password: Redacted.make(password),
        totp: typedTotp,
      });
      if (Option.isNone(draft)) return;
      setBusy(true);
      setFailure(null);
      void vault.intents.save({ ...draft.value, allowedBots: [] }, null).then(settle);
      return;
    }
    const changes = decodeChanges({
      name: name.trim(),
      origins: origins.value,
      ...(username === "" ? {} : { username: Redacted.make(username) }),
      ...(password === "" ? {} : { password: Redacted.make(password) }),
      ...(removeTotp ? { totp: null } : typedTotp === null ? {} : { totp: typedTotp }),
    });
    if (Option.isNone(changes)) return;
    setBusy(true);
    setFailure(null);
    void vault.intents.update(credential.id, changes.value).then(settle);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs font-medium">
          {t("login.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={MAX_LABEL_LENGTH}
          autoComplete="off"
          aria-invalid={tried && name.trim() === ""}
          onChange={(event) => setName(event.currentTarget.value)}
          className={lineField}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={sitesId} className="text-xs font-medium">
          {t("vault.sites")}
        </label>
        <textarea
          id={sitesId}
          value={sites}
          rows={2}
          spellCheck={false}
          aria-invalid={tried && Option.isNone(origins)}
          aria-describedby={`${sitesHintId} ${problemId}`}
          onChange={(event) => setSites(event.currentTarget.value)}
          className={cn(textField, "py-2")}
        />
        <p id={sitesHintId} className="text-xs text-muted-foreground">
          {t("vault.sitesHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={userId} className="text-xs font-medium">
          {t("login.username")}
        </label>
        <input
          id={userId}
          value={username}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setUsername(event.currentTarget.value)}
          className={cn(lineField, "font-mono")}
        />
      </div>
      <PasswordField
        label={t("login.password")}
        value={password}
        onChange={setPassword}
        autoComplete="off"
        invalid={tried && !editing && password === ""}
      />
      {editing && <p className="-mt-2 text-xs text-muted-foreground">{t("vault.keepPassword")}</p>}
      {!removeTotp && (
        <div className="flex flex-col gap-1">
          <label htmlFor={totpId} className="text-xs font-medium">
            {t("login.totp")}
          </label>
          <input
            id={totpId}
            type="password"
            value={totp}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTotp(event.currentTarget.value)}
            className={cn(lineField, "font-mono")}
          />
          <p className="text-xs text-muted-foreground">
            {editing && credential.hasTotp ? t("vault.keepTotp") : t("login.totpHint")}
          </p>
        </div>
      )}
      {editing && credential.hasTotp && (
        <BotSwitch name={t("vault.removeTotp")} checked={removeTotp} onChange={setRemoveTotp} />
      )}
      <p id={problemId} role="alert" className="text-xs text-blocked empty:hidden">
        {tried && Option.isNone(origins)
          ? t("login.siteInvalid")
          : failure === null
            ? null
            : failureText(failure)}
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone}>
          {t("vault.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy}>
          {t("vault.save")}
        </Button>
      </div>
    </form>
  );
}

const decodeChanges = Schema.decodeUnknownOption(
  Schema.Struct({
    name: CredentialDraftSchema.fields.name,
    origins: CredentialOrigins,
    username: Schema.optionalKey(CredentialDraftSchema.fields.username),
    password: Schema.optionalKey(CredentialDraftSchema.fields.password),
    totp: Schema.optionalKey(CredentialDraftSchema.fields.totp),
  }),
);
