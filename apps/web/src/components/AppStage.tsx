// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorAppViewId, MessageEntry } from "@j3-bots/contracts";
import {
  botRepliesAfter,
  type ConnectorAppDisplayMode,
  type TimelineItem,
} from "@j3-bots/client-runtime/presentation";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Where a conversation shows a connector's app other than in the bot's reply
// (decision 0093): over the conversation (`fullscreen`), or pinned at its top
// while it scrolls (`pip`). One app at a time; another one asking goes back
// to the reply. docs/architecture/clients.md, "Connector apps".

/** An app shown other than in the reply. */
interface StagedApp {
  readonly viewId: ConnectorAppViewId;
  readonly mode: Exclude<ConnectorAppDisplayMode, "inline">;
}

/** An app shown other than in the reply, and the last row there was as it went. */
export interface StagedFrom extends StagedApp {
  readonly since: string | null;
}

export interface AppStageState {
  /**
   * The conversation's area between its header and its composer, which a
   * full-screen app covers and a pinned one sits at the top of; null where
   * there is none, as in the gallery, where every app stays in the reply.
   */
  readonly area: HTMLElement | null;
  /** What scrolls the conversation: apps far out of it are not kept running. Null: all are. */
  readonly scroller: HTMLElement | null;
  /** The modes the conversation can show an app in. */
  readonly modes: ReadonlyArray<ConnectorAppDisplayMode>;
  readonly staged: StagedApp | null;
  /** Shows the app in `mode`, and returns the mode it is shown in now. */
  readonly show: (
    viewId: ConnectorAppViewId,
    mode: ConnectorAppDisplayMode,
  ) => ConnectorAppDisplayMode;
  /** What the bots said since an app went full screen, which shows over it. */
  readonly replies: ReadonlyArray<MessageEntry>;
}

const INLINE_ONLY: ReadonlyArray<ConnectorAppDisplayMode> = ["inline"];
const EVERY_MODE: ReadonlyArray<ConnectorAppDisplayMode> = ["inline", "fullscreen", "pip"];

const noStage: AppStageState = {
  area: null,
  scroller: null,
  modes: INLINE_ONLY,
  staged: null,
  show: () => "inline",
  replies: [],
};

const AppStageContext = createContext<AppStageState>(noStage);

export const useAppStage = (): AppStageState => use(AppStageContext);

/**
 * The stage of one conversation's apps. A conversation mounts its own, so
 * an app shown full screen in one is not in the next. Esc takes a
 * full-screen app back to the reply.
 */
export function AppStageProvider({
  area,
  scroller,
  rows,
  initial = null,
  children,
}: {
  readonly area: HTMLElement | null;
  readonly scroller: HTMLElement | null;
  readonly rows: ReadonlyArray<TimelineItem>;
  /**
   * The app shown other than in the reply as it opens, and the row after
   * which what the bots say shows over it: the gallery's. A conversation opens with none.
   */
  readonly initial?: StagedFrom | null;
  readonly children: ReactNode;
}) {
  const [staged, setStaged] = useState<StagedFrom | null>(initial);

  const fullscreen = staged?.mode === "fullscreen";
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setStaged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // What is in the conversation as an app goes full screen: only what comes after shows over it.
  const latest = useRef<string | null>(null);
  useLayoutEffect(() => {
    latest.current = rows.at(-1)?.key ?? null;
  }, [rows]);

  // The same for as long as the conversation's area is, so an app's place in the reply keeps it.
  const show = useCallback(
    (viewId: ConnectorAppViewId, mode: ConnectorAppDisplayMode): ConnectorAppDisplayMode => {
      if (mode === "inline") {
        setStaged((current) => (current?.viewId === viewId ? null : current));
        return "inline";
      }
      if (area === null) return "inline";
      setStaged({ viewId, mode, since: latest.current });
      return mode;
    },
    [area],
  );

  const value = useMemo<AppStageState>(() => {
    const replies = staged?.mode === "fullscreen" ? botRepliesAfter(rows, staged.since) : [];
    return {
      area,
      scroller,
      modes: area === null ? INLINE_ONLY : EVERY_MODE,
      staged: staged === null ? null : { viewId: staged.viewId, mode: staged.mode },
      show,
      replies,
    };
  }, [area, scroller, rows, staged, show]);

  return <AppStageContext value={value}>{children}</AppStageContext>;
}
