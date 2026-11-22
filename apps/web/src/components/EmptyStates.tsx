// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import { connectCommand, openingHeld, springs } from "@j3-bots/client-runtime/presentation";
import { ensemble } from "@j3-bots/design-tokens";
import type { ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import {
  providerLine,
  type ProviderTone,
  quietConversationText,
} from "@j3-bots/client-runtime/wording";
import { springAnimation } from "../onboarding/motion";
import { BotAvatar } from "./BotAvatar";
import { CommandLine } from "./CommandLine";
import { useConnectionLineShown } from "./ConnectionBanner";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const idle = { _tag: "idle" } as const;

/** Three idle bots: the picture for screens where the team is still to come. */
function Ensemble() {
  return (
    <span
      className="flex items-end [--avatar-cutout:var(--background)]"
      style={{ gap: ensemble.gap }}
      aria-hidden
    >
      {ensemble.members.map(({ shape, color, size }) => (
        <BotAvatar key={shape} avatar={{ shape, color }} state={idle} size={size} />
      ))}
    </span>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center">
      {children}
    </div>
  );
}

export function Heading({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <h1 className="display-type text-2xl">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/** Before the first roster arrives: the server has not answered yet. */
export function Connecting() {
  const { t } = useI18n();
  // When the connection line says why the server is out of reach, saying it here again adds nothing.
  const explained = useConnectionLineShown();
  return (
    <Centered>
      <Ensemble />
      {!explained && (
        <Heading title={t("firstRun.connecting.title")} body={t("firstRun.connecting.body")} />
      )}
    </Centered>
  );
}

/** A conversation whose bot or room no longer exists, as an old link can open. */
export function ConversationGone({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <Centered>
      <Heading title={t("empty.gone.title")} body={t("empty.gone.body")} />
      <Button onClick={onBack}>{t("empty.gone.back")}</Button>
    </Centered>
  );
}

/** The command that connects the providers, when one needs it, ready to copy. */
export function ConnectProviders({ engine }: { engine: EngineStatus }) {
  const { t } = useI18n();
  const connect = connectCommand(engine);
  if (connect === null) return null;
  return <CommandLine command={connect} copyLabel={t("firstRun.connect.copy")} />;
}

const providerToneClass = {
  ready: "text-success",
  waiting: "text-waiting",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<ProviderTone, string>;

/**
 * One provider: its name, and its state in words. `stale` mutes a state
 * reported before a disconnection.
 */
export function ProviderRow({
  provider,
  stale = false,
}: {
  provider: ProviderStatus;
  stale?: boolean;
}) {
  const line = providerLine(provider, usePresentation());
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-md border border-border px-3 py-2">
      <span>{provider.name}</span>
      <span
        className={cn("text-xs", stale ? "text-muted-foreground" : providerToneClass[line.tone])}
      >
        {line.text}
      </span>
    </li>
  );
}

/** Wide layouts with bots but none open. */
export function NoSelection({ nextShortcut }: { nextShortcut: string }) {
  const { t } = useI18n();
  return (
    <Centered>
      <Ensemble />
      <Heading title={t("empty.noSelection.title")} body={t("empty.noSelection.body")} />
      {/* A keyboard shortcut means nothing on a touch screen; only a coarse pointer hides it. */}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground pointer-coarse:hidden">
        <Kbd>{nextShortcut}</Kbd>
        {t("empty.noSelection.shortcut")}
      </p>
    </Centered>
  );
}

/**
 * A conversation with nothing in it yet. A new bot speaks first, so this is
 * usually brief; while its provider is not connected, it says what connects it.
 */
export function QuietConversation({ bot, engine }: { bot: Bot; engine: EngineStatus | null }) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const name = bot.profile.name;
  const held = openingHeld(bot, engine);
  return (
    <Centered>
      <span
        className="[--avatar-cutout:var(--background)]"
        style={{ animation: springAnimation("onboarding-pop", springs.pop) }}
      >
        <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={72} />
      </span>
      <Heading
        title={name}
        body={
          held === null
            ? quietConversationText(bot, ctx)
            : t("empty.quiet.waitingForModel", { name })
        }
      />
      {held?._tag === "connect" && (
        <div className="flex w-full max-w-sm flex-col gap-2 text-start">
          <p className="text-center text-sm text-muted-foreground">
            {t("empty.quiet.connectHint")}
          </p>
          <CommandLine command={held.command} copyLabel={t("firstRun.connect.copy")} large />
        </div>
      )}
    </Centered>
  );
}
