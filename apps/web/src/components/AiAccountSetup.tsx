// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import {
  type AccountEdits,
  type AccountField,
  accountPatch,
  newAccountName,
  noAccountEdits,
  type SetUpAccount,
  setUpAccounts,
} from "@j3-bots/client-runtime/presentation";
import { useAiAccountModel } from "@j3-bots/client-runtime/react";
import { type EngineStatus, type SignInHarness } from "@j3-bots/contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../app/context";
import { AiAccountRow, type WebAiConnect } from "./AiConnect";
import type { ProviderActions } from "./ProviderFix";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm";
import { lineField } from "./ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Switch } from "./ui/switch";

// Settings → Providers on a server that lets the operator set each AI account up
// (decision 0108): every Claude Code and Codex account, one row each, with
// the sign-in that row has always had, its switch, and under Advanced its
// name, the program it runs, its launch options and where it keeps its
// sign-in; Remove for an account the operator added; and Add account.

type Asking = "idle" | "asking" | "failed";

const harnesses: ReadonlyArray<SignInHarness> = ["claude-code", "codex"];

/**
 * Every account the operator set up, in the server's order, and Add
 * account below them. `version` is what a connected account shows of the
 * program it runs, as Settings always showed it.
 */
export function SetUpAccountList({
  ai,
  engine,
  actions,
  stale,
  version,
}: {
  readonly ai: WebAiConnect;
  readonly engine: EngineStatus;
  readonly actions: ProviderActions;
  readonly stale: boolean;
  readonly version: (entry: SetUpAccount) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-col gap-2">
      <ul aria-label={t("ai.choice.label")} className="flex w-full flex-col gap-2">
        {setUpAccounts(engine).map((entry) => (
          <SetUpAccountRow
            key={entry.provider.id}
            ai={ai}
            entry={entry}
            actions={actions}
            stale={stale}
          >
            {version(entry)}
          </SetUpAccountRow>
        ))}
      </ul>
      {!stale && <AddAccount engine={engine} actions={actions} />}
    </div>
  );
}

/** One account the operator set up: its sign-in row, with what they set up of it under it. */
export function SetUpAccountRow({
  ai,
  entry,
  actions,
  stale,
  children,
  defaultEdits,
}: {
  readonly ai: WebAiConnect;
  readonly entry: SetUpAccount;
  readonly actions: ProviderActions;
  readonly stale: boolean;
  readonly children?: ReactNode;
  /** Opens Advanced with these edits typed, as the gallery shows it. */
  readonly defaultEdits?: AccountEdits;
}) {
  const model = useAiAccountModel(entry.account, ai.input);
  return (
    <AiAccountRow
      ai={ai}
      model={model}
      paths
      stale={stale}
      setup={
        stale ? null : <AccountSetup entry={entry} actions={actions} defaultEdits={defaultEdits} />
      }
    >
      {children}
    </AiAccountRow>
  );
}

/** The switch, and Advanced folded under it. */
function AccountSetup({
  entry,
  actions,
  defaultEdits,
}: {
  readonly entry: SetUpAccount;
  readonly actions: ProviderActions;
  readonly defaultEdits: AccountEdits | undefined;
}) {
  const { t } = useI18n();
  const { provider, setup } = entry;
  const switchId = useId();
  const [switching, setSwitching] = useState<Asking>("idle");
  const toggle = (enabled: boolean) => {
    setSwitching("asking");
    void actions
      .setUpAccount(provider.id, { enabled })
      .then((took) => setSwitching(took ? "idle" : "failed"));
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex min-h-9 items-center gap-3">
        <label htmlFor={switchId} className="min-w-0 flex-1 text-sm">
          {t("accounts.use", { name: provider.name })}
        </label>
        <Switch
          id={switchId}
          checked={setup.enabled}
          disabled={switching === "asking"}
          onCheckedChange={toggle}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t(setup.enabled ? "accounts.on" : "accounts.off")}
      </p>
      {switching === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("accounts.saveFailed")}
        </p>
      )}
      <Collapsible.Root className="w-full text-start" defaultOpen={defaultEdits !== undefined}>
        <Collapsible.Trigger className="pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90 motion-reduce:transition-none rtl:-scale-x-100"
          />
          {t("accounts.advanced")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-opacity">
          <AccountForm
            entry={entry}
            actions={actions}
            defaultEdits={defaultEdits ?? noAccountEdits}
          />
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

/**
 * An account's name, the program it runs and its launch options, which Save
 * sends only once they are what the server takes, saying first when saving
 * restarts the account; where it keeps its sign-in, which J3 Bots chooses;
 * and Remove, for an account the operator added.
 */
function AccountForm({
  entry,
  actions,
  defaultEdits,
}: {
  readonly entry: SetUpAccount;
  readonly actions: ProviderActions;
  readonly defaultEdits: AccountEdits;
}) {
  const { t } = useI18n();
  const { provider, setup } = entry;
  const ids = {
    name: useId(),
    binaryPath: useId(),
    binaryPathHint: useId(),
    launchArguments: useId(),
    launchArgumentsHint: useId(),
    home: useId(),
    errors: { name: useId(), binaryPath: useId(), launchArguments: useId() },
  };
  const [edits, setEdits] = useState(defaultEdits);
  const [saving, setSaving] = useState<Asking>("idle");
  const [removing, setRemoving] = useState(false);
  const [removal, setRemoval] = useState<Asking>("idle");
  const patch = accountPatch(provider.name, setup, edits);
  const invalid = (field: AccountField) => patch._tag === "invalid" && patch.fields.has(field);
  const edit = (change: Partial<AccountEdits>) => {
    setEdits((current) => ({ ...current, ...change }));
    if (saving === "failed") setSaving("idle");
  };
  const fieldProps = (field: AccountField, hint: string | null) => ({
    "aria-invalid": invalid(field) || undefined,
    "aria-describedby":
      [hint, invalid(field) ? ids.errors[field] : null].filter((id) => id !== null).join(" ") ||
      undefined,
    readOnly: saving === "asking",
  });
  const errorText = (field: AccountField, text: string) =>
    invalid(field) ? (
      <p id={ids.errors[field]} className="text-xs text-blocked">
        {text}
      </p>
    ) : null;
  const save = () => {
    if (patch._tag !== "changes" || saving === "asking") return;
    setSaving("asking");
    void actions.setUpAccount(provider.id, patch.changes).then((took) => {
      setSaving(took ? "idle" : "failed");
      if (took) setEdits(noAccountEdits);
    });
  };
  return (
    <form
      className="flex flex-col gap-3 pt-2 pb-1"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.name} className="text-xs">
          {t("accounts.name")}
        </label>
        <input
          id={ids.name}
          value={edits.name ?? provider.name}
          autoComplete="off"
          onChange={(event) => edit({ name: event.currentTarget.value })}
          className={lineField}
          {...fieldProps("name", null)}
        />
        {errorText("name", t("accounts.name.invalid"))}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.binaryPath} className="text-xs">
          {t("accounts.binaryPath")}
        </label>
        <input
          id={ids.binaryPath}
          value={edits.binaryPath ?? setup.binaryPath ?? ""}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("accounts.binaryPath.placeholder")}
          onChange={(event) => edit({ binaryPath: event.currentTarget.value })}
          className={`${lineField} font-mono`}
          {...fieldProps("binaryPath", ids.binaryPathHint)}
        />
        <p id={ids.binaryPathHint} className="text-xs text-muted-foreground">
          {t("accounts.binaryPath.hint")}
        </p>
        {errorText("binaryPath", t("accounts.binaryPath.invalid"))}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.launchArguments} className="text-xs">
          {t("accounts.launchArguments")}
        </label>
        <input
          id={ids.launchArguments}
          value={edits.launchArguments ?? setup.launchArguments}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => edit({ launchArguments: event.currentTarget.value })}
          className={`${lineField} font-mono`}
          {...fieldProps("launchArguments", ids.launchArgumentsHint)}
        />
        <p id={ids.launchArgumentsHint} className="text-xs text-muted-foreground">
          {t("accounts.launchArguments.hint")}
        </p>
        {errorText("launchArguments", t("accounts.launchArguments.invalid"))}
      </div>
      <div className="flex flex-col gap-1">
        <p id={ids.home} className="text-xs">
          {t("accounts.home")}
        </p>
        <p
          aria-labelledby={ids.home}
          className="font-mono text-xs break-all text-muted-foreground select-text"
        >
          {setup.home}
        </p>
        <p className="text-xs text-muted-foreground">{t("accounts.home.hint")}</p>
      </div>
      {patch._tag === "changes" && patch.rebuild && (
        <p role="status" className="text-xs text-pretty text-waiting">
          {t("accounts.restarts")}
        </p>
      )}
      {saving === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("accounts.saveFailed")}
        </p>
      )}
      {removal === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("accounts.remove.failed")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {setup.added && (
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={removal === "asking"}
            onClick={() => setRemoving(true)}
          >
            {t("accounts.remove")}
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          variant="primary"
          className="ms-auto"
          aria-disabled={patch._tag !== "changes" || saving === "asking"}
        >
          {saving === "asking" ? t("accounts.saving") : t("accounts.save")}
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("accounts.remove.title", { name: provider.name })}
        body={t("accounts.remove.body")}
        cancel={t("ai.cancel")}
        confirm={t("accounts.remove.confirm")}
        onConfirm={() => {
          setRemoval("asking");
          void actions
            .removeAccount(provider.id)
            .then((took) => setRemoval(took ? "idle" : "failed"));
        }}
      />
    </form>
  );
}

/** Another Claude or ChatGPT account, which then signs in on its own row. */
function AddAccount({
  engine,
  actions,
}: {
  readonly engine: EngineStatus;
  readonly actions: ProviderActions;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState<Asking>("idle");
  const add = (harness: SignInHarness) => {
    setAdding("asking");
    const base =
      harness === "claude-code" ? t("accounts.add.name.claude-code") : t("accounts.add.name.codex");
    void actions
      .addAccount(harness, newAccountName(engine, harness, base))
      .then((took) => setAdding(took ? "idle" : "failed"));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Menu>
          <MenuTrigger disabled={adding === "asking"} render={<Button size="sm" />}>
            <PlusIcon aria-hidden />
            {t("accounts.add")}
          </MenuTrigger>
          <MenuPopup side="bottom">
            {harnesses.map((harness) => (
              <MenuItem key={harness} onClick={() => add(harness)}>
                {harness === "claude-code"
                  ? t("accounts.add.claude-code")
                  : t("accounts.add.codex")}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">
          {t("accounts.add.hint")}
        </p>
      </div>
      {adding === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("accounts.add.failed")}
        </p>
      )}
    </div>
  );
}
