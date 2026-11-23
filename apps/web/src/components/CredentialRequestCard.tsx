// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure } from "@j3-bots/client-runtime";
import {
  type CredentialDraft,
  CredentialDraft as CredentialDraftSchema,
  type CredentialRequestEntry,
  type SiteOrigin,
  siteOriginOf,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { LockKeyholeIcon } from "lucide-react";
import { useId, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { type FocusWatch, useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "./CardFrame";
import { Button } from "./ui/button";
import { lineField } from "./ui/field";
import { Switch } from "./ui/switch";
import {
  PasswordField,
  useVaultFailureText,
  type VaultAccess,
  VaultGate,
} from "./vault/VaultForms";

const decodeDraft = Schema.decodeUnknownOption(CredentialDraftSchema);

/** The host a site's origin names, as a login's first name. */
const hostOf = (origin: SiteOrigin) => new URL(origin).host;

interface CredentialRequestCardProps {
  readonly entry: CredentialRequestEntry;
  readonly vault: VaultAccess;
  readonly onDismiss: () => void;
  /** A dismissal is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking the operator to save a login in the vault. What the operator
 * types goes from this card straight to the vault, never to the bot, and is
 * gone from the page once saved. While the vault cannot take it, the card
 * offers its setup or unlock in place. Once saved or dismissed, here or
 * elsewhere, the card only says which.
 */
export function CredentialRequestCard({
  entry,
  vault,
  onDismiss,
  submitting = false,
}: CredentialRequestCardProps) {
  const { t } = useI18n();
  const outcomeId = useId();
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;
  const bots = useBots();
  const botName = (botId === null ? undefined : bots.get(botId))?.profile.name ?? t("bot.unknown");
  const pending = entry.status._tag === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  const unlocked = vault.view._tag === "ready" && vault.view.status.state === "unlocked";

  return (
    <CardFrame
      ref={target}
      icon={<LockKeyholeIcon />}
      title={t("login.title")}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium break-all">{entry.origin}</p>
        {entry.note !== "" && <p className="text-sm text-muted-foreground">{entry.note}</p>}
      </div>
      {entry.status._tag === "pending" ? (
        unlocked ? (
          <LoginForm
            entry={entry}
            vault={vault}
            botName={botName}
            canAllow={botId !== null}
            onDismiss={onDismiss}
            submitting={submitting}
            focusWatch={actions}
          />
        ) : (
          <div className="flex flex-col gap-3" {...actions}>
            <VaultGate vault={vault} />
            <div className="flex justify-end">
              <Button
                size="sm"
                aria-disabled={submitting}
                onClick={() => {
                  if (!submitting) onDismiss();
                }}
              >
                {t("login.dismiss")}
              </Button>
            </div>
          </div>
        )
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {entry.status._tag === "saved"
            ? t("login.saved", { name: entry.status.name })
            : t("login.dismissed")}
        </p>
      )}
    </CardFrame>
  );
}

/** The login's fields and actions. Unmounted with the request, taking what was typed with it. */
function LoginForm({
  entry,
  vault,
  botName,
  canAllow,
  onDismiss,
  submitting,
  focusWatch,
}: {
  readonly entry: CredentialRequestEntry;
  readonly vault: VaultAccess;
  readonly botName: string;
  readonly canAllow: boolean;
  readonly onDismiss: () => void;
  readonly submitting: boolean;
  readonly focusWatch: FocusWatch;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const siteId = useId();
  const nameId = useId();
  const userId = useId();
  const totpId = useId();
  const totpHintId = useId();
  const problemId = useId();
  const allowId = useId();
  const [site, setSite] = useState<string>(entry.origin);
  const [name, setName] = useState(() => hostOf(entry.origin));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [allow, setAllow] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);

  const origin = siteOriginOf(site);
  const draft: Option.Option<CredentialDraft> = Option.flatMap(origin, (found) =>
    decodeDraft({
      name: name.trim(),
      origins: [found],
      username: Redacted.make(username),
      password: Redacted.make(password),
      totp: totp.trim() === "" ? null : Redacted.make(totp.trim()),
    }),
  );
  const busy = saving || submitting;
  const problem = !tried
    ? null
    : Option.isNone(origin)
      ? t("login.siteInvalid")
      : failure !== null
        ? failureText(failure)
        : null;
  const botId = entry.author._tag === "bot" ? entry.author.botId : null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (busy || Option.isNone(draft)) return;
        setSaving(true);
        setFailure(null);
        void vault.intents
          .save({ ...draft.value, allowedBots: allow && botId !== null ? [botId] : [] }, entry.id)
          .then(
            (result) => {
              setSaving(false);
              if (result._tag === "failed") setFailure(result.failure);
            },
            () => {
              setSaving(false);
              setFailure({ _tag: "unexpected" });
            },
          );
      }}
      {...focusWatch}
    >
      <div className="grid gap-3 tablet:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={siteId} className="text-xs font-medium">
            {t("login.site")}
          </label>
          <input
            id={siteId}
            value={site}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tried && Option.isNone(origin)}
            aria-describedby={problemId}
            onChange={(event) => setSite(event.currentTarget.value)}
            className={lineField}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-xs font-medium">
            {t("login.name")}
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={80}
            autoComplete="off"
            aria-invalid={tried && name.trim() === ""}
            onChange={(event) => setName(event.currentTarget.value)}
            className={lineField}
          />
        </div>
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
        invalid={tried && password === ""}
      />
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
          aria-describedby={totpHintId}
          onChange={(event) => setTotp(event.currentTarget.value)}
          className={cn(lineField, "font-mono")}
        />
        <p id={totpHintId} className="text-xs text-muted-foreground">
          {t("login.totpHint")}
        </p>
      </div>
      {canAllow && (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={allowId} className="text-sm">
            {t("login.allow", { name: botName })}
          </label>
          <Switch id={allowId} checked={allow} onCheckedChange={setAllow} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("login.unseen", { name: botName })}</p>
      <p id={problemId} role="alert" className="text-xs text-blocked empty:hidden">
        {problem}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onDismiss();
          }}
        >
          {t("login.dismiss")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          aria-disabled={busy || password === "" || name.trim() === ""}
        >
          {t("login.save")}
        </Button>
      </div>
    </form>
  );
}
