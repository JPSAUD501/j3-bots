// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useServerUpdate, useServerUpdateEnded } from "@j3-bots/client-runtime/react";
import { useMemo } from "react";
import type { RemoteServerUpdate } from "../shell/data";

/**
 * Updating the server this page is connected to, as the shared client
 * follows it: what it says, an update under way through its restart, and
 * how one this device saw ended.
 */
export function useRemoteServerUpdate(): RemoteServerUpdate {
  const { serverUpdate } = useJ3Client();
  const view = useServerUpdate();
  const ended = useServerUpdateEnded();
  return useMemo(
    () => ({
      view,
      ended,
      dismissEnded: serverUpdate.dismissEnded,
      refresh: serverUpdate.refresh,
      check: () => serverUpdate.check().then(() => undefined),
      setChannel: (channel) => void serverUpdate.setChannel(channel),
      start: serverUpdate.start,
    }),
    [serverUpdate, view, ended],
  );
}
