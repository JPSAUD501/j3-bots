// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure } from "@j3-bots/client-runtime";
import { secretsFailureText } from "@j3-bots/client-runtime/wording";
import { type SecretAskEntry, SecretName, secretReference } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { type FocusWatch, useFocusAfterActions } from "../lib/useFocusAfterActions";
import { CardFrame, useClosedHere } from "./CardFrame";
import { Button } from "./ui/button";
import { askedSecret, type DraftProblem } from "./secrets/drafts";
import {
  asCode,
  asText,
  MAX_LENGTH,
  Problem,
  SecretField,
  type SecretsAccess,
  secretsReady,
  Sentence,
  SwitchLine,
} from "./secrets/parts";

const decodeName = Schema.decodeUnknownOption(SecretName);

interface SecretAskCardProps {
  readonly entry: SecretAskEntry;
  readonly secrets: SecretsAccess;
  readonly onDecline: () => void;
  /** A decline is on its way: the card takes no second one. */
  readonly submitting?: boolean;
}

/**
 * A bot asking the operator for a secret: a login for a site, or a single
 * value. What the operator types goes from this card straight to their
 * secrets, never to the bot, and is gone from the page once saved. Once
 * saved, declined or expired, here or elsewhere, the card only says which.
 */
export function SecretAskCard({
  entry,
  secrets,
  onDecline,
  submitting = false,
}: SecretAskCardProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const outcomeId = useId();
  const bots = useBots();
  const botName = bots.get(entry.author.botId)?.profile.name ?? t("bot.unknown");
  const pending = entry.status._tag === "pending";
  const { target, actions } = useFocusAfterActions<HTMLElement>(pending);
  const { closedHere } = useClosedHere(pending);
  // A save-login card from before secrets may name its secret in a way no reference takes.
  const reference = Option.match(decodeName(entry.name), {
    onSome: secretReference,
    onNone: () => entry.name,
  });

  const outcome = () => {
    switch (entry.status._tag) {
      case "pending":
        return null;
      case "saved":
        return (
          <Sentence
            parts={i18n.parts("ask.saved", { secret: asCode(reference), name: asText(botName) })}
          />
        );
      case "declined":
        return t("ask.declined", { name: botName });
      case "expired":
        return t("ask.expired", { name: botName });
    }
  };

  return (
    <CardFrame
      ref={target}
      icon={<KeyRoundIcon />}
      title={t(entry.secret._tag === "login" ? "ask.title.login" : "ask.title.value", {
        name: botName,
      })}
      attention={pending}
      entryId={entry.id}
      describedBy={pending ? undefined : outcomeId}
    >
      {entry.note !== "" && <p className="text-sm text-muted-foreground">{entry.note}</p>}
      {pending ? (
        <>
          <p className="text-xs text-muted-foreground">
            <Sentence
              parts={i18n.parts("ask.savedAs", {
                secret: asCode(reference),
                name: asText(botName),
              })}
            />
          </p>
          {secrets.view._tag === "ready" && !secretsReady(secrets.view) ? (
            <div className="flex flex-col gap-3" {...actions}>
              <p className="text-sm text-muted-foreground">{t("ask.unavailable")}</p>
              <div className="flex justify-end">
                <DeclineButton busy={submitting} onDecline={onDecline} />
              </div>
            </div>
          ) : (
            <AskForm
              entry={entry}
              secrets={secrets}
              botName={botName}
              reference={reference}
              onDecline={onDecline}
              submitting={submitting}
              focusWatch={actions}
            />
          )}
        </>
      ) : (
        <p id={outcomeId} className={cn("text-xs text-muted-foreground", closedHere && "arrive")}>
          {outcome()}
        </p>
      )}
    </CardFrame>
  );
}

function DeclineButton({
  busy,
  onDecline,
}: {
  readonly busy: boolean;
  readonly onDecline: () => void;
}) {
  const { t } = useI18n();
  return (
    <Button
      size="sm"
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onDecline();
      }}
    >
      {t("ask.decline")}
    </Button>
  );
}

const problemKey = {
  name: "secrets.nameInvalid",
  sites: "secrets.siteInvalid",
  password: "ask.passwordRequired",
  value: "ask.valueRequired",
} as const satisfies Record<DraftProblem, string>;

/** Why saving failed, in a sentence: on a card, a name taken names the secret. */
function useAskFailureText(reference: string): (failure: SecretsFailure) => string {
  const i18n = useI18n();
  const { t } = i18n;
  return (failure) => {
    if (failure._tag !== "refused") return t("ask.failed");
    const { error } = failure;
    if (error._tag === "Conflict" && error.reason === "secret-name-taken") {
      return t("ask.nameTaken", { secret: reference });
    }
    if (error._tag === "Invalid" && error.reason === "totp") return t("ask.totpInvalid");
    return secretsFailureText(failure, i18n);
  };
}

/** The ask's fields and actions. Unmounted with the ask, taking what was typed with it. */
function AskForm({
  entry,
  secrets,
  botName,
  reference,
  onDecline,
  submitting,
  focusWatch,
}: {
  readonly entry: SecretAskEntry;
  readonly secrets: SecretsAccess;
  readonly botName: string;
  readonly reference: string;
  readonly onDecline: () => void;
  readonly submitting: boolean;
  readonly focusWatch: FocusWatch;
}) {
  const { t } = useI18n();
  const failureText = useAskFailureText(reference);
  const problemId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [value, setValue] = useState("");
  const [everyBot, setEveryBot] = useState(false);
  const [tried, setTried] = useState<DraftProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SecretsFailure | null>(null);
  const busy = saving || submitting;

  const save = () => {
    if (busy) return;
    const secret = askedSecret(entry, { username, password, totp, value }, everyBot);
    if (secret._tag === "invalid") {
      setTried(secret.problem);
      return;
    }
    setTried(null);
    setSaving(true);
    setFailure(null);
    void secrets.intents.add(secret.value, entry.id).then(
      (result) => {
        setSaving(false);
        if (result._tag === "failed") setFailure(result.failure);
      },
      () => {
        setSaving(false);
        setFailure({ _tag: "unexpected" });
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      {...focusWatch}
    >
      {entry.secret._tag === "login" ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">{t("ask.site")}</span>
            <span className="text-sm break-all">{entry.secret.origin}</span>
          </div>
          <SecretField
            label={t("ask.username")}
            value={username}
            onChange={setUsername}
            mono
            maxLength={MAX_LENGTH.username}
          />
          <SecretField
            label={t("ask.password")}
            value={password}
            onChange={setPassword}
            masked
            maxLength={MAX_LENGTH.password}
            invalid={tried === "password"}
            describedBy={problemId}
          />
          <SecretField
            label={t("ask.totp")}
            hint={t("ask.totpHint")}
            value={totp}
            onChange={setTotp}
            masked
            maxLength={MAX_LENGTH.totp}
          />
        </>
      ) : (
        <SecretField
          label={t("ask.value")}
          hint={t("ask.valueHint")}
          value={value}
          onChange={setValue}
          masked
          maxLength={MAX_LENGTH.value}
          invalid={tried === "value"}
          describedBy={problemId}
        />
      )}
      <SwitchLine label={t("ask.everyBot")} checked={everyBot} onChange={setEveryBot} />
      <p className="text-xs text-muted-foreground">{t("ask.unseen", { name: botName })}</p>
      <Problem id={problemId}>
        {tried !== null ? t(problemKey[tried]) : failure === null ? null : failureText(failure)}
      </Problem>
      <div className="flex justify-end gap-2">
        <DeclineButton busy={busy} onDecline={onDecline} />
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy}>
          {t("ask.save")}
        </Button>
      </div>
    </form>
  );
}
