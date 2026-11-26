// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { timeInSentence } from "@j3-bots/client-runtime/wording";
import {
  EXPORT_PASSPHRASE_MIN_LENGTH,
  type LeftOut,
  type LocalExportResult,
  type LocalServerState,
  type MovedAway,
  type UseThisComputerResult,
} from "@j3-bots/desktop-bridge";
import * as Redacted from "effect/Redacted";
import { useId, useState, type ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { BigButton, FirstScreen, FormProblem } from "../onboarding/parts";
import { Button } from "./ui/button";
import { Confirm, ConfirmDialog } from "./ui/confirm";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";
import { lineField } from "./ui/field";
import { Switch } from "./ui/switch";

// Where the bots live, in the desktop app: on this computer, which runs its
// own server, or on a server elsewhere. The first screen asks; Settings
// changes it, both ways. Every screen here is the desktop app's alone.

/** The folder where the bots would keep their data must be repaired first: why, and how. */
type HomeRefused = Extract<UseThisComputerResult, { readonly _tag: "home-refused" }>;

/** Why "Usar neste computador" did not go through, or `null` while it has not failed. */
type UseFailure = "failed" | "unavailable" | HomeRefused;

const failureOf = (answer: UseThisComputerResult | null): UseFailure | null =>
  answer === "changed" ? null : (answer ?? "failed");

/**
 * The desktop app's first screen where this computer can run the bots: on
 * this computer, at once and with nothing to type, or on a server, which
 * goes on to its address and pairing. A home that must be repaired first is
 * shown as a start that failed, with Try again.
 */
export function WhereBotsLive({
  onUseThisComputer,
  onConnectToServer,
  notice = null,
}: {
  /** Resolves with the app's answer; once it changed, the app loads the page again. */
  readonly onUseThisComputer: () => Promise<UseThisComputerResult | null>;
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
  const use = () => {
    setState("pending");
    // Once it changed, the app loads the page again: only a failure is shown here.
    void onUseThisComputer().then((answer) => setState(failureOf(answer) ?? "pending"));
  };
  if (typeof state === "object") {
    return (
      <LocalServerFailed
        server={state}
        onRetry={use}
        footer={<ConnectInstead onConnect={onConnectToServer} />}
      />
    );
  }
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
            if (!pending) use();
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

/** What a failure the app saw says of itself: as a start's, or an update's it rolled back from. */
type Failure = Pick<LocalServerState, "reason" | "fix" | "logTail">;

/**
 * Why the server on this computer did not start, or the update it was
 * rolled back from, in its own words, what repairs it, and the lines it last
 * wrote, shown on request.
 */
function FailureDetails({ server }: { readonly server: Failure }) {
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
  readonly server: Failure;
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
 * there are bots to come back to; also why an update was rolled back.
 */
export function LocalServerFailedBody({
  server,
  onRetry,
}: {
  readonly server: Failure;
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
  readonly onUse: () => Promise<UseThisComputerResult | null>;
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
      <p role="alert" className="text-xs text-pretty break-words text-blocked empty:hidden">
        {typeof state === "object" ? (
          <>
            {state.reason}
            <span className="mt-0.5 block text-muted-foreground">{state.fix}</span>
          </>
        ) : state === "failed" ? (
          t("where.thisComputer.failed")
        ) : state === "unavailable" ? (
          t("where.thisComputer.unavailable")
        ) : null}
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
  const switchId = useId();
  const hintId = useId();
  const [shown, setShown] = useState(on);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={switchId} className="text-sm">
            {t("settings.startWithSystem")}
          </label>
          <span id={hintId} className="text-2xs text-muted-foreground">
            {t("settings.startWithSystem.hint")}
          </span>
        </span>
        <Switch
          id={switchId}
          checked={shown}
          readOnly={state === "pending"}
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

/** How moving the bots stands: nothing asked yet, under way, or failed, with the export's own words. */
type MoveState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "pending" }
  | { readonly _tag: "failed"; readonly reason: string | null }
  | { readonly _tag: "refused"; readonly reason: "taken" | "inside-data" };

/** What the two passphrases say is wrong, once the operator asked to export. */
type PassphraseProblem = "too-short" | "differ";

const passphraseProblem = (passphrase: string, again: string): PassphraseProblem | null =>
  passphrase.length < EXPORT_PASSPHRASE_MIN_LENGTH
    ? "too-short"
    : passphrase !== again
      ? "differ"
      : null;

/**
 * Moves the bots on this computer to another server: a dialog that says what
 * the file holds and what stays behind, and asks for the passphrase its
 * secrets are sealed under, twice, with the line that it cannot be
 * recovered. The app then asks where to save the file and writes it.
 */
export function MoveToAnotherServer({
  onMove,
}: {
  /** Resolves with the app's answer; once it exported, the app loads the page again. */
  readonly onMove: (passphrase: Redacted.Redacted<string>) => Promise<LocalExportResult | null>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const passphraseId = useId();
  const hintId = useId();
  const againId = useId();
  const problemId = useId();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [checked, setChecked] = useState(false);
  const [state, setState] = useState<MoveState>({ _tag: "idle" });
  const pending = state._tag === "pending";
  const problem = checked ? passphraseProblem(passphrase, again) : null;
  const close = () => {
    setOpen(false);
    setPassphrase("");
    setAgain("");
    setChecked(false);
    setState({ _tag: "idle" });
  };
  const submit = () => {
    setChecked(true);
    if (pending || passphraseProblem(passphrase, again) !== null) return;
    setState({ _tag: "pending" });
    void onMove(Redacted.make(passphrase)).then((answer) => {
      // Once it exported, the app loads the page again: only the rest is shown here.
      if (answer?._tag === "exported") return;
      setState(
        answer?._tag === "cancelled"
          ? { _tag: "idle" }
          : answer?._tag === "refused"
            ? { _tag: "refused", reason: answer.reason }
            : {
                _tag: "failed",
                reason: answer?._tag === "failed" ? (answer.reason ?? null) : null,
              },
      );
    });
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!pending) close();
      }}
    >
      <Dialog.Trigger render={<Button size="sm" variant="secondary" />}>
        {t("local.move")}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={cn(
            alertDialog,
            "max-h-[calc(100dvh-2rem)] max-w-md gap-3 overflow-y-auto p-5",
          )}
        >
          <Dialog.Title id={titleId} className={dialogTitle}>
            {t("local.move.title")}
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {t("local.move.body")}
          </Dialog.Description>
          <p className="text-sm text-muted-foreground">{t("local.move.stays")}</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={passphraseId} className="text-xs">
                {t("local.move.passphrase")}
              </label>
              <input
                id={passphraseId}
                type="password"
                className={lineField}
                value={passphrase}
                readOnly={pending}
                autoComplete="new-password"
                aria-describedby={`${hintId} ${problemId}`}
                aria-invalid={problem === "too-short"}
                onChange={(event) => setPassphrase(event.currentTarget.value)}
              />
              <p id={hintId} className="text-2xs text-muted-foreground">
                {t("local.move.passphrase.hint", { min: EXPORT_PASSPHRASE_MIN_LENGTH })}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={againId} className="text-xs">
                {t("local.move.passphrase.again")}
              </label>
              <input
                id={againId}
                type="password"
                className={lineField}
                value={again}
                readOnly={pending}
                autoComplete="new-password"
                aria-describedby={problemId}
                aria-invalid={problem === "differ"}
                onChange={(event) => setAgain(event.currentTarget.value)}
              />
            </div>
            <p className="text-sm font-medium">{t("local.move.unrecoverable")}</p>
            <p
              id={problemId}
              role="alert"
              className="text-xs text-pretty break-words text-blocked empty:hidden"
            >
              {problem === "too-short"
                ? t("local.move.tooShort", { min: EXPORT_PASSPHRASE_MIN_LENGTH })
                : problem === "differ"
                  ? t("local.move.differ")
                  : state._tag === "refused"
                    ? t(state.reason === "taken" ? "local.move.taken" : "local.move.insideData")
                    : state._tag === "failed"
                      ? state.reason === null
                        ? t("local.move.failed")
                        : `${t("local.move.failed")} ${state.reason}`
                      : null}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" aria-disabled={pending} onClick={pending ? undefined : close}>
                {t("local.move.cancel")}
              </Button>
              <Button type="submit" variant="primary" aria-disabled={pending}>
                {pending ? t("local.move.pending") : t("local.move.submit")}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Deletes the data the bots that moved away left on this computer, once the
 * operator confirms, after a question that says the export is then their only
 * copy. `quiet`: a plain text button, below the screen's way on.
 */
function DeleteLocalData({
  onDelete,
  secretsLeftOut,
  quiet = false,
}: {
  /** Resolves `false` when nothing was deleted. */
  readonly onDelete: () => Promise<boolean>;
  /** The export left the secrets out: deleting the data here loses them. */
  readonly secretsLeftOut: boolean;
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
        title={t("local.moved.delete.title")}
        body={
          secretsLeftOut
            ? `${t("local.moved.delete.body")} ${t("local.moved.delete.secrets")}`
            : t("local.moved.delete.body")
        }
        cancel={t("local.moved.delete.cancel")}
        confirm={t("local.moved.delete")}
        onConfirm={() => {
          setState("pending");
          void onDelete().then((deleted) => setState(deleted ? "idle" : "failed"));
        }}
      >
        {t("local.moved.delete")}
      </Confirm>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed" && t("local.moved.failed")}
      </p>
    </div>
  );
}

/** What the export left out, when it left anything out; nothing otherwise. */
function LeftOutNotice({ leftOut }: { readonly leftOut: LeftOut }) {
  const { t, plural } = useI18n();
  const more = leftOut.names - leftOut.firstNames.length;
  const lines: Array<ReactNode> = [
    leftOut.secrets === undefined ? null : (
      <li key="secrets">{t(`local.moved.leftOut.secrets.${leftOut.secrets}`)}</li>
    ),
    leftOut.links === 0 ? null : (
      <li key="links">{plural("local.moved.leftOut.links", leftOut.links)}</li>
    ),
    leftOut.names === 0 ? null : (
      <li key="names">
        {plural("local.moved.leftOut.names", leftOut.names)}
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs break-all">
          {leftOut.firstNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {more > 0 && <li>{plural("local.moved.leftOut.names.more", more)}</li>}
        </ul>
      </li>
    ),
    leftOut.attachmentsMissing === 0 ? null : (
      <li key="attachments">
        {plural("local.moved.leftOut.attachments", leftOut.attachmentsMissing)}
      </li>
    ),
  ].filter((line) => line !== null);
  if (lines.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-border px-4 py-3 text-start">
      <p className="text-sm font-medium">{t("local.moved.leftOut")}</p>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-muted-foreground">{lines}</ul>
    </div>
  );
}

/**
 * The bots on this computer moved to another server, and their data is
 * still here: when, the file, what the new server needs next, and the ways
 * on: connecting to it, running the bots here again, or deleting their data.
 */
export function MovedAwayScreen({
  moved,
  onConnect,
  onRunHere,
  onDelete,
}: {
  readonly moved: MovedAway;
  /** Goes on to the server address screen. Resolves `false` when nothing changed. */
  readonly onConnect: () => Promise<boolean>;
  /** Resolves `false` when nothing changed; otherwise the app loads the page again. */
  readonly onRunHere: () => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const problemId = useId();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const [askingRunHere, setAskingRunHere] = useState(false);
  const pending = state === "pending";
  const go = (step: () => Promise<boolean>) => {
    if (pending) return;
    setState("pending");
    void step().then((changed) => setState(changed ? "pending" : "failed"));
  };
  return (
    <FirstScreen
      title={t("local.moved.title")}
      body={t("local.moved.body", { when: timeInSentence(moved.at, ctx) })}
    >
      <p className="w-full rounded-lg bg-muted px-4 py-3 text-start font-mono text-xs break-all">
        {t("local.moved.file", { file: moved.file })}
      </p>
      <LeftOutNotice leftOut={moved.leftOut} />
      <div className="flex w-full flex-col gap-1.5 text-start">
        <p className="text-sm font-medium">{t("local.moved.next")}</p>
        <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-muted-foreground">
          <li>{t("local.moved.step.import")}</li>
          <li>{t("local.moved.step.pair")}</li>
          <li>{t("local.moved.step.webhooks")}</li>
        </ol>
      </div>
      <BigButton
        disabled={pending}
        describedBy={state === "failed" ? problemId : undefined}
        onClick={() => go(onConnect)}
      >
        {t("local.moved.connect")}
      </BigButton>
      <Button
        variant="ghost"
        className="h-11 w-full text-base"
        aria-disabled={pending}
        onClick={() => {
          if (!pending) setAskingRunHere(true);
        }}
      >
        {t("local.moved.runHere")}
      </Button>
      <ConfirmDialog
        open={askingRunHere}
        onOpenChange={setAskingRunHere}
        title={t("local.moved.runHere.title")}
        body={t("local.moved.runHere.body")}
        cancel={t("local.moved.runHere.cancel")}
        confirm={t("local.moved.runHere")}
        tone="primary"
        onConfirm={() => go(onRunHere)}
      />
      <DeleteLocalData
        quiet
        secretsLeftOut={moved.leftOut.secrets !== undefined}
        onDelete={onDelete}
      />
      <FormProblem id={problemId}>
        {state === "failed" ? t("local.moved.failed") : null}
      </FormProblem>
    </FirstScreen>
  );
}

/**
 * In Settings, once the page runs on another server: the bots that moved
 * from this computer left their data here, and a way to delete it.
 */
export function LeftHere({
  moved,
  onDelete,
}: {
  readonly moved: MovedAway;
  readonly onDelete: () => Promise<boolean>;
}) {
  const ctx = usePresentation();
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-2xs text-pretty text-muted-foreground">
        {ctx.i18n.t("local.moved.leftHere", { when: timeInSentence(moved.at, ctx) })}
      </p>
      <DeleteLocalData secretsLeftOut={moved.leftOut.secrets !== undefined} onDelete={onDelete} />
    </div>
  );
}
