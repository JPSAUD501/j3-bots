// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import * as DateTime from "effect/DateTime";
import { createContext, use, useState, useSyncExternalStore, type ReactNode } from "react";
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

const Speaking = createContext(false);

/** Whether the connection line above is saying why the server is out of reach. */
export const useConnectionLineShown = (): boolean => use(Speaking);

interface ConnectionBannerProps {
  readonly state: ConnectionState;
  /** Whether a connection has been made since the page loaded. */
  readonly everConnected: boolean;
  readonly onRetryNow: () => void;
  /** What lies under the line: the app. */
  readonly children?: ReactNode;
}

/**
 * One quiet line above the shell while the server is out of reach: what is
 * happening, and Try now when a retry is waiting. Connected, it takes no
 * room. Its text is a live region, so each change is read out once. Shown,
 * it is the top of the screen, so it takes the device's top inset and what
 * lies under it does not.
 */
export function ConnectionBanner({
  state,
  everConnected,
  onRetryNow,
  children,
}: ConnectionBannerProps) {
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
      case "background":
      case "connected":
      case "unpaired":
      case "incompatible":
      case "storage-failed":
        return null;
    }
  })();
  // The line keeps its last words while it folds away, so it never shrinks empty.
  const [lastText, setLastText] = useState(text);
  if (text !== null && text !== lastText) setLastText(text);
  return (
    <div className="flex h-full flex-col">
      {/* Opens and folds on `slide`, so what lies under it moves rather than jumps. */}
      <div
        className={cn(
          "grid shrink-0 transition-[grid-template-rows] duration-(--duration-slide) ease-slide",
          text === null ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex min-h-8 flex-wrap items-center justify-center gap-x-2 bg-muted px-3 pt-(--inset-top) text-xs text-muted-foreground">
            <span role="status" className="sr-only">
              {text}
            </span>
            <span aria-hidden>{text ?? lastText}</span>
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
        </div>
      </div>
      <div className={cn("min-h-0 flex-1", text !== null && "[--inset-top:0px]")}>
        <Speaking value={text !== null}>{children}</Speaking>
      </div>
    </div>
  );
}
