// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import { connectCommand, providerGate } from "@j3-bots/client-runtime/presentation";
import { ensemble } from "@j3-bots/design-tokens";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import {
  engineProblem,
  providerLine,
  type ProviderTone,
  quietConversationText,
} from "@j3-bots/client-runtime/wording";
import { BotAvatar } from "./BotAvatar";
import { useConnectionLineShown } from "./ConnectionBanner";
import { NewBotForm } from "./NewBotForm";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const idle = { _tag: "idle" } as const;

/** Three idle bots: the picture for screens where the team is still to come. */
export function Ensemble() {
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
      <h1 className="text-lg font-medium">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

interface FirstRunProps {
  /** Null until the server has reported it. */
  readonly engine: EngineStatus | null;
  /** Resolves once the bot exists; the shell then opens its conversation. */
  readonly onCreateBot: (name: string, primary: boolean) => Promise<void>;
}

/**
 * Before the first bot: checks that the engine runs and a provider is ready,
 * then asks for a name. No settings form; the bot asks the rest itself.
 */
export function FirstRun({ engine, onCreateBot }: FirstRunProps) {
  const i18n = useI18n();
  const { t } = i18n;
  if (engine === null) return <Connecting />;
  const problem = engineProblem(engine, i18n);
  if (problem !== null) {
    return (
      <Centered>
        <Ensemble />
        <Heading title={problem.title} body={problem.body} />
      </Centered>
    );
  }
  const gate = providerGate(engine);
  if (gate._tag !== "ready") {
    return (
      <Centered>
        <Ensemble />
        {gate._tag === "checking" ? (
          <Heading title={t("firstRun.checking.title")} body={t("firstRun.checking.body")} />
        ) : gate._tag === "unavailable" ? (
          <Heading title={t("firstRun.unavailable.title")} body={t("firstRun.unavailable.body")} />
        ) : (
          <>
            <Heading title={t("firstRun.connect.title")} body={t("firstRun.connect.body")} />
            <span className="w-full max-w-sm text-start">
              <CommandLine command={gate.command} copyLabel={t("firstRun.connect.copy")} />
            </span>
          </>
        )}
        <ul className="flex w-full max-w-sm flex-col gap-1.5 text-start text-sm">
          {engine.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
      </Centered>
    );
  }
  return <CreateFirstBot onCreateBot={onCreateBot} />;
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

/**
 * A shell command, wrapped so it reads in full on any width, with a button
 * pinned to its top corner that copies it. Where the page has no clipboard
 * (served over plain HTTP on the local network) or the browser refuses, the
 * button selects the command and says, in words and to screen readers, to
 * copy it by hand.
 */
function CommandLine({ command, copyLabel }: { command: string; copyLabel: string }) {
  const { t } = useI18n();
  const [result, setResult] = useState<"none" | "copied" | "selected">("none");
  // Counts presses, so the sentence is a new one each time and is announced again.
  const [attempt, setAttempt] = useState(0);
  const codeRef = useRef<HTMLElement>(null);
  const select = () => {
    if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
    setResult("selected");
  };
  const copy = () => {
    setAttempt((count) => count + 1);
    if (!("clipboard" in navigator)) {
      select();
      return;
    }
    navigator.clipboard.writeText(command).then(() => setResult("copied"), select);
  };
  return (
    <span className="flex flex-col">
      <span className="flex items-start gap-1 rounded-md bg-code-background ps-2.5">
        <code
          ref={codeRef}
          className="min-w-0 flex-1 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
        >
          {command}
        </code>
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={result === "copied" ? t("firstRun.connect.copied") : copyLabel}
          onClick={copy}
        >
          {result === "copied" ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </span>
      {/* Present, though empty, from the start, so the sentence is announced when it appears. Keyed
          by the press, so pressing again replaces it and it is announced again. */}
      <span role="status" className="text-xs text-muted-foreground not-empty:mt-1">
        {result === "selected" && <span key={attempt}>{t("firstRun.connect.selected")}</span>}
      </span>
    </span>
  );
}

function CreateFirstBot({ onCreateBot }: Pick<FirstRunProps, "onCreateBot">) {
  const { t } = useI18n();
  return (
    <Centered>
      <Ensemble />
      <Heading title={t("firstRun.create.title")} body={t("firstRun.create.body")} />
      <NewBotForm primaryAtFirst onCreate={onCreateBot} className="w-full max-w-xs text-start" />
    </Centered>
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

/** A conversation with nothing in it yet. A new bot speaks first, so this is usually brief. */
export function QuietConversation({ bot }: { bot: Bot }) {
  const ctx = usePresentation();
  const name = bot.profile.name;
  return (
    <Centered>
      <span className="[--avatar-cutout:var(--background)]">
        <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={72} />
      </span>
      <Heading title={name} body={quietConversationText(bot, ctx)} />
    </Centered>
  );
}
