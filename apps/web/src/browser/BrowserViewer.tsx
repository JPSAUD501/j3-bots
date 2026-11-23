// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { BrowserControl, BrowserViewState } from "@j3-bots/client-runtime";
import type { Bot, BrowserTab, BrowserTabRef } from "@j3-bots/contracts";
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useI18n } from "../app/context";
import { Button } from "../components/ui/button";
import { alertDialog, dialogBackdrop, dialogTitle } from "../components/ui/dialog";
import { textField } from "../components/ui/field";
import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { BrowserSurface } from "./BrowserSurface";
import { useBrowserTabs } from "./context";
import { addressOf, LEAVE_PAGE_KEY } from "./input";
import { holds } from "./source";
import { statusKey } from "./status";
import { frontTab, siteOf } from "@j3-bots/client-runtime/presentation";
import { type TabView, useTabView } from "./useTabView";

/** A help card the bot left for the operator in this browser: Done and Can't do it answer it. */
interface BrowserHelp {
  /** The tab the bot asked for help in. */
  readonly tab: BrowserTabRef;
  readonly onDone: () => void;
  readonly onDecline: () => void;
}

/** What the shell asks of an open viewer. */
export interface BrowserViewerHandle {
  /**
   * Closes the viewer, or with `next` does that instead, first asking whether
   * to hand the tab back while the operator holds it.
   */
  readonly requestClose: (next?: () => void) => void;
}

interface BrowserViewerProps {
  readonly bot: Bot;
  /** The tab asked for, or the bot's front tab. */
  readonly target: BrowserTabRef | "front";
  /** The bot's help card in its browser, while one waits; null otherwise. */
  readonly help: BrowserHelp | null;
  readonly onClose: () => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  readonly ref?: Ref<BrowserViewerHandle>;
}

/**
 * The bot's tab, live: its site and address, who acts on it, and one primary
 * action, taking control or, once taken, handing it back. Only the operator
 * in control gets back, forward, reload and the address field, and only then
 * does what they do over the picture reach the page. It follows the bot to a
 * pop-up the page opens, as a sign-in window, and back when it closes.
 */
export function BrowserViewer({
  bot,
  target,
  help,
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

  const { stageRef, box, current: tabView } = useTabView(tab?.ref ?? null);
  const state: BrowserViewState | null = tabView?.state ?? null;
  const controller = state?.control?.controller ?? null;
  const control = state !== null && holds(state);
  const live = state?.status._tag === "live";

  // Following a pop-up out of a tab the operator held, they keep going in it.
  const followed = useRef<{ readonly from: BrowserTabRef; readonly held: boolean } | null>(null);
  const shownTab = tab?.ref ?? null;
  const lastShown = useRef<{ ref: BrowserTabRef | null; control: boolean }>({
    ref: null,
    control: false,
  });
  useEffect(() => {
    const before = lastShown.current;
    if (before.ref !== null && before.ref !== shownTab) {
      followed.current = { from: before.ref, held: before.control };
    }
    lastShown.current = { ref: shownTab, control };
  }, [shownTab, control, followed, lastShown]);
  useEffect(() => {
    const follow = followed.current;
    const shownController = tabView?.state.control?.controller;
    if (follow === null || tabView?.state.status._tag !== "live" || shownController === undefined) {
      return;
    }
    followed.current = null;
    if (follow.held && shownController !== "you" && shownController !== "another-device") {
      tabView.view.send({ type: "take" });
    }
  }, [tabView, followed]);

  // Leaving while in control asks once whether to hand the tab back.
  const [asking, setAsking] = useState<{ readonly next: () => void } | null>(null);
  const requestClose = useEffectEvent((next: () => void = onClose) => {
    if (control) setAsking({ next });
    else next();
  });
  useImperativeHandle(ref, () => ({ requestClose: (next) => requestClose(next) }), []);

  const primary = useRef<HTMLButtonElement>(null);
  // Taking control here puts the keyboard on the page.
  const [justTook, setJustTook] = useState(false);

  const site = tab === null ? "" : siteOf(tab.url);
  // The help card answers for its own tab, or for whatever is shown once its tab is gone, as after
  // the server restarted.
  const helpHere =
    help !== null &&
    tabs !== null &&
    (help.tab === tab?.ref || !tabs.some((each) => each.ref === help.tab))
      ? help
      : null;
  const take = () => {
    if (controller === "another-device") return;
    setJustTook(true);
    tabView?.view.send({ type: "take" });
  };
  /** Gives the tab back without a word on the help card, which stays open. */
  const release = () => {
    setJustTook(false);
    tabView?.releasing();
    tabView?.view.send({ type: "release" });
  };
  // Answering the help card gives the tab back on the server.
  const done = () => {
    if (helpHere === null) return release();
    setJustTook(false);
    tabView?.releasing();
    helpHere.onDone();
  };
  const decline = () => {
    setJustTook(false);
    tabView?.releasing();
    helpHere?.onDecline();
  };

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
          variant="ghost-muted"
          size="icon"
          onClick={() => requestClose()}
          aria-label={t("browser.close")}
        >
          <XIcon />
        </Button>
      </header>
      {tab !== null && (
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          {control && tabView !== null ? (
            <Navigation url={tab.url} view={tabView} />
          ) : (
            <p
              className="min-w-0 flex-1 truncate px-1.5 font-mono text-2xs text-muted-foreground"
              title={tab.url}
            >
              {tab.url}
            </p>
          )}
        </div>
      )}
      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center p-3">
        {tab === null ? (
          tabs !== null && <StageNote>{t("browser.noTab")}</StageNote>
        ) : tabView !== null && box !== null ? (
          <>
            <BrowserSurface
              // A new view starts drawing afresh.
              key={tab.ref}
              view={tabView.view}
              viewport={state?.viewport ?? null}
              box={{ width: Math.max(box.width - 24, 64), height: Math.max(box.height - 24, 64) }}
              control={control}
              label={t("browser.page", { site: site || t("browser.panel.newTab") })}
              description={t("browser.status.you")}
              onLeave={() => primary.current?.focus()}
              focusPage={justTook}
            />
            <StageState tabView={tabView} />
            {control && state?.control?.dialog != null && (
              <PageDialog
                key={`${state.control.generation}:${state.control.dialog.kind}:${state.control.dialog.message}`}
                site={site}
                dialog={state.control.dialog}
                onAnswer={(accept, promptText) =>
                  tabView.view.send({
                    type: "dialog",
                    accept,
                    ...(promptText === undefined ? {} : { promptText }),
                  })
                }
              />
            )}
          </>
        ) : null}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 pb-[max(--spacing(2.5),env(safe-area-inset-bottom))]">
        <StatusLine state={state} tab={tab} />
        {tab !== null && state !== null && (control || live) && (
          <span className="ms-auto flex shrink-0 flex-wrap items-center gap-2">
            {control && (
              <Kbd className="hidden pointer-fine:inline-flex">
                {t("browser.viewer.leaveKey", { key: LEAVE_PAGE_KEY })}
              </Kbd>
            )}
            {control && helpHere !== null && (
              <Button variant="outline" onClick={decline}>
                {t("browser.cantDoIt")}
              </Button>
            )}
            {control ? (
              <Button ref={primary} variant="primary" onClick={done}>
                {t("browser.done")}
              </Button>
            ) : (
              <Button
                ref={primary}
                variant="primary"
                onClick={take}
                aria-disabled={controller === "another-device"}
                aria-description={
                  controller === "another-device" ? t("browser.viewer.heldElsewhere") : undefined
                }
              >
                {t("browser.take")}
              </Button>
            )}
          </span>
        )}
      </footer>
      <AlertDialog.Root
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
          <AlertDialog.Popup className={cn(alertDialog, "z-50 max-w-sm gap-2 p-5")}>
            <AlertDialog.Title className={dialogTitle}>
              {t("browser.handBack.title")}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted-foreground">
              {t("browser.handBack.body")}
            </AlertDialog.Description>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <AlertDialog.Close render={<Button />} onClick={() => asking?.next()}>
                {t("browser.handBack.keep")}
              </AlertDialog.Close>
              <AlertDialog.Close
                render={<Button variant="primary" />}
                onClick={() => {
                  release();
                  asking?.next();
                }}
              >
                {t("browser.handBack.confirm")}
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

/** Who acts on the tab, or what the view waits on; announced as it changes. */
function StatusLine({
  state,
  tab,
}: {
  readonly state: BrowserViewState | null;
  readonly tab: BrowserTab | null;
}) {
  const { t } = useI18n();
  const controller = state?.control?.controller ?? null;
  const text =
    tab === null || state === null
      ? null
      : state.status._tag === "connecting"
        ? t("browser.connecting")
        : state.status._tag === "reconnecting" || state.status._tag === "paused"
          ? t("browser.reconnecting")
          : state.status._tag === "live" && controller !== null
            ? t(statusKey(controller))
            : null;
  return (
    <p
      role="status"
      className={cn(
        "min-w-0 text-xs",
        controller === "you" ? "font-medium text-waiting" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
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
        <StageNote>
          {status.need === "sandbox"
            ? t("browser.setupNeeded.sandbox")
            : t("browser.setupNeeded.libraries")}
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
}: {
  readonly children: ReactNode;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <div className="absolute inset-3 flex flex-col items-center justify-center gap-3 rounded-md bg-background/90 p-6 text-center">
      <p className="max-w-80 text-sm text-muted-foreground">{children}</p>
      {action !== undefined && <Button onClick={action.onPress}>{action.label}</Button>}
    </div>
  );
}

/** Back, forward, reload and the address, for the operator in control. */
function Navigation({ url, view }: { readonly url: string; readonly view: TabView }) {
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
    view.view.send({ type: "navigate", url: address });
  };
  return (
    <>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => view.view.send({ type: "back" })}
        aria-label={t("browser.viewer.back")}
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => view.view.send({ type: "forward" })}
        aria-label={t("browser.viewer.forward")}
      >
        <ArrowRightIcon />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        onClick={() => view.view.send({ type: "reload" })}
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

/** A dialog the page waits on, for the operator in control to answer. */
function PageDialog({
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
