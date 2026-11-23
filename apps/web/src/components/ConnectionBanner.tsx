// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectionState } from "@j3-bots/client-runtime";
import type { LocalServerState, ServerUpdate } from "@j3-bots/desktop-bridge";
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

/**
 * In local mode, the server this computer runs, which the line speaks of
 * first while it is down, and, once it runs and the connection is up, of
 * the update it was rolled back from or the newer release it runs.
 */
export interface LocalLine {
  readonly server: LocalServerState;
  /** While it waits to restart: when it starts again. */
  readonly restartAt: DateTime.Utc | null;
  /** Starts it again now. */
  readonly onRetry: () => void;
  /** Shows why it did not start, once it failed, or why the update it was rolled back from did not. */
  readonly onDetails: () => void;
  /** Tries the update it was rolled back from again. */
  readonly onRetryUpdate: () => void;
}

/** Whether the app saw why an update was rolled back, which its details show. */
export const updateHasDetails = (update: ServerUpdate): boolean =>
  update._tag === "rolled-back" && (update.reason !== undefined || update.logTail !== undefined);

interface ConnectionBannerProps {
  readonly state: ConnectionState;
  readonly local?: LocalLine | undefined;
  /**
   * The version a server this device follows the update of is restarting
   * on, while that has it out of reach; null otherwise.
   */
  readonly updatingTo?: string | null | undefined;
  /** Whether a connection has been made since the page loaded. */
  readonly everConnected: boolean;
  readonly onRetryNow: () => void;
  /** What lies under the line: the app. */
  readonly children?: ReactNode;
}

/**
 * One quiet line above the shell while the server is out of reach: what is
 * happening, and Try now when a retry is waiting. In local mode, while the
 * server on this computer moves to a new release, it says only that, as it
 * does while a remote server restarts on the release this device updated it
 * to and is out of reach meanwhile; while
 * that server is not running, it says that first, with what starts it again.
 * Once both run, it speaks only of an update of that server that was rolled
 * back, with Try again and its details, or of a newer one than the app that
 * runs; otherwise it takes no room. Its text is a live region, so
 * each change is read out once. Shown, it is the top of the screen, so it
 * takes the device's top inset and what lies under it does not.
 */
export function ConnectionBanner({
  state,
  local,
  updatingTo = null,
  everConnected,
  onRetryNow,
  children,
}: ConnectionBannerProps) {
  const { t } = useI18n();
  const down = local !== undefined && local.server.state !== "ready" ? local : null;
  const retryAt = down !== null ? down.restartAt : state._tag === "waiting" ? state.retryAt : null;
  const seconds = useSecondsUntil(retryAt);
  // An update of the server on this computer, from the stop of the one that ran to the new one's
  // answer; a start that failed or waits to try again says so instead. A remote server restarting
  // on an update says the same, rather than that the connection was lost.
  const updatingVersion =
    local?.server.update?._tag === "updating" &&
    local.server.state !== "failed" &&
    local.server.state !== "restarting"
      ? local.server.update.to
      : updatingTo !== null && (state._tag === "waiting" || state._tag === "connecting")
        ? updatingTo
        : null;
  const updating =
    updatingVersion === null ? null : t("local.line.update.updating", { version: updatingVersion });
  /** The server on this computer, while it is not running. */
  const downText = ((): string | null => {
    switch (down?.server.state) {
      case "starting":
        return t("local.line.starting");
      case "stopped":
        return t("local.line.stopped");
      case "restarting":
        return t("local.line.restarting");
      case "failed":
        return t("local.line.failed");
      case "ready":
      case undefined:
        return null;
    }
  })();
  /** The connection, while it is not up. */
  const connectionText = ((): string | null => {
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
  // The server's version, once it runs and the connection is up: each says so first otherwise.
  const update = down === null && connectionText === null ? local?.server.update : undefined;
  const updateText = ((): string | null => {
    switch (update?._tag) {
      case "rolled-back":
        return t("local.line.update.rolledBack", {
          failed: update.failed,
          running: update.running,
        });
      case "older-app":
        return t("local.line.update.olderApp", { running: update.running });
      case "updating":
      case undefined:
        return null;
    }
  })();
  const text = updating ?? downText ?? connectionText ?? updateText;
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
          <div className="flex min-h-8 flex-wrap items-center justify-center gap-x-2 bg-muted px-3 pt-[calc(var(--inset-top)+--spacing(1))] pb-1 text-center text-xs text-muted-foreground">
            <span role="status" className="sr-only">
              {text}
            </span>
            <span aria-hidden>{text ?? lastText}</span>
            {updating === null && down?.server.state === "stopped" && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={down.onRetry}>
                {t("local.line.start")}
              </Button>
            )}
            {updating === null && down?.server.state === "failed" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={down.onDetails}
              >
                {t("local.failed.details")}
              </Button>
            )}
            {updating === null && down?.server.state === "restarting" && (
              <>
                <span aria-hidden className="tabular-nums">
                  {seconds > 0 ? t("connection.retryIn", { seconds }) : t("connection.retrying")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={down.onRetry}
                >
                  {t("connection.retryNow")}
                </Button>
              </>
            )}
            {local !== undefined && update?._tag === "rolled-back" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={local.onRetryUpdate}
                >
                  {t("local.line.update.retry")}
                </Button>
                {updateHasDetails(update) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={local.onDetails}
                  >
                    {t("local.failed.details")}
                  </Button>
                )}
              </>
            )}
            {updating === null && down === null && state._tag === "waiting" && (
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
