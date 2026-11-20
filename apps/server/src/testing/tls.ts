// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The fixture's paths come from this module's own URL.
import * as NodeUrl from "node:url";

/**
 * A self-signed certificate for `j3-bots.test` and its key, made for tests and
 * trusted by nothing. They form a pair, as an HTTPS listener needs.
 */
export const TEST_TLS = {
  cert: NodeUrl.fileURLToPath(new URL("./tls/cert.pem", import.meta.url)),
  key: NodeUrl.fileURLToPath(new URL("./tls/key.pem", import.meta.url)),
  name: "j3-bots.test",
};
