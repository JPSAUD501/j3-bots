// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  type CdpRelayConnection,
  type CdpRelayTarget,
  createCdpRelayConnection,
  RELAY_PAGE_ONLY,
} from "./cdpRelay.ts";
export { addressOf } from "./driver/address.ts";
export { type DriverPage, makeDriverPage, type PointerReporter } from "./driver/DriverPage.ts";
export { hostErrorOf } from "./driver/errors.ts";
export { type DatabaseDump, readDatabases, replaceDatabases } from "./indexedDb.ts";
export {
  type BrowserHostRpc,
  driverTabCalls,
  type PageHost,
  type PageHostClient,
  type PageHostPayload,
  type PageHostTabCalls,
  pageHostHandlers,
  remotePageHost,
} from "./PageHost.ts";
export { type CdpCookieParam, cdpParamOf, cdpRemovalOf, cookieOfCdp } from "./cookies.ts";
export {
  type ProfileOrigin,
  type ProfileSignIns,
  ProfileUnreadable,
  readProfileSignIns,
} from "./profile.ts";
export {
  HOST_SOCKET_PING,
  HOST_SOCKET_SILENCE,
  type HostSocketEnd,
  pageHostOnSocket,
  serveHostOnSocket,
} from "./hostSocket.ts";
