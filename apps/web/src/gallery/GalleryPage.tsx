// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every component in every state, in both themes, from the sample team. A
 * development tool for reviewing the design, so its own headings are not
 * translated; everything it shows is.
 */
import type { RosterItem, RosterItemKey } from "@j3-bots/contracts";
import { avatarShapeNames, botColors, colors, radii, typeScale } from "@j3-bots/design-tokens";
import { useState, type ReactNode } from "react";
import { BotsProvider, ClockProvider, I18nProvider } from "../app/context";
import { ApprovalCard } from "../components/ApprovalCard";
import { BotAvatar, RoomAvatar } from "../components/BotAvatar";
import { Composer } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import { FirstRun, NoSelection, QuietConversation } from "../components/EmptyStates";
import { HandoffCard } from "../components/HandoffCard";
import { MessageBubble } from "../components/MessageBubble";
import { NoticeLine } from "../components/NoticeLine";
import { QuestionCard } from "../components/QuestionCard";
import { RosterRow } from "../components/RosterRow";
import { RoutineChangeCard } from "../components/RoutineChangeCard";
import { SecretRequestCard } from "../components/SecretRequestCard";
import { Timeline, type TimelineIntents } from "../components/Timeline";
import { WorkFold } from "../components/WorkFold";
import { locales, type Locale } from "../i18n/i18n";
import { cn } from "../lib/cn";
import { Shell } from "../shell/Shell";
import { shellShortcuts } from "../shell/shortcuts";
import { SAMPLE_NOW, ids, sampleTeam } from "./sample";
import { useSampleSource } from "./sampleSource";
import { galleryVariants } from "./variants";

const team = sampleTeam(SAMPLE_NOW);
const variants = galleryVariants(SAMPLE_NOW);
const bots = team.roster.flatMap((item) => (item._tag === "bot" ? [item.bot] : []));
const nothing = () => {};
const shortcuts = shellShortcuts();

const languageNames: Record<Locale, string> = { en: "English", "pt-BR": "Português (Brasil)" };

export default function GalleryPage() {
  const [locale, setLocale] = useState<Locale>("en");
  return (
    <I18nProvider locale={locale}>
      <ClockProvider now={SAMPLE_NOW}>
        <BotsProvider bots={bots}>
          <div className="min-h-full">
            <div className="mx-auto flex max-w-[90rem] flex-col gap-12 px-4 py-8 @container">
              <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold">Gallery</h1>
                  <p className="text-sm text-muted-foreground">
                    Every component and state, in both themes, from the sample team. Development
                    only.
                  </p>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Language"
                  className="flex gap-1 rounded-md bg-muted p-1"
                >
                  {locales.map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      aria-checked={l === locale}
                      onClick={() => setLocale(l)}
                      className="rounded-sm px-2.5 py-1 text-xs aria-checked:bg-background aria-checked:shadow-sm"
                    >
                      {languageNames[l]}
                    </button>
                  ))}
                </div>
              </header>
              <TokensSection />
              <AvatarsSection />
              <RosterSection />
              <BubblesSection />
              <CardsSection />
              <WorkSection />
              <NoticesSection />
              <ComposerSection />
              <DetailsSection />
              <EmptyStatesSection />
              <ShellSection />
            </div>
          </div>
        </BotsProvider>
      </ClockProvider>
    </I18nProvider>
  );
}

function Section({
  title,
  children,
  stacked = false,
}: {
  title: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className={cn("grid gap-4", !stacked && "@wide:grid-cols-2")}>
        {(["light", "dark"] as const).map((theme) => (
          <div
            key={theme}
            className={cn(
              theme,
              "min-w-0 rounded-lg border border-border bg-background p-4 text-foreground",
            )}
          >
            <p className="mb-3 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              {theme}
            </p>
            <div className="flex flex-col gap-6">{children}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Labeled({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className="text-2xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function TokensSection() {
  return (
    <Section title="Tokens">
      <Labeled label="Color roles">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
          {Object.keys(colors).map((role) => (
            <div key={role} className="flex flex-col gap-1">
              <span
                className="h-9 rounded-md border border-border"
                style={{ background: `var(--${role})` }}
              />
              <span className="truncate font-mono text-2xs text-muted-foreground">{role}</span>
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Bot palette">
        <div className="flex flex-wrap gap-3">
          {botColors.map((color) => (
            <div key={color} className="flex w-14 flex-col items-center gap-1">
              <span className="size-9 rounded-pill" style={{ background: `var(--bot-${color})` }} />
              <span className="font-mono text-2xs text-muted-foreground">{color}</span>
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Type scale">
        <div className="flex flex-col gap-1">
          {Object.entries(typeScale).map(([name, { size, lineHeight }]) => (
            <p
              key={name}
              style={{ fontSize: `${size / 16}rem`, lineHeight: `${lineHeight / 16}rem` }}
            >
              <span className="me-3 inline-block w-10 font-mono text-2xs text-muted-foreground">
                {name}
              </span>
              Scout finished the report
            </p>
          ))}
        </div>
      </Labeled>
      <Labeled label="Radii">
        <div className="flex flex-wrap gap-3">
          {Object.entries(radii).map(([name, px]) => (
            <div key={name} className="flex flex-col items-center gap-1">
              <span
                className="size-12 border border-border bg-muted"
                style={{ borderRadius: px >= 9999 ? "9999px" : `${px / 16}rem` }}
              />
              <span className="font-mono text-2xs text-muted-foreground">{name}</span>
            </div>
          ))}
        </div>
      </Labeled>
    </Section>
  );
}

const scoutAvatar = team.bots.scout.profile.avatar;

function AvatarsSection() {
  return (
    <Section title="Avatars">
      <Labeled label="Shapes">
        <div className="flex flex-wrap gap-4">
          {avatarShapeNames.map((shape, index) => (
            <div key={shape} className="flex w-14 flex-col items-center gap-1">
              <BotAvatar
                avatar={{ shape, color: botColors[index] ?? "gray" }}
                state={{ _tag: "idle" }}
                size={44}
              />
              <span className="font-mono text-2xs text-muted-foreground">{shape}</span>
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="States, at 24, 36 and 72 px">
        <div className="flex flex-col gap-3">
          {[24, 36, 72].map((size) => (
            <div key={size} className="flex flex-wrap items-end gap-4">
              {variants.states.map(([name, state, unread]) => (
                <div key={name} className="flex w-16 flex-col items-center gap-1">
                  <BotAvatar avatar={scoutAvatar} state={state} unread={unread} size={size} />
                  {size === 72 && (
                    <span className="font-mono text-2xs text-muted-foreground">{name}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Still: no motion, as with reduced motion and in notifications">
        <div className="flex flex-wrap items-end gap-4">
          {variants.states.map(([name, state, unread]) => (
            <div key={name} className="flex w-16 flex-col items-center">
              <BotAvatar avatar={scoutAvatar} state={state} unread={unread} size={36} still />
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Every color working, and a room">
        <div className="flex flex-wrap items-center gap-3">
          {botColors.map((color) => (
            <BotAvatar
              key={color}
              avatar={{ shape: "circle", color }}
              state={{ _tag: "working", since: SAMPLE_NOW, stalled: false, activity: null }}
              size={36}
            />
          ))}
          <RoomAvatar
            members={[team.bots.atlas.profile.avatar, team.bots.wren.profile.avatar]}
            size={36}
          />
        </div>
      </Labeled>
    </Section>
  );
}

const memberAvatars = (item: RosterItem) =>
  item._tag === "room"
    ? item.room.members.flatMap((id) =>
        bots.filter((b) => b.id === id).map((b) => b.profile.avatar),
      )
    : [];

function RosterSection() {
  return (
    <Section title="Roster rows">
      <ul className="flex w-(--layout-roster-width) max-w-full flex-col gap-px rounded-md bg-sidebar p-2">
        {team.roster.map((item, index) => (
          <li key={item._tag === "bot" ? item.bot.id : item.room.id}>
            <RosterRow item={item} selected={index === 0} memberAvatars={memberAvatars(item)} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const timelineIntents: TimelineIntents = {
  answerQuestion: nothing,
  dismissQuestion: nothing,
  decideApproval: nothing,
  provideSecret: nothing,
  declineSecret: nothing,
  retryNotice: nothing,
  retryMessage: nothing,
  openWorkFold: nothing,
  openAttachment: nothing,
  openHandoff: nothing,
  openRoutine: nothing,
  openConversation: nothing,
};

const workSteps = (entryId: string) => team.workSteps[entryId] ?? null;
const notSubmitting = () => false;

function BubblesSection() {
  const { bubbles } = variants;
  return (
    <Section title="Bubbles">
      <Labeled label="Single bubbles, with no tightened corner: the operator, queued, cancelled, refused, perhaps delivered, being sent again, a bot with code, a bot with files">
        <div className="flex flex-col gap-2">
          <MessageBubble
            entry={bubbles.operator}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.pending}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.cancelled}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.failed}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.unresolved}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.retrying}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            submitting
          />
          <MessageBubble
            entry={bubbles.bot}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            entry={bubbles.withFiles}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="A conversation">
        <div className="max-w-(--layout-text-column)">
          <Timeline
            entries={team.entries[`bot:${ids.scout}`] ?? []}
            inRoom={false}
            workSteps={workSteps}
            submitting={notSubmitting}
            intents={timelineIntents}
          />
        </div>
      </Labeled>
      <Labeled label="A room: each speaker named above their messages">
        <div className="max-w-(--layout-text-column)">
          <Timeline
            entries={team.entries[`room:${ids.newsletter}`] ?? []}
            inRoom
            workSteps={workSteps}
            submitting={notSubmitting}
            intents={timelineIntents}
          />
        </div>
      </Labeled>
    </Section>
  );
}

function CardsSection() {
  return (
    <Section title="Questions, approvals and credentials">
      <Labeled label="Question: pending (tap an option), recommended and destructive options, a form of radio buttons, checkboxes and text, answered, dismissed, expired">
        <div className="flex flex-col gap-3">
          {variants.questions.map((entry) => (
            <QuestionCard key={entry.id} entry={entry} onAnswer={nothing} onDismiss={nothing} />
          ))}
        </div>
      </Labeled>
      <Labeled label="Approval: a whole command, indentation kept; one with the reason it asks; a summary only, with no grant for the session; a file change, its path above the coloured diff; a file read; a decision on its way; allowed; denied; expired">
        <div className="flex flex-col gap-3">
          {variants.approvals.map(({ entry, submitting }) => (
            <ApprovalCard key={entry.id} entry={entry} onDecide={nothing} submitting={submitting} />
          ))}
        </div>
      </Labeled>
      <Labeled label="Approval becoming exact while it waits: the change arrives after the summary, and focus in the summary moves to it">
        <ApprovalBecomingExact />
      </Labeled>
      <Labeled label="Credential: pending with a link, provided, declined, expired">
        <div className="flex flex-col gap-3">
          {variants.secrets.map((entry) => (
            <SecretRequestCard
              key={entry.id}
              entry={entry}
              onProvide={nothing}
              onDecline={nothing}
            />
          ))}
        </div>
      </Labeled>
    </Section>
  );
}

function WorkSection() {
  return (
    <Section title="Work folds">
      <Labeled label="Running, finished, loading its steps, stopped, failed">
        <div className="flex flex-col gap-2">
          {variants.folds.map(({ entry, steps, open }) => (
            <WorkFold
              key={entry.id}
              entry={entry}
              steps={steps}
              defaultOpen={open}
              onOpenChange={nothing}
            />
          ))}
        </div>
      </Labeled>
    </Section>
  );
}

function NoticesSection() {
  return (
    <Section title="Notices, handoffs and routine changes">
      <Labeled label="Notices">
        <div className="flex flex-col">
          {variants.notices.map((entry) => (
            <NoticeLine
              key={entry.id}
              entry={entry}
              onRetry={nothing}
              onOpenConversation={nothing}
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="Handoffs">
        <div className="flex flex-col">
          {variants.handoffs.map((entry) => (
            <HandoffCard key={entry.id} entry={entry} onOpen={nothing} />
          ))}
        </div>
      </Labeled>
      <Labeled label="Routine changes">
        <div className="flex flex-col gap-2">
          {variants.routineChanges.map((entry) => (
            <RoutineChangeCard key={entry.id} entry={entry} onOpen={nothing} />
          ))}
        </div>
      </Labeled>
    </Section>
  );
}

/** A summary approval that the button makes exact, as the engine's fetched change does. */
function ApprovalBecomingExact() {
  const [fetched, setFetched] = useState(false);
  const { summary, exact } = variants.approvalBecomingExact;
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        data-gallery-fetch
        disabled={fetched}
        onClick={() => setFetched(true)}
        className="rounded-sm bg-muted px-2.5 py-1 text-xs disabled:opacity-50"
      >
        Bring the fetched change
      </button>
      <div className="w-full">
        <ApprovalCard entry={fetched ? exact : summary} onDecide={nothing} />
      </div>
    </div>
  );
}

function ComposerDemo({ initial, recipient }: { initial: string; recipient: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Composer
      recipient={recipient}
      value={value}
      onValueChange={setValue}
      onSend={() => setValue("")}
      onAttach={nothing}
      onDictate={nothing}
    />
  );
}

function ComposerSection() {
  return (
    <Section title="Conversation header and composer">
      <Labeled label="Headers: a working bot (with Stop), a waiting bot (the line goes to the request), a blocked bot, a room">
        <div className="flex flex-col gap-2">
          {[
            { _tag: "bot", bot: team.bots.scout } as const,
            { _tag: "bot", bot: team.bots.atlas } as const,
            { _tag: "bot", bot: team.bots.ledger } as const,
            { _tag: "room", room: team.room } as const,
          ].map((subject) => (
            <div
              key={subject._tag === "bot" ? subject.bot.id : subject.room.id}
              className="rounded-md border border-border"
            >
              <ConversationHeader
                subject={subject}
                detailsOpen={false}
                onToggleDetails={nothing}
                onBack={nothing}
                onStop={nothing}
                onGoToWaiting={nothing}
                stopShortcut={shortcuts.stop}
              />
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Composer: empty, and with a draft">
        <div className="flex max-w-(--layout-text-column) flex-col gap-3">
          <ComposerDemo initial="" recipient={team.bots.scout.profile.name} />
          <ComposerDemo
            initial={
              "Ask whether the photo can go on the website too.\nAnd keep the intro under 80 words."
            }
            recipient={team.room.name}
          />
        </div>
      </Labeled>
    </Section>
  );
}

const detailsIntents = {
  setRoutineEnabled: nothing,
  openRoutine: nothing,
  openAttachment: nothing,
  openMemoryFile: nothing,
  editProfile: nothing,
  freshStart: nothing,
  deleteBot: nothing,
};

function Pane({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[40rem] w-(--layout-details-width) max-w-full flex-col overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}

function DetailsSection() {
  const { scout, moss } = team.bots;
  return (
    <Section title="Details panel">
      <div className="flex flex-wrap gap-4">
        <Pane>
          <BotDetails
            bot={scout}
            routines={team.routines[scout.id] ?? []}
            memory={team.memory[scout.id] ?? []}
            files={team.files[scout.id] ?? []}
            modelName="Claude Code · Claude Sonnet 5.5"
            intents={detailsIntents}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          <BotDetails
            bot={moss}
            routines={[]}
            memory={[]}
            files={[]}
            modelName={null}
            intents={detailsIntents}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          <RoomDetails room={team.room} onClose={nothing} />
        </Pane>
      </div>
    </Section>
  );
}

function Frame({
  label,
  width,
  height,
  children,
}: {
  label: string;
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <Labeled label={label} className="max-w-full">
      <div
        className="max-w-full overflow-hidden rounded-md border border-border"
        style={{ width: `${width / 16}rem`, height: `${height / 16}rem` }}
      >
        {children}
      </div>
    </Labeled>
  );
}

const signInCommands: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR=~/.j3-bots/providers/claude claude",
  codex: "CODEX_HOME=~/.j3-bots/providers/codex codex login",
};

const engines = {
  starting: null,
  down: { ...team.engine, state: { _tag: "unavailable", reason: "down" } },
  incompatible: { ...team.engine, state: { _tag: "incompatible", runningVersion: "0.1.8" } },
  signIn: {
    ...team.engine,
    providers: team.engine.providers.map((p) => ({
      ...p,
      status: {
        _tag: "sign-in-required",
        command: signInCommands[p.harness] ?? p.harness,
      } as const,
    })),
  },
  unusable: {
    ...team.engine,
    providers: team.engine.providers.map((p, index) => ({
      ...p,
      status:
        index === 0
          ? ({
              _tag: "limited",
              resetsAt: team.engine.providers[0]?.usage[0]?.resetsAt ?? null,
            } as const)
          : ({ _tag: "unavailable" } as const),
    })),
  },
} as const;

const created = () => Promise.resolve();

/** A bot just created: its first turn has started and nothing is in its conversation yet. */
const speakingFirst = {
  ...team.bots.moss,
  state: { _tag: "thinking", since: SAMPLE_NOW, stalled: false },
} as const;

function EmptyStatesSection() {
  return (
    <Section title="Empty states">
      <div className="flex flex-wrap gap-4">
        <Frame label="First run: connecting" width={340} height={360}>
          <FirstRun engine={engines.starting} onCreateBot={created} />
        </Frame>
        <Frame label="First run: engine not running" width={340} height={360}>
          <FirstRun engine={engines.down} onCreateBot={created} />
        </Frame>
        <Frame label="First run: wrong engine version" width={340} height={360}>
          <FirstRun engine={engines.incompatible} onCreateBot={created} />
        </Frame>
        <Frame
          label="First run: sign in to a provider, with the command for each"
          width={400}
          height={460}
        >
          <FirstRun engine={engines.signIn} onCreateBot={created} />
        </Frame>
        <Frame label="First run: one provider limited, one unavailable" width={400} height={420}>
          <FirstRun engine={engines.unusable} onCreateBot={created} />
        </Frame>
        <Frame label="No bots yet: creating one opens its conversation" width={760} height={480}>
          <ShellFrame initial={null} firstRun />
        </Frame>
        <Frame label="Nothing selected" width={340} height={360}>
          <NoSelection nextShortcut={shortcuts.nextBot.label} />
        </Frame>
        <Frame label="A quiet conversation" width={340} height={360}>
          <QuietConversation bot={team.bots.moss} />
        </Frame>
        <Frame label="A new bot, about to speak first" width={340} height={360}>
          <QuietConversation bot={speakingFirst} />
        </Frame>
      </div>
    </Section>
  );
}

const rowKey = (item: RosterItem): RosterItemKey =>
  item._tag === "bot"
    ? { _tag: "bot", botId: item.bot.id }
    : { _tag: "room", roomId: item.room.id };

/** In a frame there is no router: a roster row is a button that selects. */
const rowButton = (onClick: () => void) => <button type="button" onClick={onClick} />;

/** A whole shell in a frame, with its own selection and its own copy of the sample team. */
function ShellFrame({
  initial,
  details = false,
  firstRun = false,
}: {
  initial: RosterItemKey | null;
  details?: boolean;
  firstRun?: boolean;
}) {
  const source = useSampleSource({ firstRun });
  const [selected, setSelected] = useState(initial);
  const [detailsOpen, setDetailsOpen] = useState(details);
  return (
    <Shell
      data={source.data}
      intents={source.intents}
      keyboard={false}
      navigation={{
        selected,
        detailsOpen: detailsOpen && selected !== null,
        select: setSelected,
        setDetailsOpen,
        rowLink: (item) => rowButton(() => setSelected(rowKey(item))),
      }}
    />
  );
}

function ShellSection() {
  const scout = { _tag: "bot", botId: ids.scout } as const;
  return (
    <Section title="App shell" stacked>
      <div className="flex flex-col gap-6">
        <Frame label="Desktop, 1280 px: roster, conversation and details" width={1280} height={760}>
          <ShellFrame initial={scout} details />
        </Frame>
        <Frame
          label="Tablet, 900 px: the name opens the details as a modal dialog over the conversation; Escape, the scrim or the close button returns to the title"
          width={900}
          height={640}
        >
          {/* Closed at first: a dialog open on load would hold the whole gallery's focus. */}
          <ShellFrame initial={{ _tag: "bot", botId: ids.atlas }} />
        </Frame>
        <div className="flex flex-wrap gap-6">
          <Frame label="Phone, 390 px: the roster" width={390} height={760}>
            <ShellFrame initial={null} />
          </Frame>
          <Frame label="Phone: a conversation" width={390} height={760}>
            <ShellFrame initial={{ _tag: "room", roomId: ids.newsletter }} />
          </Frame>
          <Frame
            label="Phone: a bot waiting on an approval; its name opens the details as a dialog"
            width={390}
            height={760}
          >
            <ShellFrame initial={{ _tag: "bot", botId: ids.atlas }} />
          </Frame>
        </div>
      </div>
    </Section>
  );
}
