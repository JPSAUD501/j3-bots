// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type PromptOption,
  promptArguments,
  promptOptions,
  promptQuery,
} from "@j3-bots/client-runtime/presentation";
import type { IntentResult } from "@j3-bots/client-runtime";
import { useConnectors, useJ3Client } from "@j3-bots/client-runtime/react";
import type { BotId } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { ScrollView, View } from "react-native";
import { Problem, TextField } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

/** The prompt the operator picked, while they fill in its arguments or its server writes it. */
interface ChosenPrompt {
  readonly prompt: PromptOption;
  readonly drafts: Readonly<Record<string, string>>;
  readonly writing: boolean;
  readonly failed: boolean;
  /** Use was pressed: an empty required argument says so. */
  readonly tried: boolean;
}

/**
 * The `/` menu of a bot's conversation: while the whole draft is `/` and a
 * word, the prompts its connectors offer that match it, read when the `/` is
 * typed. A pick with no arguments is written at once; one with arguments opens
 * a small form first. What the server writes goes to `onWritten`, which makes
 * it the draft. Without `botId`, as in a room, it never opens.
 */
export function usePromptPicker({
  botId,
  text,
  focused,
  onWritten,
}: {
  botId: BotId | null;
  text: string;
  focused: boolean;
  onWritten: (text: string, cut: boolean) => void;
}) {
  const client = useJ3Client();
  const connectors = useConnectors();
  const [prompts, setPrompts] = useState<ReadonlyArray<PromptOption>>([]);
  const [chosen, setChosen] = useState<ChosenPrompt | null>(null);

  const query = botId === null || !focused || chosen !== null ? null : promptQuery(text);
  const typing = query !== null;
  // Each `/` reads them again: a server can change what it offers at any time.
  const load = useEffectEvent((id: BotId) =>
    client.connectors.prompts(id).then((result) => {
      const known = connectors._tag === "ready" ? connectors.value : [];
      return result._tag === "done"
        ? result.value.flatMap((prompt) => {
            const connector = known.find((one) => one.id === prompt.connectorId);
            return connector === undefined ? [] : [{ ...prompt, connector: connector.name }];
          })
        : [];
    }),
  );
  useEffect(() => {
    if (!typing || botId === null) return;
    let current = true;
    void load(botId).then((list) => {
      if (current) setPrompts(list);
    });
    return () => {
      current = false;
    };
  }, [typing, botId]);

  const write = (prompt: PromptOption, drafts: Readonly<Record<string, string>>) => {
    const given = promptArguments(prompt, drafts);
    if (given === null || botId === null) {
      setChosen({ prompt, drafts, writing: false, failed: false, tried: true });
      return;
    }
    const writing: ChosenPrompt = { prompt, drafts, writing: true, failed: false, tried: true };
    setChosen(writing);
    void client.connectors
      .renderPrompt({
        botId,
        connectorId: prompt.connectorId,
        name: prompt.name,
        arguments: given,
      })
      .then((result) => written(writing, result));
  };
  // An answer for a prompt cancelled, or left for another conversation, writes nothing.
  const written = useEffectEvent(
    (
      asked: ChosenPrompt,
      result: IntentResult<{ readonly text: string; readonly cut: boolean }>,
    ) => {
      if (chosen !== asked) return;
      if (result._tag === "failed") {
        setChosen({ ...asked, writing: false, failed: true });
        return;
      }
      setChosen(null);
      onWritten(result.value.text, result.value.cut);
    },
  );

  return {
    options: query === null ? [] : promptOptions(query, prompts),
    chosen,
    pick: (prompt: PromptOption) => {
      const drafts = Object.fromEntries(prompt.arguments.map((argument) => [argument.name, ""]));
      if (prompt.arguments.length === 0) write(prompt, drafts);
      else setChosen({ prompt, drafts, writing: false, failed: false, tried: false });
    },
    fill: (name: string, value: string) =>
      setChosen((was) =>
        was === null ? null : { ...was, drafts: { ...was.drafts, [name]: value }, failed: false },
      ),
    use: () => {
      if (chosen !== null && !chosen.writing) write(chosen.prompt, chosen.drafts);
    },
    cancel: () => setChosen(null),
  };
}

/** The prompts that match what follows `/`, above the composer. A tap picks. */
export function PromptList({
  options,
  onPick,
}: {
  readonly options: ReadonlyArray<PromptOption>;
  readonly onPick: (prompt: PromptOption) => void;
}) {
  const { t } = useI18n();
  return (
    <ScrollView
      accessibilityLabel={t("prompt.menu")}
      // A tap picks without closing the keyboard.
      keyboardShouldPersistTaps="always"
      className="max-h-72 grow-0 rounded-lg border border-border bg-surface"
      contentContainerClassName="p-1"
    >
      {options.map((prompt) => (
        <PressScale
          key={`${prompt.connectorId}:${prompt.name}`}
          depth="row"
          accessibilityRole="button"
          onPress={() => onPick(prompt)}
          className="min-h-11 justify-center rounded-md px-2 py-1.5 active:bg-muted"
        >
          <View className="flex-row items-baseline gap-2">
            <Text numberOfLines={1} className="shrink text-base text-foreground">
              {prompt.title ?? prompt.name}
            </Text>
            <Text className="text-xs text-muted-foreground">{prompt.connector}</Text>
          </View>
          {prompt.description !== "" && (
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {prompt.description}
            </Text>
          )}
        </PressScale>
      ))}
    </ScrollView>
  );
}

/**
 * The arguments of the prompt the operator picked, above the composer. Use
 * prompt has its server write it into the draft; Cancel leaves the draft as it
 * was. A server that did not write it says so, and Use prompt tries again.
 */
export function PromptForm({
  chosen,
  onFill,
  onUse,
  onCancel,
}: {
  readonly chosen: ChosenPrompt;
  readonly onFill: (name: string, value: string) => void;
  readonly onUse: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const { prompt } = chosen;
  return (
    <View className="gap-3 rounded-lg border border-border bg-surface p-3">
      <View>
        <Text accessibilityRole="header" className="text-base font-medium text-foreground">
          {prompt.title ?? prompt.name}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {prompt.description === ""
            ? prompt.connector
            : `${prompt.connector} · ${prompt.description}`}
        </Text>
      </View>
      {prompt.arguments.map((argument) => {
        const name = argument.title ?? argument.name;
        const value = chosen.drafts[argument.name] ?? "";
        const missing = chosen.tried && argument.required && value.trim() === "";
        return (
          <TextField
            key={argument.name}
            label={argument.required ? name : t("prompt.optional", { label: name })}
            value={value}
            onChange={(next) => onFill(argument.name, next)}
            {...(argument.description === "" ? {} : { hint: argument.description })}
            error={missing ? t("connectorInput.required") : null}
            readOnly={chosen.writing}
          />
        );
      })}
      <Problem>
        {chosen.failed ? t("prompt.failed", { connector: prompt.connector }) : null}
      </Problem>
      <View className="flex-row flex-wrap justify-end gap-2">
        <Button variant="outline" label={t("prompt.cancel")} onPress={onCancel} />
        <Button variant="primary" label={t("prompt.use")} held={chosen.writing} onPress={onUse} />
      </View>
    </View>
  );
}
