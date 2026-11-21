// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PairingOffer } from "@j3-bots/client-runtime";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { useDevices, useJ3Client } from "@j3-bots/client-runtime/react";
import { activityTime } from "@j3-bots/client-runtime/wording";
import {
  type Device,
  type DeviceId,
  type PairingCode,
  PairingLink,
  type ServerOrigin,
} from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { generate } from "lean-qr";
import { toSvgPath } from "lean-qr/extras/svg";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { ChoiceRow, confirm, Problem, Quiet, Section } from "../components/form.tsx";
import { usePresentation } from "../presentation.tsx";
import { Button } from "../ui.tsx";

const shownCode = (code: PairingCode) => `${code.slice(0, 5)}-${code.slice(5)}`;

type Pairing =
  | { readonly _tag: "idle" }
  | { readonly _tag: "starting" }
  | ({ readonly _tag: "started" } & PairingOffer)
  | { readonly _tag: "failed" };

const encodeLink = Schema.encodeSync(PairingLink);

/** Every paired device, and a code to pair one more, which takes the server. */
export function DevicesSection(props: { readonly connected: boolean }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const client = useJ3Client();
  const devices = useDevices();
  const [pairing, setPairing] = useState<Pairing>({ _tag: "idle" });
  // Revocations under way or not confirmed. One the server confirms leaves the list with its
  // device; for the others the list is read again, and shows whether the device is still there.
  const [revoking, setRevoking] = useState<ReadonlyMap<DeviceId, "pending" | "failed">>(new Map());
  const revoke = (deviceId: DeviceId) => {
    setRevoking((held) => new Map(held).set(deviceId, "pending"));
    void client.revokeDevice(deviceId).then((result) =>
      setRevoking((held) => {
        const next = new Map(held);
        if (result._tag === "done") next.delete(deviceId);
        else next.set(deviceId, "failed");
        return next;
      }),
    );
  };
  const startPairing = () => {
    if (!props.connected || pairing._tag === "starting") return;
    setPairing({ _tag: "starting" });
    void client
      .startPairing()
      .then((result) =>
        setPairing(
          result._tag === "done" ? { _tag: "started", ...result.value } : { _tag: "failed" },
        ),
      );
  };
  return (
    <Section title={t("settings.devices")}>
      {devices._tag !== "ready" ? (
        <Quiet>{t("details.loading")}</Quiet>
      ) : (
        devices.value.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            state={revoking.get(device.id)}
            onRevoke={() => revoke(device.id)}
          />
        ))
      )}
      <View className="items-start gap-2">
        <Button
          label={pairing._tag === "started" ? t("settings.pair.again") : t("settings.pair")}
          disabled={!props.connected || pairing._tag === "starting"}
          onPress={startPairing}
        />
        {!props.connected && <Quiet>{t("settings.pair.offline")}</Quiet>}
        {pairing._tag === "started" && <PairingCodeShown offer={pairing} />}
        <Problem>{pairing._tag === "failed" ? t("settings.pair.failed") : null}</Problem>
      </View>
    </Section>
  );
}

function DeviceRow(props: {
  readonly device: Device;
  readonly state: "pending" | "failed" | undefined;
  readonly onRevoke: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { device, state } = props;
  return (
    <View className="flex-row items-center gap-3 rounded-md border border-border px-3 py-2">
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base text-foreground">
          {device.name}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {device.current
            ? t("settings.device.current")
            : device.lastSeenAt === null
              ? t("settings.device.neverSeen")
              : t("settings.device.lastSeen", { when: activityTime(device.lastSeenAt, ctx) })}
          {device.pushRegistered && ` · ${t("settings.device.pushOn")}`}
        </Text>
        <Problem>
          {state === "failed" ? t("settings.device.revoke.failed", { name: device.name }) : null}
        </Problem>
      </View>
      {state === "failed" ? (
        <Button
          variant="destructive"
          label={t("settings.device.revoke.retry")}
          onPress={props.onRevoke}
        />
      ) : (
        !device.current && (
          <Button
            variant="destructive"
            label={
              state === "pending"
                ? t("settings.device.revoke.pending")
                : t("settings.device.revoke")
            }
            accessibilityLabel={t("settings.device.revoke.title", { name: device.name })}
            disabled={state === "pending"}
            onPress={() =>
              confirm({
                title: t("settings.device.revoke.title", { name: device.name }),
                body: t("settings.device.revoke.body", { name: device.name }),
                cancel: t("settings.device.revoke.cancel"),
                confirm: t("settings.device.revoke"),
                onConfirm: props.onRevoke,
              })
            }
          />
        )
      )}
    </View>
  );
}

/**
 * The code to enter on the other device and, when the server can be reached
 * from another device, a QR code of the pairing link for its camera. The link
 * carries the first origin the offer lists unless the operator picks another.
 */
function PairingCodeShown({ offer }: { readonly offer: PairingOffer }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [picked, setPicked] = useState<ServerOrigin | null>(null);
  // A new code may come with other addresses: the pick holds while it is one of them.
  const server =
    picked !== null && offer.origins.includes(picked) ? picked : (offer.origins[0] ?? null);
  return (
    <View accessibilityLiveRegion="polite" className="gap-3">
      <Quiet>
        {server === null ? t("settings.pair.instructions") : t("settings.pair.scanOrEnter")}
      </Quiet>
      {server !== null && (
        <PairingQr
          text={encodeLink({ server, code: offer.code })}
          label={t("settings.pair.qr", { address: server })}
        />
      )}
      <View className="gap-1">
        <Text selectable className="font-mono text-lg tracking-wider text-foreground">
          {shownCode(offer.code)}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("settings.pair.expires", { time: clockTime(offer.expiresAt, ctx) })}
        </Text>
      </View>
      {server !== null && offer.origins.length > 1 && (
        <View accessibilityRole="radiogroup" className="gap-2">
          <Text className="text-sm text-foreground">{t("settings.pair.address")}</Text>
          {offer.origins.map((origin) => (
            <ChoiceRow
              key={origin}
              kind="one"
              label={origin}
              selected={origin === server}
              onPress={() => setPicked(origin)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Light modules around the code, as the QR standard asks, so a camera finds its edges. */
const QUIET_ZONE = 4;

/** In px: large enough for a camera at arm's length. */
const QR_SIDE = 192;

/**
 * `text` as a QR code. Black on white in either theme: cameras read a light
 * code on a dark ground poorly, and the quiet zone is part of the image.
 */
function PairingQr({ text, label }: { readonly text: string; readonly label: string }) {
  const { size, path } = useMemo(() => {
    const code = generate(text);
    return { size: code.size, path: toSvgPath(code) };
  }, [text]);
  const side = size + 2 * QUIET_ZONE;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg
        width={QR_SIDE}
        height={QR_SIDE}
        viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${side} ${side}`}
      >
        <Rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={side} height={side} fill="#fff" />
        <Path d={path} fill="#000" />
      </Svg>
    </View>
  );
}
