// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { PairBotIds, TeammatePair } from "@j3-bots/contracts";
import { pairKeyText } from "@j3-bots/client-runtime/presentation";
import { activityTime, pairLine, pairTitle } from "@j3-bots/client-runtime/wording";
import type { ComponentProps, ReactElement } from "react";
import { usePresentation } from "../app/context";
import type { DataAttributes } from "../lib/dataAttributes";
import { PairAvatar } from "./avatar/TeamAvatars";
import { type PairIntents, PairMenuRows } from "./PairHeader";
import { WithMenu } from "./RosterMenu";

interface PairRowProps extends useRender.ComponentProps<"button"> {
  readonly pair: TeammatePair;
  readonly selected: boolean;
}

/**
 * Two bots that wrote each other, as the roster lists them: both faces, both
 * names, and the latest message after who wrote it. It is never unread: what
 * two bots tell each other does not ask for the operator.
 */
function PairRow({ pair, selected, render, ...props }: PairRowProps) {
  const ctx = usePresentation();
  const own: ComponentProps<"button"> & DataAttributes = {
    className:
      "group/row pressable pressable-row flex h-(--layout-row-pointer) w-full items-center gap-3 rounded-lg px-2.5 text-start hover:bg-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent data-selected:bg-muted pointer-coarse:h-(--layout-row-touch)",
    type: render ? undefined : "button",
    "data-selected": selected ? "" : undefined,
    "aria-current": selected ? "page" : undefined,
    "data-roster-row": pairKeyText(pair.botIds),
    children: (
      <>
        <span className="[--avatar-cutout:var(--sidebar)] group-hover/row:[--avatar-cutout:var(--row-hover)] group-data-selected/row:[--avatar-cutout:var(--muted)]">
          <PairAvatar botIds={pair.botIds} size={40} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{pairTitle(pair.botIds, ctx)}</span>
            <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums transition-opacity duration-(--duration-fast) pointer-fine:group-hover/entry:opacity-0 pointer-fine:group-focus-within/entry:opacity-0 pointer-fine:group-has-data-popup-open/entry:opacity-0">
              {activityTime(pair.lastMessage.createdAt, ctx)}
            </span>
          </span>
          <span className="truncate text-xs text-muted-foreground">{pairLine(pair, ctx)}</span>
        </span>
      </>
    ),
  };
  return useRender({ defaultTagName: "button", render, props: mergeProps<"button">(own, props) });
}

/**
 * The roster's "Between bots": every pair of bots that wrote each other,
 * latest first, after the bots and rooms. It is no section of the
 * operator's: it cannot be renamed, folded or moved into.
 */
export function BetweenBots({
  pairs,
  selected,
  pairLink,
  intents,
}: {
  pairs: ReadonlyArray<TeammatePair>;
  /** The teammate conversation open now, if one is. */
  selected: PairBotIds | null;
  /** The link a row navigates with, such as a router link to the conversation. */
  pairLink: (botIds: PairBotIds) => ReactElement;
  intents: PairIntents;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  if (pairs.length === 0) return null;
  const selectedKey = selected === null ? null : pairKeyText(selected);
  return (
    <section aria-labelledby="roster-between-bots" className="mt-2">
      <h2
        id="roster-between-bots"
        className="flex h-8 items-center ps-2.5 text-xs font-semibold text-muted-foreground"
      >
        {t("pairs.section")}
      </h2>
      {pairs.map((pair) => {
        const key = pairKeyText(pair.botIds);
        return (
          <WithMenu
            key={key}
            rows={<PairMenuRows botIds={pair.botIds} intents={intents} />}
            label={t("roster.menu", { name: pairTitle(pair.botIds, ctx) })}
            className=""
            buttonClassName="top-1/2 right-2 -translate-y-1/2"
          >
            <PairRow pair={pair} selected={key === selectedKey} render={pairLink(pair.botIds)} />
          </WithMenu>
        );
      })}
    </section>
  );
}
