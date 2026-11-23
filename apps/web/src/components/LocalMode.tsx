// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LocalServerState, ModeChange } from "@j3-bots/desktop-bridge";
import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { BigButton, FirstScreen, FormProblem } from "../onboarding/parts";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { Switch } from "./ui/switch";

// Where the bots live, in the desktop app: on this computer, which runs its
// own server, or on a server elsewhere. The first screen asks; Settings
// changes it, both ways. Every screen here is the desktop app's alone.

/** Why "Usar neste computador" did not go through, or `null` while it has not failed. */
type UseFailure = "failed" | "unavailable";

const failureOf = (answer: ModeChange | null): UseFailure | null =>
  answer === "changed" ? null : answer === "unavailable" ? "unavailable" : "failed";

/**
 * The desktop app's first screen where this computer can run the bots: on
 * this computer, at once and with nothing to type, or on a server, which
 * goes on to its address and pairing.
 */
export function WhereBotsLive({
  onUseThisComputer,
  onConnectToServer,
  notice = null,
}: {
  /** Resolves with the app's answer; once it changed, the app loads the page again. */
  readonly onUseThisComputer: () => Promise<ModeChange | null>;
  /** Goes on to the server address screen. */
  readonly onConnectToServer: () => void;
  /** A sentence about a link that led here, said above the choices. */
  readonly notice?: string | null;
}) {
  const { t } = useI18n();
  const hintId = useId();
  const problemId = useId();
  const [state, setState] = useState<"idle" | "pending" | UseFailure>("idle");
  const pending = state === "pending";
  return (
    <FirstScreen title={t("where.title")} body={t("where.body")}>
      {notice !== null && (
        <p role="status" className="w-full rounded-lg bg-muted px-4 py-3 text-sm break-words">
          {notice}
        </p>
      )}
      <div className="flex w-full flex-col gap-2">
        <BigButton
          disabled={pending}
          describedBy={state === "idle" || pending ? hintId : `${hintId} ${problemId}`}
          onClick={() => {
            if (pending) return;
            setState("pending");
            // Once it changed, the app loads the page again: only a failure is shown here.
            void onUseThisComputer().then((answer) => setState(failureOf(answer) ?? "pending"));
          }}
        >
          {pending ? t("where.thisComputer.pending") : t("where.thisComputer")}
        </BigButton>
        <p id={hintId} className="text-sm text-pretty text-muted-foreground">
          {t("where.thisComputer.hint")}
        </p>
      </div>
      <Button
        variant="ghost"
        className="h-11 w-full text-base"
        aria-disabled={pending}
        onClick={() => {
          if (!pending) onConnectToServer();
        }}
      >
        {t("where.server")}
      </Button>
      <FormProblem id={problemId}>
        {state === "failed"
          ? t("where.thisComputer.failed")
          : state === "unavailable"
            ? t("where.thisComputer.unavailable")
            : null}
      </FormProblem>
    </FirstScreen>
  );
}

/**
 * A way out of the screens before there are bots on this computer, to a
 * server instead: nothing is asked, since nothing was made here yet.
 */
export function ConnectInstead({ onConnect }: { readonly onConnect: () => void }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost-muted" size="sm" onClick={onConnect}>
      {t("where.server")}
    </Button>
  );
}

/** A way back from the server address screen to the choice of where the bots live. */
export function BackToWhere({ onBack }: { readonly onBack: () => void }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost-muted" size="sm" onClick={onBack}>
      {t("onboarding.back")}
    </Button>
  );
}

/**
 * Why the server on this computer did not start, in its own words, what
 * repairs it, and the lines it last wrote, shown on request.
 */
function FailureDetails({ server }: { readonly server: LocalServerState }) {
  const { t } = useI18n();
  const logId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-full flex-col gap-3 text-start">
      <p className="text-base text-pretty break-words">
        {server.reason ?? t("local.failed.unknown")}
      </p>
      {server.fix !== undefined && (
        <p className="text-sm text-pretty break-words text-muted-foreground">{server.fix}</p>
      )}
      <Button
        variant="ghost-muted"
        size="sm"
        className="self-start"
        aria-expanded={open}
        aria-controls={logId}
        onClick={() => setOpen((shown) => !shown)}
      >
        {open ? t("local.failed.hideDetails") : t("local.failed.details")}
      </Button>
      <pre
        id={logId}
        hidden={!open}
        className="max-h-60 overflow-auto rounded-lg bg-muted p-3 font-mono text-2xs whitespace-pre-wrap break-words text-muted-foreground"
      >
        {server.logTail === undefined || server.logTail.trim() === ""
          ? t("local.failed.noLog")
          : server.logTail}
      </pre>
    </div>
  );
}

/**
 * The server on this computer did not start: why, what repairs it, Try again
 * and, on request, its last lines. `footer`: a way out, as to a server.
 */
export function LocalServerFailed({
  server,
  onRetry,
  footer,
}: {
  readonly server: LocalServerState;
  readonly onRetry: () => void;
  readonly footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <FirstScreen title={t("local.failed.title")} body={null}>
      <FailureDetails server={server} />
      <BigButton onClick={onRetry}>{t("local.failed.retry")}</BigButton>
      {footer}
    </FirstScreen>
  );
}

/**
 * The same, in a dialog over the app, opened from the connection line once
 * there are bots to come back to.
 */
export function LocalServerFailedBody({
  server,
  onRetry,
}: {
  readonly server: LocalServerState;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <FailureDetails server={server} />
      <Button variant="primary" className="self-end" onClick={onRetry}>
        {t("local.failed.retry")}
      </Button>
    </div>
  );
}

/**
 * This computer is not signed in to its own server, and only the operator
 * signs it in again: after its access was ended (`signed-out`), as from
 * another device, or after signing in failed (`failed`).
 */
export function LocalSignIn({
  reason,
  onSignIn,
  footer,
}: {
  readonly reason: "signed-out" | "failed";
  /** Resolves `false` when it did not sign in; otherwise the app goes on. */
  readonly onSignIn: () => Promise<boolean>;
  readonly footer?: ReactNode;
}) {
  const { t } = useI18n();
  const problemId = useId();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const pending = state === "pending";
  return (
    <FirstScreen
      title={t(reason === "signed-out" ? "local.signedOut.title" : "local.signInFailed.title")}
      body={t(reason === "signed-out" ? "local.signedOut.body" : "local.signInFailed.body")}
    >
      <div className="flex w-full flex-col gap-2">
        <BigButton
          disabled={pending}
          describedBy={state === "failed" ? problemId : undefined}
          onClick={() => {
            if (pending) return;
            setState("pending");
            void onSignIn().then((signedIn) => setState(signedIn ? "pending" : "failed"));
          }}
        >
          {pending ? t("local.signedOut.pending") : t("local.signedOut.signIn")}
        </BigButton>
        <FormProblem id={problemId}>
          {state === "failed" ? t("local.signedOut.failed") : null}
        </FormProblem>
      </div>
      {footer}
    </FirstScreen>
  );
}

/** While the app stops the bots on this computer, on the way to a server. */
export function StoppingLocal() {
  const { t } = useI18n();
  return (
    <FirstScreen title={t("local.stopping")} body={null}>
      {null}
    </FirstScreen>
  );
}

/**
 * Stops using this computer, once the operator confirms, after a question
 * that says what stops and what stays. `quiet`: a plain text button, for the
 * screens before the roster, where it is not what the operator came for.
 */
export function StopUsingComputer({
  onStop,
  quiet = false,
}: {
  /** Resolves `false` when nothing changed; otherwise the app loads the page again. */
  readonly onStop: () => Promise<boolean>;
  readonly quiet?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const pending = state === "pending";
  return (
    <div className={cn("flex flex-col gap-1.5", quiet ? "items-center" : "items-start")}>
      <Confirm
        trigger={
          <Button
            size="sm"
            variant={quiet ? "ghost-muted" : "destructive-outline"}
            aria-disabled={pending}
          />
        }
        busy={pending}
        title={t("local.stop.title")}
        body={t("local.stop.body")}
        cancel={t("local.stop.cancel")}
        confirm={t("local.stop")}
        onConfirm={() => {
          setState("pending");
          void onStop().then((stopped) => setState(stopped ? "pending" : "failed"));
        }}
      >
        {pending ? t("local.stop.pending") : t("local.stop")}
      </Confirm>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed" && t("local.stop.failed")}
      </p>
    </div>
  );
}

/**
 * Leaves the server for this computer, once the operator confirms: the app
 * forgets the server and this device's sign-in there, as changing server
 * does, and runs the bots here.
 */
export function UseThisComputer({
  address,
  onUse,
}: {
  readonly address: string;
  readonly onUse: () => Promise<ModeChange | null>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "pending" | UseFailure>("idle");
  const pending = state === "pending";
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Confirm
        trigger={<Button size="sm" variant="secondary" aria-disabled={pending} />}
        busy={pending}
        title={t("settings.where.useThisComputer.title")}
        body={t("settings.where.useThisComputer.body", { address })}
        cancel={t("server.change.cancel")}
        confirm={t("where.thisComputer")}
        onConfirm={() => {
          setState("pending");
          void onUse().then((answer) => setState(failureOf(answer) ?? "pending"));
        }}
      >
        {pending ? t("where.thisComputer.pending") : t("where.thisComputer")}
      </Confirm>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed"
          ? t("where.thisComputer.failed")
          : state === "unavailable"
            ? t("where.thisComputer.unavailable")
            : null}
      </p>
    </div>
  );
}

/** Starting the app with the system: what it does, beside the switch. */
export function StartWithSystem({
  on,
  onChange,
}: {
  readonly on: boolean;
  /** Resolves with what holds once the app answered. */
  readonly onChange: (on: boolean) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const hintId = useId();
  const [shown, setShown] = useState(on);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span id={labelId} className="text-sm">
            {t("settings.startWithSystem")}
          </span>
          <span id={hintId} className="text-2xs text-muted-foreground">
            {t("settings.startWithSystem.hint")}
          </span>
        </span>
        <Switch
          checked={shown}
          readOnly={state === "pending"}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          onCheckedChange={(next) => {
            setShown(next);
            setState("pending");
            void onChange(next).then((held) => {
              setShown(held);
              setState(held === next ? "idle" : "failed");
            });
          }}
        />
      </div>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed" && t("settings.startWithSystem.failed")}
      </p>
    </div>
  );
}
