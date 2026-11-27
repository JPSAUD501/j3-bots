// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client } from "@j3-bots/client-runtime/react";
import {
  DIAGNOSTICS_MEDIA_TYPE,
  type DiagnosticsClient,
  diagnosticsFileName,
  ReleaseVersion,
} from "@j3-bots/contracts";
import Constants from "expo-constants";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";
import { Problem, Quiet } from "../components/form.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { useI18n } from "../i18n.ts";
import { shareAppFiles } from "../platform/openFile.ts";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";

/** Where the sheet stands: waiting for Share, getting the file from the server, or having failed to. */
type SheetState = "ready" | "preparing" | "failed";

/** This app, as the zip's manifest names it: its release, when it is one. */
const client: DiagnosticsClient = {
  surface: "android",
  version: Option.getOrNull(
    Schema.decodeUnknownOption(ReleaseVersion)(Constants.expoConfig?.version),
  ),
  os: "android",
};

/**
 * The About page's privacy area's row for the server's diagnostics zip, on a
 * server that makes one: what it is for, and Download diagnostics, which
 * opens the sheet that says what is in it. Share gets the file and hands it
 * to the system's share sheet, for the operator to send where they choose.
 */
export function DiagnosticsRow() {
  const { t } = useI18n();
  const j3 = useJ3Client();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SheetState>("ready");
  const close = () => {
    if (state === "preparing") return;
    setOpen(false);
    setState("ready");
  };
  const share = () => {
    setState("preparing");
    void j3
      .downloadDiagnostics(client)
      .then((result) =>
        result._tag === "done"
          ? shareAppFiles([
              {
                name: diagnosticsFileName(DateTime.nowUnsafe()),
                mediaType: DIAGNOSTICS_MEDIA_TYPE,
                bytes: result.value.bytes,
              },
            ])
          : false,
      )
      .then((shared) => {
        if (!shared) return setState("failed");
        setOpen(false);
        setState("ready");
      });
  };
  return (
    <View className="gap-2">
      <Quiet>{t("diagnostics.hint")}</Quiet>
      <View className="items-start">
        <Button
          variant="secondary"
          label={t("diagnostics.download")}
          onPress={() => setOpen(true)}
        />
      </View>
      <Sheet
        open={open}
        title={t("diagnostics.sheet.title")}
        onClose={close}
        footer={
          <View className="flex-row gap-2 px-5 pb-4">
            <Button
              grow
              variant="secondary"
              label={t("diagnostics.sheet.cancel")}
              disabled={state === "preparing"}
              onPress={close}
            />
            <Button
              grow
              variant="primary"
              label={
                state === "preparing"
                  ? t("diagnostics.sheet.preparing")
                  : t("diagnostics.sheet.share")
              }
              held={state === "preparing"}
              onPress={share}
            />
          </View>
        }
      >
        <View className="gap-4 pb-2">
          <Quiet>{t("diagnostics.sheet.lead")}</Quiet>
          <SheetList
            heading={t("diagnostics.sheet.inside")}
            items={[
              t("diagnostics.sheet.inside.logs"),
              t("diagnostics.sheet.inside.failures"),
              t("diagnostics.sheet.inside.setup"),
              t("diagnostics.sheet.inside.usageData"),
            ]}
          />
          <SheetList
            heading={t("diagnostics.sheet.never")}
            items={[
              t("diagnostics.sheet.never.messages"),
              t("diagnostics.sheet.never.names"),
              t("diagnostics.sheet.never.secrets"),
            ]}
          />
          <Problem>{state === "failed" ? t("diagnostics.sheet.failed") : null}</Problem>
        </View>
      </Sheet>
    </View>
  );
}

function SheetList(props: { readonly heading: string; readonly items: ReadonlyArray<string> }) {
  return (
    <View className="gap-1">
      <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
        {props.heading}
      </Text>
      {props.items.map((item) => (
        <Text key={item} className="text-sm text-foreground">
          {`• ${item}`}
        </Text>
      ))}
    </View>
  );
}
