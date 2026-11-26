// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  type ArgumentsDraft,
  type CommandConsent,
  commandConsent,
  commandEdit,
  type FormProblems,
  keepsLine,
  type KnownCommand,
} from "@j3-bots/client-runtime/presentation";
import {
  connectFailureText,
  envProblemText,
  pinRefusalText,
} from "@j3-bots/client-runtime/wording";
import type { CommandLine, Connector } from "@j3-bots/contracts";
import { useId, useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { alertDialog, dialogBackdrop, dialogTitle } from "../ui/dialog";
import { textField } from "../ui/field";
import { type KeyedPair, LineField, PageSection, PairRows } from "./parts";
import type { ConnectorsIntents } from "./screen";

// A connector the server starts by command, as the web and desktop apps add
// and change one: its command line, the confirmation it runs under, and an
// edit that asks for that confirmation again whenever the command line or a
// variable's name changes. A variable's value is masked as it is typed, and
// leaves the form once the server has it.

/**
 * A command line's fields: the program, its arguments, one per line, and its
 * environment. `args` is `kept` in an edit until the operator types them
 * again, since the server never shows them; `keptNames` are the variables
 * whose values an empty field keeps, none once the edit sends a new line.
 */
export function CommandFields({
  command,
  args,
  env,
  problems,
  readOnly,
  editing,
  keptNames,
  autoFocus,
  onCommand,
  onArgs,
  onEnv,
}: {
  command: string;
  args: ArgumentsDraft;
  env: ReadonlyArray<KeyedPair>;
  problems: FormProblems | null;
  readOnly: boolean;
  /** False when adding: every argument and value is typed. */
  editing: boolean;
  keptNames: ReadonlyArray<string>;
  autoFocus: boolean;
  onCommand: (command: string) => void;
  onArgs: (args: ArgumentsDraft) => void;
  onEnv: (env: ReadonlyArray<KeyedPair>) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const argsId = useId();
  const argsHintId = useId();
  const commandProblem = problems?.command
    ? t("connect.required", { field: t("addOwn.command") })
    : problems !== null && problems.pin !== null
      ? pinRefusalText(problems.pin, i18n)
      : null;
  return (
    <>
      <LineField
        label={t("addOwn.command")}
        hint={t("addOwn.command.hint")}
        placeholder={t("addOwn.command.placeholder")}
        problem={commandProblem}
        value={command}
        onChange={onCommand}
        readOnly={readOnly}
        autoFocus={autoFocus}
        mono
      />
      <div className="flex flex-col gap-1">
        <span id={argsId} className="text-xs">
          {t("addOwn.args")}
        </span>
        {args._tag === "kept" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">{t("connector.editCommand.args.kept")}</p>
            <Button
              size="sm"
              disabled={readOnly}
              aria-describedby={argsId}
              onClick={() => onArgs({ _tag: "typed", text: "" })}
            >
              {t("connector.editCommand.args.retype")}
            </Button>
          </div>
        ) : (
          <>
            <textarea
              aria-labelledby={argsId}
              aria-describedby={argsHintId}
              rows={3}
              aria-invalid={problems?.args ? true : undefined}
              value={args.text}
              readOnly={readOnly}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onArgs({ _tag: "typed", text: event.currentTarget.value })}
              className={cn(textField, "py-2 font-mono")}
            />
            <p id={argsHintId} className="text-xs text-muted-foreground">
              {t("addOwn.args.hint")}
            </p>
            {editing && (
              <Button
                size="sm"
                variant="ghost-muted"
                className="self-start"
                disabled={readOnly}
                onClick={() => onArgs({ _tag: "kept" })}
              >
                {t("connector.editCommand.args.keep")}
              </Button>
            )}
          </>
        )}
        {problems?.args && (
          <p role="alert" className="text-xs text-blocked">
            {t("addOwn.args.invalid")}
          </p>
        )}
        {problems?.argsAgain && (
          <p role="alert" className="text-xs text-blocked">
            {t("connector.editCommand.args.again")}
          </p>
        )}
      </div>
      <PageSection title={t("addOwn.env")}>
        <PairRows
          rows={env}
          problems={(problems?.env ?? []).map((problem) => ({
            index: problem.index,
            text: envProblemText(problem, i18n),
          }))}
          readOnly={readOnly}
          onChange={onEnv}
          valuePlaceholder={(row) =>
            keptNames.includes(row.name.trim())
              ? t("connector.editCommand.value.kept")
              : t("addOwn.env.value")
          }
          labels={{
            name: t("addOwn.env.name"),
            value: t("addOwn.env.value"),
            add: t("addOwn.env.add"),
            remove: t("addOwn.env.remove"),
          }}
        />
      </PageSection>
    </>
  );
}

/**
 * Asks the operator to confirm a command line before it runs: the program
 * and every argument as they will run, the name of every variable and never
 * its value, and that it runs as their user on the computer that runs J3
 * Bots. For a change, what is new since the command they confirmed before.
 */
export function CommandConsentDialog({
  consent,
  changed,
  onAnswer,
}: {
  /**
   * Null while nothing waits on the operator. Closing answers no, after
   * Run it answered yes, so a second answer must do nothing.
   */
  consent: CommandConsent | null;
  changed: boolean;
  onAnswer: (accepted: boolean) => void;
}) {
  const { t } = useI18n();
  // The last one asked stays shown while the dialog closes.
  const [shown, setShown] = useState(consent);
  if (consent !== null && consent !== shown) setShown(consent);
  return (
    <AlertDialog.Root
      open={consent !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
        <AlertDialog.Popup className={cn(alertDialog, "z-50 max-h-[85vh] max-w-md gap-3 p-5")}>
          <AlertDialog.Title className={dialogTitle}>
            {changed ? t("addOwn.consent.titleChanged") : t("addOwn.consent.title")}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {t("addOwn.consent.body")}
          </AlertDialog.Description>
          {shown !== null && (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("addOwn.consent.commandLine")}
                </h3>
                {/* One argument a line, as typed: an argument holds spaces of its own. */}
                <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                  {[
                    ...shown.settings.map((setting) => `${setting.name}=${setting.value}`),
                    shown.program,
                    ...shown.args,
                  ].join("\n")}
                </pre>
                {shown.settings.length > 0 && (
                  <p className="text-xs text-muted-foreground">{t("addOwn.consent.settings")}</p>
                )}
                {shown.programChanged && (
                  <p className="text-xs text-waiting">{t("addOwn.consent.programChanged")}</p>
                )}
              </section>
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t("addOwn.consent.variables")}
                </h3>
                {shown.names.length === 0 ? (
                  <p className="text-sm">{t("addOwn.consent.variables.none")}</p>
                ) : (
                  <>
                    <ul className="flex flex-wrap gap-1.5">
                      {shown.names.map((name) => (
                        <li
                          key={name}
                          className="flex items-center gap-1.5 rounded-pill bg-muted px-2 py-0.5 font-mono text-xs"
                        >
                          {name}
                          {shown.added.includes(name) && (
                            <span className="rounded-pill bg-waiting-surface px-1.5 font-sans text-2xs font-medium text-waiting">
                              {t("addOwn.consent.new")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {t("addOwn.consent.variables.hint")}
                    </p>
                  </>
                )}
                {shown.removed.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("addOwn.consent.removed", { names: shown.removed.join(", ") })}
                  </p>
                )}
              </section>
            </div>
          )}
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button />}>{t("addOwn.consent.cancel")}</AlertDialog.Close>
            <AlertDialog.Close render={<Button variant="primary" />} onClick={() => onAnswer(true)}>
              {t("addOwn.consent.confirm")}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** What an edit was, once the server took it, for the line the page shows. */
export type EditOutcome = "command" | "values";

/**
 * Changes a command connector's command line or its variables' values. Its
 * program and its variables' names start as they are; its arguments and
 * values are never shown. A value alone is saved as it is; a change to the
 * command line is confirmed first, then sent whole.
 */
export function EditCommand({
  connector,
  known,
  intents,
  onDone,
}: {
  connector: Connector;
  known: KnownCommand;
  intents: ConnectorsIntents;
  /** Null when the operator closed it with nothing saved. */
  onDone: (outcome: EditOutcome | null) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [command, setCommand] = useState(known.program);
  const [args, setArgs] = useState<ArgumentsDraft>({ _tag: "kept" });
  const [env, setEnv] = useState<ReadonlyArray<KeyedPair>>(() =>
    known.names.map((name, key) => ({ key, name, value: "" })),
  );
  const [problems, setProblems] = useState<FormProblems | null>(null);
  const [asking, setAsking] = useState<{
    readonly command: CommandLine;
    readonly consent: CommandConsent;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const send = (changes: Parameters<ConnectorsIntents["update"]>[1], outcome: EditOutcome) => {
    setSubmitting(true);
    setFailure(null);
    void intents.update(connector.id, changes).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        // The server keeps them now: none stays in the form.
        setEnv((rows) => rows.map((row) => ({ ...row, value: "" })));
        setArgs({ _tag: "kept" });
        onDone(outcome);
      } else {
        setFailure(connectFailureText(result.failure, i18n));
      }
    });
  };

  return (
    <form
      aria-label={t("connector.editCommand")}
      className="flex flex-col gap-4 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        const edit = commandEdit(known, { command, args, env });
        switch (edit._tag) {
          case "invalid":
            setProblems(edit.problems);
            return;
          case "unchanged":
            setProblems(null);
            onDone(null);
            return;
          case "values":
            setProblems(null);
            send({ values: edit.values }, "values");
            return;
          case "command":
            setProblems(null);
            setAsking({ command: edit.command, consent: commandConsent(edit.command, known) });
            return;
        }
      }}
    >
      <p className="text-sm text-muted-foreground">{t("connector.editCommand.hint")}</p>
      <CommandFields
        command={command}
        args={args}
        env={env}
        problems={problems}
        readOnly={submitting}
        editing
        keptNames={keepsLine(known, { command, args, env }) ? known.names : []}
        autoFocus
        onCommand={setCommand}
        onArgs={setArgs}
        onEnv={setEnv}
      />
      {failure !== null && (
        <p role="alert" className="text-sm text-blocked">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" aria-disabled={submitting}>
          {submitting ? t("connect.submitting") : t("connector.editCommand.save")}
        </Button>
        <Button size="sm" variant="ghost-muted" disabled={submitting} onClick={() => onDone(null)}>
          {t("signIn.cancel")}
        </Button>
      </div>
      <CommandConsentDialog
        consent={asking?.consent ?? null}
        changed
        onAnswer={(accepted) => {
          if (asking === null) return;
          setAsking(null);
          if (accepted) send({ command: asking.command }, "command");
        }}
      />
    </form>
  );
}
