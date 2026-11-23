// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every component in every state, in both themes, from the sample team. A
 * development tool for reviewing the design, so its own headings are not
 * translated; everything it shows is.
 */
import {
  AttachmentId,
  type AvatarChoice,
  type BotId,
  type BotTemplate,
  Conflict,
  type EngineStatus,
  EntryId,
  type EntryTarget,
  Invalid,
  LANGUAGES,
  type Language,
  MemoryPath,
  MemoryRevision,
  ModelId,
  type Notification,
  type NotificationKind,
  PairingCode,
  ProviderId,
  type ProviderStatus,
  type Bot,
  type Room,
  RoomId,
  type RosterItem,
  type RosterItemKey,
  type RoutineRun,
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
  TemplateTooLarge,
  RoutineRunId,
  type HarnessLocation,
  type SignInHarness,
  type UsageWindow,
} from "@j3-bots/contracts";
import {
  avatarCast,
  avatarShapeNames,
  botColors,
  colors,
  fontFamilies,
  freeAvatar,
  press,
  radii,
  resolveAvatar,
  shadows,
  springs,
  typeScale,
  type Spring,
  type Themed,
  type TypeInput,
} from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  turnsNotRead,
  type DraftFile,
  type DraftMention,
  type PairingFailure,
  type RecentTurns,
  type RecentTurnsState,
  type SignInView,
} from "@j3-bots/client-runtime";
import {
  addressed,
  addresseeOf,
  avatarSeed,
  avatarStates,
  buildTimeline,
  liveTurn,
  withLiveTurn,
  mentionOptions,
  type OnboardingStep,
} from "@j3-bots/client-runtime/presentation";
import { ClockProvider, OperatorTimeZone } from "../app/clock";
import { BotsProvider, I18nProvider, useI18n } from "../app/context";
import { ApprovalCard } from "../components/ApprovalCard";
import { AvatarPicker } from "../components/avatar/AvatarPicker";
import { BotAvatar, RoomAvatar } from "../components/avatar/BotAvatar";
import { Composer, type MentionCandidate, MentionList } from "../components/Composer";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { EditBotForm, type EditBotFormProps } from "../components/EditBotDialog";
import { NoSelection, QuietConversation, QuietRoom } from "../components/EmptyStates";
import { Onboarding } from "../onboarding/Onboarding";
import { HandoffCard } from "../components/HandoffCard";
import { MemoryFile, type MemoryFileProps } from "../components/MemoryViewer";
import { MessageBubble } from "../components/MessageBubble";
import { NeedsUpdateLine, NoticeLine } from "../components/NoticeLine";
import { Incompatible, Pairing, StorageFailed } from "../components/Pairing";
import { QuestionCard } from "../components/QuestionCard";
import { RoomForm, type RoomFormProps } from "../components/RoomDialog";
import { Roster } from "../components/Roster";
import { HiddenBots, SectionBlock, useFoldedSections } from "../components/RosterGroups";
import type { RosterIntents, RosterMenuContext } from "../components/RosterMenu";
import { RosterRow } from "../components/RosterRow";
import { PrimaryBadge } from "../components/avatar/PrimaryBadge";
import { RoutineChangeCard } from "../components/RoutineChangeCard";
import { RoutineRunList } from "../components/RoutineRuns";
import { SecretRequestCard } from "../components/SecretRequestCard";
import { ShareTemplateContent, TemplateForm } from "../components/TemplateDialogs";
import { Timeline, type TimelineIntents } from "../components/Timeline";
import { EngineSection } from "../components/SettingsDialog";
import type { LocalProviderSetup } from "../components/ProviderSetup";
import { UsageSection } from "../components/UsageSection";
import { WorkFold } from "../components/WorkFold";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Confirm } from "../components/ui/confirm";
import { lineField, textField } from "../components/ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { LANGUAGE_NAMES, notificationText } from "@j3-bots/i18n";
import { cn } from "../lib/cn";
import { iconUrl, notificationIcon } from "../live/notificationIcon";
import { addresseeLine } from "@j3-bots/client-runtime/wording";
import { rosterIntents } from "../shell/rosterIntents";
import { Shell } from "../shell/Shell";
import { shellShortcuts } from "../shell/shortcuts";
import { SAMPLE_NOW, ids, sampleTeam } from "./sample";
import { useSampleSource } from "./sampleSource";
import { galleryVariants } from "./variants";

const team = sampleTeam(SAMPLE_NOW);
const variants = galleryVariants(SAMPLE_NOW);
const bots = team.roster.flatMap((item) => (item._tag === "bot" ? [item.bot] : []));
const nothing = () => {};
/** A room with no work under way: it offers no Stop. */
const restingRoom: Room = {
  ...team.room,
  id: RoomId.make("weekend-plans"),
  name: "Weekend plans",
  members: [team.bots.moss.id, team.bots.pip.id],
  hostId: team.bots.moss.id,
  work: "none",
};
/** The sample room while the server ends its work. */
const stoppingRoom: Room = { ...team.room, work: "stopping" };
const shortcuts = shellShortcuts();
/** The type scale's two sets: the one a page shows depends on its pointer, so both are drawn. */
const typeInputs: ReadonlyArray<TypeInput> = ["pointer", "touch"];

export default function GalleryPage() {
  const [locale, setLocale] = useState<Language>("en");
  return (
    <I18nProvider locale={locale}>
      <ClockProvider now={SAMPLE_NOW}>
        <OperatorTimeZone timeZone={team.settings.timeZone}>
          <BotsProvider bots={bots}>
            <div className="min-h-full">
              <div className="mx-auto flex max-w-[90rem] flex-col gap-12 px-4 py-8 @container">
                <header className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h1 className="display-type text-3xl">Gallery</h1>
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
                    {LANGUAGES.map((l) => (
                      <button
                        key={l}
                        type="button"
                        role="radio"
                        aria-checked={l === locale}
                        onClick={() => setLocale(l)}
                        className="rounded-sm px-2.5 py-1 text-xs aria-checked:bg-background aria-checked:shadow-raised"
                      >
                        {LANGUAGE_NAMES[l]}
                      </button>
                    ))}
                  </div>
                </header>
                <TokensSection />
                <PrimitivesSection />
                <MotionSection />
                <AvatarsSection />
                <NotificationsSection />
                <RosterSection />
                <RosterOrganizeSection />
                <BubblesSection />
                <CardsSection />
                <WorkSection />
                <NoticesSection />
                <ComposerSection />
                <DetailsSection />
                <EditingSection />
                <TemplatesSection />
                <RoomsSection />
                <EngineSettingsSection />
                <UsageGallerySection />
                <FirstRunSection />
                <LocalFirstRunSection />
                <FirstRunWideSection />
                <EmptyStatesSection />
                <ConnectionSection />
                <ShellSection />
              </div>
            </div>
          </BotsProvider>
        </OperatorTimeZone>
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
  /** What each theme's panel shows, or a function of the theme for what draws its own colors. */
  children: ReactNode | ((theme: keyof Themed) => ReactNode);
  stacked?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="display-type text-2xl">{title}</h2>
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
            <div className="flex flex-col gap-6">
              {typeof children === "function" ? children(theme) : children}
            </div>
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
      <Labeled label="Faces">
        <div className="flex flex-col gap-1">
          <p className="display-type text-3xl">{fontFamilies.display}</p>
          <p className="text-lg">
            {fontFamilies.text} <span className="font-medium">medium</span>{" "}
            <span className="font-semibold">semibold</span>
          </p>
          <p className="font-mono text-sm">{fontFamilies.mono}: pnpm test --filter web != 0</p>
        </div>
      </Labeled>
      {typeInputs.map((input) => (
        <Labeled key={input} label={`Type scale, ${input}`}>
          <div className="flex flex-col gap-1">
            {Object.entries(typeScale).map(([name, step]) => {
              const { size, lineHeight } = step[input];
              return (
                <p
                  key={name}
                  className={size >= typeScale["2xl"][input].size ? "display-type" : undefined}
                  style={{ fontSize: `${size / 16}rem`, lineHeight: `${lineHeight / 16}rem` }}
                >
                  <span className="me-3 inline-block w-16 font-sans font-normal tracking-normal text-2xs text-muted-foreground">
                    {name} {size}/{lineHeight}
                  </span>
                  Scout finished the report
                </p>
              );
            })}
          </div>
        </Labeled>
      ))}
      <Labeled label="Elevation">
        <div className="flex flex-wrap gap-4">
          {Object.keys(shadows).map((name) => (
            <div key={name} className="flex flex-col items-center gap-1">
              <span
                className="size-16 rounded-lg bg-surface"
                style={{ boxShadow: `var(--elevation-${name})` }}
              />
              <span className="font-mono text-2xs text-muted-foreground">{name}</span>
            </div>
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

/** An avatar the gallery shows in every state: the scout, until Generate draws another. */
interface Subject {
  readonly avatar: AvatarChoice;
  readonly seed: string;
}

const scout: Subject = {
  avatar: resolveAvatar(team.bots.scout.profile.avatar),
  seed: team.bots.scout.id,
};

/** The `count`th generated avatar: a shape, a color and a seed, drawn from a hash of the count. */
const generated = (count: number): Subject => {
  const seed = `generated-${count}`;
  const hash = avatarSeed(seed);
  return {
    avatar: {
      shape: avatarShapeNames[hash % avatarShapeNames.length] ?? "dome",
      color: botColors[(hash >>> 8) % botColors.length] ?? "slate",
    },
    seed,
  };
};

const AVATAR_SIZES = [24, 40, 96] as const;

/** The looks the first 24 bots take when nobody chooses one: the cast, then twelve more pairs. */
const firstLooks = Array.from({ length: 24 }).reduce<Array<AvatarChoice>>(
  (taken) => [...taken, freeAvatar(taken)],
  [],
);

function PrimitivesSection() {
  const { t } = useI18n();
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState(true);
  return (
    <Section title="Primitives">
      <Labeled label="Buttons: hover, and press to feel the spring back">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">{t("editBot.save")}</Button>
          <Button>{t("editBot.cancel")}</Button>
          <Button variant="outline">{t("details.freshStart")}</Button>
          <Button variant="ghost">{t("settings.title")}</Button>
          <Button variant="ghost-muted">{t("roster.new.cancel")}</Button>
          <Button variant="destructive">{t("details.delete", { name: "Scout" })}</Button>
          <Button variant="destructive-outline">{t("room.delete", { name: "Launch" })}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm">
            {t("editBot.save")}
          </Button>
          <Button size="sm">{t("details.freshStart")}</Button>
          <Button variant="primary" disabled>
            {t("editBot.save")}
          </Button>
          <Button size="icon" variant="ghost" aria-label={t("roster.new")}>
            <PlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost-muted" aria-label={t("settings.title")}>
            <SettingsIcon />
          </Button>
        </div>
      </Labeled>
      <Labeled label="Fields: empty, filled, refused, read-only">
        <div className="grid max-w-sm gap-2">
          <input className={lineField} placeholder={t("settings.name.placeholder")} />
          <input className={lineField} defaultValue="Ada" aria-label={t("editBot.name")} />
          <input
            className={lineField}
            defaultValue=""
            aria-invalid
            aria-label={t("editBot.name")}
          />
          <input
            className={lineField}
            defaultValue="Scout"
            readOnly
            aria-label={t("editBot.name")}
          />
          <textarea
            className={cn(textField, "field-sizing-content min-h-20 resize-none py-2")}
            placeholder={t("editBot.titleField.placeholder")}
          />
        </div>
      </Labeled>
      <Labeled label="Switch and checkbox">
        <div className="flex items-center gap-6">
          <Switch checked={on} onCheckedChange={setOn} aria-label="Switch" />
          <Switch checked={false} disabled aria-label="Disabled switch" />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={setChecked} />
            Checkbox
          </label>
        </div>
      </Labeled>
      <Labeled label="Menu and confirmation: open to see them spring in">
        <div className="flex flex-wrap items-center gap-2">
          <Menu>
            <MenuTrigger render={<Button />}>{t("roster.new")}</MenuTrigger>
            <MenuPopup side="bottom">
              <MenuItem onClick={nothing}>{t("newBot.title")}</MenuItem>
              <MenuItem onClick={nothing} hint={t("details.freshStart")}>
                {t("settings.title")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Confirm
            trigger={<Button variant="destructive-outline" />}
            title={t("details.delete.title", { name: "Scout" })}
            body={t("details.delete.body", { name: "Scout" })}
            cancel={t("details.delete.cancel", { name: "Scout" })}
            confirm={t("details.delete", { name: "Scout" })}
            onConfirm={nothing}
          >
            {t("details.delete", { name: "Scout" })}
          </Confirm>
        </div>
      </Labeled>
    </Section>
  );
}

/** A spring's track: pressing the card sends the ball to the other end on that spring. */
function SpringCard({ name, spring }: { name: string; spring: Spring }) {
  const track = useRef<HTMLSpanElement>(null);
  const ball = useRef<HTMLSpanElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  const replay = () => {
    const box = track.current;
    const dot = ball.current;
    if (box === null || dot === null) return;
    const end = `translateX(${box.clientWidth - dot.clientWidth}px)`;
    const [from, to] = atEnd ? [end, "translateX(0)"] : ["translateX(0)", end];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dot.animate([{ transform: from }, { transform: to }], {
      duration: reduced ? 0 : spring.duration,
      easing: spring.easing,
      fill: "both",
    });
    setAtEnd(!atEnd);
  };
  return (
    <button
      type="button"
      onClick={replay}
      className="pressable flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-start shadow-raised hover:bg-muted"
    >
      <span className="display-type text-lg capitalize">{name}</span>
      <span ref={track} className="relative my-2 block h-3.5 w-full rounded-pill bg-muted">
        <span
          ref={ball}
          className="absolute start-0 top-0 block size-3.5 rounded-pill bg-foreground"
        />
      </span>
      <span className="text-xs text-muted-foreground">
        {spring.frequency} Hz, damping {spring.damping}, settles in {spring.duration} ms
      </span>
    </button>
  );
}

function MotionSection() {
  return (
    <Section title="Motion">
      <Labeled label="Springs: press a card to replay it">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          {Object.entries(springs).map(([name, spring]) => (
            <SpringCard key={name} name={name} spring={spring} />
          ))}
        </div>
      </Labeled>
      <Labeled label="Press">
        <p className="text-sm text-muted-foreground">
          A control scales to {press.scale} in {press.duration} ms, a round icon button to{" "}
          {press.roundScale} and a row to {press.rowScale}, then springs back on pop. Reduced motion
          keeps the colors and drops every move.
        </p>
      </Labeled>
    </Section>
  );
}

function AvatarsSection() {
  const [subject, setSubject] = useState(scout);
  const [count, setCount] = useState(0);
  const [picked, setPicked] = useState<AvatarChoice>(avatarCast[0]);
  const [name, setName] = useState("Scout");
  const subjectName = `${subject.avatar.shape} · ${subject.avatar.color}`;
  return (
    <Section title="Avatars">
      <Labeled label={`Every state at 24, 40 and 96 px: ${subjectName}`}>
        <div className="flex flex-col gap-3">
          {AVATAR_SIZES.map((size) => (
            <div key={size} className="flex flex-wrap items-end gap-3">
              {avatarStates.map((state) => (
                <div key={state} className="flex min-w-16 flex-col items-center gap-1">
                  <BotAvatar
                    avatar={subject.avatar}
                    seed={subject.seed}
                    state={state}
                    size={size}
                  />
                  {size === 96 && (
                    <span className="font-mono text-2xs text-muted-foreground">{state}</span>
                  )}
                </div>
              ))}
              <div className="flex min-w-16 flex-col items-center gap-1">
                <BotAvatar
                  avatar={subject.avatar}
                  seed={subject.seed}
                  state="working"
                  stalled
                  size={size}
                />
                {size === 96 && (
                  <span className="font-mono text-2xs text-muted-foreground">stalled</span>
                )}
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setSubject(generated(count + 1));
                setCount(count + 1);
              }}
            >
              Generate
            </Button>
            <Button variant="ghost" onClick={() => setSubject(scout)}>
              Scout
            </Button>
          </div>
        </div>
      </Labeled>
      <Labeled label="Still: as under reduced motion and in notifications, at 40 px">
        <div className="flex flex-wrap items-end gap-3">
          {avatarStates.map((state) => (
            <BotAvatar
              key={state}
              avatar={subject.avatar}
              seed={subject.seed}
              state={state}
              size={40}
              still
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="The primary bot's mark at 24, 32, 40 and 52 px: it names a role, so the light still says what the bot is doing">
        <div className="flex flex-wrap items-end gap-4">
          {([24, 32, 40, 52] as const).map((size) => (
            <PrimaryBadge key={size} primary size={size}>
              <BotAvatar
                avatar={team.bots.scout.profile.avatar}
                seed={team.bots.scout.id}
                state="working"
                size={size}
              />
            </PrimaryBadge>
          ))}
        </div>
      </Labeled>
      <Labeled label="The first 24 bots' looks, in the order new bots take them, and a room">
        <div className="flex flex-wrap items-end gap-3">
          {firstLooks.map((avatar) => (
            <div
              key={`${avatar.shape}/${avatar.color}`}
              className="flex w-16 flex-col items-center gap-1"
            >
              <BotAvatar
                avatar={avatar}
                seed={`cast-${avatar.shape}-${avatar.color}`}
                state="idle"
                size={40}
              />
              <span className="font-mono text-2xs text-muted-foreground">
                {avatar.shape}
                <br />
                {avatar.color}
              </span>
            </div>
          ))}
          <RoomAvatar
            members={[team.bots.atlas, team.bots.wren].map((bot) => ({
              id: bot.id,
              avatar: bot.profile.avatar,
            }))}
            size={40}
          />
        </div>
      </Labeled>
      <Labeled label="Picker, with a name to type">
        <div className="flex max-w-md flex-col gap-3">
          <input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            className={lineField}
          />
          <AvatarPicker value={picked} onChange={setPicked} name={name} seed="gallery-picker" />
        </div>
      </Labeled>
    </Section>
  );
}

const sampleNotification = (
  kind: NotificationKind,
  botId: BotId,
  target: EntryTarget = { _tag: "conversation", botId },
): Notification => ({
  target,
  entryId: EntryId.make(`${kind}-${botId}`),
  botId,
  kind,
  preview: null,
});

/**
 * One notification of each kind, from bots in different states (Otto is idle
 * when he asks; Ledger is blocked), and one from a room.
 */
const sampleNotifications: ReadonlyArray<Notification> = [
  sampleNotification("message", ids.scout),
  sampleNotification("handoff", ids.wren),
  sampleNotification("question", ids.otto),
  sampleNotification("approval", ids.atlas),
  sampleNotification("secret-request", ids.iris),
  sampleNotification("message", ids.ledger),
  sampleNotification("message", ids.wren, { _tag: "room", roomId: ids.newsletter }),
];

/** A notification as a system shows one: its icon as the app draws it, its title and its body. */
function NotificationPreview({
  notification,
  theme,
}: {
  notification: Notification;
  theme: keyof Themed;
}) {
  const i18n = useI18n();
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void notificationIcon(notification, team.roster, theme).then((png) => {
      if (current) setIcon(iconUrl(png));
    });
    return () => {
      current = false;
    };
  }, [notification, theme]);
  const name = (id: BotId) =>
    team.roster.flatMap((row) =>
      row._tag === "bot" && row.bot.id === id ? [row.bot.profile.name] : [],
    )[0] ?? null;
  const roomName = (id: RoomId) =>
    team.roster.flatMap((row) =>
      row._tag === "room" && row.room.id === id ? [row.room.name] : [],
    )[0] ?? null;
  const text = notificationText(notification, { botName: name, roomName }, i18n);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      {icon === null ? (
        <span className="size-12 shrink-0" />
      ) : (
        <img src={icon} alt="" width={48} height={48} className="shrink-0" />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{text?.title}</p>
        <p className="truncate text-xs text-muted-foreground">{text?.body}</p>
        <p className="font-mono text-2xs text-muted-foreground">{notification.kind}</p>
      </div>
    </div>
  );
}

function NotificationsSection() {
  return (
    <Section title="Notifications">
      {(theme) => (
        <Labeled label="Each kind, with the icon drawn in the theme the system is in">
          <div className="grid gap-2 @wide:grid-cols-2">
            {sampleNotifications.map((notification) => (
              <NotificationPreview
                key={notification.entryId}
                notification={notification}
                theme={theme}
              />
            ))}
          </div>
        </Labeled>
      )}
    </Section>
  );
}

const memberAvatars = (item: RosterItem) =>
  item._tag === "room"
    ? item.room.members.flatMap((id) =>
        bots.filter((b) => b.id === id).map((b) => ({ id: b.id, avatar: b.profile.avatar })),
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

/** The roster alone, at its width beside a conversation, with its own copy of the sample team. */
function RosterFrame() {
  const source = useSampleSource();
  const folded = useFoldedSections(source.data.sections);
  const [selected, setSelected] = useState<RosterItemKey | null>({
    _tag: "bot",
    botId: ids.atlas,
  });
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <Roster
        items={source.data.roster ?? []}
        sections={source.data.sections}
        selected={selected}
        rowLink={(item) => rowButton(() => setSelected(rowKey(item)))}
        onNewBot={nothing}
        onNewFromTemplate={nothing}
        onNewRoom={nothing}
        intents={rosterIntents(source.intents, {
          selected,
          select: setSelected,
          setDetailsOpen: nothing,
        })}
        folded={folded}
      />
    </div>
  );
}

const quietIntents: RosterIntents = {
  placeBot: nothing,
  pinRoom: nothing,
  markRead: nothing,
  markUnread: nothing,
  createSection: () => Promise.resolve(null),
  updateSection: nothing,
  deleteSection: nothing,
  openDetails: nothing,
  deleteBot: nothing,
};

const quietMenu: RosterMenuContext = {
  intents: quietIntents,
  sections: team.sections,
  primary: team.bots.scout,
  ask: nothing,
  renameSection: nothing,
};

const homeSection = team.sections[0];
const hiddenBots = team.roster.flatMap((item) =>
  item._tag === "bot" && item.bot.hidden ? [item] : [],
);

function RosterOrganizeSection() {
  return (
    <Section title="Organizing the roster">
      <Frame
        label="The pinned bots as large avatars, the primary one marked; rooms and the bots in no section; a section with bots, one with none yet; the row to the hidden bots. Right-click a row or tile, or its “…”, for its menu"
        width={340}
        height={980}
      >
        <RosterFrame />
      </Frame>
      {homeSection !== undefined && (
        // A section being named takes focus as it appears, so the gallery leaves it to the roster above.
        <Labeled label="A folded section with something unread">
          <div className="flex w-(--layout-roster-width) max-w-full flex-col rounded-md bg-sidebar p-2">
            <SectionBlock
              section={homeSection}
              index={0}
              sections={team.sections}
              unread
              folded
              onFold={nothing}
              renaming={false}
              onStartRename={nothing}
              onRename={nothing}
              menu={quietMenu}
            >
              {null}
            </SectionBlock>
          </div>
        </Labeled>
      )}
      <Frame label="The hidden conversations, each with Unhide" width={340} height={220}>
        <div className="h-full bg-sidebar p-2">
          <HiddenBots
            items={hiddenBots}
            selected={null}
            rowLink={() => rowButton(nothing)}
            onBack={nothing}
            onUnhide={nothing}
          />
        </div>
      </Frame>
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
  const { t } = useI18n();
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
          {/* In a room, refused because the member it mentions left: Send again sends it to the host. */}
          <MessageBubble
            message={bubbles.notSent}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onDiscard={nothing}
            leftRoom={["Wren"]}
            retryLabel={t("message.retry.host", { name: "Scout" })}
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
            rows={withLiveTurn(
              buildTimeline(team.entries[`bot:${ids.scout}`] ?? []),
              liveTurn(team.bots.scout),
            )}
            room={null}
            workSteps={workSteps}
            submitting={notSubmitting}
            intents={timelineIntents}
            turnBot={{ bot: team.bots.scout, lastEntry: null }}
          />
        </div>
      </Labeled>
      <Labeled label="A room: each speaker named above their messages">
        <div className="max-w-(--layout-text-column)">
          <Timeline
            rows={buildTimeline(team.entries[`room:${ids.newsletter}`] ?? [])}
            room={team.room}
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
      <Labeled label="Question: pending (tap an option), recommended and destructive options, a form of radio buttons, checkboxes and text, answered, dismissed, expired, refused">
        <div className="flex flex-col gap-3">
          {variants.questions.map((entry) => (
            <QuestionCard key={entry.id} entry={entry} onAnswer={nothing} onDismiss={nothing} />
          ))}
        </div>
      </Labeled>
      <Labeled label="Approval: a whole command, indentation kept; one with the reason it asks; a summary only, with no grant for the session; a file change, its path above the coloured diff; a file read; a decision on its way; allowed; denied; expired; refused">
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

/** Scout in each state a turn under way can be in, from the sample's `now`. */
const turnStates = (() => {
  const ago = (seconds: number) =>
    DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - seconds * 1000);
  const as = (state: Bot["state"]): Bot => ({ ...team.bots.scout, state });
  const running = variants.folds[0];
  return [
    {
      name: "thinking",
      bot: as({ _tag: "thinking", since: ago(7), stalled: false, quietSince: null }),
      fold: null,
    },
    {
      name: "working",
      bot: as({
        _tag: "working",
        since: ago(72),
        stalled: false,
        quietSince: null,
        activity: "pnpm test billing",
        tool: null,
      }),
      fold: running?.entry ?? null,
    },
    {
      name: "waiting",
      bot: as({ _tag: "waiting", entryId: EntryId.make("variant-approval"), since: ago(134) }),
      fold: running?.entry ?? null,
    },
    {
      name: "stalled",
      bot: as({
        _tag: "working",
        since: ago(1220),
        stalled: true,
        quietSince: ago(780),
        activity: null,
        tool: null,
      }),
      fold: running?.entry ?? null,
    },
    {
      name: "past an hour",
      bot: as({
        _tag: "working",
        since: ago(3723),
        stalled: false,
        quietSince: null,
        activity: null,
        tool: "browser",
      }),
      fold: running?.entry ?? null,
    },
  ] as const;
})();

function WorkSection() {
  return (
    <Section title="A turn's work">
      <Labeled label="Under way: thinking before any step, working on a step (its steps open), waiting on the operator, stalled, past an hour">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          {turnStates.map(({ name, bot, fold }) => (
            <WorkFold
              key={name}
              fold={fold}
              live={{ bot, lastEntry: null }}
              steps={fold === null ? null : (variants.folds[0]?.steps ?? null)}
              onOpenChange={nothing}
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="Folded: running with no turn seen, finished, loading its steps, stopped, failed">
        <div className="flex flex-col gap-2">
          {variants.folds.map(({ entry, steps, open }) => (
            <WorkFold
              key={entry.id}
              fold={entry}
              live={null}
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
      <Labeled label="A kind from a newer server">
        <NeedsUpdateLine />
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
  mentionable,
}: {
  initial: string;
  recipient: string;
  files?: ReadonlyArray<DraftFile>;
  sending?: boolean;
  /** The device could not keep the draft yet. */
  notSaved?: boolean;
  /** Text another tab replaced, on offer. */
  replaced?: string | null;
  /** In a room, its members and its host. */
  mentionable?: { readonly members: ReadonlyArray<MentionCandidate>; readonly hostId: BotId };
}) {
  const i18n = useI18n();
  const draftKey = useId();
  const [value, setValue] = useState(initial);
  const [mentions, setMentions] = useState<ReadonlyArray<DraftMention>>([]);
  const addressee =
    mentionable === undefined
      ? null
      : addresseeLine(
          addresseeOf(
            addressed(
              value,
              mentions,
              mentionable.members.map((member) => member.id),
            )?.mentions ?? null,
            mentionable.hostId,
            (botId) => mentionable.members.find((member) => member.id === botId)?.name,
            i18n,
          ),
          i18n,
        );
  const [files, setFiles] = useState(initialFiles);
  const [replaced, setReplaced] = useState(initialReplaced);
  return (
    <Composer
      draftKey={draftKey}
      recipient={recipient}
      value={value}
      mentions={mentions}
      onValueChange={(text, picked) => {
        setValue(text);
        setMentions(picked);
      }}
      files={files}
      sending={sending}
      notSaved={notSaved}
      onAttachFiles={nothing}
      onDetachFile={(key) => setFiles((current) => current.filter((file) => file.key !== key))}
      onSend={() => {
        setValue("");
        setMentions([]);
      }}
      onDictate={nothing}
      {...(mentionable === undefined ? {} : { mentionable: mentionable.members })}
      {...(addressee === null ? {} : { addressee })}
      {...(replaced === null
        ? {}
        : {
            replaced: {
              revision: 1,
              onRestore: () => {
                setValue(replaced);
                setMentions([]);
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
      <Labeled label="Headers: a working bot (with Stop), a waiting bot (the line goes to the request), a blocked bot, a room with work under way (with Stop, which asks first), the same room while its work stops, a room at rest">
        <div className="flex flex-col gap-2">
          {(
            [
              { key: "working", subject: { _tag: "bot", bot: team.bots.scout } },
              { key: "waiting", subject: { _tag: "bot", bot: team.bots.atlas } },
              { key: "blocked", subject: { _tag: "bot", bot: team.bots.ledger } },
              { key: "room", subject: { _tag: "room", room: team.room } },
              { key: "room-stopping", subject: { _tag: "room", room: stoppingRoom } },
              { key: "room-resting", subject: { _tag: "room", room: restingRoom } },
            ] as const
          ).map(({ key, subject }) => (
            <div key={key} className="rounded-md border border-border">
              <ConversationHeader
                subject={subject}
                detailsOpen={false}
                onToggleDetails={nothing}
                onBack={nothing}
                onStop={nothing}
                onGoToWaiting={nothing}
                folds={[]}
                stopShortcut={shortcuts.stop}
                onAnnounce={nothing}
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
  shareTemplate: nothing,
};

const roomIntents = {
  editRoom: nothing,
  archiveRoom: () => Promise.resolve(),
  unarchiveRoom: () => Promise.resolve(),
  deleteRoom: nothing,
};

/** The sample room after deleting bots left it with one: archived, with no host. */
const archivedRoom: Room = {
  id: team.room.id,
  name: team.room.name,
  hopLimit: team.room.hopLimit,
  pinned: false,
  createdAt: team.room.createdAt,
  status: "archived",
  members: [team.bots.scout.id],
  hostId: null,
  archivedAt: SAMPLE_NOW,
};

function Pane({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[40rem] w-(--layout-details-width) max-w-full flex-col overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}

/** A run that started `minutesAgo` before SAMPLE_NOW and took a minute, unless it is still going. */
const sampleRun = (
  minutesAgo: number,
  status: RoutineRun["status"],
  change: Partial<RoutineRun> = {},
): RoutineRun => ({
  id: RoutineRunId.make(`gallery-run-${minutesAgo}`),
  startedAt: DateTime.subtract(SAMPLE_NOW, { minutes: minutesAgo }),
  finishedAt:
    status === "running" ? null : DateTime.subtract(SAMPLE_NOW, { minutes: minutesAgo - 1 }),
  status,
  attempts: status === "skipped" ? 0 : 1,
  delivered: status === "delivered" ? [EntryId.make(`gallery-said-${minutesAgo}`)] : [],
  note: null,
  ...change,
});

/** Every way a run can end, newest first, as the price watch's history could show them. */
const sampleRuns: ReadonlyArray<RoutineRun> = [
  sampleRun(2, "running"),
  sampleRun(353, "delivered"),
  sampleRun(24 * 60 + 353, "silent", {
    note: "No price dropped: the three bikes cost what they did yesterday.",
  }),
  sampleRun(2 * 24 * 60 + 353, "failed", {
    attempts: 3,
    failure: { _tag: "permission-mode-refused", permissionMode: "full-access", allowed: "auto" },
  }),
  sampleRun(3 * 24 * 60 + 353, "failed", { attempts: 2 }),
  sampleRun(3 * 24 * 60 + 354, "skipped"),
  // Monday's 08:47 run started at 10:47: J3 Bots wasn't running at 08:47.
  sampleRun(4 * 24 * 60 + 233, "delivered", {
    dueAt: DateTime.subtract(SAMPLE_NOW, { minutes: 4 * 24 * 60 + 353 }),
  }),
  sampleRun(8 * 24 * 60 + 353, "delivered"),
];

function DetailsSection() {
  const { scout, moss, atlas } = team.bots;
  const priceWatch = team.routines[scout.id]?.[0] ?? null;
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
            bot={atlas}
            routines={team.routines[atlas.id] ?? []}
            memory={team.memory[atlas.id] ?? []}
            files={team.files[atlas.id] ?? []}
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
          <RoutineRunList
            routine={priceWatch}
            runs={{
              _tag: "ready",
              value: { runs: sampleRuns, hasOlder: true },
              stale: false,
            }}
          />
        </Pane>
        <Pane>
          <BotDetails
            bot={scout}
            routines={null}
            memory={null}
            files={null}
            modelName="Claude Code · Claude Sonnet 5.5"
            intents={detailsIntents}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          <RoutineRunList routine={priceWatch} runs={null} />
        </Pane>
        <Pane>
          <RoomDetails room={team.room} intents={roomIntents} onClose={nothing} />
        </Pane>
        <Pane>
          <RoomDetails room={archivedRoom} intents={roomIntents} onClose={nothing} />
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
          title="Profile"
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

/** A template as a research bot's share would make it, for both of its sheets. */
const scoutTemplate: BotTemplate = {
  format: TEMPLATE_FORMAT,
  version: TEMPLATE_VERSION,
  profile: {
    name: "Scout",
    title: "Research",
    avatar: team.bots.scout.profile.avatar,
    job: "Finds sources on what I ask about, reads them, and sends a short summary with links. Never buys or signs up for anything.",
  },
  model: toCodex,
  permissionMode: "full-access",
  skills: [
    {
      name: "source-check",
      text: "---\nname: source-check\ndescription: How to judge a source before quoting it.\n---\n\n1. Prefer the primary source.\n2. Note the date; older than a year needs saying so.\n3. Two independent sources before calling something settled.\n",
    },
    {
      name: "weekly-digest",
      text: "---\nname: weekly-digest\ndescription: The shape of the Friday digest.\n---\n\nThree items at most, one line each, a link under each.\n",
    },
  ],
  routines: [
    {
      name: "Friday digest",
      instruction:
        "Read what was saved this week and send a digest of at most three items. Send nothing if nothing was saved.",
      trigger: { _tag: "schedule", cron: "0 16 * * 5" },
    },
    {
      name: "New paper",
      instruction: "Summarize the paper the webhook names in three lines and send it.",
      trigger: { _tag: "webhook" },
    },
  ],
};

/** A template's sheet as the dialog holds it, in a frame the size of a sheet. */
function TemplateFrame({
  label,
  children,
}: {
  label: string;
  children: (titleId: string) => ReactNode;
}) {
  const titleId = useId();
  return (
    <Frame label={label} width={400} height={760}>
      <div className="flex h-full flex-col bg-background">{children(titleId)}</div>
    </Frame>
  );
}

const shareActions = {
  onRetry: nothing,
  onDownload: nothing,
  onCopy: () => Promise.resolve(true),
  onClose: nothing,
};

function TemplatesSection() {
  const elsewhere = { ...scoutTemplate, model: { ...toCodex, modelId: ModelId.make("gpt-6") } };
  return (
    <Section title="Templates: sharing a bot and creating one from a file">
      <div className="flex flex-wrap gap-4">
        <TemplateFrame label="Share: what the file holds, before it leaves">
          {(titleId) => (
            <ShareTemplateContent
              share={{ _tag: "ready", template: scoutTemplate }}
              titleId={titleId}
              {...shareActions}
            />
          )}
        </TemplateFrame>
        <TemplateFrame label="Share: the template could not be read">
          {(titleId) => (
            <ShareTemplateContent
              share={{ _tag: "failed", name: "Scout" }}
              titleId={titleId}
              {...shareActions}
            />
          )}
        </TemplateFrame>
        <TemplateFrame label="Share: the file would be too large to read">
          {(titleId) => (
            <ShareTemplateContent
              share={{
                _tag: "too-large",
                name: "Scout",
                error: new TemplateTooLarge({
                  size: 1_210_000,
                  largest: { _tag: "skill", name: "source-review" },
                }),
              }}
              titleId={titleId}
              {...shareActions}
            />
          )}
        </TemplateFrame>
        <TemplateFrame label="Create: the mode it asks for is capped by the default">
          {(titleId) => (
            <TemplateForm
              template={scoutTemplate}
              engine={twoProviders}
              connected
              onCreate={() => new Promise(() => {})}
              onClose={nothing}
              titleId={titleId}
            />
          )}
        </TemplateFrame>
        <TemplateFrame label="Create: its model is not on this server">
          {(titleId) => (
            <TemplateForm
              template={elsewhere}
              engine={twoProviders}
              connected
              onCreate={() => new Promise(() => {})}
              onClose={nothing}
              titleId={titleId}
            />
          )}
        </TemplateFrame>
      </div>
    </Section>
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
        <MemoryVariant label="Memory: reading" reading={{ _tag: "reading" }} />
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

/** The room form as the dialog holds it, in a frame the size of a sheet. */
function RoomFormVariant({
  label,
  ...props
}: { label: string } & Partial<Omit<RoomFormProps, "titleId">>) {
  const titleId = useId();
  return (
    <Frame label={label} width={400} height={720}>
      <div className="h-full bg-background">
        <RoomForm
          mode={{ _tag: "create" }}
          bots={bots}
          defaultHopLimit={team.settings.budgets.hops}
          connected
          onSubmit={() => new Promise(() => {})}
          onClose={nothing}
          titleId={titleId}
          {...props}
        />
      </div>
    </Frame>
  );
}

const roomMembers: ReadonlyArray<MentionCandidate> = team.room.members.flatMap((id) => {
  const bot = bots.find((candidate) => candidate.id === id);
  return bot ? [{ id, name: bot.profile.name, avatar: bot.profile.avatar }] : [];
});

/** The mention list as it opens above the composer, for `query` typed after `@`. */
function MentionVariant({
  label,
  query,
  active,
}: {
  label: string;
  query: string;
  active: number;
}) {
  const listId = useId();
  return (
    <Labeled label={label}>
      <div className="relative h-56 max-w-72">
        <MentionList
          id={listId}
          options={mentionOptions(query, roomMembers)}
          members={roomMembers}
          active={active}
          optionId={(index) => `${listId}-${index}`}
          onPick={nothing}
        />
      </div>
    </Labeled>
  );
}

function RoomsSection() {
  const { scout, wren, juniper } = team.bots;
  return (
    <Section title="Rooms: the room form and mentions">
      <div className="flex flex-wrap gap-4">
        <RoomFormVariant label="New room: empty; pick bots and the host follows them, then Create to see what is missing" />
        <RoomFormVariant
          label="New room: the server refused the bots, one of them deleted meanwhile"
          initial={{
            name: "Launch week",
            members: [scout.id, wren.id],
            hostPick: null,
            hopLimit: "",
          }}
          initialFailure={{ _tag: "refused", error: new Invalid({ reason: "room-members" }) }}
        />
        <RoomFormVariant
          label="Edit: as saved"
          mode={{ _tag: "edit", room: team.room, gone: false }}
        />
        <RoomFormVariant
          label="Edit: the room was archived meanwhile, offline"
          mode={{ _tag: "edit", room: team.room, gone: false }}
          connected={false}
          initial={{
            name: team.room.name,
            members: [juniper.id, scout.id],
            hostPick: juniper.id,
            hopLimit: "2",
          }}
          initialFailure={{ _tag: "refused", error: new Conflict({ reason: "room-archived" }) }}
        />
        <RoomFormVariant
          label="Unarchive: a room left with one bot"
          mode={{ _tag: "unarchive", room: archivedRoom, gone: false }}
        />
        <RoomFormVariant
          label="Edit: the room was deleted while the form was open; it stays open and saves nothing"
          mode={{ _tag: "edit", room: team.room, gone: true }}
        />
      </div>
      <div className="flex flex-wrap gap-6">
        <MentionVariant
          label="Mentions: after @, every member and @everyone, the second one active"
          query=""
          active={1}
        />
        <MentionVariant label="Mentions: after @w, the members it matches" query="w" active={0} />
        <MentionVariant label="Mentions: after @ev, only everyone" query="ev" active={0} />
      </div>
      <Labeled label="Composer in a room: type @ to open the list; arrows, Enter, Tab and Escape work, and so does a tap. Only a pick mentions; the line under it says who the message wakes">
        <div className="max-w-(--layout-text-column) pt-60">
          <ComposerDemo
            initial=""
            recipient={team.room.name}
            mentionable={{ members: roomMembers, hostId: team.room.hostId }}
          />
        </div>
      </Labeled>
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

const engines = {
  starting: null,
  // As the server sends them: no provider is reported before the engine runs.
  engineStarting: { ...team.engine, state: { _tag: "starting" }, providers: [] },
  downloading: {
    ...team.engine,
    state: { _tag: "starting", install: { receivedBytes: 42_400_000, totalBytes: 180_200_000 } },
    providers: [],
  },
  downloadingNoTotal: {
    ...team.engine,
    state: { _tag: "starting", install: { receivedBytes: 42_400_000, totalBytes: null } },
    providers: [],
  },
  down: { ...team.engine, state: { _tag: "unavailable", reason: "down" } },
  portInUse: { ...team.engine, state: { _tag: "unavailable", reason: "port-in-use" } },
  installFailed: { ...team.engine, state: { _tag: "unavailable", reason: "install-failed" } },
  credentialRefused: {
    ...team.engine,
    state: { _tag: "unavailable", reason: "credential-refused" },
  },
  incompatible: { ...team.engine, state: { _tag: "incompatible", runningVersion: "0.1.8" } },
  checking: {
    ...team.engine,
    providers: team.engine.providers.map((p, index) => ({
      ...p,
      status:
        index === 0
          ? ({ _tag: "unavailable", checking: true } as const)
          : ({ _tag: "sign-in-required", command: "j3-bots provider connect" } as const),
    })),
  },
  connect: {
    ...team.engine,
    providers: team.engine.providers.map((p) => ({
      ...p,
      status: { _tag: "sign-in-required", command: "j3-bots provider connect" } as const,
    })),
  },
  noModels: {
    ...team.engine,
    providers: team.engine.providers.map((p, index) => ({
      ...p,
      status:
        index === 0
          ? ({ _tag: "ready" } as const)
          : ({ _tag: "unavailable", checking: false } as const),
      models: [],
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
          : ({ _tag: "unavailable", checking: false } as const),
    })),
  },
} as const;

/** The sample engine with Codex signed in again and Claude Code's windows changed by `windows`. */
const usageEngine = (
  windows: (usage: ReadonlyArray<UsageWindow>) => ReadonlyArray<UsageWindow>,
  claudeStatus: ProviderStatus["status"] = { _tag: "ready" },
): EngineStatus => ({
  ...team.engine,
  providers: team.engine.providers.map((p, index) =>
    index === 0
      ? { ...p, status: claudeStatus, usage: windows(p.usage) }
      : { ...p, status: { _tag: "ready" } },
  ),
});

/** Claude Code's window at `index` at its limit. */
const atLimit = (index: number) => (usage: ReadonlyArray<UsageWindow>) =>
  usage.map((w, i) => (i === index ? { ...w, usedPercent: 100 } : w));

const usageEngines = {
  /** Claude Code at its five-hour limit; Codex reporting no limit. */
  atLimit: usageEngine(atLimit(0), {
    _tag: "limited",
    resetsAt: team.engine.providers[0]?.usage[0]?.resetsAt ?? null,
  }),
  /** One model's weekly window at its limit: the provider still runs its other models. */
  modelAtLimit: usageEngine(atLimit(2)),
  /** The five-hour window full when last checked, its reset since passed. */
  resetPassed: usageEngine((usage) =>
    usage.map((w, i) =>
      i === 0
        ? { ...w, usedPercent: 100, resetsAt: DateTime.subtract(SAMPLE_NOW, { minutes: 3 }) }
        : w,
    ),
  ),
  /** Through a provider connection: no provider reports a window. */
  noWindows: usageEngine(() => []),
  /** Every provider signed out, reporting no window. */
  signedOut: {
    ...engines.connect,
    providers: engines.connect.providers.map((p) => ({ ...p, usage: [] })),
  },
};

/** The day's turns, read and current. */
const turnsRead = (
  value: RecentTurns,
  extra: Partial<Omit<RecentTurnsState, "read">> & { readonly stale?: boolean } = {},
): RecentTurnsState => ({
  read: { _tag: "ready", value, stale: extra.stale ?? false },
  loadingMore: extra.loadingMore ?? false,
  failed: extra.failed ?? false,
});

/** The day's latest turns, with earlier ones of the day on the server. */
const firstPage: RecentTurns = {
  ...team.recentTurns,
  turns: team.recentTurns.turns.slice(0, 9),
  hasMore: true,
  canLoadMore: true,
};

/** The sample's names, made long enough to wrap on a phone. */
const longNames = {
  roster: team.roster.map((item) =>
    item._tag === "bot" && item.bot.id === ids.atlas
      ? {
          ...item,
          bot: {
            ...item.bot,
            profile: { ...item.bot.profile, name: "Atlas, keeper of the release notes" },
          },
        }
      : item,
  ),
  turns: {
    ...team.recentTurns,
    turns: team.recentTurns.turns.map((turn) =>
      turn.routine?._tag === "routine"
        ? {
            ...turn,
            routine: { ...turn.routine, name: `${turn.routine.name} for every open branch` },
          }
        : turn,
    ),
  },
};

function EngineSettingsSection() {
  return (
    <Section title="Settings: the engine">
      <div className="flex flex-wrap gap-4">
        <Frame label="Downloading, on the first start" width={420} height={160}>
          <EngineSection engine={engines.downloading} stale={false} />
        </Frame>
        <Frame label="Downloading, with no size known" width={420} height={160}>
          <EngineSection engine={engines.downloadingNoTotal} stale={false} />
        </Frame>
        <Frame label="Starting, once downloaded" width={420} height={160}>
          <EngineSection engine={engines.engineStarting} stale={false} />
        </Frame>
        <Frame label="The download failed" width={420} height={160}>
          <EngineSection engine={{ ...engines.installFailed, providers: [] }} stale={false} />
        </Frame>
      </div>
    </Section>
  );
}

function UsageGallerySection() {
  const usage = (
    engine: EngineStatus | null,
    recent: RecentTurnsState,
    { engineStale = false, roster = team.roster } = {},
  ) => (
    <UsageSection
      engine={engine}
      engineStale={engineStale}
      recent={recent}
      roster={roster}
      onLoadMore={nothing}
      onRetry={nothing}
    />
  );
  return (
    <Section title="Usage">
      <div className="flex flex-wrap gap-4">
        <Frame label="Limits and the day's turns, by provider and bot" width={420} height={640}>
          {usage(team.engine, turnsRead(team.recentTurns))}
        </Frame>
        <Frame
          label="More turns than one read: the latest, and the oldest shown"
          width={420}
          height={520}
        >
          {usage(team.engine, turnsRead(firstPage))}
        </Frame>
        <Frame label="Loading earlier turns" width={420} height={520}>
          {usage(team.engine, turnsRead(firstPage, { loadingMore: true }))}
        </Frame>
        <Frame label="The most turns shown" width={420} height={520}>
          {usage(team.engine, turnsRead({ ...firstPage, canLoadMore: false }))}
        </Frame>
        <Frame label="A provider at its limit; another reports none" width={420} height={640}>
          {usage(usageEngines.atLimit, turnsRead(team.recentTurns))}
        </Frame>
        <Frame label="One model at its weekly limit" width={420} height={640}>
          {usage(usageEngines.modelAtLimit, turnsRead(team.recentTurns))}
        </Frame>
        <Frame label="A reset passed since the last check" width={420} height={640}>
          {usage(usageEngines.resetPassed, turnsRead(team.recentTurns))}
        </Frame>
        <Frame
          label="No provider reports limits, as through a provider connection"
          width={420}
          height={520}
        >
          {usage(usageEngines.noWindows, turnsRead(team.recentTurns))}
        </Frame>
        <Frame label="Offline: limits and turns last known" width={420} height={640}>
          {usage(team.engine, turnsRead(team.recentTurns, { stale: true }), { engineStale: true })}
        </Frame>
        <Frame label="Turns loading" width={420} height={320}>
          {usage(team.engine, turnsNotRead)}
        </Frame>
        <Frame label="The turns couldn't be read" width={420} height={320}>
          {usage(team.engine, { ...turnsNotRead, failed: true })}
        </Frame>
        <Frame label="Earlier turns couldn't be read" width={420} height={520}>
          {usage(team.engine, turnsRead(firstPage, { failed: true }))}
        </Frame>
        <Frame label="Long names on a phone" width={320} height={640}>
          {usage(team.engine, turnsRead(longNames.turns), { roster: longNames.roster })}
        </Frame>
        <Frame label="The engine isn't running" width={420} height={120}>
          {usage(engines.down, turnsRead(team.recentTurns))}
        </Frame>
        <Frame label="No provider can run bots yet" width={420} height={200}>
          {usage(usageEngines.signedOut, turnsRead({ ...team.recentTurns, turns: [] }))}
        </Frame>
      </div>
    </Section>
  );
}

/** A bot just created: its first turn has started and nothing is in its conversation yet. */
const speakingFirst = {
  ...team.bots.moss,
  state: { _tag: "thinking", since: SAMPLE_NOW, stalled: false, quietSince: null },
  opening: true,
} as const;

/** A bot just created on a provider not connected yet: its hello waits for it. */
const waitingFirst = { ...team.bots.moss, opening: true } as const;

/** The first run at `step`, as a phone shows it, with the engine `engine`. */
function FirstRunAt({
  step,
  engine = team.engine,
  providerSetup,
}: {
  step: OnboardingStep;
  engine?: EngineStatus | null;
  providerSetup?: LocalProviderSetup;
}) {
  return (
    <Onboarding
      engine={engine}
      initialStep={step}
      initialName="Nova"
      {...(providerSetup === undefined ? {} : { providerSetup })}
      onCreate={() => Promise.resolve({ _tag: "done", value: ids.scout })}
      onArrived={arrived}
    />
  );
}

const arrived = () => {};

function FirstRunSection() {
  return (
    <Section title="First run">
      <div className="flex flex-wrap gap-4">
        <Frame label="Welcome" width={390} height={760}>
          <FirstRunAt step="welcome" />
        </Frame>
        <Frame label="The first bot's name, with a default" width={390} height={760}>
          <FirstRunAt step="name" />
        </Frame>
        <Frame label="Its look; with a provider, this step creates it" width={390} height={760}>
          <FirstRunAt step="look" />
        </Frame>
        <Frame label="No provider connected: one command, live" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.connect} />
        </Frame>
        <Frame label="The engine still checking its providers" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.checking} />
        </Frame>
        <Frame label="No provider can run a bot" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.unusable} />
        </Frame>
        <Frame label="The engine downloading, on the first start" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.downloading} />
        </Frame>
        <Frame label="A download that doesn't say its size" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.downloadingNoTotal} />
        </Frame>
        <Frame label="The engine not running" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.down} />
        </Frame>
        <Frame label="A provider connected while the step is read" width={390} height={760}>
          <FirstRunAt step="connect" />
        </Frame>
        <Frame label="The arrival, saying hello" width={390} height={760}>
          <FirstRunAt step="arrival" />
        </Frame>
        <Frame label="The arrival, before a provider is connected" width={390} height={760}>
          <FirstRunAt step="arrival" engine={engines.connect} />
        </Frame>
        <Frame label="The whole first run, live, with a provider" width={390} height={760}>
          <ShellFrame initial={null} firstRun />
        </Frame>
        <Frame label="The whole first run, live, with no provider" width={390} height={760}>
          <ShellFrame initial={null} firstRun engine={engines.connect} />
        </Frame>
      </div>
    </Section>
  );
}

/** Where the sample server finds each harness. */
const harnessesFound = {
  both: [
    { harness: "claude-code", path: "/usr/local/bin/claude" },
    { harness: "codex", path: "/usr/local/bin/codex" },
  ],
  claudeOnly: [
    { harness: "claude-code", path: "/usr/local/bin/claude" },
    { harness: "codex", path: null },
  ],
  none: [
    { harness: "claude-code", path: null },
    { harness: "codex", path: null },
  ],
} as const satisfies Record<string, ReadonlyArray<HarnessLocation>>;

/** The providers set up from the app on this computer, with the harnesses `found` and each sign-in as `signIns`. */
const localSetup = (
  found: ReadonlyArray<HarnessLocation>,
  signIns: ReadonlyArray<readonly [SignInHarness, SignInView]> = [],
): LocalProviderSetup => ({
  signIns: new Map(signIns),
  signIn: () => {},
  cancelSignIn: () => {},
  harnesses: () => Promise.resolve(found),
  connectEndpoint: () => Promise.resolve({ _tag: "work-running", bots: 2 } as const),
});

const signInPage = "https://example.com/oauth/authorize";

function LocalFirstRunSection() {
  return (
    <Section title="First run on this computer">
      <div className="flex flex-wrap gap-4">
        <Frame label="Both harnesses found: sign in with either" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
        <Frame label="Only Claude Code found" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.claudeOnly)}
          />
        </Frame>
        <Frame label="Waiting for the browser" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["claude-code", { _tag: "waiting-for-browser", url: signInPage, opened: false }],
            ])}
          />
        </Frame>
        <Frame
          label="A harness that needs a terminal: an endpoint instead"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["claude-code", { _tag: "failed", reason: "needs-terminal" }],
            ])}
          />
        </Frame>
        <Frame label="Signed in, while an endpoint stays connected" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["claude-code", { _tag: "succeeded", endpoint: "https://proxy.example.com" }],
            ])}
          />
        </Frame>
        <Frame label="Timed out, with the other still to try" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["codex", { _tag: "failed", reason: "timed-out" }],
            ])}
          />
        </Frame>
        <Frame label="Neither harness installed" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.none)}
          />
        </Frame>
        <Frame label="Settings: where the harnesses are, and signing in" width={420} height={420}>
          <EngineSection
            engine={engines.connect}
            stale={false}
            providerSetup={localSetup(harnessesFound.claudeOnly)}
          />
        </Frame>
        <Frame label="Settings: one provider ready, the other to sign in" width={420} height={420}>
          <EngineSection
            engine={team.engine}
            stale={false}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
      </div>
    </Section>
  );
}

function FirstRunWideSection() {
  return (
    <Section title="First run on a wide window" stacked>
      <div className="flex flex-col gap-6">
        <Frame label="Wide, live, with a provider" width={1280} height={760}>
          <ShellFrame initial={null} firstRun />
        </Frame>
        <Frame label="Wide, live, with no provider" width={1280} height={760}>
          <ShellFrame initial={null} firstRun engine={engines.connect} />
        </Frame>
      </div>
    </Section>
  );
}

function EmptyStatesSection() {
  return (
    <Section title="Empty states">
      <div className="flex flex-wrap gap-4">
        <Frame label="Nothing selected" width={340} height={360}>
          <NoSelection nextShortcut={shortcuts.nextBot.label} />
        </Frame>
        <Frame label="A quiet conversation" width={340} height={360}>
          <QuietConversation bot={team.bots.moss} engine={team.engine} />
        </Frame>
        <Frame label="A new bot, about to speak first" width={340} height={360}>
          <QuietConversation bot={speakingFirst} engine={team.engine} />
        </Frame>
        <Frame
          label="A new bot whose provider is not connected: its hello waits"
          width={340}
          height={420}
        >
          <QuietConversation bot={waitingFirst} engine={engines.connect} />
        </Frame>
        <Frame label="A quiet room" width={340} height={360}>
          <QuietRoom room={team.room} />
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
          height={760}
        >
          <Pairing
            reason="new"
            defaultName="Chrome on Android"
            address="http://192.0.2.10:3737"
            onPair={refused({ _tag: "invalid-code" })}
          />
        </Frame>
        <Frame
          label="Pairing: opened from a QR code, its code filled in (any code is refused as wrong)"
          width={390}
          height={760}
        >
          <Pairing
            reason="new"
            defaultName="Safari on iPhone"
            initialCode={PairingCode.make("7KQ2M9XH4D")}
            address="http://192.0.2.10:3737"
            onPair={refused({ _tag: "invalid-code" })}
          />
        </Frame>
        <Frame
          label="Pairing: signed out elsewhere (any code meets the lockout)"
          width={390}
          height={760}
        >
          <Pairing
            reason="signed-out"
            defaultName="Safari on iPhone"
            address="https://j3.example.test"
            onPair={refused({
              _tag: "rate-limited",
              retryAt: lockedUntil,
            })}
          />
        </Frame>
        <Frame
          label="Pairing: signed out here without reaching the server"
          width={390}
          height={760}
        >
          <Pairing
            reason="still-listed"
            defaultName="Firefox on Linux"
            address="http://192.0.2.10:3737"
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
  engine,
}: {
  initial: RosterItemKey | null;
  details?: boolean;
  firstRun?: boolean;
  engine?: EngineStatus;
}) {
  const source = useSampleSource(engine === undefined ? { firstRun } : { firstRun, engine });
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
