// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultFailure, VaultHandle, VaultResult, VaultView } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { unlockWaitsUntil, vaultFailureText } from "@j3-bots/client-runtime/wording";
import { MIN_MASTER_PASSWORD_LENGTH, MasterPassword, type VaultStatus } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type ReactNode, useId, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { lineField } from "../ui/field";

/** What the app asks of the vault: every request of `VaultHandle`, each answered as a promise. */
export type VaultIntents = Omit<VaultHandle, "view">;

/** The vault as a screen shows it, and what it can ask of it. */
export interface VaultAccess {
  readonly view: VaultView;
  readonly intents: VaultIntents;
}

const decodePassword = Schema.decodeUnknownOption(MasterPassword);

/** The password typed, as the contract takes it; none while it is too short or too long. */
const masterPassword = (typed: string): Option.Option<MasterPassword> =>
  decodePassword(Redacted.make(typed));

/** Why a request to the vault failed, in a sentence. */
export function useVaultFailureText(): (failure: VaultFailure) => string {
  const ctx = usePresentation();
  return (failure) => vaultFailureText(failure, ctx);
}

/** A masked field with its label above it. */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  invalid = false,
  describedBy,
  readOnly = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: "new-password" | "current-password" | "off";
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly readOnly?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        readOnly={readOnly}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={cn(lineField, "font-mono")}
      />
    </div>
  );
}

/** The answer to a vault form, in its own line under it; empty, it takes no space. */
function Problem({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-xs text-blocked empty:hidden">
      {children}
    </p>
  );
}

/** Runs `request` once at a time, saying how its last run failed. */
function useRequest() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<VaultFailure | null>(null);
  const run = <A,>(request: () => Promise<VaultResult<A>>, onDone?: (value: A) => void) => {
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

/**
 * Creates the vault's master password: typed twice, with the line that says
 * nobody can give it back. `actions` go beside the button, such as a Skip.
 */
export function SetupVaultForm({
  intents,
  onDone,
  submitLabel,
  actions,
  className,
}: {
  readonly intents: VaultIntents;
  readonly onDone?: () => void;
  readonly submitLabel?: string;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const problemId = useId();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const { busy, failure, run } = useRequest();
  const short = password.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = again !== password;
  const problem = tried
    ? short
      ? t("vault.tooShort", { count: MIN_MASTER_PASSWORD_LENGTH })
      : mismatch
        ? t("vault.mismatch")
        : null
    : null;
  return (
    <form
      className={cn("flex flex-col gap-3 text-start", className)}
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        const checked = masterPassword(password);
        if (mismatch || Option.isNone(checked)) return;
        run(
          () => intents.setup(checked.value),
          () => {
            setPassword("");
            setAgain("");
            onDone?.();
          },
        );
      }}
    >
      <PasswordField
        label={t("vault.password")}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        invalid={tried && short}
        describedBy={problemId}
      />
      <PasswordField
        label={t("vault.confirm")}
        value={again}
        onChange={setAgain}
        autoComplete="new-password"
        invalid={tried && !short && mismatch}
        describedBy={problemId}
      />
      <p className="text-xs text-muted-foreground">{t("vault.noRecovery")}</p>
      <Problem id={problemId}>
        {problem ?? (failure === null ? null : failureText(failure))}
      </Problem>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions}
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy}>
          {submitLabel ?? t("vault.create")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Unlocks the vault with its master password, saying while too many wrong
 * ones make it wait. `actions` go beside the button.
 */
function UnlockVaultForm({
  status,
  intents,
  actions,
  className,
}: {
  readonly status: VaultStatus;
  readonly intents: VaultIntents;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const failureText = useVaultFailureText();
  const problemId = useId();
  const [password, setPassword] = useState("");
  const { busy, failure, run } = useRequest();
  const waiting = unlockWaitsUntil(status, ctx.now);
  return (
    <form
      className={cn("flex flex-col gap-3 text-start", className)}
      onSubmit={(event) => {
        event.preventDefault();
        const checked = masterPassword(password);
        if (Option.isNone(checked) || waiting !== null) return;
        run(
          () => intents.unlock(checked.value),
          () => setPassword(""),
        );
      }}
    >
      <PasswordField
        label={t("vault.password")}
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        invalid={failure !== null}
        describedBy={problemId}
      />
      <Problem id={problemId}>
        {waiting !== null
          ? t("vault.wait", { time: clockTime(waiting, ctx) })
          : failure === null
            ? null
            : failureText(failure)}
      </Problem>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          aria-disabled={busy || waiting !== null || password.length < MIN_MASTER_PASSWORD_LENGTH}
        >
          {t("vault.unlock")}
        </Button>
      </div>
    </form>
  );
}

/** Replaces the master password, checking the current one. */
export function ChangePasswordForm({
  intents,
  onDone,
  onCancel,
}: {
  readonly intents: VaultIntents;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const failureText = useVaultFailureText();
  const problemId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [tried, setTried] = useState(false);
  const { busy, failure, run } = useRequest();
  const short = next.length < MIN_MASTER_PASSWORD_LENGTH;
  const mismatch = again !== next;
  const problem = tried
    ? short
      ? t("vault.tooShort", { count: MIN_MASTER_PASSWORD_LENGTH })
      : mismatch
        ? t("vault.mismatch")
        : null
    : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        const was = masterPassword(current);
        const becomes = masterPassword(next);
        if (mismatch || Option.isNone(was) || Option.isNone(becomes)) return;
        run(() => intents.changePassword(was.value, becomes.value), onDone);
      }}
    >
      <PasswordField
        label={t("vault.current")}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
        describedBy={problemId}
      />
      <PasswordField
        label={t("vault.next")}
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        invalid={tried && short}
        describedBy={problemId}
      />
      <PasswordField
        label={t("vault.confirm")}
        value={again}
        onChange={setAgain}
        autoComplete="new-password"
        invalid={tried && !short && mismatch}
        describedBy={problemId}
      />
      <p className="text-xs text-muted-foreground">{t("vault.noRecovery")}</p>
      <Problem id={problemId}>
        {problem ?? (failure === null ? null : failureText(failure))}
      </Problem>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          {t("vault.cancel")}
        </Button>
        <Button type="submit" variant="primary" size="sm" aria-disabled={busy}>
          {t("vault.changePassword")}
        </Button>
      </div>
    </form>
  );
}

/** A sentence on why the vault cannot take a login, with the screen's actions under it. */
function GateNote({
  text,
  actions,
}: {
  readonly text: string | null;
  readonly actions?: ReactNode;
}) {
  if (text === null && actions === undefined) return null;
  return (
    <div className="flex flex-col gap-3">
      {text !== null && <p className="text-sm text-muted-foreground">{text}</p>}
      {actions !== undefined && (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
    </div>
  );
}

/**
 * What a screen shows while the vault cannot take a login: its setup or its
 * unlock, inline, or why there is none. `actions`, such as a card's Dismiss,
 * go beside the form's own button, or under the sentence. Null once the vault
 * is unlocked.
 */
export function VaultGate({
  vault,
  actions,
  className,
}: {
  readonly vault: VaultAccess;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const { view, intents } = vault;
  switch (view._tag) {
    case "loading":
      return <GateNote text={null} actions={actions} />;
    case "unsupported":
      return <GateNote text={t("vault.unsupported")} actions={actions} />;
    case "ready":
      switch (view.status.state) {
        case "unlocked":
          return null;
        case "newer":
          return <GateNote text={t("vault.newer")} actions={actions} />;
        case "uninitialized":
          return (
            <div className={cn("flex flex-col gap-2", className)}>
              <p className="text-sm text-muted-foreground">{t("vault.notSetUp")}</p>
              <SetupVaultForm intents={intents} actions={actions} />
            </div>
          );
        case "locked":
          return (
            <div className={cn("flex flex-col gap-2", className)}>
              <p className="text-sm text-muted-foreground">{t("vault.lockedBody")}</p>
              <UnlockVaultForm status={view.status} intents={intents} actions={actions} />
            </div>
          );
      }
  }
}
