// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GroupPosition } from "@j3-bots/client-runtime/presentation";
import type { ReactNode } from "react";

/**
 * Where several bots speak, in a room or between two teammates, each run of
 * one bot's messages is headed by its name and closed by its face, at the
 * bottom left beside the last bubble. The messages leave room for the face.
 */
export const speakerGutter = "relative ps-9";

/** The speaker's name, over the first bubble of its run. */
export function SpeakerName({ position, name }: { position: GroupPosition; name: string }) {
  if (position !== "single" && position !== "first") return null;
  return <span className="ps-1 pt-1 text-xs font-medium text-muted-foreground">{name}</span>;
}

/** The speaker's face, beside the last bubble of its run. */
export function SpeakerFace({
  position,
  children,
}: {
  position: GroupPosition;
  children: ReactNode;
}) {
  if (position !== "single" && position !== "last") return null;
  return (
    <span aria-hidden className="absolute start-0 bottom-0 flex">
      {children}
    </span>
  );
}
