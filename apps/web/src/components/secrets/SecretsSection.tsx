// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure, SecretsResult } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { activityTime, secretsStateText } from "@j3-bots/client-runtime/wording";
import {
  type Secret,
  type SecretAccess,
  type SecretField as Field,
  type SecretId,
  type TotpPreview,
  MAX_SECRET_NAME_LENGTH,
  secretReference,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useBots, useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { Section } from "../SettingsSection";
import { Button } from "../ui/button";
import { Confirm } from "../ui/confirm";
import { textField } from "../ui/field";
import { Segmented } from "../ui/segmented";
import { SkeletonRows } from "../ui/skeleton";
import { type DraftProblem, editChanges, newSecret } from "./drafts";
import {
  AccessPicker,
  asCode,
  MAX_LENGTH,
  Problem,
  SecretField,
  type SecretsAccess,
  Sentence,
  SwitchLine,
  useAccessText,
  useSecretsFailureText,
} from "./parts";
import { hideShownLater } from "./shown";

/** Runs one request at a time, saying how its last run failed. */
function useRequest() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const run = <A,>(request: () => Promise<SecretsResult<A>>, onDone?: (value: A) => void) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    void request().then(
      (result) => {
        setBusy(false);
        if (result._tag === "failed") setFailure(result.failure);
        else onDone?.(result.value);
      },
      () => {
        setBusy(false);
        setFailure({ _tag: "unexpected" });
      },
    );
  };
  return { busy, failure, run };
}

type Screen =
  | { readonly _tag: "list" }
  | { readonly _tag: "add" }
  | { readonly _tag: "secret"; readonly id: SecretId };

/**
 * Settings' Secrets page: what stands in the way while secrets cannot be used,
 * and otherwise every secret, with a page for each and a way to add one.
 * Values show only on request, for a while, and the server records each
 * time one is shown.
 */
export function SecretsSection({ secrets }: { readonly secrets: SecretsAccess }) {
  const i18n = useI18n();
  const failureText = useSecretsFailureText();
  const [screen, setScreen] = useState<Screen>({ _tag: "list" });
  const { view } = secrets;
  const list = () => setScreen({ _tag: "list" });

  const body = () => {
    if (view._tag === "loading") return <SkeletonRows />;
    const blocked = secretsStateText(view.status, i18n);
    if (blocked !== null) return <p className="text-sm text-muted-foreground">{blocked}</p>;
    if (view.listFailure !== null) {
      return (
        <p role="alert" className="text-sm text-blocked">
          {failureText(view.listFailure)}
        </p>
      );
    }
    if (view.secrets === null) return <SkeletonRows />;
    if (screen._tag === "add")
      return <SecretEditor secrets={secrets} secret={null} onDone={list} />;
    if (screen._tag === "secret") {
      const shown = view.secrets.find((secret) => secret.id === screen.id);
      // Deleted elsewhere: the list shows it is gone.
      if (shown !== undefined) {
        return <SecretPage key={shown.id} secret={shown} secrets={secrets} onBack={list} />;
      }
    }
    return (
      <SecretList
        list={view.secrets}
        onOpen={(id) => setScreen({ _tag: "secret", id })}
        onAdd={() => setScreen({ _tag: "add" })}
      />
    );
  };

  return <Section>{body()}</Section>;
}

/** What a secret is, in a line: "Value", or "Login" and its sites. */
function useKindText(): (secret: Secret) => string {
  const { t } = useI18n();
  return ({ kind }) =>
    kind._tag === "value"
      ? t("secrets.kind.value")
      : `${t("secrets.kind.login")} · ${kind.origins.join(", ")}`;
}

/** When a bot last used the secret, and which one while it is still here. */
function useLastUsedText(): (secret: Secret) => string {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  return ({ lastUse }) => {
    if (lastUse === null) return t("secrets.neverUsed");
    const when = activityTime(lastUse.at, ctx);
    const bot = bots.get(lastUse.botId);
    return bot === undefined
      ? t("secrets.lastUsedBy", { when })
      : t("secrets.lastUsed", { name: bot.profile.name, when });
  };
}

function SecretList({
  list,
  onOpen,
  onAdd,
}: {
  readonly list: ReadonlyArray<Secret>;
  readonly onOpen: (id: SecretId) => void;
  readonly onAdd: () => void;
}) {
  const { t, plural } = useI18n();
  const kindText = useKindText();
  const accessText = useAccessText();
  const lastUsedText = useLastUsedText();
  return (
    <>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("secrets.empty")}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{plural("secrets.count", list.length)}</p>
          <ul className="-mx-2 flex flex-col">
            {list.map((secret) => (
              <li key={secret.id}>
                <button
                  type="button"
                  onClick={() => onOpen(secret.id)}
                  className="flex w-full min-w-0 flex-col items-start rounded-lg px-2 py-2 text-start hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="font-mono text-sm font-medium break-all">{secret.name}</span>
                  <span className="text-xs break-all text-muted-foreground">
                    {kindText(secret)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {accessText(secret.access)} · {lastUsedText(secret)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div>
        <Button size="sm" onClick={onAdd}>
          {t("secrets.add")}
        </Button>
      </div>
    </>
  );
}

/** One secret: how bots use it, its values on request, who may use it, and changing or deleting it. */
function SecretPage({
  secret,
  secrets,
  onBack,
}: {
  readonly secret: Secret;
  readonly secrets: SecretsAccess;
  readonly onBack: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const kindText = useKindText();
  const lastUsedText = useLastUsedText();
  const failureText = useSecretsFailureText();
  const [editing, setEditing] = useState(false);
  const removal = useRequest();
  const fields: ReadonlyArray<Field> =
    secret.kind._tag === "value"
      ? ["value"]
      : secret.kind.hasTotp
        ? ["username", "password", "totp"]
        : ["username", "password"];
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost-muted" className="self-start" onClick={onBack}>
        <ChevronLeftIcon aria-hidden />
        {t("secrets.back")}
      </Button>
      <div className="flex min-w-0 flex-col">
        <h4 className="font-mono text-sm font-medium break-all">{secret.name}</h4>
        <span className="text-xs break-all text-muted-foreground">{kindText(secret)}</span>
        <span className="text-xs text-muted-foreground">
          <Sentence
            parts={ctx.i18n.parts("secrets.reference", {
              reference: asCode(secretReference(secret.name)),
            })}
          />
        </span>
      </div>
      {editing ? (
        <SecretEditor secrets={secrets} secret={secret} onDone={() => setEditing(false)} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <h5 className="text-xs font-medium text-muted-foreground">{t("secrets.values")}</h5>
            {fields.map((field) => (
              <ShownValue key={field} id={secret.id} field={field} secrets={secrets} />
            ))}
            {secret.kind._tag === "login" && secret.kind.hasTotp && (
              <CodeNow id={secret.id} secrets={secrets} />
            )}
          </div>
          <AllowedBots secret={secret} secrets={secrets} />
          <div className="flex flex-col text-xs text-muted-foreground">
            <span>{lastUsedText(secret)}</span>
            {secret.lastReveal !== null && (
              <span>
                {t("secrets.lastShown", { when: activityTime(secret.lastReveal.at, ctx) })}
              </span>
            )}
          </div>
          <Problem>{removal.failure === null ? null : failureText(removal.failure)}</Problem>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              {t("secrets.edit")}
            </Button>
            <Confirm
              trigger={<Button size="sm" variant="destructive-outline" />}
              title={t("secrets.deleteTitle", { name: secret.name })}
              body={t("secrets.deleteBody")}
              cancel={t("secrets.cancel")}
              confirm={t("secrets.delete")}
              busy={removal.busy}
              onConfirm={() => removal.run(() => secrets.intents.remove(secret.id), onBack)}
            >
              {t("secrets.delete")}
            </Confirm>
          </div>
        </>
      )}
    </div>
  );
}

const fieldLabel = {
  value: "secrets.field.value",
  username: "secrets.field.username",
  password: "secrets.field.password",
  totp: "secrets.field.totp",
} as const satisfies Record<Field, string>;

/**
 * One value of a secret, hidden until asked for. Shown, it goes after a
 * while (`hideShownLater`), as it does when the operator hides it, the page
 * is hidden, or the page of the secret goes away with Settings.
 */
function ShownValue({
  id,
  field,
  secrets,
}: {
  readonly id: SecretId;
  readonly field: Field;
  readonly secrets: SecretsAccess;
}) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const [value, setValue] = useState<Redacted.Redacted<string> | null>(null);
  // What the last Copy did: copied, or, where the page has no clipboard (plain
  // HTTP on the local network) or the browser refused, selected to copy by hand.
  const [copied, setCopied] = useState<"copied" | "selected" | null>(null);
  const shownRef = useRef<HTMLElement>(null);
  const reveal = useRequest();
  useEffect(() => {
    if (value === null) return;
    const stop = hideShownLater(() => setValue(null), document);
    return () => {
      stop();
      setCopied(null);
    };
  }, [value]);
  useEffect(() => {
    if (copied !== "copied") return;
    const settle = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(settle);
  }, [copied]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs text-muted-foreground">{t(fieldLabel[field])}</span>
      <span className="flex min-w-0 items-center gap-1">
        {value !== null && (
          <code
            ref={shownRef}
            className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
          >
            {Redacted.value(value)}
          </code>
        )}
        {reveal.failure !== null && (
          <span className="text-xs text-blocked">{failureText(reveal.failure)}</span>
        )}
        {value !== null && (
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() =>
              void secrets.intents.copy(value).then((done) => {
                if (done) return setCopied("copied");
                if (shownRef.current) window.getSelection()?.selectAllChildren(shownRef.current);
                setCopied("selected");
              })
            }
          >
            {copied === "copied" ? t("secrets.copied") : t("secrets.copy")}
          </Button>
        )}
        {value !== null && copied === "selected" && (
          <span role="status" className="text-xs text-muted-foreground">
            {t("secrets.selected")}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost-muted"
          aria-disabled={reveal.busy}
          onClick={() => {
            if (value !== null) setValue(null);
            else reveal.run(() => secrets.intents.reveal(id, field), setValue);
          }}
        >
          {value === null ? t("secrets.show") : t("secrets.hide")}
        </Button>
      </span>
    </div>
  );
}

/** The login's one-time code now, to check it against the site's, until it is no longer valid. */
function CodeNow({ id, secrets }: { readonly id: SecretId; readonly secrets: SecretsAccess }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useSecretsFailureText();
  const [code, setCode] = useState<TotpPreview | null>(null);
  const preview = useRequest();
  const valid = code !== null && DateTime.isLessThan(ctx.now, code.validUntil);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span className="text-xs text-muted-foreground">{t("secrets.code")}</span>
      {valid ? (
        <span className="flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm tracking-widest">
            {Redacted.value(code.code)}
          </code>
          <span className="text-xs text-muted-foreground">
            {t("secrets.codeUntil", { time: clockTime(code.validUntil, ctx) })}
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          {preview.failure !== null && (
            <span className="text-xs text-blocked">{failureText(preview.failure)}</span>
          )}
          <Button
            size="sm"
            variant="ghost-muted"
            aria-disabled={preview.busy}
            onClick={() => preview.run(() => secrets.intents.totpPreview(id), setCode)}
          >
            {t("secrets.codeShow")}
          </Button>
        </span>
      )}
    </div>
  );
}

/** Which bots may use the secret, changed as soon as the operator changes it. */
function AllowedBots({
  secret,
  secrets,
}: {
  readonly secret: Secret;
  readonly secrets: SecretsAccess;
}) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const bots = [...useBots().values()];
  const titleId = useId();
  const change = useRequest();
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-1">
      <h5 id={titleId} className="text-xs font-medium text-muted-foreground">
        {t("secrets.bots")}
      </h5>
      <AccessPicker
        bots={bots}
        access={secret.access}
        disabled={change.busy}
        onChange={(access) => change.run(() => secrets.intents.setAccess(secret.id, access))}
      />
      <Problem>{change.failure === null ? null : failureText(change.failure)}</Problem>
    </div>
  );
}

type Kind = "login" | "value";

/** What a field the operator must fix says. */
const problemKey = {
  name: "secrets.nameInvalid",
  sites: "secrets.siteInvalid",
  password: "secrets.passwordRequired",
  value: "secrets.valueRequired",
} as const satisfies Record<DraftProblem, string>;

/**
 * Adds a secret, or changes one (`secret`). Changing, the values left empty
 * keep what the secret has; a login's one-time code key can be removed.
 */
function SecretEditor({
  secrets,
  secret,
  onDone,
}: {
  readonly secrets: SecretsAccess;
  readonly secret: Secret | null;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const failureText = useSecretsFailureText();
  const bots = [...useBots().values()];
  const kindId = useId();
  const sitesId = useId();
  const sitesHintId = useId();
  const botsId = useId();
  const problemId = useId();
  const [kind, setKind] = useState<Kind>(secret?.kind._tag ?? "login");
  const [name, setName] = useState<string>(secret?.name ?? "");
  const [sites, setSites] = useState(
    secret?.kind._tag === "login" ? secret.kind.origins.join("\n") : "",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [value, setValue] = useState("");
  const [access, setAccess] = useState<SecretAccess>({ _tag: "bots", botIds: [] });
  const [tried, setTried] = useState<DraftProblem | null>(null);
  const { busy, failure, run } = useRequest();
  const hasTotp = secret?.kind._tag === "login" && secret.kind.hasTotp;
  const login = kind === "login";

  const submit = () => {
    const typed = { name, sites, username, password, totp, removeTotp, value };
    if (secret === null) {
      const added = newSecret(login, typed, access);
      setTried(added._tag === "invalid" ? added.problem : null);
      if (added._tag === "ready") run(() => secrets.intents.add(added.value, null), onDone);
      return;
    }
    const changes = editChanges(login, typed);
    setTried(changes._tag === "invalid" ? changes.problem : null);
    if (changes._tag === "ready")
      run(() => secrets.intents.update(secret.id, changes.value), onDone);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {secret === null ? (
        <div className="flex flex-col gap-1">
          <span id={kindId} className="text-xs font-medium">
            {t("secrets.add")}
          </span>
          <Segmented
            value={kind}
            onChange={setKind}
            labelledBy={kindId}
            options={[
              { value: "login", label: t("secrets.kind.login") },
              { value: "value", label: t("secrets.kind.value") },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t(login ? "secrets.kind.loginHint" : "secrets.kind.valueHint")}
          </p>
        </div>
      ) : (
        <h5 className="text-sm font-medium">{t("secrets.editTitle", { name: secret.name })}</h5>
      )}
      <SecretField
        label={t("secrets.name")}
        hint={t("secrets.nameHint")}
        value={name}
        onChange={setName}
        mono
        maxLength={MAX_SECRET_NAME_LENGTH}
        invalid={tried === "name"}
        describedBy={problemId}
      />
      {login ? (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={sitesId} className="text-xs font-medium">
              {t("secrets.sites")}
            </label>
            <textarea
              id={sitesId}
              value={sites}
              rows={2}
              spellCheck={false}
              aria-invalid={tried === "sites"}
              aria-describedby={`${sitesHintId} ${problemId}`}
              onChange={(event) => setSites(event.currentTarget.value)}
              className={cn(textField, "py-2")}
            />
            <p id={sitesHintId} className="text-xs text-muted-foreground">
              {t("secrets.sitesHint")}
            </p>
          </div>
          <SecretField
            label={t("secrets.field.username")}
            hint={secret === null ? undefined : t("secrets.keepUsername")}
            value={username}
            onChange={setUsername}
            mono
            maxLength={MAX_LENGTH.username}
          />
          <SecretField
            label={t("secrets.field.password")}
            hint={secret === null ? undefined : t("secrets.keepPassword")}
            value={password}
            onChange={setPassword}
            masked
            maxLength={MAX_LENGTH.password}
            invalid={tried === "password"}
            describedBy={problemId}
          />
          {!removeTotp && (
            <SecretField
              label={t("secrets.field.totp")}
              hint={hasTotp ? t("secrets.keepTotp") : t("ask.totpHint")}
              value={totp}
              onChange={setTotp}
              masked
              maxLength={MAX_LENGTH.totp}
            />
          )}
          {hasTotp && (
            <SwitchLine
              label={t("secrets.removeTotp")}
              checked={removeTotp}
              onChange={setRemoveTotp}
            />
          )}
        </>
      ) : (
        <SecretField
          label={t("secrets.field.value")}
          hint={secret === null ? t("ask.valueHint") : t("secrets.keepValue")}
          value={value}
          onChange={setValue}
          masked
          maxLength={MAX_LENGTH.value}
          invalid={tried === "value"}
          describedBy={problemId}
        />
      )}
      {secret === null && (
        <div role="group" aria-labelledby={botsId} className="flex flex-col gap-1">
          <span id={botsId} className="text-xs font-medium">
            {t("secrets.bots")}
          </span>
          <AccessPicker bots={bots} access={access} onChange={setAccess} />
        </div>
      )}
      <Problem id={problemId}>
        {tried !== null ? t(problemKey[tried]) : failure === null ? null : failureText(failure)}
      </Problem>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone}>
          {t("secrets.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy}>
          {t("secrets.save")}
        </Button>
      </div>
    </form>
  );
}
