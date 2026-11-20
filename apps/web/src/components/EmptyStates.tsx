// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EngineStatus } from "@j3-bots/contracts";
import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../app/context";
import { BotAvatar } from "./BotAvatar";
import { Button } from "./ui/button";
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
  readonly onCreateBot: (name: string, primary: boolean) => void;
}

/**
 * Before the first bot: checks that the engine runs and a provider is signed
 * in, then asks for a name. No settings form; the bot asks the rest itself.
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
    return (
      <Centered>
        <Ensemble />
        <Heading title={t("firstRun.signIn.title")} body={t("firstRun.signIn.body")} />
        <ul className="flex w-full max-w-xs flex-col gap-1 text-start text-sm">
          {engine.providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2"
            >
              <span>{provider.name}</span>
              <span className="text-xs text-waiting">{t("firstRun.signIn.needed")}</span>
            </li>
          ))}
        </ul>
      </Centered>
    );
  }
  return <CreateFirstBot onCreateBot={onCreateBot} />;
}

function CreateFirstBot({ onCreateBot }: Pick<FirstRunProps, "onCreateBot">) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState(true);
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
          if (trimmed !== "") onCreateBot(trimmed, primary);
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
          className="h-9 rounded-md border border-input bg-surface px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent"
        />
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={primary}
            onChange={(e) => setPrimary(e.currentTarget.checked)}
            className="mt-0.5 accent-foreground"
          />
          <span>{t("firstRun.create.primary")}</span>
        </label>
        <Button type="submit" variant="primary" disabled={trimmed === ""}>
          {t("firstRun.create.submit")}
        </Button>
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
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
