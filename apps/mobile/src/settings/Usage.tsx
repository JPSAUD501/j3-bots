// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecentTurnsState } from "@j3-bots/client-runtime";
import {
  type BotSpend,
  coverage,
  providerUsage,
  type ProviderUsage,
} from "@j3-bots/client-runtime/presentation";
import { timeInSentence, windowText } from "@j3-bots/client-runtime/wording";
import { type EngineStatus, USAGE_PERIOD, type UsageWindow } from "@j3-bots/contracts";
import * as Duration from "effect/Duration";
import { View } from "react-native";
import { Text } from "../text.tsx";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useBots, usePresentation } from "../presentation.tsx";
import { Button } from "../ui.tsx";

/** The turns as a read answered them, stale or not. */
type RecentTurnsRead = Extract<RecentTurnsState["read"], { readonly _tag: "ready" }>;

/**
 * Whether a provider's limit is close, and who spends its turns: each
 * provider's limit windows as the engine reports them, and the bots that used
 * its turns recently, with their routines' share. The windows come live with
 * the engine's status; the turns are read when Settings opens.
 */
export function UsageSection(props: {
  /** Null until the server has reported the engine's status. */
  readonly engine: EngineStatus | null;
  /** `engine` is what the server last reported, before this device lost the connection. */
  readonly engineStale: boolean;
  readonly recent: RecentTurnsState;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}) {
  const { t } = usePresentation().i18n;
  const bots = useBots();
  const { engine, recent } = props;
  if (engine === null) {
    return (
      <Section open>
        <SkeletonRows />
      </Section>
    );
  }
  // Only a running engine reports its providers; the Engine section says why it is not.
  if (engine.state._tag !== "ready") {
    return (
      <Section open>
        <Quiet>{t("usage.engineNotRunning")}</Quiet>
      </Section>
    );
  }
  const read: RecentTurnsRead | null = recent.read._tag === "ready" ? recent.read : null;
  const providers = providerUsage(engine.providers, read?.value.turns ?? [], bots);
  // Through a provider connection no provider reports limits: one quiet line
  // above the cards says so, not one per provider.
  const anyWindows = providers.some((provider) => provider.windows.length > 0);
  return (
    <Section open>
      {providers.length === 0 ? (
        <Quiet>{t("usage.noProviders")}</Quiet>
      ) : (
        <>
          {!anyWindows && <Quiet>{t("usage.noWindowsAtAll")}</Quiet>}
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              anyWindows={anyWindows}
              windowsStale={props.engineStale}
              turns={read === null ? (recent.failed ? "failed" : "loading") : read}
            />
          ))}
        </>
      )}
      <TurnsFooter
        recent={recent}
        read={read}
        onLoadMore={props.onLoadMore}
        onRetry={props.onRetry}
      />
    </Section>
  );
}

/**
 * What the counts cover and when they were read, then what reads more: "Load
 * earlier turns", or "Try again" after a read failed.
 */
function TurnsFooter(props: {
  readonly recent: RecentTurnsState;
  readonly read: RecentTurnsRead | null;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}) {
  const ctx = usePresentation();
  const { t, plural } = ctx.i18n;
  const { recent, read } = props;
  const covered = read === null ? null : coverage(read.value);
  const when = read === null ? null : timeInSentence(read.value.readAt, ctx);
  return (
    <>
      {covered !== null && when !== null && (
        <Text className="text-xs text-muted-foreground">
          {covered._tag === "period"
            ? plural("usage.read.period", Duration.toHours(USAGE_PERIOD), { when })
            : t(covered.capped ? "usage.read.capped" : "usage.read.latest", {
                count: covered.count,
                when,
                oldest: timeInSentence(covered.oldest, ctx),
              })}
        </Text>
      )}
      {recent.failed ? (
        <View className="flex-row flex-wrap items-center gap-x-3">
          <Text className="text-sm text-blocked">{t("usage.readFailed")}</Text>
          <Button label={t("usage.retry")} onPress={props.onRetry} />
        </View>
      ) : (
        read?.value.canLoadMore === true && (
          <View className="items-start">
            <Button
              label={recent.loadingMore ? t("usage.loadingMore") : t("usage.loadMore")}
              disabled={recent.loadingMore}
              onPress={props.onLoadMore}
            />
          </View>
        )
      )}
    </>
  );
}

function ProviderCard(props: {
  readonly provider: ProviderUsage;
  /** Whether any provider reports limits; when none does, the section says so once. */
  readonly anyWindows: boolean;
  readonly windowsStale: boolean;
  readonly turns: RecentTurnsRead | "loading" | "failed";
}) {
  const { t, plural } = usePresentation().i18n;
  const { provider, turns } = props;
  const turnsStale = typeof turns !== "string" && turns.stale;
  return (
    <View className="gap-3 rounded-md border border-border px-3 py-2.5">
      <Text accessibilityRole="header" className="text-sm text-foreground">
        {provider.name}
      </Text>
      {provider.windows.length > 0
        ? provider.windows.map(({ key, usageWindow }) => (
            <WindowMeter key={key} usageWindow={usageWindow} stale={props.windowsStale} />
          ))
        : props.anyWindows && <Quiet>{t("usage.noWindows")}</Quiet>}
      {/* After a failed first read the footer says so once, for every provider. */}
      {turns !== "failed" && (
        <View className={`gap-1.5 ${props.anyWindows ? "border-t border-border pt-2.5" : ""}`}>
          {turns === "loading" ? (
            <SkeletonRows />
          ) : provider.bots.length === 0 ? (
            <Text className="text-xs text-muted-foreground">
              {/* Turns not read yet may have used it. */}
              {turns.value.hasMore
                ? t("usage.noTurnsShown")
                : plural("usage.noTurns", Duration.toHours(USAGE_PERIOD))}
            </Text>
          ) : (
            provider.bots.map((spend) => (
              <BotTurns key={spend.botId} spend={spend} stale={turnsStale} />
            ))
          )}
        </View>
      )}
    </View>
  );
}

/**
 * One limit window: how much of it is used, as a bar and in words, and when
 * it resets, when the provider says. The words carry it; the bar repeats them.
 * Past its reset, or offline, it is greyed: the figures are the last known.
 */
function WindowMeter(props: { readonly usageWindow: UsageWindow; readonly stale: boolean }) {
  const text = windowText(props.usageWindow, usePresentation());
  const muted = props.stale || text.tone === "reset";
  const full = !muted && text.tone === "full";
  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <Text className="min-w-0 shrink text-xs text-foreground">{text.name}</Text>
        <Text
          className={`text-xs ${muted ? "text-muted-foreground" : full ? "text-blocked" : "text-foreground"}`}
        >
          {text.used}
        </Text>
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="h-1.5 overflow-hidden rounded-pill bg-muted"
      >
        <View
          className={`h-full rounded-pill ${muted ? "bg-muted-foreground" : full ? "bg-blocked" : "bg-foreground"}`}
          style={{ width: `${text.percent}%` }}
        />
      </View>
      {text.reset !== null && <Text className="text-2xs text-muted-foreground">{text.reset}</Text>}
    </View>
  );
}

/** A bot and the turns it spent, with its routines' share under it. */
function BotTurns(props: { readonly spend: BotSpend; readonly stale: boolean }) {
  const { t, plural } = usePresentation().i18n;
  const { spend, stale } = props;
  const tone = stale ? "text-muted-foreground" : "text-foreground";
  return (
    <View className="gap-1">
      <View className="flex-row items-start gap-2">
        <View className="mt-0.5 size-5">
          {spend.bot !== null && (
            <BotAvatar
              avatar={spend.bot.profile.avatar}
              seed={spend.bot.id}
              state="idle"
              size={20}
              still
            />
          )}
        </View>
        <Text className={`min-w-0 flex-1 text-sm ${tone} ${spend.bot === null ? "italic" : ""}`}>
          {spend.bot?.profile.name ?? t("usage.deletedBot")}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {plural("usage.turns", spend.turns)}
        </Text>
      </View>
      {spend.routines.map(({ routine, turns }) => (
        <View
          key={routine._tag === "routine" ? `routine:${routine.id}` : "deleted"}
          className="flex-row items-baseline gap-2 ps-6"
        >
          <Text
            className={`min-w-0 flex-1 text-xs text-muted-foreground ${routine._tag === "deleted" ? "italic" : ""}`}
          >
            {routine._tag === "routine" ? routine.name : t("usage.deletedRoutines")}
          </Text>
          <Text className="text-xs text-muted-foreground tabular-nums">
            {plural("usage.turns", turns)}
          </Text>
        </View>
      ))}
    </View>
  );
}
