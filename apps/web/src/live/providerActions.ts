// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import type { ProviderActions } from "../components/ProviderFix";

/** What the provider lines ask of the server, through `j3`: each resolves with whether it took the request. */
export const providerActionsOf = (j3: J3Client): ProviderActions => ({
  recheck: (providerId) => j3.recheckProvider(providerId).then((result) => result._tag === "done"),
  update: (providerId) => j3.updateProvider(providerId).then((result) => result._tag === "done"),
  install: (harness) => j3.installHarness(harness).then((result) => result._tag === "done"),
  cancelInstall: (harness) =>
    j3.cancelHarnessInstall(harness).then((result) => result._tag === "done"),
  addAccount: (harness, name) =>
    j3.addAccount(harness, name).then((result) => result._tag === "done"),
  setUpAccount: (providerId, changes) =>
    j3.setUpAccount(providerId, changes).then((result) => result._tag === "done"),
  removeAccount: (providerId) =>
    j3.removeAccount(providerId).then((result) => result._tag === "done"),
});
