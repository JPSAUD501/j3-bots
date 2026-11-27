// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LookingAt } from "@j3-bots/contracts";
import { lookingAtLine } from "@j3-bots/client-runtime/presentation";
import { AppWindowIcon, ImageIcon, ImageOffIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../app/context";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";

/**
 * The picture of the window, as its chip shows it. `none`: this computer
 * cannot take one. `off`: none goes, until the operator turns it on.
 * `asking`: macOS needs the operator's permission first, which the card
 * above the chips asks for. `taking`, `on` with what was taken, and
 * `failed` when nothing could be.
 */
export type PictureChip =
  | { readonly _tag: "none" }
  | { readonly _tag: "off" }
  | { readonly _tag: "asking" }
  | { readonly _tag: "taking" }
  | { readonly _tag: "on"; readonly url: string }
  | { readonly _tag: "failed" };

/** What goes with the operator's message, as quick access shows it: exactly what is sent. */
export interface WindowChipsView {
  readonly lookingAt: LookingAt;
  readonly picture: PictureChip;
}

export interface WindowChipsIntents {
  /** Nothing of the window goes: neither its app and title nor its picture. */
  readonly removeWindow: () => void;
  readonly turnPictureOn: () => void;
  readonly turnPictureOff: () => void;
  /** Asks macOS for Screen Recording, where the operator allows it. */
  readonly allowScreen: () => void;
  /** Puts the ask away, the picture off. */
  readonly notNow: () => void;
}

/** A chip: what it names, which a tap opens or acts on, and its own way to take it off. */
function Chip({
  children,
  label,
  pressed,
  dashed = false,
  onPress,
  removeLabel,
  onRemove,
}: {
  children: ReactNode;
  label: string;
  pressed?: boolean;
  dashed?: boolean;
  onPress?: () => void;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 max-w-full min-w-0 items-center rounded-pill border text-xs",
        dashed ? "border-dashed border-border text-muted-foreground" : "border-border bg-muted",
      )}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        {...(pressed === undefined ? {} : { "aria-expanded": pressed })}
        aria-disabled={onPress === undefined}
        onClick={onPress}
        className={cn(
          "flex h-full min-w-0 items-center gap-1.5 rounded-pill ps-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          onRemove === undefined ? "pe-2.5" : "pe-1",
          onPress !== undefined && "cursor-pointer hover:text-foreground",
          "[&_svg]:size-3.5 [&_svg]:shrink-0",
        )}
      >
        {children}
      </button>
      {onRemove !== undefined && removeLabel !== undefined && (
        <button
          type="button"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
          className="pressable-round me-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-pill text-muted-foreground hover:bg-muted-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent [&_svg]:size-3.5"
        >
          <XIcon />
        </button>
      )}
    </span>
  );
}

/**
 * Above quick access's composer: the window the operator was in as they
 * opened it, one chip for its app and title, one for its picture, which is
 * off until they turn it on. A tap on a chip shows what goes, whole; its ×
 * takes it off. What the chips show is exactly what goes with the message.
 */
export function WindowChips({
  view,
  intents,
  botName,
  initialPreview = null,
}: {
  view: WindowChipsView;
  intents: WindowChipsIntents;
  botName: string;
  /** What shows whole as it first draws, as the gallery shows it. */
  initialPreview?: "window" | "picture" | null;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(initialPreview);
  const previewId = useId();
  const { lookingAt, picture } = view;
  const app = lookingAt.app;
  const shownPreview = preview === "picture" && picture._tag !== "on" ? null : preview;
  const toggle = (which: "window" | "picture") => setPreview(shownPreview === which ? null : which);

  return (
    <div
      role="group"
      aria-label={t("quickAccess.window.label")}
      className="swap-in flex flex-col gap-1.5 pb-1.5"
    >
      {picture._tag === "asking" && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs">
          <p className="font-medium text-sm">{t("quickAccess.screen.title")}</p>
          <p className="text-pretty text-muted-foreground">{t("quickAccess.screen.body")}</p>
          <p className="text-pretty text-muted-foreground">{t("quickAccess.screen.reopen")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={intents.allowScreen}>
              {t("quickAccess.screen.allow")}
            </Button>
            <Button size="sm" variant="ghost" onClick={intents.notNow}>
              {t("quickAccess.screen.notNow")}
            </Button>
          </div>
        </div>
      )}
      {shownPreview === "window" && (
        <div
          id={previewId}
          className="flex flex-col gap-1 rounded-lg border border-border bg-muted/50 p-3 text-xs"
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted-foreground">{t("quickAccess.window.app")}</dt>
            <dd className="min-w-0 break-words">{app}</dd>
            {lookingAt.title !== undefined && (
              <>
                <dt className="text-muted-foreground">{t("quickAccess.window.title")}</dt>
                <dd className="min-w-0 break-words">{lookingAt.title}</dd>
              </>
            )}
          </dl>
          <p className="text-pretty text-muted-foreground">
            {t("quickAccess.window.hint", { name: botName })}
          </p>
        </div>
      )}
      {shownPreview === "picture" && picture._tag === "on" && (
        <div
          id={previewId}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/50 p-2 text-xs"
        >
          <img
            src={picture.url}
            alt={t("quickAccess.picture.name", { app })}
            className="max-h-40 w-full rounded-md object-contain"
          />
          <p className="px-1 text-pretty text-muted-foreground">
            {t("quickAccess.picture.hint", { name: botName })}
          </p>
        </div>
      )}
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <Chip
          label={t("quickAccess.window.show", { name: botName, app })}
          pressed={shownPreview === "window"}
          onPress={() => toggle("window")}
          removeLabel={t("quickAccess.window.remove", { app })}
          onRemove={intents.removeWindow}
        >
          <AppWindowIcon aria-hidden />
          <span className="truncate">{lookingAtLine(lookingAt)}</span>
        </Chip>
        {(picture._tag === "off" || picture._tag === "asking") && (
          <Chip
            dashed
            label={t("quickAccess.picture.add", { app })}
            {...(picture._tag === "asking" ? { pressed: true } : {})}
            onPress={intents.turnPictureOn}
          >
            <ImagePlusIcon aria-hidden />
            <span className="truncate">{t("quickAccess.picture.off")}</span>
          </Chip>
        )}
        {picture._tag === "taking" && (
          <Chip
            label={t("quickAccess.picture.taking")}
            removeLabel={t("quickAccess.picture.remove")}
            onRemove={intents.turnPictureOff}
          >
            <ImageIcon aria-hidden className="animate-pulse motion-reduce:animate-none" />
            <span className="truncate">{t("quickAccess.picture.taking")}</span>
          </Chip>
        )}
        {picture._tag === "on" && (
          <Chip
            label={t("quickAccess.picture.show", { app })}
            pressed={shownPreview === "picture"}
            onPress={() => toggle("picture")}
            removeLabel={t("quickAccess.picture.remove")}
            onRemove={() => {
              setPreview(null);
              intents.turnPictureOff();
            }}
          >
            <img src={picture.url} alt="" className="size-5 rounded-sm object-cover" />
            <span className="truncate">{t("quickAccess.picture.on")}</span>
          </Chip>
        )}
        {picture._tag === "failed" && (
          <Chip
            label={t("quickAccess.picture.failed")}
            onPress={intents.turnPictureOn}
            removeLabel={t("quickAccess.picture.remove")}
            onRemove={intents.turnPictureOff}
          >
            <ImageOffIcon aria-hidden />
            <span className="truncate">{t("quickAccess.picture.failed")}</span>
          </Chip>
        )}
      </div>
    </div>
  );
}
