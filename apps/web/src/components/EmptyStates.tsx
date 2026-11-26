// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus, Room } from "@j3-bots/contracts";
import { openingHeld, providerDetail, providerFix } from "@j3-bots/client-runtime/presentation";
import { avatarEnsemble } from "@j3-bots/design-tokens";
import { type LucideIcon, SearchXIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBots, useI18n, usePresentation } from "../app/context";
import { AiConnect, type ConnectPlace, useWebAiConnect } from "./AiConnect";
import { cn } from "../lib/cn";
import {
  type ProviderPlace,
  providerLine,
  type ProviderTone,
  heldHelloText,
  quietConversationText,
} from "@j3-bots/client-runtime/wording";
import { BotAvatar, RoomAvatar, roomAvatarMembers } from "./avatar/BotAvatar";
import { LiveBotAvatar } from "./avatar/mood";
import { useConnectionLineShown } from "./ConnectionBanner";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import type { ProviderActions } from "./ProviderFix";

/** Three idle bots: the picture for screens where the team is still to come. */
function Ensemble() {
  return (
    <span className="flex items-end gap-2" aria-hidden>
      {avatarEnsemble.map(({ avatar, size }) => (
        <BotAvatar
          key={avatar.shape}
          avatar={avatar}
          seed={`welcome-${avatar.shape}`}
          state="idle"
          size={size}
        />
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

/**
 * A state's mark above its heading, where the screen is about something that
 * went wrong or is gone rather than about the bots: an icon in a quiet disc.
 */
export function StateMark({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="appear flex size-14 items-center justify-center rounded-pill bg-muted text-muted-foreground">
      <Icon aria-hidden className="size-6" />
    </span>
  );
}

/** Three dots that pulse in turn: something is under way and will take a moment. */
export function Working() {
  return (
    <span aria-hidden className="flex items-center gap-1.5">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-1.5 animate-[dot-pulse_1.2s_ease-in-out_infinite] rounded-pill bg-muted-foreground motion-reduce:animate-none"
          style={{ animationDelay: `${dot * 160}ms` }}
        />
      ))}
    </span>
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
      <Working />
    </Centered>
  );
}

/** A conversation whose bot or room no longer exists, as an old link can open. */
export function ConversationGone({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <Centered>
      <StateMark icon={SearchXIcon} />
      <Heading title={t("empty.gone.title")} body={t("empty.gone.body")} />
      <Button onClick={onBack}>{t("empty.gone.back")}</Button>
    </Centered>
  );
}

const providerToneClass = {
  ready: "text-success",
  waiting: "text-waiting",
  blocked: "text-blocked",
  muted: "text-muted-foreground",
} as const satisfies Record<ProviderTone, string>;

/**
 * A provider that is neither AI account, as the scripted agent of a
 * development server: its name, and its state in words. `stale` mutes a state
 * reported before a disconnection. One the engine cannot run also offers to
 * check it again, and keeps what the engine said of it under "Details";
 * unless stale.
 */
export function ProviderRow({
  provider,
  place,
  actions,
  stale = false,
}: {
  provider: ProviderStatus;
  place: ProviderPlace;
  actions: ProviderActions;
  stale?: boolean;
}) {
  const { t } = useI18n();
  const line = providerLine(provider, usePresentation(), place);
  const [asking, setAsking] = useState<"idle" | "asking" | "failed">("idle");
  const detail = providerDetail(provider);
  const fixable = providerFix(provider) !== null;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span>{provider.name}</span>
        <span
          className={cn("text-xs", stale ? "text-muted-foreground" : providerToneClass[line.tone])}
        >
          {line.text}
        </span>
      </div>
      {!stale && fixable && (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={asking === "asking"}
          onClick={() => {
            setAsking("asking");
            void actions.recheck(provider.id).then((took) => setAsking(took ? "idle" : "failed"));
          }}
        >
          {t("ai.tryAgain")}
        </Button>
      )}
      {asking === "failed" && (
        <p role="alert" className="text-xs text-blocked">
          {t("ai.requestFailed")}
        </p>
      )}
      {!stale && detail !== null && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("ai.details")}</summary>
          <p className="pt-1 text-pretty break-words select-text">{detail}</p>
        </details>
      )}
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
 * usually brief; while its AI is not connected, it says so, with the same
 * way to connect one as the first run, where it connects (`connect`).
 */
export function QuietConversation({
  bot,
  engine,
  connect,
  actions,
}: {
  bot: Bot;
  engine: EngineStatus | null;
  connect: ConnectPlace;
  actions: ProviderActions;
}) {
  const ctx = usePresentation();
  const name = bot.profile.name;
  const held = openingHeld(bot, engine);
  return (
    <Centered>
      <span className="pop-in">
        <LiveBotAvatar bot={bot} size={96} />
      </span>
      <Heading
        title={name}
        body={held === null ? quietConversationText(bot, ctx) : heldHelloText(name, held, ctx)}
      />
      {held !== null && held._tag !== "limit" && (
        <WaitingForAi engine={engine} connect={connect} actions={actions} />
      )}
    </Centered>
  );
}

/** What connects the AI a bot's hello waits for, under the bot. */
function WaitingForAi({
  engine,
  connect,
  actions,
}: {
  engine: EngineStatus | null;
  connect: ConnectPlace;
  actions: ProviderActions;
}) {
  const ai = useWebAiConnect({ engine, connect, actions });
  return (
    <div className="flex w-full max-w-sm flex-col">
      <AiConnect ai={ai} />
    </div>
  );
}

/** A room nothing has been said in yet: its members, and that every one of them reads it. */
export function QuietRoom({ room }: { room: Extract<Room, { readonly status: "active" }> }) {
  const { t } = useI18n();
  const bots = useBots();
  return (
    <Centered>
      <span className="pop-in">
        <RoomAvatar size={96} members={roomAvatarMembers(room, bots)} />
      </span>
      <Heading title={room.name} body={t("empty.quiet.room")} />
    </Centered>
  );
}
