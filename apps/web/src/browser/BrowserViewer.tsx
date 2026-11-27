// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserControl, BrowserViewState } from "@j3-bots/client-runtime";
import { botViewerTab, tabFaces } from "@j3-bots/client-runtime/presentation";
import { usePageUse } from "@j3-bots/client-runtime/react";
import type { Bot, BrowserInput, BrowserTab, BrowserTabRef } from "@j3-bots/contracts";
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useI18n } from "../app/context";
import { DocsLink } from "../components/DocsLink";
import { Button } from "../components/ui/button";
import { textField } from "../components/ui/field";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { BrowserSurface } from "./BrowserSurface";
import { useBrowser, useBrowserTabs } from "./context";
import { Faces } from "./Faces";
import { LEAVE_PAGE_KEY } from "./input";
import { QuietLine } from "./QuietLine";
import {
  addressOf,
  BROWSER_SETUP_DOCS,
  frontTab,
  siteOf,
} from "@j3-bots/client-runtime/presentation";
import { type TabView, useTabView } from "./useTabView";
import { useWaitingBots } from "./waiting";

/** What the shell asks of an open viewer. */
export interface BrowserViewerHandle {
  /** Closes the viewer, or with `next` does that instead; what this device held goes back first. */
  readonly requestClose: (next?: () => void) => void;
}

interface BrowserViewerProps {
  readonly bot: Bot;
  /** The tab asked for, or the bot's front tab. */
  readonly target: BrowserTabRef | "front";
  readonly onClose: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  readonly ref?: Ref<BrowserViewerHandle>;
}

/**
 * The bot's tab, live: its site and address, the faces of the bots on it
 * and its one quiet line. Touching the page is using it, with no step
 * before: what the person does over the picture reaches the page, the bots
 * on the tab wait, and they carry on by themselves once the person stops,
 * after a short countdown Now skips. Wait for me holds them until Continue.
 * Leaving gives the tab back at once. It follows the bot to a pop-up the
 * page opens, as a sign-in window, and back when it closes.
 */
export function BrowserViewer({
  bot,
  target,
  onClose,
  headingRef,
  headingId,
  ref,
}: BrowserViewerProps) {
  const { t } = useI18n();
  const tabs = useBrowserTabs(bot.id);
  const front = tabs === null ? null : frontTab(tabs);

  // The tab shown: the one asked for, until the bot's front tab changes, as when the page opens a
  // pop-up; then the front tab. A tab that closes gives way to the front tab.
  const [asked, setAsked] = useState<BrowserTabRef | null>(target === "front" ? null : target);
  // A tab asked for while the viewer is open, as from a help card, is shown at once.
  const [seenTarget, setSeenTarget] = useState(target);
  if (seenTarget !== target) {
    setSeenTarget(target);
    setAsked(target === "front" ? null : target);
  }
  const [seenFront, setSeenFront] = useState<BrowserTabRef | null | undefined>(undefined);
  const frontRef = front?.ref ?? null;
  if (tabs !== null && seenFront !== frontRef) {
    setSeenFront(frontRef);
    if (seenFront !== undefined && frontRef !== null) setAsked(frontRef);
  }
  const tab: BrowserTab | null =
    (asked === null ? null : tabs?.find((each) => each.ref === asked)) ?? front;

  const pane = useRef<TabPaneHandle>(null);
  const requestClose = useEffectEvent((next: () => void = onClose) => {
    pane.current?.leave();
    next();
  });
  useImperativeHandle(ref, () => ({ requestClose: (next) => requestClose(next) }), []);
  const closeButton = useRef<HTMLButtonElement>(null);
  const site = tab === null ? "" : siteOf(tab.url);

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-sm font-semibold outline-none"
        >
          {site || t("browser.viewer.title")}
        </h2>
        <Button
          ref={closeButton}
          variant="ghost-muted"
          size="icon"
          onClick={() => requestClose()}
          aria-label={t("browser.close")}
        >
          <XIcon />
        </Button>
      </header>
      {tab === null ? (
        <div className="relative flex min-h-0 flex-1">
          {tabs !== null && <StageNote>{t("browser.noTab")}</StageNote>}
        </div>
      ) : (
        <TabPane
          // Each tab is used on its own: leaving one gives it back.
          key={tab.ref}
          ref={pane}
          tab={tab}
          site={site}
          onLeavePage={() => closeButton.current?.focus()}
        />
      )}
    </section>
  );
}

/** What the viewer asks of the tab it shows. */
interface TabPaneHandle {
  /** Gives back what this device holds on the tab, at once. */
  readonly leave: () => void;
}

/** One tab's address, page and line, and the person's use of it. */
function TabPane({
  tab,
  site,
  onLeavePage,
  ref,
}: {
  readonly tab: BrowserTab;
  readonly site: string;
  readonly onLeavePage: () => void;
  readonly ref: Ref<TabPaneHandle>;
}) {
  const { t } = useI18n();
  // Declared first, so it runs before the view closes as the pane goes: what was held goes back.
  const leaving = useRef(() => {});
  useEffect(() => () => leaving.current(), []);

  const { source } = useBrowser();
  const here = useSyncExternalStore(source.pairing.subscribe, source.pairing.get);
  const shared = useSyncExternalStore(source.sharedBrowser.subscribe, source.sharedBrowser.get);
  const shown = botViewerTab(tab, here);
  const { stageRef, box, current: tabView } = useTabView(tab.ref);
  const state: BrowserViewState | null = tabView?.state ?? null;
  const use = usePageUse({ tab: shown, send: tabView?.view.send ?? null, shared });
  const waitsForPerson = useWaitingBots();
  const status = state?.status._tag;
  const usable =
    status === "live" && shown.holder._tag !== "elsewhere" && shown.holder._tag !== "fill";
  const reconnecting = status === "reconnecting" || status === "paused";

  const leave = () => {
    tabView?.releasing();
    use.leave();
  };
  useEffect(() => {
    leaving.current = leave;
  });
  useImperativeHandle(ref, () => ({ leave: () => leaving.current() }), []);

  return (
    <>
      {tabView !== null && (
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <Navigation url={tab.url} send={use.send} />
        </div>
      )}
      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        {tabView !== null && box !== null && (
          <>
            <BrowserSurface
              view={tabView.view}
              viewport={state?.viewport ?? null}
              box={{ width: Math.max(box.width - 24, 64), height: Math.max(box.height - 24, 64) }}
              usable={usable}
              send={use.send}
              holding={use.holding}
              onIt={shown.onIt}
              label={t("browser.page", { site: site || t("browser.panel.newTab") })}
              description={t("browser.viewer.touchIsUsing")}
              onLeave={onLeavePage}
            />
            <StageState tabView={tabView} />
            {use.holding && state?.control?.dialog != null && (
              <PageDialog
                key={`${state.control.generation}:${state.control.dialog.kind}:${state.control.dialog.message}`}
                site={site}
                dialog={state.control.dialog}
                onAnswer={(accept, promptText) =>
                  use.send({
                    type: "dialog",
                    accept,
                    ...(promptText === undefined ? {} : { promptText }),
                  })
                }
              />
            )}
          </>
        )}
      </div>
      <footer className="flex min-h-12 shrink-0 items-center gap-2 border-t border-border px-3 py-2 pb-[max(--spacing(2),env(safe-area-inset-bottom))]">
        <Faces faces={tabFaces(shown, waitsForPerson)} />
        {reconnecting ? (
          <p role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t("browser.reconnecting")}
          </p>
        ) : (
          <QuietLine
            line={use.line}
            onNow={use.giveBack}
            onContinue={use.giveBack}
            className="flex-1"
          />
        )}
        {use.holding && (
          <Kbd className="hidden shrink-0 pointer-fine:inline-flex">
            {t("browser.viewer.leaveKey", { key: LEAVE_PAGE_KEY })}
          </Kbd>
        )}
        {shown.onIt.length > 0 && use.line._tag !== "waits-until-continue" && (
          <Button variant="ghost-muted" size="sm" className="shrink-0" onClick={use.waitForMe}>
            {t("browser.sheet.waitForMe")}
          </Button>
        )}
      </footer>
    </>
  );
}

/** What stands over the picture when there is none to show, or it is out of date. */
function StageState({ tabView }: { readonly tabView: TabView }) {
  const { t } = useI18n();
  const { status } = tabView.state;
  switch (status._tag) {
    case "connecting":
    case "live":
    case "reconnecting":
    case "paused":
      return null;
    case "gone":
      return <StageNote>{t("browser.gone")}</StageNote>;
    case "setup-needed":
      return (
        <StageNote link={{ label: t("details.browser.howToFix"), href: BROWSER_SETUP_DOCS }}>
          {t("browser.setupNeeded")}
        </StageNote>
      );
    case "replaced":
      return (
        <StageNote action={{ label: t("browser.showHere"), onPress: tabView.reopen }}>
          {t("browser.replaced")}
        </StageNote>
      );
    case "failed":
      return (
        <StageNote action={{ label: t("browser.retry"), onPress: tabView.reopen }}>
          {t("browser.failed")}
        </StageNote>
      );
  }
}

function StageNote({
  children,
  action,
  link,
}: {
  readonly children: ReactNode;
  readonly action?: { readonly label: string; readonly onPress: () => void };
  /** A page that says more, opened outside the app. */
  readonly link?: { readonly label: string; readonly href: string };
}) {
  return (
    <div className="absolute inset-3 flex flex-col items-center justify-center gap-3 rounded-md bg-background/90 p-6 text-center">
      <p className="max-w-80 text-sm text-muted-foreground">{children}</p>
      {action !== undefined && <Button onClick={action.onPress}>{action.label}</Button>}
      {link !== undefined && <DocsLink href={link.href}>{link.label}</DocsLink>}
    </div>
  );
}

/** Back, forward, reload and the address: going somewhere is using the page. */
function Navigation({
  url,
  send,
}: {
  readonly url: string;
  readonly send: (input: BrowserInput) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ readonly from: string; readonly text: string } | null>(null);
  const [bad, setBad] = useState(false);
  // What the operator typed stays until the page goes elsewhere.
  const text = draft !== null && draft.from === url ? draft.text : url;
  const go = () => {
    const address = addressOf(text);
    setBad(address === null);
    if (address === null) return;
    setDraft(null);
    send({ type: "navigate", url: address });
  };
  return (
    <>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => send({ type: "back" })}
        aria-label={t("browser.viewer.back")}
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => send({ type: "forward" })}
        aria-label={t("browser.viewer.forward")}
      >
        <ArrowRightIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => send({ type: "reload" })}
        aria-label={t("browser.viewer.reload")}
      >
        <RotateCwIcon />
      </Button>
      <form
        // The address is checked here, so a host alone can be taken as https.
        noValidate
        className="flex min-w-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <input
          type="url"
          inputMode="url"
          enterKeyHint="go"
          value={text}
          onChange={(event) => {
            setBad(false);
            setDraft({ from: url, text: event.target.value });
          }}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={t("browser.viewer.address")}
          aria-invalid={bad}
          aria-describedby={bad ? "browser-address-error" : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(textField, "h-8 px-2.5 font-mono text-2xs pointer-coarse:h-11")}
        />
        {bad && (
          <span
            id="browser-address-error"
            role="alert"
            className="px-2.5 pt-1 text-2xs text-blocked"
          >
            {t("browser.viewer.badAddress")}
          </span>
        )}
      </form>
    </>
  );
}

/** A dialog the page waits on, for the person using the page to answer: the wide viewer's and the live view's. */
export function PageDialog({
  site,
  dialog,
  onAnswer,
}: {
  readonly site: string;
  readonly dialog: NonNullable<BrowserControl["dialog"]>;
  readonly onAnswer: (accept: boolean, promptText?: string) => void;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState(dialog.defaultValue);
  const title =
    dialog.kind === "beforeunload"
      ? t("browser.dialog.leave")
      : t("browser.dialog.from", { site: site || t("browser.panel.newTab") });
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="absolute inset-x-6 top-6 mx-auto flex max-w-sm flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-overlay"
    >
      <p className="text-xs font-semibold">{title}</p>
      {dialog.message !== "" && (
        <p className="text-sm whitespace-pre-wrap wrap-break-word">{dialog.message}</p>
      )}
      {dialog.kind === "prompt" && (
        <input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          aria-label={title}
          className={cn(textField, "h-9")}
        />
      )}
      <div className="flex justify-end gap-2">
        {dialog.kind !== "alert" && (
          <Button variant="outline" size="sm" onClick={() => onAnswer(false)}>
            {t("browser.dialog.dismiss")}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => onAnswer(true, dialog.kind === "prompt" ? answer : undefined)}
        >
          {t("browser.dialog.accept")}
        </Button>
      </div>
    </div>
  );
}
