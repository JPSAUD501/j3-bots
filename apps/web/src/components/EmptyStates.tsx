// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus, ProviderStatus } from "@j3-bots/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { usageLimitText } from "../presentation/roster";
import { BotAvatar } from "./BotAvatar";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Kbd } from "./ui/kbd";

const idle = { _tag: "idle" } as const;

/** Three idle bots: the picture for screens where the team is still to come. */
function Ensemble() {
  return (
    <span className="flex items-end gap-1.5 [--avatar-cutout:var(--background)]" aria-hidden>
      <BotAvatar avatar={{ shape: "hexagon", color: "teal" }} state={idle} size={36} />
      <BotAvatar avatar={{ shape: "circle", color: "violet" }} state={idle} size={48} />
      <BotAvatar avatar={{ shape: "triangle", color: "orange" }} state={idle} size={36} />
    </span>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center">
      {children}
    </div>
  );
}

function Heading({ title, body }: { title: string; body: string }) {
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
  if (engine === null) {
    return (
      <Centered>
        <Ensemble />
        <Heading title={t("firstRun.connecting.title")} body={t("firstRun.connecting.body")} />
      </Centered>
    );
  }
  switch (engine.state._tag) {
    case "starting":
    case "unavailable":
      return (
        <Centered>
          <Ensemble />
          <Heading title={t("firstRun.engineDown.title")} body={t("firstRun.engineDown.body")} />
        </Centered>
      );
    case "incompatible":
      return (
        <Centered>
          <Ensemble />
          <Heading
            title={t("firstRun.incompatible.title")}
            body={t("firstRun.incompatible.body", {
              running: engine.state.runningVersion,
              pinned: engine.pinnedVersion,
            })}
          />
        </Centered>
      );
    case "ready":
      break;
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

/** One provider: its name, its state in words, and the command that signs it in when it needs one. */
function ProviderRow({ provider }: { provider: ProviderStatus }) {
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
        <span className={cn("text-xs", tone)}>{label}</span>
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
 * button selects the command so it can be copied by hand.
 */
function CommandLine({ command, copyLabel }: { command: string; copyLabel: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);
  const select = () => {
    if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
  };
  const copy = () => {
    if (!("clipboard" in navigator)) {
      select();
      return;
    }
    navigator.clipboard.writeText(command).then(() => setCopied(true), select);
  };
  return (
    <span className="flex items-start gap-1 rounded-md bg-code-background ps-2.5">
      <code
        ref={codeRef}
        className="min-w-0 flex-1 py-1.5 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {command}
      </code>
      <Button
        variant="ghost-muted"
        size="icon-sm"
        aria-label={copied ? t("firstRun.signIn.copied") : copyLabel}
        onClick={copy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}

function CreateFirstBot({ onCreateBot }: Pick<FirstRunProps, "onCreateBot">) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(true);
  const [state, setState] = useState<"editing" | "creating" | "failed">("editing");
  const inputId = useId();
  const trimmed = name.trim();
  return (
    <Centered>
      <Ensemble />
      <Heading title={t("firstRun.create.title")} body={t("firstRun.create.body")} />
      <form
        className="flex w-full max-w-xs flex-col gap-3 text-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || state === "creating") return;
          setState("creating");
          onCreateBot(trimmed, primary).then(
            () => setState("editing"),
            () => setState("failed"),
          );
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t("firstRun.create.name")}
        </label>
        <input
          id={inputId}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={t("firstRun.create.placeholder")}
          className="h-9 rounded-md border border-input bg-surface px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11"
        />
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <span className="mt-px">
            <Checkbox checked={primary} onCheckedChange={setPrimary} />
          </span>
          <span>{t("firstRun.create.primary")}</span>
        </label>
        <Button type="submit" variant="primary" disabled={trimmed === "" || state === "creating"}>
          {t("firstRun.create.submit")}
        </Button>
        {state === "failed" && (
          <p role="alert" className="text-xs text-blocked">
            {t("firstRun.create.failed")}
          </p>
        )}
      </form>
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
      {/* A keyboard shortcut means nothing on a touch screen. */}
      <p className="hidden items-center gap-1.5 text-xs text-muted-foreground pointer-fine:flex">
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
