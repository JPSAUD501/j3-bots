// SPDX-License-Identifier: AGPL-3.0-or-later
import { ClientIdentity } from "@j3-bots/client-runtime";
import type { TelemetryOs } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Constants from "expo-constants";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// What the phone app tells its server it is, for usage data (decision 0099).

/** Where the phone's random id for usage data is kept: not a secret, and only ever sent hashed. */
const ID_KEY = "usage-data-id";

/** This phone's alone, as the credential is: a backup restored elsewhere does not carry it. */
const ID_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const randomHex = () =>
  Array.from(ExpoCrypto.getRandomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The id kept on this phone, made the first time. A store that fails gives one for this run alone. */
const randomId = Effect.promise(async () => {
  try {
    const kept = await SecureStore.getItemAsync(ID_KEY, ID_OPTIONS);
    if (kept !== null && kept !== "") return kept;
    const made = randomHex();
    await SecureStore.setItemAsync(ID_KEY, made, ID_OPTIONS);
    return made;
  } catch {
    return randomHex();
  }
});

const os: TelemetryOs =
  Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "other";

/** The phone app, with the release it was built as. */
export const identity = Layer.succeed(ClientIdentity, {
  surface: "android",
  os,
  version: Effect.sync(() => Constants.expoConfig?.version ?? null),
  randomId,
});
