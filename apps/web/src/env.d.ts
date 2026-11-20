// SPDX-License-Identifier: AGPL-3.0-or-later

interface ImportMetaEnv {
  /**
   * Development only: the origin of a J3 Bots server. The dev server then
   * proxies the API, the socket and attachments to it, and the app runs on it
   * instead of the sample team.
   */
  readonly VITE_J3_SERVER?: string;
}
