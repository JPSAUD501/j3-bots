// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsFailure, SecretsHandle, SecretsView } from "@j3-bots/client-runtime";
import { secretsFailureText } from "@j3-bots/client-runtime/wording";
import type { Bot, SecretAccess } from "@j3-bots/contracts";
import { type ReactNode, useId } from "react";
import { useBots, useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { Checkbox } from "../ui/checkbox";
import { lineField } from "../ui/field";
import { Switch } from "../ui/switch";

/** What the app asks of the secrets: every request of `SecretsHandle`, each answered as a promise. */
export type SecretsIntents = Omit<SecretsHandle, "view">;

/** The secrets as a screen shows them, and what it can ask of them. */
export interface SecretsAccess {
  readonly view: SecretsView;
  readonly intents: SecretsIntents;
}

/** Whether secrets can be added and used now; false too while their state is not known yet. */
export const secretsReady = (view: SecretsView): boolean =>
  view._tag === "ready" && view.status.state === "ready";

/** Why a request about secrets failed, in a sentence. */
export function useSecretsFailureText(): (failure: SecretsFailure) => string {
  const i18n = useI18n();
  return (failure) => secretsFailureText(failure, i18n);
}

/** The longest value of each kind the contract takes, so a field cannot take more. */
export const MAX_LENGTH = {
  username: 1_000,
  password: 10_000,
  totp: 4_000,
  value: 10_000,
} as const;

/**
 * One labelled one-line field, with a hint under it. `masked` hides what is
 * typed, as for a password; values never go to the browser's autofill.
 */
export function SecretField({
  label,
  value,
  onChange,
  hint,
  masked = false,
  mono = false,
  invalid = false,
  maxLength,
  describedBy,
  autoComplete = "off",
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string | undefined;
  readonly masked?: boolean;
  readonly mono?: boolean;
  readonly invalid?: boolean;
  readonly maxLength?: number;
  readonly describedBy?: string;
  readonly autoComplete?: "off" | "current-password";
}) {
  const id = useId();
  const hintId = useId();
  const described = [hint === undefined ? null : hintId, describedBy ?? null]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <input
        id={id}
        type={masked ? "password" : "text"}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={described === "" ? undefined : described}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={cn(lineField, (masked || mono) && "font-mono")}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** What is wrong with a form, in its own line under it; empty, it takes no space. */
export function Problem({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-blocked empty:hidden">
      {children}
    </p>
  );
}

/** A switch and its label on one line. */
export function SwitchLine({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-9 items-center gap-3 text-sm">
      <span className="flex-1">{label}</span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * Which bots may use a secret: every bot, which takes bots made later too,
 * or each bot by name. Turning "Every bot" off leaves every bot ticked, for
 * the operator to take some out.
 */
export function AccessPicker({
  bots,
  access,
  onChange,
  disabled = false,
}: {
  readonly bots: ReadonlyArray<Bot>;
  readonly access: SecretAccess;
  readonly onChange: (access: SecretAccess) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <SwitchLine
        label={t("secrets.everyBot")}
        checked={access._tag === "every-bot"}
        disabled={disabled}
        onChange={(checked) =>
          onChange(
            checked ? { _tag: "every-bot" } : { _tag: "bots", botIds: bots.map((bot) => bot.id) },
          )
        }
      />
      {access._tag === "bots" && (
        <ul className="flex flex-col">
          {bots.map((bot) => (
            <li key={bot.id}>
              <label className="flex min-h-9 items-center gap-3 text-sm pointer-coarse:min-h-11">
                <Checkbox
                  checked={access.botIds.includes(bot.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({
                      _tag: "bots",
                      botIds: checked
                        ? [...access.botIds.filter((id) => id !== bot.id), bot.id]
                        : access.botIds.filter((id) => id !== bot.id),
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{bot.profile.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Which bots may use a secret, in a line: "Every bot", the names of the bots still here, or "No bot yet". */
export function useAccessText(): (access: SecretAccess) => string {
  const { t } = useI18n();
  const bots = useBots();
  return (access) => {
    if (access._tag === "every-bot") return t("secrets.everyBot");
    const names = access.botIds.flatMap((id) => {
      const bot = bots.get(id);
      return bot === undefined ? [] : [bot.profile.name];
    });
    return names.length === 0 ? t("secrets.noBot") : names.join(", ");
  };
}

/** A value set into a sentence by `i18n.parts`: a reference shows as code, a name as it is. */
export interface Filled {
  readonly text: string;
  readonly code: boolean;
}

export const asCode = (text: string): Filled => ({ text, code: true });
export const asText = (text: string): Filled => ({ text, code: false });

/**
 * A sentence from `i18n.parts`, with its references as code. Its text needs
 * no key; a reference is keyed by itself, as a sentence names one only once.
 */
export function Sentence({ parts }: { readonly parts: ReadonlyArray<string | Filled> }) {
  return parts.map((part) =>
    typeof part === "string" ? (
      part
    ) : part.code ? (
      <code key={part.text} className="rounded bg-muted px-1 py-0.5 font-mono break-all">
        {part.text}
      </code>
    ) : (
      part.text
    ),
  );
}
