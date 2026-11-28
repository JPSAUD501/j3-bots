// SPDX-License-Identifier: AGPL-3.0-or-later
import { siteOf, tabFaces, type ViewerTab } from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserTabRef } from "@j3-bots/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { Faces } from "../Faces";
import { useLastPicture } from "./pictures";
import { Sheet } from "./Sheet";
import { useSideSwipe } from "./swipe";

/**
 * Every tab, two to a row, as on the phone: each with its last picture, its
 * name and the faces of the bots on it. A press shows it; a swipe sideways
 * or its × closes it, with Undo under the list rather than a question. New
 * opens a tab at an address. A server from before shared tabs opens and
 * closes none.
 */
export function TabGrid({
  open,
  tabs,
  shown,
  canChange,
  waitsForPerson,
  undo,
  onClose,
  onShow,
  onCloseTab,
  onNew,
}: {
  readonly open: boolean;
  readonly tabs: ReadonlyArray<ViewerTab>;
  readonly shown: BrowserTabRef | null;
  /** The person may open and close tabs. */
  readonly canChange: boolean;
  readonly waitsForPerson: ReadonlySet<BotId>;
  /** What Undo says and does, while it can. */
  readonly undo: ReactNode;
  readonly onClose: () => void;
  readonly onShow: (ref: BrowserTabRef) => void;
  readonly onCloseTab: (tab: ViewerTab) => void;
  readonly onNew: () => void;
}) {
  const { t, plural } = useI18n();
  return (
    <Sheet
      open={open}
      title={plural("browser.live.tabs", tabs.length)}
      onClose={onClose}
      footer={undo}
    >
      {canChange && (
        <div className="mb-3 flex justify-end">
          <Button variant="outline" size="sm" onClick={onNew}>
            <PlusIcon />
            {t("browser.grid.new")}
          </Button>
        </div>
      )}
      <ul className="grid grid-cols-2 gap-3">
        {tabs.map((tab) => (
          <TabCard
            key={tab.ref}
            tab={tab}
            current={tab.ref === shown}
            canClose={canChange}
            waitsForPerson={waitsForPerson}
            onShow={() => onShow(tab.ref)}
            onClose={() => onCloseTab(tab)}
          />
        ))}
      </ul>
    </Sheet>
  );
}

function TabCard({
  tab,
  current,
  canClose,
  waitsForPerson,
  onShow,
  onClose,
}: {
  readonly tab: ViewerTab;
  readonly current: boolean;
  readonly canClose: boolean;
  readonly waitsForPerson: ReadonlySet<BotId>;
  readonly onShow: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const picture = useLastPicture(tab.ref);
  const name = tab.title === "" ? siteOf(tab.url) || t("browser.panel.newTab") : tab.title;
  const [offset, setOffset] = useState(0);
  const swipe = useSideSwipe({
    onMove: (dx) => {
      if (canClose) setOffset(dx);
    },
    onSwipe: (direction) => {
      setOffset(0);
      if (canClose && direction !== null) onClose();
    },
  });
  return (
    <li
      {...swipe}
      className={cn(
        "relative touch-pan-y",
        offset === 0 && "transition-[translate,opacity] duration-(--duration-state) ease-out",
      )}
      style={{
        translate: `${offset}px 0`,
        opacity: 1 - Math.min(Math.abs(offset) / 240, 0.6),
      }}
    >
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        aria-label={name}
        onClick={onShow}
        className={cn(
          "block w-full overflow-hidden rounded-lg border bg-background text-start focus-visible:outline-2 focus-visible:outline-accent",
          current ? "border-foreground" : "border-border",
        )}
      >
        <span className="block aspect-[4/5] w-full bg-muted">
          {picture !== null && (
            <img src={picture.url} alt="" className="size-full object-cover object-top" />
          )}
        </span>
        <span className="flex min-h-11 items-center gap-1.5 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
          <Faces faces={tabFaces(tab, waitsForPerson)} size={18} />
        </span>
      </button>
      {canClose && (
        <Button
          variant="ghost-muted"
          size="icon"
          aria-label={t("browser.grid.close", { title: name })}
          onClick={onClose}
          className="absolute end-1 top-1"
        >
          <span className="flex size-6 items-center justify-center rounded-pill bg-surface/90">
            <XIcon className="size-3.5" />
          </span>
        </Button>
      )}
    </li>
  );
}
