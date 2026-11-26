// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus, Room } from "@j3-bots/contracts";
import {
  connectCommand,
  openingHeld,
  ownHarness,
  providerDetail,
} from "@j3-bots/client-runtime/presentation";
import { avatarEnsemble } from "@j3-bots/design-tokens";
import { type LucideIcon, SearchXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useBots, useI18n, usePresentation } from "../app/context";
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
import { CommandLine } from "./CommandLine";
import { useConnectionLineShown } from "./ConnectionBanner";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { OwnHarnessLine, type ProviderActions, ProviderFix } from "./ProviderFix";
import { engineFindings, type LocalProviderSetup, LocalSignIn } from "./ProviderSetup";
import { ProviderUpdate } from "./ProviderUpdate";

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
 * reported before a disconnection. One the engine cannot run also shows what
 * the engine said of it and what fixes it (`ProviderFix`); and its
 * harness's version and update: of J3 Bots' own copy when it runs one
 * (`OwnHarnessLine`), else of the harness the engine found
 * (`ProviderUpdate`); unless stale.
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
  const detail = providerDetail(provider);
  const own = ownHarness(provider);
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
      {!stale && detail !== null && (
        <p className="text-xs text-pretty break-words text-muted-foreground">
          {t("provider.detail", { detail })}
        </p>
      )}
      {!stale && <ProviderFix provider={provider} place={place} actions={actions} />}
      {!stale &&
        (own === null ? (
          <ProviderUpdate provider={provider} onUpdate={actions.update} />
        ) : (
          <OwnHarnessLine own={own} actions={actions} />
        ))}
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
 * Where a provider of the server this client talks to connects: from here,
 * when the server runs on this computer; in the desktop app that runs it,
 * from another device; otherwise with the command, on the server's machine.
 */
export type ConnectPlace =
  | { readonly _tag: "here"; readonly setup: LocalProviderSetup }
  | { readonly _tag: "desktop-app" }
  | { readonly _tag: "server" };

/**
 * A conversation with nothing in it yet. A new bot speaks first, so this is
 * usually brief; while its provider is not connected, it says what connects
 * it, where it connects (`connect`).
 */
export function QuietConversation({
  bot,
  engine,
  connect,
}: {
  bot: Bot;
  engine: EngineStatus | null;
  connect: ConnectPlace;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
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
      {held?._tag === "connect" && (
        <div className="flex w-full max-w-sm flex-col gap-2 text-start">
          {connect._tag === "desktop-app" ? (
            <p className="text-center text-sm text-pretty text-muted-foreground">
              {t("empty.quiet.connectInApp")}
            </p>
          ) : connect._tag === "here" ? (
            <LocalSignIn
              setup={connect.setup}
              fallback={<ConnectCommand command={held.command} />}
              findings={engineFindings(engine)}
            />
          ) : (
            <ConnectCommand command={held.command} />
          )}
        </div>
      )}
    </Centered>
  );
}

/** The command that connects a provider, to run where the server is. */
function ConnectCommand({ command }: { command: string }) {
  const { t } = useI18n();
  return (
    <>
      <p className="text-center text-sm text-muted-foreground">{t("empty.quiet.connectHint")}</p>
      <CommandLine command={command} copyLabel={t("firstRun.connect.copy")} large />
    </>
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
