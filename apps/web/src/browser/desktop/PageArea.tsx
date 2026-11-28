// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BrowserPlace,
  BrowserSuggestion,
  DesktopBrowserCommand,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import { siteOf } from "@j3-bots/client-runtime/presentation";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../../components/ui/button";
import { useCovered } from "../../lib/covered";
import type { DesktopBrowserBridge } from "../../live/desktop";
import { useFoundIn, useStillOf } from "./state";
import { SiteTile } from "./Toolbar";

// Where the tab in front is drawn. The page itself is the app's view, laid
// over this area by the main process; the area tells it where it is. What
// the app draws instead: a new tab's start, a page that failed to open, and
// a still picture of the page while something of the window lies over it:
// the browser's own menus and lists, which `covered` tells, or any of the
// app's dialogs, which leave the area hidden from assistive technology.

/** How long the area follows its own place after it appears, while its pane slides in. */
const SETTLING_MS = 600;

export function PageArea({
  bridge,
  tab,
  place,
  covered,
  finding,
  addressRef,
  command,
  onStopFinding,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab | null;
  readonly place: BrowserPlace;
  readonly covered: boolean;
  readonly finding: boolean;
  readonly addressRef: RefObject<HTMLInputElement | null>;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly onStopFinding: () => void;
}) {
  const { t } = useI18n();
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const underDialog = useCovered(area);
  const hidden = covered || underDialog || tab?.held === true;
  const still = useStillOf(bridge, tab?.ref ?? null);

  useLayoutEffect(() => {
    const element = area;
    if (element === null) return;
    let last = "";
    const report = () => {
      const { left, top, width, height } = element.getBoundingClientRect();
      const placement = {
        bounds: width > 0 && height > 0 ? { x: left, y: top, width, height } : null,
        covered: hidden,
      };
      const said = `${left} ${top} ${width} ${height} ${hidden}`;
      if (said === last) return;
      last = said;
      bridge.place(placement);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    // A pane that slides in moves the area without resizing it.
    const until = performance.now() + SETTLING_MS;
    let frame = requestAnimationFrame(function follow(now) {
      report();
      if (now < until) frame = requestAnimationFrame(follow);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [bridge, area, hidden]);
  // Gone, the tab is drawn nowhere in this window.
  useEffect(() => () => bridge.place({ bounds: null, covered: false }), [bridge]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      {finding && tab !== null && (
        <FindBar bridge={bridge} tab={tab} command={command} onClose={onStopFinding} />
      )}
      <div ref={setArea} className="relative min-h-0 flex-1">
        {tab === null || tab.url === "" ? (
          <NewTab
            bridge={bridge}
            tab={tab}
            place={place}
            command={command}
            addressRef={addressRef}
          />
        ) : tab.failed !== null ? (
          <Failed url={tab.failed.url} onRetry={() => command({ _tag: "reload", tab: tab.ref })} />
        ) : hidden && still !== null ? (
          <img
            src={still}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-cover object-top-left"
          />
        ) : null}
        {tab?.held === true && (
          // No live region here: the area must hold none for `useCovered` to see a dialog over it.
          <p className="absolute inset-x-0 top-3 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full bg-foreground px-3 py-1.5 text-center text-xs text-background shadow-raised">
            {t("desktopBrowser.held")}
          </p>
        )}
      </div>
    </div>
  );
}

/** A new tab: the address waits in the bar, and the sites used most sit below. */
function NewTab({
  bridge,
  tab,
  place,
  command,
  addressRef,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab | null;
  readonly place: BrowserPlace;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly addressRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  const [sites, setSites] = useState<ReadonlyArray<BrowserSuggestion>>([]);
  useEffect(() => {
    void bridge.suggest("").then(setSites);
  }, [bridge]);
  const go = (url: string) =>
    tab === null
      ? command({ _tag: "open", input: url, private: false, place })
      : command({ _tag: "go", tab: tab.ref, input: url });
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
      <button
        type="button"
        className="h-10 w-full max-w-md rounded-full bg-muted px-4 text-start text-sm text-muted-foreground"
        onClick={() => addressRef.current?.focus()}
      >
        {t("desktopBrowser.address")}
      </button>
      {tab?.private === true ? (
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          {t("desktopBrowser.privateHint")}
        </p>
      ) : (
        <ul className="grid max-w-md grid-cols-4 gap-3">
          {sites.map((site) =>
            site._tag === "visited" ? (
              <li key={site.url}>
                <button
                  type="button"
                  onClick={() => go(site.url)}
                  className="pressable flex w-20 flex-col items-center gap-1.5 rounded-lg p-2 text-xs hover:bg-muted"
                >
                  <SiteTile
                    url={site.url}
                    title={site.title}
                    className="size-10 rounded-xl text-base"
                  />
                  <span className="w-full truncate text-center">
                    {site.title || siteOf(site.url)}
                  </span>
                </button>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

/** A page that did not open, in everyday words. */
function Failed({ url, onRetry }: { readonly url: string; readonly onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-lg font-semibold">
        {t("desktopBrowser.failed.title", { site: siteOf(url) || url })}
      </h2>
      <p className="max-w-sm text-sm text-muted-foreground">{t("desktopBrowser.failed.body")}</p>
      <Button onClick={onRetry}>{t("desktopBrowser.failed.retry")}</Button>
    </div>
  );
}

/**
 * Finding in the page: the word, which match of how many, the one before
 * and after, and closing. Enter goes to the next, Escape closes. It sits at
 * the top of the page's area, which the page leaves for it.
 */
function FindBar({
  bridge,
  tab,
  command,
  onClose,
}: {
  readonly bridge: DesktopBrowserBridge;
  readonly tab: DesktopBrowserTab;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const found = useFoundIn(bridge, tab.ref);
  const find = (forward: boolean, looking = text) => {
    if (looking !== "") command({ _tag: "find", tab: tab.ref, text: looking, forward });
  };
  const close = () => {
    command({ _tag: "stopFinding", tab: tab.ref });
    onClose();
  };
  const control =
    "pressable-round inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 [&_svg]:size-4";
  return (
    <div className="flex h-11 shrink-0 items-center justify-end px-2">
      <div className="flex h-9 items-center gap-1 rounded-full border border-border bg-surface ps-3 pe-1 shadow-raised">
        <input
          autoFocus
          aria-label={t("desktopBrowser.find")}
          placeholder={t("desktopBrowser.find")}
          value={text}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            if (next === "") command({ _tag: "stopFinding", tab: tab.ref });
            else find(true, next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              find(!event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {text !== "" && found !== null && (
          <span className="px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {found.matches === 0
              ? t("desktopBrowser.find.none")
              : t("desktopBrowser.find.count", {
                  active: String(found.active),
                  matches: String(found.matches),
                })}
          </span>
        )}
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.previous")}
          disabled={text === ""}
          onClick={() => find(false)}
        >
          <ChevronUpIcon />
        </button>
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.next")}
          disabled={text === ""}
          onClick={() => find(true)}
        >
          <ChevronDownIcon />
        </button>
        <button
          type="button"
          className={control}
          aria-label={t("desktopBrowser.find.close")}
          onClick={close}
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}
