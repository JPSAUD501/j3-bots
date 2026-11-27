// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Bot,
  type BotId,
  type EngineStatus,
  type RosterItem,
  USAGE_PERIOD,
  type UsageWindow,
} from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import type { RecentTurnsState } from "@j3-bots/client-runtime";
import {
  coverage,
  providerUsage,
  type BotSpend,
  type ProviderUsage,
} from "@j3-bots/client-runtime/presentation";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { timeInSentence, windowText } from "@j3-bots/client-runtime/wording";
import { BotAvatar } from "./avatar/BotAvatar";
import { Section } from "./SettingsSection";
import { SkeletonRows } from "./ui/skeleton";
import { Button } from "./ui/button";

/** The turns as a read answered them, stale or not. */
type RecentTurnsRead = Extract<RecentTurnsState["read"], { readonly _tag: "ready" }>;

interface UsageSectionProps {
  /** Null until the server has reported the engine's status. */
  readonly engine: EngineStatus | null;
  /** `engine` is what the server last reported, before this device lost the connection. */
  readonly engineStale: boolean;
  readonly recent: RecentTurnsState;
  /** The whole roster, hidden bots included, for the bots' names and shapes. */
  readonly roster: ReadonlyArray<RosterItem> | null;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}

/**
 * Whether a provider's limit is close, and who spends its turns: each
 * provider's limit windows as the engine reports them, and the bots that used
 * its turns recently, with their routines' share. The windows come live with
 * the engine's status; the turns are read when Settings opens.
 */
export function UsageSection({
  engine,
  engineStale,
  recent,
  roster,
  onLoadMore,
  onRetry,
}: UsageSectionProps) {
  const { t } = useI18n();
  if (engine === null) {
    return (
      <Section>
        <SkeletonRows />
      </Section>
    );
  }
  // Only a running engine reports its providers; the Engine section says why it is not.
  if (engine.state._tag !== "ready") {
    return (
      <Section>
        <p className="text-xs text-muted-foreground">{t("usage.engineNotRunning")}</p>
      </Section>
    );
  }
  const bots = new Map<BotId, Bot>(
    (roster ?? []).flatMap((item) => (item._tag === "bot" ? [[item.bot.id, item.bot]] : [])),
  );
  const read: RecentTurnsRead | null = recent.read._tag === "ready" ? recent.read : null;
  const providers = providerUsage(engine.providers, read?.value.turns ?? [], bots);
  // Through a provider connection no provider reports limits: one quiet line
  // above the blocks says so, not one per provider, and the blocks hold only
  // the turns.
  const anyWindows = providers.some((provider) => provider.windows.length > 0);
  return (
    <Section>
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("usage.noProviders")}</p>
      ) : (
        <>
          {!anyWindows && (
            <p className="text-xs text-muted-foreground">{t("usage.noWindowsAtAll")}</p>
          )}
          <ul className="flex flex-col gap-2">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                anyWindows={anyWindows}
                windowsStale={engineStale}
                turns={read === null ? (recent.failed ? "failed" : "loading") : read}
              />
            ))}
          </ul>
        </>
      )}
      <TurnsFooter recent={recent} read={read} onLoadMore={onLoadMore} onRetry={onRetry} />
    </Section>
  );
}

/**
 * What the counts cover and when they were read, in one line, then what reads
 * more: "Load earlier tasks", or "Try again" after a read failed.
 */
function TurnsFooter({
  recent,
  read,
  onLoadMore,
  onRetry,
}: {
  recent: RecentTurnsState;
  read: RecentTurnsRead | null;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const covered = read === null ? null : coverage(read.value);
  const when = read === null ? null : timeInSentence(read.value.readAt, ctx);
  return (
    <>
      {covered !== null && when !== null && (
        <p className="text-xs text-muted-foreground">
          {covered._tag === "period"
            ? plural("usage.read.period", Duration.toHours(USAGE_PERIOD), { when })
            : t(covered.capped ? "usage.read.capped" : "usage.read.latest", {
                count: covered.count,
                when,
                oldest: timeInSentence(covered.oldest, ctx),
              })}
        </p>
      )}
      {recent.failed ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-blocked">{t("usage.readFailed")}</span>
          <Button size="sm" onClick={onRetry}>
            {t("usage.retry")}
          </Button>
        </p>
      ) : (
        read?.value.canLoadMore && (
          <Button
            size="sm"
            className="self-start"
            aria-disabled={recent.loadingMore}
            onClick={() => {
              if (!recent.loadingMore) onLoadMore();
            }}
          >
            {recent.loadingMore ? t("usage.loadingMore") : t("usage.loadMore")}
          </Button>
        )
      )}
    </>
  );
}

function ProviderCard({
  provider,
  anyWindows,
  windowsStale,
  turns,
}: {
  provider: ProviderUsage;
  /** Whether any provider reports limits; when none does, the section says so once. */
  anyWindows: boolean;
  windowsStale: boolean;
  turns: RecentTurnsRead | "loading" | "failed";
}) {
  const { t, plural } = useI18n();
  const turnsStale = typeof turns !== "string" && turns.stale;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border px-3 py-2.5">
      <h4 className="text-sm">{provider.name}</h4>
      {provider.windows.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {provider.windows.map(({ key, usageWindow }) => (
            <WindowMeter key={key} usageWindow={usageWindow} stale={windowsStale} />
          ))}
        </ul>
      ) : (
        anyWindows && <p className="text-xs text-muted-foreground">{t("usage.noWindows")}</p>
      )}
      {/* After a failed first read the footer says so once, for every provider. */}
      {turns !== "failed" && (
        <div className={cn(anyWindows && "border-t border-border pt-2.5")}>
          {turns === "loading" ? (
            <SkeletonRows />
          ) : provider.bots.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {/* Turns not read yet may have used it. */}
              {turns.value.hasMore
                ? t("usage.noTurnsShown")
                : plural("usage.noTurns", Duration.toHours(USAGE_PERIOD))}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {provider.bots.map((spend) => (
                <BotTurns key={spend.botId} spend={spend} stale={turnsStale} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * One limit window: how much of it is used, as a bar and in words, and when
 * it resets, when the provider says. The words carry it; the bar repeats them.
 * Past its reset, or offline, it is greyed: the figures are the last known.
 */
function WindowMeter({ usageWindow, stale }: { usageWindow: UsageWindow; stale: boolean }) {
  const text = windowText(usageWindow, usePresentation());
  const muted = stale || text.tone === "reset";
  const full = !muted && text.tone === "full";
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="min-w-0 wrap-break-word">{text.name}</span>
        <span className={muted ? "text-muted-foreground" : full ? "text-blocked" : undefined}>
          {text.used}
        </span>
      </span>
      <span aria-hidden className="h-1.5 overflow-hidden rounded-pill bg-muted">
        <span
          className={cn(
            "block h-full rounded-pill",
            muted ? "bg-muted-foreground" : full ? "bg-blocked" : "bg-foreground",
          )}
          style={{ width: `${text.percent}%` }}
        />
      </span>
      {text.reset !== null && <span className="text-2xs text-muted-foreground">{text.reset}</span>}
    </li>
  );
}

/**
 * A bot and the turns it spent, with its routines' share under it. A long
 * name wraps; the counts keep to the first line, at the end.
 */
function BotTurns({ spend, stale }: { spend: BotSpend; stale: boolean }) {
  const { t, plural } = useI18n();
  return (
    <li className={cn("flex flex-col gap-1", stale && "text-muted-foreground")}>
      <span className="flex items-start gap-2 text-sm">
        {spend.bot === null ? (
          <span aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : (
          <span className={cn("mt-0.5 shrink-0", stale && "grayscale")}>
            <BotAvatar
              avatar={spend.bot.profile.avatar}
              seed={spend.bot.id}
              state="idle"
              size={20}
              still
            />
          </span>
        )}
        <span className={cn("min-w-0 flex-1 wrap-break-word", spend.bot === null && "italic")}>
          {spend.bot?.profile.name ?? t("usage.deletedBot")}
        </span>
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
          {plural("usage.turns", spend.turns)}
        </span>
      </span>
      {spend.routines.length > 0 && (
        <ul className="flex flex-col gap-0.5 ps-6">
          {spend.routines.map(({ routine, turns }) => (
            <li
              key={routine._tag === "routine" ? `routine:${routine.id}` : "deleted"}
              className="flex items-baseline gap-2 text-xs text-muted-foreground"
            >
              <span
                className={cn(
                  "min-w-0 flex-1 wrap-break-word",
                  routine._tag === "deleted" && "italic",
                )}
              >
                {routine._tag === "routine" ? routine.name : t("usage.deletedRoutines")}
              </span>
              <span className="shrink-0 tabular-nums">{plural("usage.turns", turns)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
