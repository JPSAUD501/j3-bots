// SPDX-License-Identifier: AGPL-3.0-or-later
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type {
  BrowserPlace,
  DesktopBrowserCommand,
  DesktopBrowserTab,
} from "@j3-bots/desktop-bridge";
import { EllipsisVerticalIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useI18n } from "../../app/context";
import { Kbd } from "../../components/ui/kbd";
import { MenuItem, MenuSeparator } from "../../components/ui/menu";
import { cn } from "../../lib/cn";
import { control, keys, popup } from "./controls";

// The browser's menu: its rows in groups, a line between each two. A group
// with no row for the tab in front is left out, with its line.

type MenuEntry =
  | {
      readonly _tag: "item";
      readonly key: string;
      readonly label: string;
      /** The keys that do the same, as `keys` takes them. */
      readonly shortcut?: ReadonlyArray<string>;
      readonly onClick: () => void;
    }
  /** A row of its own controls, not a command. */
  | { readonly _tag: "row"; readonly key: string; readonly row: ReactNode };

export function BrowserMenu({
  tab,
  place,
  command,
  canReopen,
  mac,
  onOpen,
  onList,
  onFind,
  onSignIns,
}: {
  readonly tab: DesktopBrowserTab | null;
  readonly place: BrowserPlace;
  readonly command: (command: DesktopBrowserCommand) => void;
  readonly canReopen: boolean;
  readonly mac: boolean;
  /** The menu opens or closes, over the page. */
  readonly onOpen: (open: boolean) => void;
  /** Opens one of the bar's lists. */
  readonly onList: (list: "downloads" | "history") => void;
  readonly onFind: () => void;
  readonly onSignIns?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const other: BrowserPlace = place === "panel" ? "window" : "panel";
  const groups: ReadonlyArray<ReadonlyArray<MenuEntry>> = [
    [
      {
        _tag: "item",
        key: "newTab",
        label: t("desktopBrowser.newTab"),
        shortcut: ["Ctrl", "T"],
        onClick: () => command({ _tag: "open", private: false, place }),
      },
      {
        _tag: "item",
        key: "newPrivateTab",
        label: t("desktopBrowser.newPrivateTab"),
        shortcut: ["Ctrl", "Shift", "N"],
        onClick: () => command({ _tag: "open", private: true, place }),
      },
      ...(canReopen
        ? [
            {
              _tag: "item",
              key: "reopen",
              label: t("desktopBrowser.menu.reopen"),
              shortcut: ["Ctrl", "Shift", "T"],
              onClick: () => command({ _tag: "reopen", place }),
            } satisfies MenuEntry,
          ]
        : []),
    ],
    tab === null
      ? []
      : [
          {
            _tag: "row",
            key: "zoom",
            row: (
              <div className="flex h-9 items-center gap-2 px-2.5">
                <span className="flex-1">{t("desktopBrowser.menu.zoom")}</span>
                <button
                  type="button"
                  className={control}
                  aria-label={t("desktopBrowser.menu.zoomOut")}
                  onClick={() => command({ _tag: "zoom", tab: tab.ref, to: "out" })}
                >
                  −
                </button>
                <span className="w-10 text-center tabular-nums">{tab.zoom}%</span>
                <button
                  type="button"
                  className={control}
                  aria-label={t("desktopBrowser.menu.zoomIn")}
                  onClick={() => command({ _tag: "zoom", tab: tab.ref, to: "in" })}
                >
                  +
                </button>
              </div>
            ),
          },
          {
            _tag: "item",
            key: "find",
            label: t("desktopBrowser.menu.find"),
            shortcut: ["Ctrl", "F"],
            onClick: onFind,
          },
          {
            _tag: "item",
            key: "print",
            label: t("desktopBrowser.menu.print"),
            shortcut: ["Ctrl", "P"],
            onClick: () => command({ _tag: "print", tab: tab.ref }),
          },
        ],
    [
      {
        _tag: "item",
        key: "history",
        label: t("desktopBrowser.menu.history"),
        shortcut: ["Ctrl", mac ? "Y" : "H"],
        onClick: () => onList("history"),
      },
      {
        _tag: "item",
        key: "downloads",
        label: t("desktopBrowser.downloads"),
        shortcut: ["Ctrl", "J"],
        onClick: () => onList("downloads"),
      },
      ...(onSignIns === undefined
        ? []
        : [
            {
              _tag: "item",
              key: "signIns",
              label: t("desktopBrowser.menu.signIns"),
              onClick: onSignIns,
            } satisfies MenuEntry,
          ]),
    ],
    tab === null
      ? []
      : [
          {
            _tag: "item",
            key: "otherPlace",
            label: t(place === "panel" ? "desktopBrowser.toWindow" : "desktopBrowser.toPanel"),
            shortcut: ["Ctrl", "Shift", "D"],
            onClick: () => command({ _tag: "show", tab: tab.ref, place: other }),
          },
        ],
  ];
  const shown = groups.filter((group) => group.length > 0);
  return (
    <MenuPrimitive.Root onOpenChange={onOpen}>
      <MenuPrimitive.Trigger className={control} aria-label={t("desktopBrowser.menu")}>
        <EllipsisVerticalIcon />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <MenuPrimitive.Popup className={cn(popup, "min-w-60")}>
            {shown.map((group, index) => (
              <Fragment key={group[0]?.key}>
                {index > 0 && <MenuSeparator />}
                {group.map((entry) =>
                  entry._tag === "row" ? (
                    <Fragment key={entry.key}>{entry.row}</Fragment>
                  ) : (
                    <MenuItem key={entry.key} onClick={entry.onClick}>
                      {entry.shortcut === undefined ? (
                        entry.label
                      ) : (
                        <span className="flex items-center gap-4">
                          {entry.label}
                          <Kbd className="ms-auto">{keys(mac, ...entry.shortcut)}</Kbd>
                        </span>
                      )}
                    </MenuItem>
                  ),
                )}
              </Fragment>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
