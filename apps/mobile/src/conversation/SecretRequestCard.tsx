// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_SECRET_REQUEST_VALUE_LENGTH,
  type SecretRequestInput,
  secretRequestAnswer,
  secretRequestInputs,
  webAddress,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { SecretRequestEntry } from "@j3-bots/contracts";
import { ExternalLink, Eye, EyeOff, KeyRound } from "lucide-react-native";
import { type Ref, useRef, useState } from "react";
import { Linking, type TextInputInstance, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";
import { PressScale } from "../press.tsx";

/**
 * A bot asking for credentials only the operator has: one value, or several
 * at once, such as an email and a password. Each value is typed into its own
 * input, masked unless the bot said it is not secret, and handed on as a
 * `Redacted`, so it never reaches a log, and nothing on the phone keeps it:
 * not the drafts, not the keyboard's suggestions. The inputs live only as
 * long as the request waits; once it is answered, here or elsewhere, or
 * expires, the values are gone and the card only says what happened.
 */
export function SecretRequestCard({ entry }: { readonly entry: SecretRequestEntry }) {
  const { t, plural } = useI18n();
  const pending = entry.status === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const inputs = secretRequestInputs(entry);
  return (
    <CardFrame icon={KeyRound} title={t("secret.title")} attention={pending}>
      <View className="gap-1">
        <Text className="text-sm font-medium text-foreground">{entry.label}</Text>
        {entry.reason !== "" && (
          <Text className="text-sm text-muted-foreground">{entry.reason}</Text>
        )}
      </View>
      {entry.status === "pending" ? (
        <SecretForm entry={entry} inputs={inputs} onAnswer={answered} />
      ) : (
        <Text ref={outcome} className="text-xs text-muted-foreground">
          {entry.status === "expired"
            ? t("secret.expired")
            : plural(
                entry.status === "provided" ? "secret.provided" : "secret.declined",
                inputs.length,
              )}
        </Text>
      )}
    </CardFrame>
  );
}

/**
 * The inputs and their actions. Unmounted with the request, taking the typed
 * values with it. The keyboard's action moves to the first input still empty,
 * and sends once every one is filled. While an answer is on its way they take
 * no second one but keep their place.
 */
function SecretForm({
  entry,
  inputs,
  onAnswer,
}: {
  readonly entry: SecretRequestEntry;
  readonly inputs: ReadonlyArray<SecretRequestInput>;
  readonly onAnswer: () => void;
}) {
  const { t, plural } = useI18n();
  const client = useJ3Client();
  const submitting = useSubmitting(entry.id);
  const [values, setValues] = useState<ReadonlyArray<string>>(() => inputs.map(() => ""));
  // Each input, by position, so the keyboard's action can move to the first one still empty.
  const fields = useRef<Array<TextInputInstance | null>>([]);
  const link = webAddress(entry.url);
  const result = secretRequestAnswer(inputs, values);
  const single = entry.fields.length === 0;
  const note =
    entry.delivery === "reference"
      ? plural("secret.unseen", inputs.length)
      : entry.delivery === "file"
        ? plural("secret.inFile", inputs.length)
        : null;
  const provide = () => {
    if (submitting) return;
    if (result._tag === "blank") {
      fields.current[result.position]?.focus();
      return;
    }
    onAnswer();
    void client.provideSecret(entry.id, result.answer);
    setValues(inputs.map(() => ""));
  };
  const decline = () => {
    if (submitting) return;
    onAnswer();
    void client.provideSecret(entry.id, { _tag: "decline" });
  };
  return (
    <>
      {inputs.map((input, position) => (
        <SecretInput
          key={input.id ?? "value"}
          ref={(element) => {
            fields.current[position] = element;
          }}
          input={input}
          labelled={!single}
          hint={single && entry.reason !== "" ? entry.reason : undefined}
          value={values[position] ?? ""}
          onChange={(value) =>
            setValues((typed) => typed.map((old, at) => (at === position ? value : old)))
          }
          last={position === inputs.length - 1}
          onSubmit={provide}
          submitting={submitting}
        />
      ))}
      {note !== null && <Text className="text-xs text-muted-foreground">{note}</Text>}
      <View className="flex-row flex-wrap items-center gap-2">
        {link !== null && (
          <PressScale
            accessibilityRole="link"
            onPress={() => void Linking.openURL(link)}
            className="min-h-11 flex-row items-center gap-1"
          >
            <Text className="text-xs text-muted-foreground underline">{t("secret.getOne")}</Text>
            <Icon icon={ExternalLink} size={12} color="accent-muted-foreground" />
          </PressScale>
        )}
        <View className="ms-auto flex-row gap-2">
          <Button
            variant="outline"
            label={t("secret.decline")}
            onPress={decline}
            held={submitting}
          />
          <Button
            variant="primary"
            label={t("secret.provide")}
            onPress={provide}
            disabled={result._tag === "blank"}
            held={submitting}
          />
        </View>
      </View>
    </>
  );
}

/**
 * One value's input: shown as typed, or masked with a button that shows it.
 * Only a login's user name and password are offered to the phone's autofill.
 * A masked value shown stays a password to the keyboard, which learns nothing
 * from it.
 */
function SecretInput({
  ref,
  input,
  labelled,
  hint,
  value,
  onChange,
  last,
  onSubmit,
  submitting,
}: {
  readonly ref: Ref<TextInputInstance>;
  readonly input: SecretRequestInput;
  /** Whether it shows its own label; the one input of a request for one value has the card's. */
  readonly labelled: boolean;
  readonly hint: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The last input sends; the others move on. */
  readonly last: boolean;
  readonly onSubmit: () => void;
  readonly submitting: boolean;
}) {
  const { t } = useI18n();
  const placeholderColor = useColor("accent-muted-foreground");
  const [shown, setShown] = useState(false);
  const autofill = input.autofill;
  return (
    <View className="gap-1">
      {labelled && <Text className="text-xs font-medium text-foreground">{input.label}</Text>}
      <View className="justify-center">
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChange}
          editable={!submitting}
          secureTextEntry={input.masked && !shown}
          keyboardType={input.masked && shown ? "visible-password" : "default"}
          maxLength={MAX_SECRET_REQUEST_VALUE_LENGTH}
          autoComplete={autofill ?? "off"}
          importantForAutofill={autofill === null ? "no" : "yes"}
          textContentType={autofill ?? "none"}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          returnKeyType={last ? "done" : "next"}
          submitBehavior={last ? "blurAndSubmit" : "submit"}
          onSubmitEditing={onSubmit}
          placeholder={input.placeholder ?? undefined}
          placeholderTextColor={placeholderColor}
          accessibilityLabel={input.label}
          accessibilityHint={hint}
          className={`min-h-11 rounded-md border border-input bg-surface px-3 text-base text-foreground ${input.masked ? "pe-12" : ""}`}
        />
        {input.masked && (
          <PressScale
            accessibilityRole="togglebutton"
            accessibilityLabel={t("secret.show", { label: input.label })}
            accessibilityState={{ checked: shown }}
            onPress={() => setShown((was) => !was)}
            className="absolute end-0 min-h-11 min-w-11 items-center justify-center"
          >
            <Icon icon={shown ? EyeOff : Eye} size={18} color="accent-muted-foreground" />
          </PressScale>
        )}
      </View>
    </View>
  );
}
