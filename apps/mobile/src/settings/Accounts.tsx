// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AccountEdits,
  type AccountField,
  accountPatch,
  newAccountName,
  noAccountEdits,
  ownHarness,
  type SetUpAccount,
  setUpAccounts,
} from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client } from "@j3-bots/client-runtime/react";
import type { EngineStatus, SignInHarness } from "@j3-bots/contracts";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { SetUpAccountRow } from "../components/AiConnect.tsx";
import { OwnHarnessLine, ProviderUpdate } from "../components/Engine.tsx";
import { DeleteButton, Problem, SwitchRow, TextField } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

// Settings' AI accounts on a server that lets the operator set each up
// (decision 0108): each Claude Code and Codex account with where it stands,
// its switch and, under Advanced, its name, program, launch options and the
// folder of its sign-in; then adding another. The web draws the same.

/** The words of each harness's new account. */
const addWords = {
  "claude-code": { label: "accounts.add.claude-code", base: "accounts.add.name.claude-code" },
  codex: { label: "accounts.add.codex", base: "accounts.add.name.codex" },
} as const satisfies Record<SignInHarness, { readonly label: string; readonly base: string }>;

const harnesses = ["claude-code", "codex"] as const satisfies ReadonlyArray<SignInHarness>;

/** Every account the operator set up, one row each, and Add account under them. */
export function SetUpAccounts(props: { readonly engine: EngineStatus; readonly stale: boolean }) {
  const { t } = useI18n();
  return (
    <View accessibilityLabel={t("ai.choice.label")} className="w-full gap-2">
      {setUpAccounts(props.engine).map((each) => (
        <AccountRow
          key={each.provider.id}
          engine={props.engine}
          account={each}
          stale={props.stale}
        />
      ))}
      {!props.stale && <AddAccount engine={props.engine} />}
    </View>
  );
}

/** One account: its row, with the version it runs once connected, and what the operator sets up. */
function AccountRow(props: {
  readonly engine: EngineStatus;
  readonly account: SetUpAccount;
  readonly stale: boolean;
}) {
  const { provider } = props.account;
  const own = ownHarness(provider);
  return (
    <SetUpAccountRow
      engine={props.engine}
      account={props.account.account}
      stale={props.stale}
      settings={props.stale ? null : <AccountSettings account={props.account} />}
    >
      {own === null ? <ProviderUpdate provider={provider} /> : <OwnHarnessLine own={own} />}
    </SetUpAccountRow>
  );
}

/** A request this screen made of an account: under way, or the last one the server refused. */
type Asking = "idle" | "asking" | "failed";

/**
 * The account's switch, which saves at once, and under Advanced its name,
 * program and launch options, saved together, the folder its sign-in is kept
 * in, and Remove for one the operator added.
 */
function AccountSettings({ account }: { readonly account: SetUpAccount }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const connected = useConnection()._tag === "connected";
  const { provider, setup } = account;
  const name = provider.name;
  const [switching, setSwitching] = useState<Asking>("idle");
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<AccountEdits>(noAccountEdits);
  const [saving, setSaving] = useState<Asking>("idle");
  const [removeFailed, setRemoveFailed] = useState(false);
  const patch = accountPatch(name, setup, edits);
  const readOnly = !connected || saving === "asking";
  const fieldError = (field: AccountField, words: string) =>
    patch._tag === "invalid" && patch.fields.has(field) ? words : null;
  const edit = (change: Partial<AccountEdits>) => {
    setEdits((current) => ({ ...current, ...change }));
    if (saving === "failed") setSaving("idle");
  };
  return (
    <View className="gap-2 border-t border-border pt-2">
      <SwitchRow
        label={t("accounts.use", { name })}
        hint={t(setup.enabled ? "accounts.on" : "accounts.off")}
        value={setup.enabled}
        readOnly={!connected || switching === "asking"}
        onChange={(enabled) => {
          setSwitching("asking");
          void client
            .setUpAccount(provider.id, { enabled })
            .then((result) => setSwitching(result._tag === "done" ? "idle" : "failed"));
        }}
      />
      <Problem>{switching === "failed" ? t("accounts.saveFailed") : null}</Problem>
      <PressScale
        accessibilityRole="button"
        accessibilityLabel={t("accounts.advanced")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((now) => !now)}
        className="min-h-11 flex-row items-center gap-1.5 self-start"
      >
        <Icon icon={open ? ChevronDown : ChevronRight} color="accent-muted-foreground" size={14} />
        <Text className="text-sm text-muted-foreground">{t("accounts.advanced")}</Text>
      </PressScale>
      {open && (
        <View className="gap-4">
          <TextField
            label={t("accounts.name")}
            value={edits.name ?? name}
            readOnly={readOnly}
            autoCapitalize="words"
            onChange={(value) => edit({ name: value })}
            error={fieldError("name", t("accounts.name.invalid"))}
          />
          <TextField
            label={t("accounts.binaryPath")}
            value={edits.binaryPath ?? setup.binaryPath ?? ""}
            placeholder={t("accounts.binaryPath.placeholder")}
            hint={t("accounts.binaryPath.hint")}
            readOnly={readOnly}
            autoCapitalize="none"
            onChange={(value) => edit({ binaryPath: value })}
            error={fieldError("binaryPath", t("accounts.binaryPath.invalid"))}
          />
          <TextField
            label={t("accounts.launchArguments")}
            value={edits.launchArguments ?? setup.launchArguments}
            hint={t("accounts.launchArguments.hint")}
            readOnly={readOnly}
            autoCapitalize="none"
            onChange={(value) => edit({ launchArguments: value })}
            error={fieldError("launchArguments", t("accounts.launchArguments.invalid"))}
          />
          <View className="gap-1">
            <Text className="text-sm text-foreground">{t("accounts.home")}</Text>
            <Text selectable className="text-sm text-muted-foreground">
              {setup.home}
            </Text>
            <Text className="text-xs text-muted-foreground">{t("accounts.home.hint")}</Text>
          </View>
          {patch._tag === "changes" && patch.rebuild && (
            <Text className="text-sm text-muted-foreground">{t("accounts.restarts")}</Text>
          )}
          <Problem>
            {saving === "failed"
              ? t("accounts.saveFailed")
              : removeFailed
                ? t("accounts.remove.failed")
                : null}
          </Problem>
          <View className="flex-row flex-wrap justify-end gap-2">
            {setup.added && (
              <DeleteButton
                label={t("accounts.remove")}
                title={t("accounts.remove.title", { name })}
                body={t("accounts.remove.body")}
                cancel={t("editBot.cancel")}
                onDelete={() =>
                  client
                    .removeAccount(provider.id)
                    .then((result) => setRemoveFailed(result._tag !== "done"))
                }
              />
            )}
            <Button
              variant="primary"
              label={saving === "asking" ? t("accounts.saving") : t("accounts.save")}
              disabled={patch._tag !== "changes" || !connected}
              held={saving === "asking"}
              onPress={() => {
                if (patch._tag !== "changes") return;
                setSaving("asking");
                void client.setUpAccount(provider.id, patch.changes).then((result) => {
                  if (result._tag === "done") {
                    setEdits(noAccountEdits);
                    setSaving("idle");
                  } else {
                    setSaving("failed");
                  }
                });
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Add account, which asks whose: another Claude or another ChatGPT account,
 * each signed in on its own. Its first name is the AI's, numbered.
 */
function AddAccount({ engine }: { readonly engine: EngineStatus }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const connected = useConnection()._tag === "connected";
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<Asking>("idle");
  return (
    <View className="gap-1">
      <View className="flex-row">
        <Button
          variant="secondary"
          label={t("accounts.add")}
          disabled={!connected}
          held={adding === "asking"}
          onPress={() => setOpen(true)}
        />
      </View>
      <Problem>{adding === "failed" ? t("accounts.add.failed") : null}</Problem>
      <Sheet open={open} title={t("accounts.add")} onClose={() => setOpen(false)}>
        <View className="gap-2">
          <Text className="text-sm text-muted-foreground">{t("accounts.add.hint")}</Text>
          {harnesses.map((harness) => (
            <Button
              key={harness}
              variant="outline"
              label={t(addWords[harness].label)}
              onPress={() => {
                setOpen(false);
                setAdding("asking");
                const name = newAccountName(engine, harness, t(addWords[harness].base));
                void client
                  .addAccount(harness, name)
                  .then((result) => setAdding(result._tag === "done" ? "idle" : "failed"));
              }}
            />
          ))}
        </View>
      </Sheet>
    </View>
  );
}
