// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import * as DateTime from "effect/DateTime";
import { useSyncExternalStore } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

const unsubscribed = () => () => {};
const everySecond = (tick: () => void) => {
  const timer = window.setInterval(tick, 1000);
  return () => window.clearInterval(timer);
};
const currentSecond = () => Math.floor(Date.now() / 1000);

/** Whole seconds until `at`, counting down while the component shows it. */
function useSecondsUntil(at: DateTime.Utc | null): number {
  const second = useSyncExternalStore(at === null ? unsubscribed : everySecond, currentSecond);
  return at === null ? 0 : Math.max(0, Math.ceil(DateTime.toEpochMillis(at) / 1000) - second);
}

interface ConnectionBannerProps {
  readonly state: ConnectionState;
  /** Whether a connection has been made since the page loaded. */
  readonly everConnected: boolean;
  readonly onRetryNow: () => void;
}

/**
 * One quiet line above the shell while the server is out of reach: what is
 * happening, and Try now when a retry is waiting. Connected, it takes no
 * room. Its text is a live region, so each change is read out once.
 */
export function ConnectionBanner({ state, everConnected, onRetryNow }: ConnectionBannerProps) {
  const { t } = useI18n();
  const retryAt = state._tag === "waiting" ? state.retryAt : null;
  const seconds = useSecondsUntil(retryAt);
  const text = ((): string | null => {
    switch (state._tag) {
      case "offline":
        return t("connection.offline");
      case "connecting":
        return everConnected ? t("connection.reconnecting") : null;
      case "waiting":
        return state.reason === "dropped" ? t("connection.lost") : t("connection.unreachable");
      case "starting":
      case "connected":
      case "unpaired":
      case "incompatible":
      case "storage-failed":
        return null;
    }
  })();
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-center gap-x-2 bg-muted px-3 text-xs text-muted-foreground",
        text === null ? "h-0 overflow-hidden" : "min-h-8 pt-[env(safe-area-inset-top)]",
      )}
    >
      <span role="status">{text}</span>
      {state._tag === "waiting" && (
        <>
          {/* Changes every second, so it is shown and not announced. */}
          <span aria-hidden className="tabular-nums">
            {seconds > 0 ? t("connection.retryIn", { seconds }) : t("connection.retrying")}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onRetryNow}>
            {t("connection.retryNow")}
          </Button>
        </>
      )}
    </div>
  );
}
