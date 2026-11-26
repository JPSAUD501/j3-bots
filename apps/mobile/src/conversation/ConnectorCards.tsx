// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  type InputDraft,
  type InputProblem,
  inputContent,
  inputDrafts,
  inputProblem,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type {
  ConnectorAuthEntry,
  ConnectorInputEntry,
  ElicitationAnswer,
  ElicitationField,
} from "@j3-bots/contracts";
import { MessageSquareText, PlugZap } from "lucide-react-native";
import { useState } from "react";
import { Linking, View } from "react-native";
import { SwitchRow, TextField } from "../components/form.tsx";
import { ConnectorTile } from "../connectors/parts.tsx";
import { useOpenConnectors } from "../connectors/intents.ts";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";
import { choiceRow, Indicator } from "./QuestionCard.tsx";

/**
 * A connector a bot called, or added, needs the operator to sign in. Sign in
 * opens the connector's page with its sign-in started. The card closes once
 * the connector works, or is removed.
 */
export function ConnectorAuthCard({ entry }: { readonly entry: ConnectorAuthEntry }) {
  const { t } = useI18n();
  const open = useOpenConnectors();
  const pending = entry.status === "pending";
  const { outcome } = useOutcomeFocus(pending);
  return (
    <CardFrame icon={PlugZap} title={t("connectorCard.auth.title")} attention={pending}>
      <View className="flex-row items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <Text className="min-w-0 flex-1 text-base text-foreground">
          {t("connectorCard.auth.body", { name: entry.name })}
        </Text>
      </View>
      {pending ? (
        <View className="flex-row justify-end">
          <Button
            variant="primary"
            label={t("connectorCard.signIn")}
            onPress={() =>
              open({
                at: {
                  _tag: "connector",
                  connectorId: entry.connectorId,
                  signIn: true,
                  added: false,
                },
                forBot: entry.author.botId,
              })
            }
          />
        </View>
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status === "signed-in"
            ? t("connectorCard.signedIn")
            : t("connectorCard.removed", { name: entry.name })}
        </Text>
      )}
    </CardFrame>
  );
}

type ClosedInput = Exclude<ConnectorInputEntry["status"], { readonly _tag: "pending" }>;

const closedInputText = (status: ClosedInput) => {
  if (status._tag === "expired") return "connectorInput.closed.expired" as const;
  switch (status.action) {
    case "accept":
      return "connectorInput.closed.accept" as const;
    case "decline":
      return "connectorInput.closed.decline" as const;
    case "cancel":
      return "connectorInput.closed.cancel" as const;
  }
};

/**
 * A connector's server asks the operator for something in the middle of a
 * bot's call, which waits on the answer: a few fields to fill in, or a page of
 * its own to open, named by its host. The answer goes to the server only.
 * Decline says no; Not now lets the server ask again later. Once answered,
 * here or elsewhere, or once the call ended, the card says how it closed.
 */
export function ConnectorInputCard({ entry }: { readonly entry: ConnectorInputEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const submitting = useSubmitting(entry.id);
  const pending = entry.status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const { request } = entry;
  const fields = request._tag === "form" ? request.fields : [];
  const [drafts, setDrafts] = useState(() => inputDrafts(fields));
  // Problems show once the operator tried to send, not while they type.
  const [tried, setTried] = useState(false);
  const answer = (given: ElicitationAnswer) => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "connector-input", answer: given }).then((result) => {
      if (refusedWith(result, "connector-input")) say(t("connectorInput.refused"));
    });
  };
  const send = () => {
    const content = inputContent(fields, drafts);
    setTried(true);
    if (content !== null) answer({ _tag: "accept", content });
  };
  return (
    <CardFrame icon={MessageSquareText} title={t("connectorInput.title")} attention={pending}>
      <View className="flex-row items-center gap-3">
        <ConnectorTile name={entry.name} glyph={entry.glyph} />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-medium text-foreground">
            {entry.name}
          </Text>
          {request.message !== "" && (
            <Text className="text-sm text-foreground">{request.message}</Text>
          )}
        </View>
      </View>
      {request._tag === "url" && (
        <Text className="text-sm text-muted-foreground">
          {t("connectorInput.page", { name: entry.name, host: request.host })}
        </Text>
      )}
      {pending && request._tag === "form" && (
        <View className="gap-3">
          {fields.map((field) => (
            <InputField
              key={field.key}
              field={field}
              draft={drafts[field.key]}
              problem={tried ? inputProblem(field, drafts[field.key]) : null}
              readOnly={submitting}
              onChange={(draft) => setDrafts((all) => ({ ...all, [field.key]: draft }))}
            />
          ))}
          <Text className="text-xs text-muted-foreground">
            {t("connectorInput.private", { name: entry.name })}
          </Text>
        </View>
      )}
      {pending ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            label={t("connectorInput.decline")}
            held={submitting}
            onPress={() => answer({ _tag: "decline" })}
          />
          <Button
            variant="outline"
            label={t("connectorInput.notNow")}
            held={submitting}
            onPress={() => answer({ _tag: "cancel" })}
          />
          {request._tag === "form" ? (
            <Button
              variant="primary"
              label={t("connectorInput.send")}
              held={submitting}
              onPress={send}
            />
          ) : (
            <Button
              variant="primary"
              label={t("connectorInput.open", { host: request.host })}
              held={submitting}
              onPress={() => {
                if (submitting) return;
                // The server waits on its page: it is opened, and the card answered.
                void Linking.openURL(request.url).catch(() => undefined);
                answer({ _tag: "accept", content: {} });
              }}
            />
          )}
        </View>
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {t(closedInputText(entry.status))}
        </Text>
      )}
    </CardFrame>
  );
}

/** One field of a connector's form, as its kind takes it. */
function InputField({
  field,
  draft,
  problem,
  readOnly,
  onChange,
}: {
  readonly field: ElicitationField;
  readonly draft: InputDraft | undefined;
  readonly problem: InputProblem | null;
  readonly readOnly: boolean;
  readonly onChange: (draft: InputDraft) => void;
}) {
  const { t } = useI18n();
  const label = field.required ? field.label : t("connectorInput.optional", { label: field.label });
  const problemText =
    problem === null
      ? null
      : problem === "required"
        ? t("connectorInput.required")
        : t("connectorInput.invalid");
  const hint = field.description ?? undefined;
  if (field._tag === "boolean") {
    return (
      <SwitchRow
        label={field.label}
        {...(hint === undefined ? {} : { hint })}
        value={draft === true}
        onChange={onChange}
        readOnly={readOnly}
      />
    );
  }
  if (field._tag === "choice") {
    const picked = typeof draft === "object" ? draft : [];
    const toggle = (value: string) =>
      onChange(
        field.multiple
          ? picked.includes(value)
            ? picked.filter((one) => one !== value)
            : [...picked, value]
          : [value],
      );
    return (
      <View
        accessibilityRole={field.multiple ? "list" : "radiogroup"}
        accessibilityLabel={label}
        className="gap-1.5"
      >
        <Text className="text-sm text-foreground">{label}</Text>
        {hint !== undefined && <Text className="text-xs text-muted-foreground">{hint}</Text>}
        {field.options.map((option) => {
          const checked = picked.includes(option.value);
          return (
            <PressScale
              key={option.value}
              depth="row"
              accessibilityRole={field.multiple ? "checkbox" : "radio"}
              accessibilityState={{ checked, disabled: readOnly }}
              onPress={readOnly ? undefined : () => toggle(option.value)}
              className={choiceRow(checked)}
            >
              <Indicator shape={field.multiple ? "square" : "round"} checked={checked} />
              <Text className="min-w-0 flex-1 text-sm text-foreground">{option.label}</Text>
            </PressScale>
          );
        })}
        {problemText !== null && <Text className="text-xs text-blocked">{problemText}</Text>}
      </View>
    );
  }
  const plain = field._tag === "text" && field.format !== null;
  return (
    <TextField
      label={label}
      value={typeof draft === "string" ? draft : ""}
      onChange={onChange}
      {...(hint === undefined ? {} : { hint })}
      error={problemText}
      readOnly={readOnly}
      {...(plain || field._tag === "number" ? { autoCapitalize: "none" as const } : {})}
    />
  );
}
