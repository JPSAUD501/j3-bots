// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every component in every state, in both themes, from the sample team. A
 * development tool for reviewing the design, so its own headings are not
 * translated; everything it shows is.
 */
import type { DraftFile, PairingFailure } from "@j3-bots/client-runtime";
import {
  AttachmentId,
  Conflict,
  type EngineStatus,
  Invalid,
  MemoryPath,
  MemoryRevision,
  ModelId,
  ProviderId,
  type RosterItem,
  type RosterItemKey,
} from "@j3-bots/contracts";
import { avatarShapeNames, botColors, colors, radii, typeScale } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { useId, useState, type ReactNode } from "react";
import { BotsProvider, ClockProvider, I18nProvider } from "../app/context";
import { ApprovalCard } from "../components/ApprovalCard";
import { BotAvatar, RoomAvatar } from "../components/BotAvatar";
import { Composer } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { EditBotForm, type EditBotFormProps } from "../components/EditBotDialog";
import { FirstRun, NoSelection, QuietConversation } from "../components/EmptyStates";
import { HandoffCard } from "../components/HandoffCard";
import { MemoryFile, type MemoryFileProps } from "../components/MemoryViewer";
import { MessageBubble } from "../components/MessageBubble";
import { NoticeLine } from "../components/NoticeLine";
import { Incompatible, Pairing, StorageFailed } from "../components/Pairing";
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
              <EditingSection />
              <EmptyStatesSection />
              <ConnectionSection />
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
  resendMessage: nothing,
  discardMessage: nothing,
  closeWorkFold: nothing,
};

const workSteps = (entryId: string) => team.workSteps[entryId] ?? null;
const notSubmitting = () => false;

function BubblesSection() {
  const { bubbles } = variants;
  return (
    <Section title="Bubbles">
      <Labeled label="Single bubbles, with no tightened corner: the operator, queued, cancelled, refused, perhaps delivered, being sent again, on its way from this device, not sent from it, answered with no record on this device, a bot with code, a bot with files">
        <div className="flex flex-col gap-2">
          <MessageBubble
            message={bubbles.operator}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.pending}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.cancelled}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.failed}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.unresolved}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.retrying}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            submitting
          />
          <MessageBubble
            message={bubbles.sending}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.notSent}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onDiscard={nothing}
          />
          <MessageBubble
            message={bubbles.unrecorded}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.bot}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.withFiles}
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

/** Files in every state the composer shows: uploading, ready, and refused. */
const draftFiles: ReadonlyArray<DraftFile> = [
  {
    _tag: "uploading",
    key: "photo",
    name: "Team photo.jpg",
    mediaType: "image/jpeg",
    size: 2_400_000,
    sent: 900_000,
  },
  {
    _tag: "ready",
    key: "brief",
    attachment: {
      id: AttachmentId.make("gallery-brief"),
      name: "Brief.pdf",
      mediaType: "application/pdf",
      size: 184_000,
    },
  },
  {
    _tag: "failed",
    key: "video",
    name: "Launch video.mov",
    mediaType: "video/quicktime",
    size: 900_000_000,
    problem: "too-large",
  },
];

function ComposerDemo({
  initial,
  recipient,
  files: initialFiles = [],
  sending = false,
  notSaved = false,
  replaced: initialReplaced = null,
}: {
  initial: string;
  recipient: string;
  files?: ReadonlyArray<DraftFile>;
  sending?: boolean;
  /** The device could not keep the draft yet. */
  notSaved?: boolean;
  /** Text another tab replaced, on offer. */
  replaced?: string | null;
}) {
  const draftKey = useId();
  const [value, setValue] = useState(initial);
  const [files, setFiles] = useState(initialFiles);
  const [replaced, setReplaced] = useState(initialReplaced);
  return (
    <Composer
      draftKey={draftKey}
      recipient={recipient}
      value={value}
      onValueChange={setValue}
      files={files}
      sending={sending}
      notSaved={notSaved}
      onAttachFiles={nothing}
      onDetachFile={(key) => setFiles((current) => current.filter((file) => file.key !== key))}
      onSend={() => setValue("")}
      onDictate={nothing}
      {...(replaced === null
        ? {}
        : {
            replaced: {
              revision: 1,
              onRestore: () => {
                setValue(replaced);
                setReplaced(null);
              },
              onDismiss: () => setReplaced(null),
            },
          })}
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
      <Labeled label="Composer: empty, with a draft, with files uploading, ready and refused, handing a draft over, which takes no files dropped on it, not saved on the device yet, and offering back text another tab replaced">
        <div className="flex max-w-(--layout-text-column) flex-col gap-3">
          <ComposerDemo initial="" recipient={team.bots.scout.profile.name} />
          <ComposerDemo
            initial={
              "Ask whether the photo can go on the website too.\nAnd keep the intro under 80 words."
            }
            recipient={team.room.name}
          />
          <ComposerDemo
            initial="The brief and the photo for Friday."
            recipient={team.bots.scout.profile.name}
            files={draftFiles}
          />
          <ComposerDemo
            initial="On its way to the outbox."
            recipient={team.bots.scout.profile.name}
            sending
          />
          <ComposerDemo
            initial="Held here until the device can keep it."
            recipient={team.bots.ledger.profile.name}
            notSaved
          />
          <ComposerDemo
            initial="Book the venue for the 14th."
            recipient={team.bots.atlas.profile.name}
            replaced="Book the venue for the 14th, and ask about parking."
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

/** The sample engine with Codex signed in, so a bot can move between two providers. */
const twoProviders: EngineStatus = {
  ...team.engine,
  providers: team.engine.providers.map((provider) =>
    provider.harness === "codex"
      ? {
          ...provider,
          status: { _tag: "ready" },
          models: [{ id: ModelId.make("gpt-5.5-codex"), name: "GPT-5.5 Codex" }],
        }
      : provider,
  ),
};
const toCodex = { providerId: ProviderId.make("codex"), modelId: ModelId.make("gpt-5.5-codex") };

/** An edit form as the dialog holds it, in a frame the size of a sheet. */
function EditBotVariant({
  label,
  ...props
}: { label: string } & Partial<Omit<EditBotFormProps, "titleId">>) {
  const titleId = useId();
  return (
    <Frame label={label} width={400} height={720}>
      <div className="h-full bg-background">
        <EditBotForm
          bot={team.bots.scout}
          engine={twoProviders}
          save={undefined}
          connected
          onSave={nothing}
          onClose={nothing}
          titleId={titleId}
          {...props}
        />
      </div>
    </Frame>
  );
}

const profileNote = {
  path: MemoryPath.make("profile.md"),
  revision: MemoryRevision.make("r2"),
  text: "# Profile\n\n- Prefers short answers.\n- Ships on Thursdays; no deploys on Fridays.\n- Time zone: America/Sao_Paulo.\n",
};
const editedNote = `${profileNote.text}- Reviews pull requests in the morning.\n`;
/** A read that never answers, so the gallery keeps showing the newer version loading. */
const neverRead = () => new Promise<boolean>(() => {});

/** A memory file as the viewer holds it, in a frame the size of a sheet. */
function MemoryVariant({
  label,
  ...props
}: { label: string } & Partial<Omit<MemoryFileProps, "titleId">>) {
  const titleId = useId();
  return (
    <Frame label={label} width={400} height={360}>
      <div className="h-full bg-background">
        <MemoryFile
          title="Profile note"
          reading={{ _tag: "read", document: profileNote }}
          save={undefined}
          connected
          onSave={nothing}
          onDiscard={nothing}
          onLoadNewer={neverRead}
          onClose={nothing}
          titleId={titleId}
          {...props}
        />
      </div>
    </Frame>
  );
}

function EditingSection() {
  const edit = { text: editedNote, revision: MemoryRevision.make("r1") };
  return (
    <Section title="Editing a bot and its memory">
      <div className="flex flex-wrap gap-4">
        <EditBotVariant label="Edit: as saved; type to try the inline checks" />
        <EditBotVariant
          label="Edit: saving, a move to another provider"
          save={{ _tag: "saving", changes: { model: toCodex, permissionMode: "auto" } }}
        />
        <EditBotVariant
          label="Edit: the engine refused the model"
          save={{
            _tag: "failed",
            changes: { model: toCodex },
            failure: { _tag: "refused", error: new Invalid({ reason: "model" }) },
          }}
        />
        <EditBotVariant
          label="Edit: failed, offline"
          connected={false}
          engine={team.engine}
          save={{
            _tag: "failed",
            changes: { profile: { title: "Research lead" } },
            failure: { _tag: "unexpected" },
          }}
        />
      </div>
      <div className="flex flex-wrap gap-4">
        <MemoryVariant label="Memory: read" />
        <MemoryVariant label="Memory: saving" save={{ _tag: "saving", changes: edit }} />
        <MemoryVariant
          label="Memory: changed on the server meanwhile"
          save={{
            _tag: "failed",
            changes: edit,
            failure: { _tag: "refused", error: new Conflict({ reason: "stale-revision" }) },
          }}
        />
        <MemoryVariant
          label="Memory: linked out of private data, offline"
          connected={false}
          save={{
            _tag: "failed",
            changes: edit,
            failure: { _tag: "refused", error: new Conflict({ reason: "private-location" }) },
          }}
        />
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
  portInUse: { ...team.engine, state: { _tag: "unavailable", reason: "port-in-use" } },
  installFailed: { ...team.engine, state: { _tag: "unavailable", reason: "install-failed" } },
  credentialRefused: {
    ...team.engine,
    state: { _tag: "unavailable", reason: "credential-refused" },
  },
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
        <Frame label="First run: the engine's port is taken" width={340} height={360}>
          <FirstRun engine={engines.portInUse} onCreateBot={created} />
        </Frame>
        <Frame label="First run: the engine did not install" width={340} height={360}>
          <FirstRun engine={engines.installFailed} onCreateBot={created} />
        </Frame>
        <Frame
          label="First run: the engine refused the server's credential"
          width={340}
          height={360}
        >
          <FirstRun engine={engines.credentialRefused} onCreateBot={created} />
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

// Real times: the banner and the lockout count against the device's clock, not the gallery's.
const retryAt = DateTime.makeUnsafe(Date.now() + 30_000);
const lockedUntil = DateTime.makeUnsafe(Date.now() + 15 * 60_000);

const refused = (reason: PairingFailure) => () =>
  Promise.resolve({ _tag: "failed", reason } as const);

function ConnectionSection() {
  return (
    <Section title="Connection and pairing">
      <Labeled label="The connection line: offline, reconnecting, the connection lost with a retry waiting, the server not reached">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          <ConnectionBanner state={{ _tag: "offline" }} everConnected onRetryNow={nothing} />
          <ConnectionBanner
            state={{ _tag: "connecting", attempt: 2 }}
            everConnected
            onRetryNow={nothing}
          />
          <ConnectionBanner
            state={{ _tag: "waiting", reason: "dropped", attempt: 2, retryAt }}
            everConnected
            onRetryNow={nothing}
          />
          <ConnectionBanner
            state={{
              _tag: "waiting",
              reason: "unreachable",
              attempt: 1,
              retryAt,
            }}
            everConnected={false}
            onRetryNow={nothing}
          />
        </div>
      </Labeled>
      <div className="flex flex-wrap gap-4">
        <Frame
          label="Pairing: a new device (any code is refused as wrong)"
          width={390}
          height={560}
        >
          <Pairing
            reason="new"
            defaultName="Chrome on Android"
            onPair={refused({ _tag: "invalid-code" })}
          />
        </Frame>
        <Frame
          label="Pairing: signed out elsewhere (any code meets the lockout)"
          width={390}
          height={560}
        >
          <Pairing
            reason="signed-out"
            defaultName="Safari on iPhone"
            onPair={refused({
              _tag: "rate-limited",
              retryAt: lockedUntil,
            })}
          />
        </Frame>
        <Frame
          label="Pairing: signed out here without reaching the server"
          width={390}
          height={600}
        >
          <Pairing
            reason="still-listed"
            defaultName="Firefox on Linux"
            onPair={refused({ _tag: "invalid-code" })}
          />
        </Frame>
        <Frame label="The server speaks another protocol version" width={390} height={360}>
          <Incompatible />
        </Frame>
        <Frame label="The browser would not keep the sign-in" width={390} height={360}>
          <StorageFailed onRetry={nothing} />
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
