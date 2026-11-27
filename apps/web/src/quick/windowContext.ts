// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WindowContext } from "@j3-bots/client-runtime";
import type { QuickAccessCue, SeenWindow } from "@j3-bots/desktop-bridge";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useI18n } from "../app/context";
import type { Desktop } from "../live/desktop";
import type { PictureChip, WindowChipsIntents, WindowChipsView } from "./WindowChips";

/** What the hook asks of the desktop app. */
export type WindowSource = Pick<Desktop, "askScreenAccess"> & {
  readonly quickAccess: Pick<Desktop["quickAccess"], "onCue" | "picture">;
};

/** A picture taken of the window, as the page holds it until it goes with a message. */
interface Taken {
  readonly body: Blob;
  readonly url: string;
}

type Picture =
  | { readonly _tag: "none" }
  | { readonly _tag: "off" }
  | { readonly _tag: "asking" }
  | { readonly _tag: "taking"; readonly done: Promise<void> }
  | { readonly _tag: "on"; readonly taken: Taken }
  | { readonly _tag: "failed" };

/** What the latest showing read of the window in front, and its picture. */
interface Held {
  readonly opening: number;
  readonly window: SeenWindow;
  readonly picture: Picture;
}

const chipOf = (picture: Picture): PictureChip =>
  picture._tag === "taking"
    ? { _tag: "taking" }
    : picture._tag === "on"
      ? { _tag: "on", url: picture.taken.url }
      : picture;

/**
 * The window that was in front as quick access opened, which goes with the
 * next message sent from it: what the app read, shown as chips the operator
 * can take off, and a picture taken only when they turn it on (or always,
 * in Settings). It belongs to the showing it was read for: shown again, or
 * put away, it is gone, and so is everything taken of it.
 */
export function useWindowContext(app: WindowSource) {
  const { t } = useI18n();
  const [held, setHeld] = useState<Held | null>(null);
  // What sending reads, which an answer that arrives between renders already changed.
  const current = useRef<Held | null>(null);
  const latest = useRef(0);
  const update = (change: (before: Held | null) => Held | null) => {
    const next = change(current.current);
    current.current = next;
    setHeld(next);
  };

  // A picture's URL lives while it shows.
  const url = held?.picture._tag === "on" ? held.picture.taken.url : null;
  useEffect(() => (url === null ? undefined : () => URL.revokeObjectURL(url)), [url]);

  /** Sets the picture of showing `opening`, if that is still the one held. */
  const setPicture = (opening: number, picture: Picture, unless?: Picture) =>
    update((before) =>
      before === null ||
      before.opening !== opening ||
      (unless !== undefined && before.picture !== unless)
        ? before
        : { ...before, picture },
    );

  const take = (opening: number) => {
    let taking: Picture | null = null;
    const done = app.quickAccess.picture(opening).then((picture) => {
      if (taking === null) return;
      if (picture._tag === "taken") {
        const body = new Blob([picture.bytes.slice()], { type: picture.mediaType });
        const taken = { body, url: URL.createObjectURL(body) };
        setPicture(opening, { _tag: "on", taken }, taking);
        // Taken off or shown again meanwhile: it is not kept.
        const now = current.current?.picture;
        if (now?._tag !== "on" || now.taken !== taken) URL.revokeObjectURL(taken.url);
        return;
      }
      setPicture(
        opening,
        { _tag: picture._tag === "needs-permission" ? "asking" : "failed" },
        taking,
      );
    });
    taking = { _tag: "taking", done };
    setPicture(opening, taking);
  };

  const onCue = useEffectEvent((cue: QuickAccessCue) => {
    switch (cue._tag) {
      case "open":
        latest.current = cue.opening;
        update(() => null);
        return;
      case "leave":
        update(() => null);
        return;
      case "seen": {
        if (cue.opening !== latest.current) return;
        const { window } = cue;
        const now = window.picture === "available" && window.pictureByDefault;
        update(() => ({
          opening: cue.opening,
          window,
          picture: { _tag: window.picture === "none" ? "none" : "off" },
        }));
        if (now) take(cue.opening);
      }
    }
  });
  useEffect(() => app.quickAccess.onCue((cue) => onCue(cue)), [app]);

  const turnPictureOn = () => {
    const now = current.current;
    if (now === null) return;
    if (now.window.picture === "needs-permission") setPicture(now.opening, { _tag: "asking" });
    else take(now.opening);
  };
  const intents: WindowChipsIntents = {
    removeWindow: () => update(() => null),
    turnPictureOn,
    turnPictureOff: () => {
      const now = current.current;
      if (now !== null) setPicture(now.opening, { _tag: "off" });
    },
    allowScreen: () => {
      const now = current.current;
      if (now === null) return;
      void app.askScreenAccess().then((settings) => {
        if (settings?.screen !== "granted") {
          setPicture(now.opening, { _tag: "off" });
          return;
        }
        update((before) =>
          before === null || before.opening !== now.opening
            ? before
            : { ...before, window: { ...before.window, picture: "available" } },
        );
        take(now.opening);
      });
    },
    notNow: () => {
      const now = current.current;
      if (now !== null) setPicture(now.opening, { _tag: "off" });
    },
  };

  /**
   * What goes with a message sent now: what the chips show, once a picture
   * being taken is.
   */
  const context = async (): Promise<WindowContext | undefined> => {
    const taking = current.current?.picture;
    if (taking?._tag === "taking") await taking.done;
    const now = current.current;
    if (now === null) return undefined;
    const { lookingAt } = now.window;
    return now.picture._tag === "on"
      ? {
          lookingAt,
          picture: {
            name: `${t("quickAccess.picture.name", { app: lookingAt.app })}.jpg`,
            body: now.picture.taken.body,
          },
        }
      : { lookingAt };
  };

  const view: WindowChipsView | null =
    held === null ? null : { lookingAt: held.window.lookingAt, picture: chipOf(held.picture) };
  return {
    view,
    intents,
    context,
    /** It went with a message: the next one goes without it. */
    sent: () => update(() => null),
  };
}
