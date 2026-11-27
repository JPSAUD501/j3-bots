// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewState } from "@j3-bots/client-runtime";
import {
  BROWSER_SETUP_DOCS,
  clockTime,
  followedBot,
  type Frozen,
  frozenOf,
  listedTabs,
  needsYouElsewhere,
  neighborTab,
  type ShownTab,
  shownTab,
  siteOf,
  tabFaces,
  type ViewerTab,
} from "@j3-bots/client-runtime/presentation";
import { type PageUseHandle, type QuickSend, usePageUse } from "@j3-bots/client-runtime/react";
import { botNames, tabLineWords } from "@j3-bots/client-runtime/wording";
import type { Bot, BotId, BrowserTabRef } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  CrosshairIcon,
  EllipsisIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useBots, useI18n, usePresentation } from "../../app/context";
import { DocsLink } from "../../components/DocsLink";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { cn } from "../../lib/cn";
import type { BrowserViewerHandle } from "../BrowserViewer";
import { PageDialog } from "../BrowserViewer";
import { useBrowser, useViewerTabs } from "../context";
import { Faces } from "../Faces";
import { useTabView, zoomableSize } from "../useTabView";
import { useWaitingBots } from "../waiting";
import { AddressSheet } from "./AddressSheet";
import { type Closed, useClosingTabs } from "./closing";
import { LivePage, type LivePageHandle } from "./LivePage";
import { useLastPicture } from "./pictures";
import { useSideSwipe } from "./swipe";
import { TabGrid } from "./TabGrid";
import { TabSheet } from "./TabSheet";

/** How far the site's line is pulled down to close the live view. */
const PULL_TO_CLOSE = 96;

interface LiveViewProps {
  /** The bot whose conversation the live view opened from. */
  readonly bot: Bot;
  /** The tab asked for, or the bot's own. */
  readonly target: BrowserTabRef | "front";
  /** Over the conversation beside the roster, with a way back to it; on a phone's width, the whole screen. */
  readonly beside: boolean;
  readonly onClose: () => void;
  /** Sends a message straight to a bot's conversation, from the tab's sheet. */
  readonly send: QuickSend;
  /** Opens a bot's conversation, closing the live view. */
  readonly onConversation: (botId: BotId) => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  readonly ref?: Ref<BrowserViewerHandle>;
}

/** Whether this browser reaches the network, as far as it knows. */
function useOnline(): boolean {
  return useSyncExternalStore(
    (change) => {
      window.addEventListener("online", change);
      window.addEventListener("offline", change);
      return () => {
        window.removeEventListener("online", change);
        window.removeEventListener("offline", change);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/**
 * The narrow web's live view of the browser, the phone's design (decision
 * 0110): the page on the whole view, only its site above it, and everything
 * to press in a bar at the bottom: close, the page's Back, the faces and the
 * one line of who is on the tab, Now or Continue when it offers one, the
 * tabs and the menu. Touching the page is using it: the bots on the tab wait
 * and carry on by themselves once the person stops. Leaving gives the tab
 * back at once; nothing closes with the view.
 */
export function LiveView({
  bot,
  target,
  beside,
  onClose,
  send,
  onConversation,
  headingRef,
  headingId,
  ref,
}: LiveViewProps) {
  const { t } = useI18n();
  const { source } = useBrowser();
  const { tabs, shared } = useViewerTabs(bot.id);
  const [problem, setProblem] = useState<string | null>(null);
  const closing = useClosingTabs(() => setProblem(t("browser.grid.closeFailed")));
  const listed = tabs === null ? null : listedTabs(tabs, closing.closing);

  // The tab shown stays put as the list changes, and gives way to its neighbor once it closes.
  const asked = target === "front" ? null : target;
  const [shown, setShown] = useState<{
    readonly tab: ShownTab;
    readonly list: ReadonlyArray<ViewerTab> | null;
  }>({ tab: { ref: asked, fresh: false }, list: null });
  // A tab asked for while the view is open, as from a help card, is shown at once.
  const [seenTarget, setSeenTarget] = useState(target);
  if (seenTarget !== target) {
    setSeenTarget(target);
    if (asked !== null) setShown((now) => ({ ...now, tab: { ref: asked, fresh: false } }));
  }
  if (listed !== shown.list && !sameTabs(listed, shown.list)) {
    setShown({
      tab: shownTab({ shown: shown.tab, before: shown.list, after: listed, from: bot.id }),
      list: listed,
    });
  }
  const tab = listed?.find((each) => each.ref === shown.tab.ref) ?? null;
  // A tab just opened is waited for only while the list does not hold it yet.
  const show = (ref: BrowserTabRef, fresh = false) =>
    setShown((now) => ({
      ...now,
      tab: { ref, fresh: fresh && !(now.list?.some((each) => each.ref === ref) ?? false) },
    }));
  // Showing the page again, after another window took it or it failed to open, is a view of its own.
  const [attempt, setAttempt] = useState(0);

  const openTab = (url: string | null) => {
    void source.openBrowserTab(url).then((result) => {
      if (result._tag === "done") show(result.value, true);
      else setProblem(t("browser.grid.openFailed"));
    });
  };

  const pane = useRef<TabLiveHandle>(null);
  const close = (next: () => void = onClose) => {
    pane.current?.leave();
    next();
  };
  const closeNow = useRef(close);
  useEffect(() => {
    closeNow.current = close;
  });
  useImperativeHandle(ref, () => ({ requestClose: (next) => closeNow.current(next) }), []);

  return (
    <TabLive
      // Each tab is a view of its own: what the person did on one stays with it.
      key={`${tab?.ref ?? "none"}:${attempt}`}
      ref={pane}
      from={bot}
      tab={tab}
      loading={listed === null || (shown.tab.fresh && tab === null)}
      tabs={listed ?? []}
      shared={shared}
      closing={closing}
      problem={problem}
      beside={beside}
      send={send}
      headingRef={headingRef}
      headingId={headingId}
      onShow={(ref) => {
        setProblem(null);
        show(ref);
      }}
      onRetry={() => setAttempt((n) => n + 1)}
      onOpenTab={openTab}
      onClose={() => close()}
      onConversation={(botId) => close(() => onConversation(botId))}
    />
  );
}

/** Whether two lists hold the same tabs, as they were: a new list from the server need not be a change. */
const sameTabs = (
  one: ReadonlyArray<ViewerTab> | null,
  other: ReadonlyArray<ViewerTab> | null,
): boolean =>
  one !== null &&
  other !== null &&
  one.length === other.length &&
  one.every((tab, index) => tab.ref === other[index]?.ref);

/** The view's status, as whether the page is frozen reads it. */
const liveness = (state: BrowserViewState | null) => {
  switch (state?.status._tag) {
    case undefined:
    case "connecting":
      return "connecting";
    case "live":
    case "reconnecting":
    case "paused":
      return state.status._tag;
    case "gone":
    case "setup-needed":
    case "replaced":
    case "failed":
      return "ended";
  }
};

type Opened = "sheet" | "tabs" | "address" | "new" | null;

/** What the live view asks of the tab it shows. */
interface TabLiveHandle {
  /** Gives back what this device holds on the tab, at once. */
  readonly leave: () => void;
}

function TabLive({
  from,
  tab,
  loading,
  tabs,
  shared,
  closing,
  problem,
  beside,
  send,
  headingRef,
  headingId,
  onShow,
  onRetry,
  onOpenTab,
  onClose,
  onConversation,
  ref,
}: {
  readonly from: Bot;
  readonly tab: ViewerTab | null;
  /** The tabs are still on their way, or the one just opened. */
  readonly loading: boolean;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shared: boolean;
  readonly closing: ReturnType<typeof useClosingTabs>;
  /** What did not work, said in place of Undo. */
  readonly problem: string | null;
  readonly beside: boolean;
  readonly send: QuickSend;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  readonly onShow: (ref: BrowserTabRef) => void;
  /** Opens the tab's view again. */
  readonly onRetry: () => void;
  readonly onOpenTab: (url: string | null) => void;
  readonly onClose: () => void;
  readonly onConversation: (botId: BotId) => void;
  readonly ref: Ref<TabLiveHandle>;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const bots = useBots();
  const waitsForPerson = useWaitingBots();
  // Declared first, so it runs before the view closes as the pane goes: what was held goes back.
  const leaving = useRef(() => {});
  useEffect(() => () => leaving.current(), []);

  const { stageRef, current: tabView } = useTabView(tab?.ref ?? null, zoomableSize);
  const state: BrowserViewState | null = tabView?.state ?? null;
  const use = usePageUse({ tab, send: tabView?.view.send ?? null, shared });
  const online = useOnline();
  const frozen = frozenOf({ tab, online, status: liveness(state) });
  const status = state?.status._tag;
  const showsPage =
    tabView !== null &&
    frozen._tag === "live" &&
    (status === "live" || status === "reconnecting" || status === "paused");

  // Leaving, or going to another tab, gives what this device holds back at once.
  const leave = () => {
    tabView?.releasing();
    use.leave();
  };
  useEffect(() => {
    leaving.current = leave;
  });
  useImperativeHandle(ref, () => ({ leave: () => leaving.current() }), []);
  const showTab = (ref: BrowserTabRef) => {
    if (ref === tab?.ref) return;
    leave();
    onShow(ref);
  };

  const page = useRef<LivePageHandle>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // A wide page opens near the bot, at a size that reads, and slides after its pointer.
  const [following, setFollowing] = useState(true);
  const followed = tab === null ? null : followedBot(tab, from.id);
  const follow = following ? followed : null;

  const [opened, setOpened] = useState<Opened>(null);
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name ?? t("bot.unknown");
  const words = tabLineWords(use.line, nameOf, ctx.i18n);
  const site = siteOf(tab?.url ?? "");
  const where = site === "" ? (tab?.title ?? "") : site;
  const usable =
    status === "live" &&
    frozen._tag === "live" &&
    tab?.holder._tag !== "elsewhere" &&
    tab?.holder._tag !== "fill";
  const dialog = use.holding ? (state?.control?.dialog ?? null) : null;

  const closeTab = (closed: ViewerTab) =>
    closing.close({ ref: closed.ref, bots: closed.onIt } satisfies Closed);
  const step = (direction: -1 | 1) => {
    if (tab === null) return;
    const next = neighborTab(tabs, tab.ref, direction);
    if (next !== null) showTab(next.ref);
  };

  const undo =
    problem !== null ? (
      <Notice text={problem} />
    ) : (
      <UndoLine closed={closing.last} onUndo={closing.undo} />
    );

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col bg-background">
      <SiteLine
        where={where}
        beside={beside}
        headingRef={headingRef}
        headingId={headingId}
        onClose={onClose}
      />
      <div ref={stageRef} className="relative flex min-h-0 flex-1 flex-col">
        {showsPage && tab !== null ? (
          <LivePage
            ref={page}
            tabRef={tab.ref}
            view={tabView.view}
            page={state?.viewport ?? null}
            usable={usable}
            send={use.send}
            onIt={tab.onIt}
            follow={follow}
            onFollowing={() => setFollowing(false)}
            holding={use.holding}
            onKeyboard={use.keyboard}
            label={t("browser.page", { site: where || t("browser.panel.newTab") })}
            description={t("browser.viewer.touchIsUsing")}
            onLeave={() => closeButton.current?.focus()}
          >
            {!following && followed !== null && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                <Button
                  variant="outline"
                  className="pointer-events-auto rounded-pill bg-surface shadow-overlay"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setFollowing(true)}
                >
                  <CrosshairIcon />
                  {t("browser.live.follow", { name: nameOf(followed) })}
                </Button>
              </div>
            )}
          </LivePage>
        ) : (
          <InPlace
            tab={tab}
            loading={loading}
            state={state}
            frozen={frozen}
            onShowHere={tabView?.reopen ?? onRetry}
          />
        )}
        {dialog !== null && (
          <PageDialog
            // Each dialog the page opens starts with its own default value.
            key={`${dialog.kind}:${dialog.message}:${dialog.defaultValue}`}
            site={where}
            dialog={dialog}
            onAnswer={(accept, promptText) =>
              use.send({
                type: "dialog",
                accept,
                ...(promptText === undefined ? {} : { promptText }),
              })
            }
          />
        )}
      </div>
      {opened !== "tabs" && undo}
      <LiveBar
        use={use}
        frozen={frozen}
        faces={tab === null ? [] : tabFaces(tab, waitsForPerson)}
        text={frozenLine(frozen, words.text, t)}
        action={frozen._tag === "live" ? words.action : null}
        tabs={tabs}
        shown={tab?.ref ?? null}
        needsYou={needsYouElsewhere(tabs, tab?.ref ?? null, waitsForPerson)}
        closeButton={closeButton}
        menu={
          <MenuPopup side="top" align="end">
            <MenuItem icon={<ArrowRightIcon />} onClick={() => use.send({ type: "forward" })}>
              {t("browser.live.forward")}
            </MenuItem>
            <MenuItem icon={<RotateCwIcon />} onClick={() => use.send({ type: "reload" })}>
              {t("browser.live.reload")}
            </MenuItem>
            <MenuItem icon={<GlobeIcon />} onClick={() => setOpened("address")}>
              {t("browser.live.goTo")}
            </MenuItem>
            {shared && (
              <MenuItem icon={<PlusIcon />} onClick={() => setOpened("new")}>
                {t("browser.live.newTab")}
              </MenuItem>
            )}
            {shared && tab !== null && (
              <MenuItem icon={<XIcon />} destructive onClick={() => closeTab(tab)}>
                {t("browser.live.closeTab")}
              </MenuItem>
            )}
          </MenuPopup>
        }
        onClose={onClose}
        onBack={() => use.send({ type: "back" })}
        onSheet={() => setOpened("sheet")}
        onTabs={() => setOpened("tabs")}
        onStep={step}
        onField={(direction) => page.current?.field(direction)}
        onDoneTyping={() => page.current?.doneTyping()}
      />

      {tab !== null && (
        <TabSheet
          open={opened === "sheet"}
          tab={tab}
          from={from.id}
          waiting={use.line._tag === "waits-until-continue"}
          waitsForPerson={waitsForPerson}
          send={send}
          onClose={() => setOpened(null)}
          onWaitForMe={use.waitForMe}
          onContinue={use.giveBack}
          onConversation={(botId) => {
            setOpened(null);
            onConversation(botId);
          }}
        />
      )}
      <TabGrid
        open={opened === "tabs"}
        tabs={tabs}
        shown={tab?.ref ?? null}
        canChange={shared}
        waitsForPerson={waitsForPerson}
        undo={undo}
        onClose={() => setOpened(null)}
        onShow={(ref) => {
          setOpened(null);
          showTab(ref);
        }}
        onCloseTab={closeTab}
        onNew={() => setOpened("new")}
      />
      <AddressSheet
        open={opened === "address" || opened === "new"}
        title={opened === "new" ? t("browser.live.newTab") : t("browser.live.goTo")}
        onClose={() => setOpened(null)}
        onGo={(url) => {
          if (opened === "new") onOpenTab(url);
          else use.send({ type: "navigate", url });
          setOpened(null);
        }}
      />
    </section>
  );
}

/** The line's words while the page is frozen: no connection says it all, and offers nothing. */
const frozenLine = (frozen: Frozen, line: string, t: ReturnType<typeof useI18n>["t"]): string => {
  switch (frozen._tag) {
    case "live":
      return line;
    case "reconnecting":
      return t("browser.reconnecting");
    case "you-offline":
    case "computer-away":
      return t("browser.line.noConnection");
  }
};

/**
 * The site, alone above the page, which only informs, and is the view's
 * heading. Pulled down, it closes the live view, as a sheet does. Over the
 * conversation beside the roster, it leads with the way back to it.
 */
function SiteLine({
  where,
  beside,
  headingRef,
  headingId,
  onClose,
}: {
  readonly where: string;
  readonly beside: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  // Pulled down by a finger, from where it touched.
  const from = useRef<{ readonly id: number; readonly y: number } | null>(null);
  return (
    <header
      className="flex min-h-11 shrink-0 touch-pan-x items-center gap-1 border-b border-border px-2"
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") from.current = { id: event.pointerId, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = from.current;
        from.current = null;
        if (start?.id === event.pointerId && event.clientY - start.y > PULL_TO_CLOSE) onClose();
      }}
      onPointerCancel={() => {
        from.current = null;
      }}
    >
      {beside && (
        <Button variant="ghost-muted" size="sm" className="shrink-0" onClick={onClose}>
          <ChevronLeftIcon />
          {t("browser.live.toConversation")}
        </Button>
      )}
      <h2
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="min-w-0 flex-1 truncate py-2 text-center text-sm text-muted-foreground outline-none"
      >
        {where === "" ? t("browser.viewer.title") : where}
      </h2>
      {beside && <span aria-hidden className="w-24 shrink-0" />}
    </header>
  );
}

/** "Tab closed", whom it told, and Undo, while Undo can still bring it back. */
function UndoLine({
  closed,
  onUndo,
}: {
  readonly closed: Closed | null;
  readonly onUndo: () => void;
}) {
  const i18n = useI18n();
  const { t, plural } = i18n;
  const bots = useBots();
  if (closed === null) return null;
  const told = closed.bots.filter((botId) => bots.has(botId));
  const text =
    told.length === 0
      ? t("browser.grid.closed")
      : plural("browser.grid.closedTold", told.length, {
          names: botNames(told, (botId) => bots.get(botId)?.profile.name ?? "", i18n),
        });
  return (
    <div
      role="status"
      className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg bg-foreground ps-4 text-background"
    >
      <p className="min-w-0 flex-1 py-2.5 text-sm">{text}</p>
      <button
        type="button"
        onClick={onUndo}
        className="min-h-11 shrink-0 px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t("browser.grid.undo")}
      </button>
    </div>
  );
}

/** What did not work, in Undo's place. */
function Notice({ text }: { readonly text: string }) {
  return (
    <p
      role="status"
      className="mx-3 mb-2 shrink-0 rounded-lg bg-foreground px-4 py-2.5 text-sm text-background"
    >
      {text}
    </p>
  );
}

/**
 * The bar in the thumb's reach, at the bottom. Swiped sideways, it goes to
 * the next tab. While the keyboard is up on a field of the page, it holds
 * the previous and next field, the line, and OK, which puts the keyboard away.
 */
function LiveBar({
  use,
  frozen,
  faces,
  text,
  action,
  tabs,
  shown,
  needsYou,
  closeButton,
  menu,
  onClose,
  onBack,
  onSheet,
  onTabs,
  onStep,
  onField,
  onDoneTyping,
}: {
  readonly use: PageUseHandle;
  readonly frozen: Frozen;
  readonly faces: ReturnType<typeof tabFaces>;
  readonly text: string;
  readonly action: "now" | "continue" | null;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shown: BrowserTabRef | null;
  readonly needsYou: boolean;
  readonly closeButton: RefObject<HTMLButtonElement | null>;
  /** The menu's rows. */
  readonly menu: ReactNode;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onSheet: () => void;
  readonly onTabs: () => void;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onField: (direction: "next" | "previous") => void;
  readonly onDoneTyping: () => void;
}) {
  const { t, plural } = useI18n();
  const swipe = useSideSwipe({
    onSwipe: (direction) => {
      if (direction !== null) onStep(direction);
    },
  });
  const live = frozen._tag === "live";
  const bottom = "pb-[max(--spacing(2),env(safe-area-inset-bottom))]";

  if (use.keyboardUp && live) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-t border-border bg-surface px-2 py-1",
          bottom,
        )}
      >
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label={t("browser.keys.previous")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onField("previous")}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label={t("browser.keys.next")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onField("next")}
        >
          <ChevronDownIcon />
        </Button>
        <p role="status" className="min-w-0 flex-1 truncate px-1.5 text-sm text-muted-foreground">
          {text}
        </p>
        <Button variant="ghost" onClick={onDoneTyping}>
          {t("browser.keys.done")}
        </Button>
      </div>
    );
  }

  const index = tabs.findIndex((tab) => tab.ref === shown);
  return (
    <div {...swipe} className={cn("shrink-0 touch-pan-y border-t border-border pt-1", bottom)}>
      <div className="flex items-center gap-0.5 px-1">
        <Button
          ref={closeButton}
          variant="ghost-muted"
          size="icon"
          aria-label={t("browser.live.close")}
          onClick={onClose}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label={t("browser.live.back")}
          disabled={!live}
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <button
          type="button"
          aria-label={text === "" ? t("browser.sheet.title") : text}
          onClick={onSheet}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-start focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Faces faces={faces} />
          <span aria-live="polite" className="min-w-0 flex-1 truncate text-sm">
            {text}
          </span>
        </button>
        {action !== null && (
          <Button variant="outline" className="shrink-0 rounded-pill" onClick={use.giveBack}>
            {t(action === "now" ? "browser.line.now" : "browser.line.continue")}
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon"
          className="relative"
          aria-label={`${plural("browser.live.tabs", tabs.length)}${needsYou ? `, ${t("browser.live.needsYou")}` : ""}`}
          onClick={onTabs}
        >
          <span className="flex size-6 items-center justify-center rounded-md border-2 border-current text-2xs font-semibold">
            {tabs.length}
          </span>
          {needsYou && (
            <span
              aria-hidden
              className="absolute end-1.5 top-1.5 size-2.5 rounded-pill bg-waiting"
            />
          )}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost-muted" size="icon" aria-label={t("browser.live.more")} />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          {menu}
        </Menu>
      </div>
      {tabs.length > 1 && index !== -1 && (
        <div
          role="img"
          aria-label={t("browser.live.tabOf", {
            index: String(index + 1),
            count: String(tabs.length),
          })}
          className="flex justify-center gap-1.5 pb-1"
        >
          {tabs.map((each, at) => (
            <span
              key={each.ref}
              className={cn("size-1.5 rounded-pill", at === index ? "bg-foreground" : "bg-border")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What stands in the page's place: the last picture, dimmed under a calm
 * card, while the page is frozen; else how the view is coming, or why it
 * ended.
 */
function InPlace({
  tab,
  loading,
  state,
  frozen,
  onShowHere,
}: {
  readonly tab: ViewerTab | null;
  readonly loading: boolean;
  readonly state: BrowserViewState | null;
  readonly frozen: Frozen;
  readonly onShowHere: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const picture = useLastPicture(tab?.ref ?? null);
  const time = picture === null ? null : clockTime(DateTime.makeUnsafe(picture.at), ctx);
  const message = (
    text: ReactNode,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
      {text}
      {action !== undefined && (
        <Button variant="outline" onClick={action.onPress}>
          {action.label}
        </Button>
      )}
    </div>
  );
  const still =
    picture === null ? null : (
      <img
        src={picture.url}
        alt=""
        className="absolute inset-0 size-full object-contain object-top opacity-40"
      />
    );
  const working = (
    <div className="absolute inset-0 flex items-center justify-center">
      <LoaderCircleIcon
        role="img"
        aria-label={t("browser.connecting")}
        className="size-6 text-muted-foreground motion-safe:animate-spin"
      />
    </div>
  );
  const body = (text: string) => <p className="max-w-80 text-sm text-muted-foreground">{text}</p>;
  if (frozen._tag === "computer-away" || frozen._tag === "you-offline") {
    const away = frozen._tag === "computer-away";
    return (
      <div className="relative flex-1 bg-muted">
        {still}
        {message(
          <div
            role="status"
            className="flex w-full max-w-sm flex-col gap-1.5 rounded-xl border border-border bg-surface p-5 text-start shadow-overlay"
          >
            <p className="text-base font-medium">
              {t(away ? "browser.frozen.computerAway.title" : "browser.frozen.youOffline.title")}
            </p>
            {time !== null && (
              <p className="text-sm text-muted-foreground">
                {t(away ? "browser.frozen.computerAway.body" : "browser.frozen.youOffline.body", {
                  time,
                })}
              </p>
            )}
          </div>,
        )}
      </div>
    );
  }
  if (tab === null) {
    return (
      <div className="relative flex-1 bg-muted">
        {loading ? working : message(body(t("browser.noTab")))}
      </div>
    );
  }
  const shown = (() => {
    switch (state?.status._tag) {
      case undefined:
      case "connecting":
      case "live":
      case "reconnecting":
      case "paused":
        return (
          <>
            {still}
            {working}
          </>
        );
      case "gone":
        return message(body(t("browser.gone")));
      case "setup-needed":
        return message(
          <div className="flex flex-col items-center gap-2">
            {body(t("browser.setupNeeded"))}
            <DocsLink href={BROWSER_SETUP_DOCS}>{t("details.browser.howToFix")}</DocsLink>
          </div>,
        );
      case "replaced":
        return message(body(t("browser.replaced")), {
          label: t("browser.showHere"),
          onPress: onShowHere,
        });
      case "failed":
        return message(body(t("browser.failed")), {
          label: t("browser.retry"),
          onPress: onShowHere,
        });
    }
  })();
  return <div className="relative flex-1 bg-muted">{shown}</div>;
}
