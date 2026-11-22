// SPDX-License-Identifier: AGPL-3.0-or-later
import { PairingLink, type PairingLinkTarget } from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Modal, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n.ts";
import { Body, Button, Centered } from "../ui.tsx";

const decodeLink = Schema.decodeUnknownOption(PairingLink);

/**
 * The camera over the whole screen, reading the QR code a paired device or
 * `j3-bots pair` shows. The first pairing link it reads is handed over, to
 * fill in the pairing screen: it never pairs by itself. The camera is asked
 * for once, as the scanner opens. Refused, the scanner says so and offers to
 * ask again, or, once the system no longer lets the app ask (on Android 11
 * and later, after a second refusal), the phone's settings. The permission is
 * read again each time the app comes back to the foreground, so a camera
 * allowed in the phone's settings opens on return.
 */
export function PairingScanner(props: {
  readonly onScanned: (target: PairingLinkTarget) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission, readPermission] = useCameraPermissions({ request: true });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void readPermission();
    });
    return () => subscription.remove();
  }, [readPermission]);
  // A code that is not a pairing link says so, until one that is comes into view.
  const [wrongCode, setWrongCode] = useState(false);
  const handed = useRef(false);

  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose}>
      <View className="flex-1 bg-background">
        {permission?.granted === true ? (
          <View className="flex-1">
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => {
                if (handed.current) return;
                const target = decodeLink(data);
                if (Option.isSome(target)) {
                  handed.current = true;
                  props.onScanned(target.value);
                } else {
                  setWrongCode(true);
                }
              }}
            />
            <View
              className="absolute start-0 end-0 top-0 gap-1 bg-background px-4 py-3"
              style={{ paddingTop: insets.top + 12 }}
            >
              <Text accessibilityRole="header" className="text-base font-medium text-foreground">
                {t("pairing.scan.title")}
              </Text>
              {wrongCode && (
                <Text accessibilityLiveRegion="polite" className="text-sm text-blocked">
                  {t("pairing.scan.notPairing")}
                </Text>
              )}
            </View>
          </View>
        ) : permission?.status === "denied" ? (
          permission.canAskAgain ? (
            <Centered>
              <Body>{t("pairing.scan.refused")}</Body>
              <Button
                variant="primary"
                label={t("pairing.scan.allow")}
                onPress={() => void requestPermission()}
              />
            </Centered>
          ) : (
            <Centered>
              <Body>{t("pairing.scan.denied")}</Body>
              <Button
                variant="primary"
                label={t("pairing.scan.openSettings")}
                onPress={() => void Linking.openSettings()}
              />
            </Centered>
          )
        ) : (
          // Asking, or about to: the system's question is on screen.
          <View className="flex-1" />
        )}
        <View
          className="items-center border-t border-border bg-background px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <Button label={t("pairing.scan.close")} onPress={props.onClose} />
        </View>
      </View>
    </Modal>
  );
}
