// SPDX-License-Identifier: AGPL-3.0-or-later
import { type RecentTurns, USAGE_PERIOD } from "@j3-bots/client-runtime";
import type { Bot, BotId, EngineStatus, RosterItem, UsageWindow } from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { sinceTime, timeInSentence } from "../lib/time";
import { counted, providerUsage, type BotSpend, type ProviderUsage } from "../presentation/usage";
import { AvatarShape } from "./BotAvatar";
import { Loading, Section } from "./SettingsSection";
import { Button } from "./ui/button";

interface UsageSectionProps {
  /** Null until the server has reported the engine's status. */
  readonly engine: EngineStatus | null;
  /** `engine` is what the server last reported, before this device lost the connection. */
  readonly stale: boolean;
  /** Null while the turns load. */
  readonly recent: RecentTurns | null;
  /** The whole roster, hidden bots included, for the bots' names and shapes. */
  readonly roster: ReadonlyArray<RosterItem> | null;
  readonly onLoadMore: () => void;
}

/**
 * Whether a provider's limit is close, and who spends its turns: each
 * provider's limit windows as the engine reports them, and the bots that used
 * its turns recently, with their routines' share. The windows come live with
 * the engine's status; the turns are read when Settings opens.
 */
export function UsageSection({ engine, stale, recent, roster, onLoadMore }: UsageSectionProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  if (engine === null) {
    return (
      <Section title={t("settings.usage")}>
        <Loading />
      </Section>
    );
  }
  const bots = new Map<BotId, Bot>(
    (roster ?? []).flatMap((item) => (item._tag === "bot" ? [[item.bot.id, item.bot]] : [])),
  );
  const providers = providerUsage(engine.providers, recent?.turns ?? [], bots);
  const covered = recent === null ? null : counted(recent);
  return (
    <Section title={t("settings.usage")}>
      <p className="text-xs text-muted-foreground">
        {covered?._tag === "since"
          ? t("usage.introSince", { since: sinceTime(covered.at, ctx) })
          : ctx.i18n.plural("usage.intro", Duration.toHours(USAGE_PERIOD))}
      </p>
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("usage.noProviders")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              stale={stale}
              turnsRead={recent !== null}
            />
          ))}
        </ul>
      )}
      {recent?.canLoadMore && (
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
      )}
    </Section>
  );
}

function ProviderCard({
  provider,
  stale,
  turnsRead,
}: {
  provider: ProviderUsage;
  stale: boolean;
  turnsRead: boolean;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border px-3 py-2.5">
      <h4 className="text-sm">{provider.name}</h4>
      {provider.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("usage.noWindows")}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {provider.windows.map((usageWindow) => (
            <WindowMeter key={usageWindow.label} usageWindow={usageWindow} stale={stale} />
          ))}
        </ul>
      )}
      <div className="border-t border-border pt-2.5">
        {!turnsRead ? (
          <Loading />
        ) : provider.bots.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("usage.noTurns")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {provider.bots.map((spend) => (
              <BotTurns key={spend.botId} spend={spend} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * One limit window: how much of it is used, as a bar and in words, and when
 * it resets, when the provider says. The words carry it; the bar repeats them.
 */
function WindowMeter({ usageWindow, stale }: { usageWindow: UsageWindow; stale: boolean }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const full = usageWindow.usedPercent >= 100;
  // Rounded down, so a window short of its limit never reads as full.
  const used = Math.floor(usageWindow.usedPercent);
  const percent = new Intl.NumberFormat(ctx.i18n.locale, { style: "percent" }).format(used / 100);
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span>{usageWindow.label}</span>
        <span className={stale ? "text-muted-foreground" : full ? "text-blocked" : undefined}>
          {full ? t("usage.full") : t("usage.used", { percent })}
        </span>
      </span>
      <span aria-hidden className="h-1.5 overflow-hidden rounded-pill bg-muted">
        <span
          className={cn(
            "block h-full rounded-pill",
            stale ? "bg-muted-foreground" : full ? "bg-blocked" : "bg-foreground",
          )}
          style={{ width: `${used}%` }}
        />
      </span>
      {usageWindow.resetsAt !== null && (
        <span className="text-2xs text-muted-foreground">
          {t("usage.resets", { when: timeInSentence(usageWindow.resetsAt, ctx) })}
        </span>
      )}
    </li>
  );
}

/** A bot and the turns it spent, with its routines' share under it. */
function BotTurns({ spend }: { spend: BotSpend }) {
  const { t, plural } = useI18n();
  return (
    <li className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-sm">
        {spend.bot === null ? (
          <span aria-hidden className="size-4 shrink-0" />
        ) : (
          <AvatarShape avatar={spend.bot.profile.avatar} size={16} />
        )}
        <span className={cn("min-w-0 flex-1 truncate", spend.bot === null && "italic")}>
          {spend.bot?.profile.name ?? t("usage.deletedBot")}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {plural("usage.turns", spend.turns)}
        </span>
      </span>
      {spend.routines.length > 0 && (
        <ul className="flex flex-col gap-0.5 ps-6">
          {spend.routines.map((routine) => (
            <li
              key={routine.key}
              className="flex items-baseline gap-2 text-xs text-muted-foreground"
            >
              <span className={cn("min-w-0 flex-1 truncate", routine.name === null && "italic")}>
                {routine.name ?? t("usage.deletedRoutines")}
              </span>
              <span className="shrink-0 tabular-nums">{plural("usage.turns", routine.turns)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
