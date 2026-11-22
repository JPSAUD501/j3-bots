// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PairingFailure, ServerAddressProblem, UnpairedReason } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import * as DateTime from "effect/DateTime";
import * as Device from "expo-device";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PairingScanner } from "../components/PairingScanner.tsx";
import { useI18n } from "../i18n.ts";
import { session } from "../platform/platform.ts";
import { phoneTimeZone } from "../platform/timeZone.ts";
import { Body, Button, Title } from "../ui.tsx";

type Problem =
  | { readonly _tag: "address"; readonly problem: ServerAddressProblem }
  | { readonly _tag: "failed"; readonly reason: PairingFailure };

type FormState =
  | { readonly _tag: "editing" }
  | { readonly _tag: "pairing" }
  | { readonly _tag: "refused"; readonly problem: Problem };

/** The name the operator sees for this phone in their list of devices, until they change it. */
const defaultDeviceName = () => Device.deviceName ?? Device.modelName ?? "";

const fieldClass = "min-h-11 rounded-md border bg-muted px-3 text-base text-foreground";

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly invalid: boolean;
  readonly kind: "address" | "code" | "name";
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        aria-invalid={props.invalid}
        value={props.value}
        onChangeText={props.onChange}
        autoCorrect={false}
        spellCheck={false}
        autoCapitalize={
          props.kind === "code" ? "characters" : props.kind === "name" ? "sentences" : "none"
        }
        keyboardType={props.kind === "address" ? "url" : "default"}
        textContentType={props.kind === "code" ? "oneTimeCode" : "none"}
        maxLength={props.kind === "address" ? 2048 : props.kind === "code" ? 24 : 200}
        face={props.kind === "code" ? "mono" : "text"}
        className={`${fieldClass} ${props.invalid ? "border-blocked" : "border-transparent"} ${props.kind === "code" ? "tracking-widest" : ""}`}
      />
    </View>
  );
}

/**
 * The first screen on a new phone: where J3 Bots runs, the code from
 * `j3-bots pair` or a paired device, and a name for this phone. Once paired,
 * the app opens by itself.
 */
export function PairingScreen(props: {
  /** The server the app last ran a client for, which the address starts with. */
  readonly server: URL | null;
  /** Why this phone has no credential, said above the form unless it never had one. */
  readonly reason: UnpairedReason;
}) {
  const i18n = useI18n();
  const { t, parts } = i18n;
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState(props.server?.origin ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName);
  const [state, setState] = useState<FormState>({ _tag: "editing" });
  const [scanning, setScanning] = useState(false);

  // A lockout only shows its time: the server enforces it, and the operator
  // can lift it on the host before then, so Pair stays available.
  const busy = state._tag === "pairing";
  const ready = address.trim() !== "" && code.trim() !== "" && name.trim() !== "" && !busy;

  const problemText = (problem: Problem): string => {
    if (problem._tag === "address") {
      return problem.problem === "needs-https"
        ? t("server.needsHttps")
        : t("server.invalid", { command: "j3-bots pair" });
    }
    const reason = problem.reason;
    switch (reason._tag) {
      case "invalid-code":
        return t("pairing.invalid");
      case "rate-limited":
        return t("pairing.rateLimited", {
          time: clockTime(reason.retryAt, {
            i18n,
            timeZone: phoneTimeZone() ?? "UTC",
            now: DateTime.nowUnsafe(),
          }),
        });
      case "unreachable":
        return t("pairing.unreachable");
      case "incompatible-server":
        return t("gate.incompatible.appBody", { address: address.trim() });
      case "storage-failed":
        return t("pairing.storageFailed.mobile");
    }
  };

  const submit = () => {
    if (!ready) return;
    setState({ _tag: "pairing" });
    void session.pair({ address, code: code.trim(), deviceName: name.trim() }).then((outcome) => {
      if (outcome._tag !== "paired") setState({ _tag: "refused", problem: outcome });
    });
  };

  const problem = state._tag === "refused" ? state.problem : null;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      className="flex-1 bg-background"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow justify-center gap-6 px-6"
        contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-2">
          <Title>{t("pairing.title")}</Title>
          <Body>
            {parts("pairing.body", {
              command: (
                <Text key="command" face="mono" className="text-foreground">
                  j3-bots pair
                </Text>
              ),
            })}
          </Body>
        </View>
        {props.reason !== "new" && (
          <Text className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
            {props.reason === "signed-out" ? t("pairing.signedOut") : t("pairing.stillListed")}
          </Text>
        )}
        <View className="gap-4">
          {/* The QR code another device shows carries the address and the code, so neither is typed. */}
          <Button label={t("pairing.scan")} disabled={busy} onPress={() => setScanning(true)} />
          <Field
            kind="address"
            label={t("server.address")}
            value={address}
            onChange={setAddress}
            invalid={problem?._tag === "address"}
          />
          <Field
            kind="code"
            label={t("pairing.code")}
            value={code}
            onChange={(typed) => {
              setCode(typed);
              // A new code is a new attempt: the last answer, a lockout's time
              // included, no longer describes it.
              if (state._tag === "refused") setState({ _tag: "editing" });
            }}
            invalid={problem?._tag === "failed" && problem.reason._tag === "invalid-code"}
          />
          <Field
            kind="name"
            label={t("pairing.deviceName")}
            value={name}
            onChange={setName}
            invalid={false}
          />
          <Button
            variant="primary"
            label={state._tag === "pairing" ? t("pairing.pairing") : t("pairing.submit")}
            onPress={submit}
            disabled={!ready}
          />
          {problem !== null && (
            <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
              {problemText(problem)}
            </Text>
          )}
        </View>
      </ScrollView>
      {scanning && (
        <PairingScanner
          onClose={() => setScanning(false)}
          onScanned={(target) => {
            setScanning(false);
            setAddress(target.server);
            setCode(target.code);
            if (state._tag === "refused") setState({ _tag: "editing" });
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}
