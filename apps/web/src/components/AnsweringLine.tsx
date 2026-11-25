// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Room } from "@j3-bots/contracts";
import { answeringLine } from "@j3-bots/client-runtime/wording";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { FaceOf } from "./avatar/TeamAvatars";
import { SwapText } from "./SwapText";

/**
 * At the end of a room, who is answering there now: their faces, overlapping,
 * and one quiet line, "Hal and Bo are answering…", that changes in place as
 * each one's turn ends. It settles in as someone starts and goes once nobody
 * answers. Read out as it changes, politely.
 */
export function AnsweringLine({ room }: { readonly room: Room }) {
  const bots = useBots();
  const i18n = useI18n();
  const line = answeringLine(room, (botId) => bots.get(botId)?.profile.name, i18n);
  return (
    <div role="status">
      {line !== null && (
        <div className="arrive flex min-h-8 origin-bottom-left items-center gap-2.5 text-xs">
          <span aria-hidden className="flex shrink-0 items-center">
            {line.faces.map((botId, index) => (
              <span key={botId} className={cn("flex", index > 0 && "-ms-2")}>
                <FaceOf botId={botId} size={20} cutout={index > 0} />
              </span>
            ))}
          </span>
          <SwapText text={line.text} className="min-w-0 flex-1 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
