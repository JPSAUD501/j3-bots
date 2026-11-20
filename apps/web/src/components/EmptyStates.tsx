// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import type { I18n } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { usageLimitText } from "../presentation/roster";
import { BotAvatar } from "./BotAvatar";
import { useConnectionLineShown } from "./ConnectionBanner";
import { NewBotForm } from "./NewBotForm";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";

const idle = { _tag: "idle" } as const;

/** Three idle bots: the picture for screens where the team is still to come. */
export function Ensemble() {
  return (
    <span className="flex items-end gap-1.5 [--avatar-cutout:var(--background)]" aria-hidden>
      <BotAvatar avatar={{ shape: "hexagon", color: "teal" }} state={idle} size={36} />
      <BotAvatar avatar={{ shape: "circle", color: "violet" }} state={idle} size={48} />
      <BotAvatar avatar={{ shape: "triangle", color: "orange" }} state={idle} size={36} />
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
  const { t } = useI18n();
  if (engine === null) return <Connecting />;
  const problem = engineProblem(engine, t);
  if (problem !== null) {
    return (
      <Centered>
        <Ensemble />
        <Heading title={problem.title} body={problem.body} />
      </Centered>
    );
  }
  if (!engine.providers.some((p) => p.status._tag === "ready")) {
    const signIn = engine.providers.some((p) => p.status._tag === "sign-in-required");
    return (
      <Centered>
        <Ensemble />
        {signIn ? (
          <Heading title={t("firstRun.signIn.title")} body={t("firstRun.signIn.body")} />
        ) : (
          <Heading title={t("firstRun.unavailable.title")} body={t("firstRun.unavailable.body")} />
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

/**
 * What keeps the engine from running bots, and what the operator can do about
 * it; null when it is ready.
 */
export function engineProblem(
  engine: EngineStatus,
  t: I18n["t"],
): { readonly title: string; readonly body: string } | null {
  const { state } = engine;
  switch (state._tag) {
    case "ready":
      return null;
    case "starting":
      return { title: t("engine.starting.title"), body: t("engine.starting.body") };
    case "incompatible":
      return {
        title: t("firstRun.incompatible.title"),
        body: t("firstRun.incompatible.body", {
          running: state.runningVersion,
          pinned: engine.pinnedVersion,
        }),
      };
    case "unavailable":
      switch (state.reason) {
        case "down":
          return { title: t("engine.down.title"), body: t("engine.down.body") };
        case "port-in-use":
          return { title: t("engine.portInUse.title"), body: t("engine.portInUse.body") };
        case "install-failed":
          return { title: t("engine.installFailed.title"), body: t("engine.installFailed.body") };
        case "credential-refused":
          return {
            title: t("engine.credentialRefused.title"),
            body: t("engine.credentialRefused.body"),
          };
      }
  }
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

/**
 * One provider: its name, its state in words, and the command that signs it in
 * when it needs one. `stale` mutes a state reported before a disconnection.
 */
export function ProviderRow({
  provider,
  stale = false,
}: {
  provider: ProviderStatus;
  stale?: boolean;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const { status } = provider;
  const [label, tone] = ((): readonly [string, string] => {
    switch (status._tag) {
      case "ready":
        return [t("provider.ready"), "text-success"];
      case "sign-in-required":
        return [t("provider.signInRequired"), "text-waiting"];
      case "limited":
        return [usageLimitText(status.resetsAt, ctx), "text-blocked"];
      case "unavailable":
        return [t("provider.unavailable"), "text-muted-foreground"];
    }
  })();
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span>{provider.name}</span>
        <span className={cn("text-xs", stale ? "text-muted-foreground" : tone)}>{label}</span>
      </span>
      {status._tag === "sign-in-required" && (
        <CommandLine
          command={status.command}
          copyLabel={t("firstRun.signIn.copy", { name: provider.name })}
        />
      )}
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
          aria-label={result === "copied" ? t("firstRun.signIn.copied") : copyLabel}
          onClick={copy}
        >
          {result === "copied" ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </span>
      {/* Present, though empty, from the start, so the sentence is announced when it appears. Keyed
          by the press, so pressing again replaces it and it is announced again. */}
      <span role="status" className="text-xs text-muted-foreground not-empty:mt-1">
        {result === "selected" && <span key={attempt}>{t("firstRun.signIn.selected")}</span>}
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
  const { t } = useI18n();
  const name = bot.profile.name;
  const gettingReady = bot.state._tag === "thinking" || bot.state._tag === "working";
  return (
    <Centered>
      <span className="[--avatar-cutout:var(--background)]">
        <BotAvatar avatar={bot.profile.avatar} state={bot.state} size={72} />
      </span>
      <Heading
        title={name}
        body={
          gettingReady ? t("empty.quiet.speaksFirst", { name }) : t("empty.quiet.body", { name })
        }
      />
    </Centered>
  );
}
