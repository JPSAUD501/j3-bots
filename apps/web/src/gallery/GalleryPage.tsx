// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every component in every state, in both themes, from the sample team. A
 * development tool for reviewing the design, so its own headings are not
 * translated; everything it shows is.
 */
import {
  AttachmentId,
  type AvatarChoice,
  BotId,
  type BotTemplate,
  Conflict,
  type Connector,
  EffortLevel,
  type EngineStatus,
  type Entry,
  EntryId,
  EntryOrder,
  type EntryTarget,
  Invalid,
  LANGUAGES,
  type MessageQuote,
  type Language,
  MemoryPath,
  MemoryRevision,
  ModelId,
  type Notification,
  type NotificationKind,
  type PairBotIds,
  pairBotIds,
  PairingCode,
  ProviderId,
  type ProviderStatus,
  type Bot,
  type BrowserTabRef,
  type MessageEntry,
  type Room,
  RoomId,
  type RosterItem,
  type RosterItemKey,
  type TurnWork,
  type WorkFoldEntry,
  type RoutineRun,
  ServerOrigin,
  type Skill,
  type SuggestedReply,
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
  TemplateTooLarge,
  RoutineRunId,
  type HarnessLocation,
  type SignInHarness,
  type UsageWindow,
} from "@j3-bots/contracts";
import type {
  LocalPairingLink,
  LocalServerState,
  LookingAtSettings,
  PhoneAccess,
  RecordingCheck,
  ServerUpdate,
  UseThisComputerResult,
} from "@j3-bots/desktop-bridge";
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
  themeColorVariables,
  typeScale,
  type Spring,
  type Themed,
  type TypeInput,
} from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { WhatsNewPage, WhatsNewSection } from "../components/WhatsNew";
import {
  type CSSProperties,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isHidden,
  turnsNotRead,
  type DraftFile,
  type DraftMention,
  type PairingFailure,
  type RecentTurns,
  type RecentTurnsState,
  type Revealed,
  type RoutineCardCommand,
  type SettingsSaves,
  type SignInView,
} from "@j3-bots/client-runtime";
import {
  type AvatarPoke,
  avatarSeed,
  avatarStates,
  buildTimeline,
  type ConnectorsPlace,
  EVERYONE,
  latestOfLine,
  liveTurn,
  teammatesOf,
  withLiveTurn,
  mentionOptions,
  type OnboardingStep,
  readThrough,
  rowOrder,
  type SettingsPage,
  type ThemeChoice,
  themeChoices,
  themePalettes,
  withComment,
  withQuote,
} from "@j3-bots/client-runtime/presentation";
import { themeName } from "@j3-bots/client-runtime/wording";
import { Dialog } from "@base-ui/react/dialog";
import {
  AiSessionProvider,
  type QuickMessageState,
  type SignInRoute,
  useProfileEdits,
} from "@j3-bots/client-runtime/react";
import { ClockProvider, OperatorTimeZone } from "../app/clock";
import { QuickAccess } from "../quick/QuickAccess";
import type { Level } from "../record/level";
import { Pill, type PillProps } from "../record/Pill";
import { type Microphone, RecordSheetBody, type RecordSheetBodyProps } from "../record/RecordSheet";
import type { PictureChip, WindowChipsView } from "../quick/WindowChips";
import { I18nProvider, RosterProvider, useI18n } from "../app/context";
import { DocumentsProvider } from "../components/documents/documents";
import { DocumentPane } from "../components/documents/DocumentViewer";
import { MessageFile } from "../components/FileCard";
import { AttachmentImagesProvider } from "../components/attachmentImages";
import { ApprovalCard } from "../components/ApprovalCard";
import { ConnectorAuthCard } from "../components/connectors/ConnectorCards";
import { ConnectorAskCard } from "../components/connectors/ConnectorAskCard";
import { ConnectorInputCard } from "../components/connectors/ConnectorInputCard";
import { ConnectorsScreen } from "../components/connectors/ConnectorsDialog";
import { AvatarPicker } from "../components/avatar/AvatarPicker";
import { type AvatarHandle, BotAvatar, RoomAvatar } from "../components/avatar/BotAvatar";
import {
  Composer,
  focusAtEnd,
  type MentionCandidate,
  type MentionChoices,
  MentionList,
} from "../components/Composer";
import { conversationChoicesOf } from "../components/mentionChoices";
import { ConversationHeader } from "../components/ConversationHeader";
import { BotDetails, RoomDetails } from "../components/DetailsPanel";
import { ConnectionBanner, type LocalLine } from "../components/ConnectionBanner";
import {
  ConnectInstead,
  LocalServerFailed,
  LocalServerFailedBody,
  LocalSignIn,
  MovedAwayScreen,
  StoppingLocal,
  StopUsingComputer,
  WhereBotsLive,
} from "../components/LocalMode";
import { ServerAddress } from "../components/ServerAddress";
import type { DesktopPhone, DesktopSystem } from "../shell/data";
import { SettingsButton } from "../components/SettingsButton";
import {
  LookingAtSetting,
  SettingsPanel,
  UpdatesSection,
  WhereSection,
} from "../components/SettingsDialog";
import {
  type Pairing as PhonePairing,
  PairPhone,
  PhoneAccessSetting,
} from "../components/PhoneAccess";
import { EditBotForm, type EditBotFormProps } from "../components/EditBotDialog";
import { NewBotForm } from "../components/NewBotForm";
import { dialogTitle } from "../components/ui/dialog";
import { NoSelection, QuietConversation, QuietRoom } from "../components/EmptyStates";
import { Onboarding } from "../onboarding/Onboarding";
import { EventLine } from "../components/EventLine";
import { MemoryFile, type MemoryFileProps } from "../components/MemoryViewer";
import { MessageBubble } from "../components/MessageBubble";
import { OpenQuote, QuoteCommentEditor } from "../components/Quotes";
import { NeedsUpdateLine, NoticeLine } from "../components/NoticeLine";
import { Incompatible, Pairing, StorageFailed } from "../components/Pairing";
import { LaunchUpdate } from "../components/LaunchUpdate";
import { UpdatePromptPanel, type UpdatePromptView } from "../components/UpdatePrompt";
import { VisualTheme } from "../components/VisualCard";
import { QuestionCard } from "../components/QuestionCard";
import { RoomForm, type RoomFormProps } from "../components/RoomDialog";
import { Roster } from "../components/Roster";
import { Backstage, SectionBlock, useFoldedSections } from "../components/RosterGroups";
import type { RosterIntents, RosterMenuContext } from "../components/RosterMenu";
import { AnsweringLine } from "../components/AnsweringLine";
import { RoomWork } from "../components/RoomWork";
import { RosterRow } from "../components/RosterRow";
import { PrimaryBadge } from "../components/avatar/PrimaryBadge";
import { RoutineRunList } from "../components/RoutineRuns";
import { RoutineTrack, RoutineTrackWindow } from "../components/RoutineTrack";
import {
  playedTrack,
  sampleTrackCommand,
  trackMoments,
  trackName,
  trackOwner,
  trackRoutine,
  trackRuns,
  trackSteps,
  trackEventTrigger,
  trackTrigger,
} from "./sampleRoutineTrack";
import { BotCard, QuickMessageField } from "../components/BotCard";
import { BrowserHelpCard } from "../components/BrowserHelpCard";
import { SecretRequestCard } from "../components/SecretRequestCard";
import { ShareTemplateContent, TemplateForm } from "../components/TemplateDialogs";
import { type QuoteDrafting, Timeline, type TimelineIntents } from "../components/Timeline";
import { ConnectorsSection, EngineSection } from "../components/SettingsDialog";
import type { LocalProviderSetup } from "../components/ProviderSetup";
import { UsageSection } from "../components/UsageSection";
import { SecretAskCard } from "../components/SecretAskCard";
import { SecretsSection } from "../components/secrets/SecretsSection";
import { WorkFold } from "../components/WorkFold";
import type { DictationSource } from "../components/Dictation";
import { VoiceSection } from "../components/VoiceSettings";
import { sampleDictation, sampleVoice } from "./sampleVoice";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Confirm } from "../components/ui/confirm";
import { lineField, textField } from "../components/ui/field";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Switch } from "../components/ui/switch";
import { LANGUAGE_NAMES, notificationText } from "@j3-bots/i18n";
import { cn } from "../lib/cn";
import { iconUrl, notificationIcon } from "../live/notificationIcon";
import type {
  DesktopLocal,
  DesktopUpdate,
  DiagnosticsIntents,
  RemoteServerUpdate,
} from "../shell/data";
import { PrivacySection } from "../components/Privacy";
import { DiagnosticsSheet, type DiagnosticsSheetState } from "../components/Diagnostics";
import { rosterIntents } from "../shell/rosterIntents";
import { Shell } from "../shell/Shell";
import { shellShortcuts } from "../shell/shortcuts";
import { SAMPLE_NOW, ids, sampleEfforts, sampleTeam } from "./sample";
import {
  longPlan,
  playedHandOff,
  playedRoom,
  playedTurn,
  type PlayedBeat,
  sampleLittleOnes,
  samplePlan,
  unnamedLittleOne,
} from "./sampleWork";
import {
  sampleAskingAppRef,
  sampleConnectorAppAccess,
  sampleConnectorAppRef,
} from "./sampleConnectorApps";
import { AppStageProvider, type StagedFrom } from "../components/AppStage";
import {
  connectorsHolder,
  sampleConnectors,
  sampleConnectorsIntents,
  sampleOwnAppSetup,
} from "./sampleConnectors";
import { sampleSkills, sampleSkillsIntents } from "./sampleSkills";
import { sampleCardIntents, sampleProviderActions, useSampleSource } from "./sampleSource";
import { sampleThemeLibrary, sampleThemesIntents } from "./sampleThemes";
import { ThemeForm, ThemeSettings } from "../components/ThemeSettings";
import { ShownThemesProvider } from "../themes/ThemeRuntime";
import { sampleSentEvents } from "./usageData";
import { SentPanel } from "../components/UsageData";
import { useSampleSecrets } from "./sampleSecrets";
import { ordered, withOwnReaction } from "./entries";
import { galleryVariants } from "./variants";
import { galleryImage } from "./workImages";
import { SAMPLE_DOCUMENTS, sampleDocumentBytes } from "./sampleDocuments";
import {
  appPhases,
  appUpdate,
  endedDone,
  laterEntry,
  promptViews,
  SAMPLE_NEXT,
  SAMPLE_NIGHTLY,
  said,
  serverStatuses,
  serverUpdate,
  serverViews,
  whatsNewViews,
} from "./updates";

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
  work: "none",
  forceStop: false,
  answering: [],
};
/** The sample room while the server ends its work. */
const stoppingRoom: Room = { ...team.room, work: "stopping", answering: [] };
/** The room's Stop, which a member's AI ignores. */
const forceStopRoom: Room = { ...team.room, work: "stopping", answering: [], forceStop: true };
const shortcuts = shellShortcuts();
/** The type scale's two sets: the one a page shows depends on its pointer, so both are drawn. */
const typeInputs: ReadonlyArray<TypeInput> = ["pointer", "touch"];

/**
 * What the address asks to see alone: one section (`?section=first-run`), in
 * it one frame by its label (`&frame=Welcome`), and the language it starts in
 * (`&lang=pt-BR`). So one state can be looked at, measured or captured without
 * the rest of the gallery moving on the page.
 */
const only = (() => {
  const asked = new URLSearchParams(window.location.search);
  const lang = asked.get("lang");
  return {
    section: asked.get("section"),
    frame: asked.get("frame"),
    locale: LANGUAGES.find((language) => language === lang) ?? "en",
  };
})();

export default function GalleryPage() {
  const [locale, setLocale] = useState<Language>(only.locale);
  return (
    <I18nProvider locale={locale}>
      <ClockProvider now={SAMPLE_NOW}>
        <OperatorTimeZone timeZone={team.settings.timeZone}>
          <RosterProvider roster={team.roster} engine={team.engine}>
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
                <BotCardSection />
                <RosterOrganizeSection />
                <BubblesSection />
                <ReactionsSection />
                <QuotesSection />
                <RecordOfferSection />
                <ScreenRecordingSection />
                <DocumentsSection />
                <CardsSection />
                <RoutineTracksSection />
                <WorkSection />
                <ConnectorAppsSection />
                <PlanAndLittleOnesSection />
                <NoticesSection />
                <ComposerSection />
                <DetailsSection />
                <ConnectorsGallerySection />
                <EditingSection />
                <TemplatesSection />
                <RoomsSection />
                <SettingsPagesSection />
                <ThemesSection />
                <EngineSettingsSection />
                <SecretsGallerySection />
                <UsageGallerySection />
                <PrivacyGallerySection />
                <FirstRunSection />
                <LocalFirstRunSection />
                <FirstRunWideSection />
                <EmptyStatesSection />
                <ConnectionSection />
                <WhereBotsLiveSection />
                <PhoneAccessSection />
                <UpdatesGallerySection />
                <QuickAccessSection />
                <ShellSection />
              </div>
            </div>
          </RosterProvider>
        </OperatorTimeZone>
      </ClockProvider>
    </I18nProvider>
  );
}

/** A section's place in the page's address, from its title: "First run" is `#first-run`. */
const anchor = (title: string) => title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

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
  if (only.section !== null && only.section !== anchor(title)) return null;
  return (
    <section id={anchor(title)} className="flex scroll-mt-4 flex-col gap-3">
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
              <VisualTheme value={theme}>
                {typeof children === "function" ? children(theme) : children}
              </VisualTheme>
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

/** Every look the gallery's lively rows draw from. */
const looks = avatarShapeNames.flatMap((shape, row) =>
  botColors.map((color, column) => ({ shape, color, order: (row * 7 + column * 5) % 144 })),
);
const lookAt = (index: number): AvatarChoice => {
  const look = looks.toSorted((a, b) => a.order - b.order)[index % looks.length];
  return look === undefined ? avatarCast[0] : { shape: look.shape, color: look.color };
};

/**
 * Avatars alive, to try by hand: the eye follows the pointer only from close
 * by, a press holds the bot down, and a tap gets an answer. The buttons ask
 * all of them at once for what the app asks one of.
 */
function AliveAvatars() {
  const handles = useRef(new Map<number, AvatarHandle>());
  const [entrance, setEntrance] = useState(0);
  const all = (poke: AvatarPoke) => {
    for (const handle of handles.current.values()) handle.poke(poke);
  };
  const tapAll = () => {
    all("press");
    all("tap");
  };
  return (
    <div data-gallery-block="alive" className="flex flex-col gap-4">
      <div key={entrance} className="flex flex-wrap items-end gap-x-10 gap-y-6 pt-16 pb-2">
        {[96, 96, 64, 40, 40, 24].map((size, index) => (
          <BotAvatar
            key={`${size}-${index === 1 ? "b" : index === 4 ? "d" : "a"}`}
            ref={(handle) => {
              if (handle === null) return;
              handles.current.set(index, handle);
              return () => {
                handles.current.delete(index);
              };
            }}
            avatar={lookAt(index * 13 + 2)}
            seed={`alive-${index}`}
            state="idle"
            size={size}
            entrance={entrance > 0 && { delay: index * 120 }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button data-gallery="alive-tap" onClick={tapAll}>
          Tap them all
        </Button>
        <Button
          variant="ghost"
          data-gallery="alive-enter"
          onClick={() => setEntrance(entrance + 1)}
        >
          Bring them in
        </Button>
        <Button variant="ghost" onClick={() => all("cheer")}>
          Good news
        </Button>
      </div>
    </div>
  );
}

/** A bot the gallery makes on the spot, as the roster's row `count`. */
const madeBot = (count: number): RosterItem => {
  const look = lookAt(count * 7 + 3);
  const names = ["Nora", "Leo", "Ruby", "Owen", "Ellie", "Sam", "Jack", "Maya"];
  return {
    _tag: "bot",
    bot: {
      ...team.bots.moss,
      id: BotId.make(`made-${count}`),
      primary: false,
      profile: {
        ...team.bots.moss.profile,
        name: names[count % names.length] ?? "Nora",
        avatar: look,
      },
    },
    lastEntry: null,
    lastActivityAt: DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) + count * 1000),
    unread: false,
  };
};

/** A room the gallery makes on the spot, of the sample team's bots. */
const madeRoom = (count: number): RosterItem => ({
  _tag: "room",
  room: {
    ...restingRoom,
    id: RoomId.make(`made-room-${count}`),
    name: ["Launch week", "Reading group", "Trip to Lisbon"][count % 3] ?? "Launch week",
    members: [bots[count % bots.length], bots[(count + 3) % bots.length]].flatMap((bot) =>
      bot === undefined ? [] : [bot.id],
    ),
  },
  lastEntry: null,
  lastActivityAt: DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) + count * 1000),
  unread: false,
});

/** A roster of `items`, at its width beside a conversation, that only shows them. */
function PlainRoster({ items }: { items: ReadonlyArray<RosterItem> }) {
  const folded = useFoldedSections(null);
  return (
    <RosterProvider roster={[...team.roster, ...items]} engine={team.engine}>
      <div className="flex h-full flex-col bg-sidebar">
        <Roster
          items={items}
          sections={null}
          selected={null}
          rowLink={() => rowButton(nothing)}
          pairs={[]}
          selectedPair={null}
          pairLink={() => rowButton(nothing)}
          pairIntents={quietPairIntents}
          onNewBot={nothing}
          onNewFromTemplate={nothing}
          onNewRoom={nothing}
          intents={quietIntents}
          folded={folded}
        />
      </div>
    </RosterProvider>
  );
}

/**
 * Bots and rooms coming into the roster and leaving it: each button is what
 * the server tells a client when someone, the operator or a bot, makes or
 * deletes one.
 */
function RosterComings() {
  const [made, setMade] = useState<ReadonlyArray<RosterItem>>([]);
  const [count, setCount] = useState(0);
  const add = (item: RosterItem) => {
    setMade([...made, item]);
    setCount(count + 1);
  };
  const base = team.roster.filter((item) => item._tag === "bot" && !item.bot.hidden).slice(0, 4);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-border bg-background p-2">
        <Button size="sm" data-gallery="roster-bot" onClick={() => add(madeBot(count))}>
          New bot
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-gallery="roster-room"
          onClick={() => add(madeRoom(count))}
        >
          New room
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-gallery="roster-remove"
          onClick={() => setMade(made.slice(0, -1))}
        >
          Delete the newest
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <PlainRoster items={[...base, ...made]} />
      </div>
    </div>
  );
}

/** A full roster, every bot idle and alive: what the frame loop is measured against. */
const fullRoster: ReadonlyArray<RosterItem> = Array.from({ length: 40 }, (_, index) =>
  madeBot(index),
);

function MotionSection() {
  return (
    <Section title="Motion">
      <Labeled label="Alive: bring the pointer close to one (its eye follows within about two of its own widths, and lets go by three); press and hold; tap, and tap again">
        <AliveAvatars />
      </Labeled>
      <div className="flex flex-wrap gap-4">
        <Frame
          label="Entering the roster and leaving it: a bot, a room with its members' faces"
          width={340}
          height={520}
          replay
        >
          <RosterComings />
        </Frame>
        <Frame label="A full roster, forty bots, live" width={340} height={720}>
          <PlainRoster items={fullRoster} />
        </Frame>
      </div>
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
  connector: kind === "connector" ? "sign-in" : null,
  browserHelp: kind === "browser-help" ? { reason: "login", site: "tickets.example.com" } : null,
});

/**
 * One notification of each kind, from bots in different states (Otto is idle
 * when he asks; Ledger is blocked), and one from a room.
 */
const sampleNotifications: ReadonlyArray<Notification> = [
  sampleNotification("message", ids.scout),
  sampleNotification("question", ids.otto),
  sampleNotification("approval", ids.atlas),
  sampleNotification("secret-request", ids.iris),
  sampleNotification("browser-help", ids.otto),
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
  const profileOf = (id: BotId) =>
    team.roster.flatMap((row) =>
      row._tag === "bot" && row.bot.id === id ? [row.bot.profile] : [],
    )[0];
  const name = (id: BotId) => profileOf(id)?.name ?? null;
  const botTitle = (id: BotId) => profileOf(id)?.title ?? "";
  const roomName = (id: RoomId) =>
    team.roster.flatMap((row) =>
      row._tag === "room" && row.room.id === id ? [row.room.name] : [],
    )[0] ?? null;
  const text = notificationText(notification, { botName: name, botTitle, roomName }, i18n);
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

/** Maple with the longest title a bot takes, to show where a row cuts what. */
const longTitled = team.roster.flatMap((item) =>
  item._tag === "bot" && item.bot.id === ids.maple
    ? [
        {
          ...item,
          bot: {
            ...item.bot,
            profile: { ...item.bot.profile, title: "Competitor bakeries and their launches" },
          },
        },
      ]
    : [],
);

function RosterSection() {
  return (
    <Section title="Roster rows">
      <Labeled label="Each bot's name over its title, then its status line; a room, and Moss, a bot from before titles, in two lines">
        <ul className="flex w-(--layout-roster-width) max-w-full flex-col gap-px rounded-md bg-sidebar p-2">
          {team.roster.map((item, index) => (
            <li key={item._tag === "bot" ? item.bot.id : item.room.id}>
              <RosterRow item={item} selected={index === 0} memberAvatars={memberAvatars(item)} />
            </li>
          ))}
        </ul>
      </Labeled>
      <Labeled label="The longest title on a narrow roster: two lines at most, the status line cut first">
        <ul className="flex w-60 max-w-full flex-col gap-px rounded-md bg-sidebar p-2">
          {longTitled.map((item) => (
            <li key="long">
              <RosterRow item={item} selected={false} />
            </li>
          ))}
        </ul>
      </Labeled>
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
        pairs={source.data.pairs ?? []}
        selectedPair={null}
        pairLink={() => rowButton(nothing)}
        pairIntents={quietPairIntents}
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

const quietPairIntents = { talkTo: nothing, startRoom: nothing };

const quietIntents: RosterIntents = {
  placeBot: nothing,
  placeRoom: nothing,
  markRead: nothing,
  markUnread: nothing,
  createSection: () => Promise.resolve(null),
  updateSection: nothing,
  deleteSection: nothing,
  openDetails: nothing,
  shareTemplate: nothing,
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
// The sample's bot behind the scenes, and its room as it would be there.
const hiddenConversations = team.roster.flatMap((item) =>
  isHidden(item)
    ? [item]
    : item._tag === "room"
      ? [{ ...item, room: { ...item.room, hidden: true } }]
      : [],
);

/** A bot as its card shows it in each status, and a sample of the rest of the team for its own. */
const cardBots: ReadonlyArray<{ readonly label: string; readonly bot: Bot }> = [
  { label: "Working, by you", bot: team.bots.scout },
  {
    label: "Working, with little ones",
    bot: {
      ...team.bots.scout,
      state:
        team.bots.scout.state._tag === "working"
          ? { ...team.bots.scout.state, littleOnes: 2 }
          : team.bots.scout.state,
    },
  },
  { label: "Waiting for you", bot: team.bots.atlas },
  { label: "Free, made by another bot", bot: team.bots.wren },
  { label: "Paused by a usage limit", bot: team.bots.ledger },
  {
    label: "Stopped by a problem",
    bot: { ...team.bots.otto, state: { _tag: "blocked", failure: "unreachable", retryAt: null } },
  },
  { label: "No title and no job", bot: team.bots.moss },
  {
    label: "The longest title, in two lines",
    bot: {
      ...team.bots.wren,
      profile: { ...team.bots.wren.profile, title: "Competitor bakeries and their launches" },
    },
  },
];

/** Where a quick message stands, under its field. */
const quickStates: ReadonlyArray<{ readonly label: string; readonly state: QuickMessageState }> = [
  { label: "Sending", state: { _tag: "sending" } },
  { label: "Sent", state: { _tag: "sent" } },
  { label: "Not sent: it waits in the conversation", state: { _tag: "failed" } },
  { label: "Too long to send", state: { _tag: "invalid", problem: "too-long" } },
  { label: "The bot is gone", state: { _tag: "gone" } },
];

/** What only a frame of this label, or the whole section, shows. */
function Only({ label, children }: { label: string; children: ReactNode }) {
  if (only.frame !== null && only.frame !== label) return null;
  return <Labeled label={label}>{children}</Labeled>;
}

function BotCardSection() {
  const rooms = [team.room, restingRoom];
  const quietActions = {
    talk: nothing,
    startRoom: nothing,
    openRoutines: nothing,
    openDetails: nothing,
  };
  const send = () => Promise.resolve({ _tag: "done", value: EntryId.make("quick") } as const);
  return (
    <Section title="Bot card">
      <div className="flex flex-wrap items-start gap-4">
        {cardBots.map(({ label, bot }) => (
          <Only key={label} label={label}>
            <BotCard
              bot={bot}
              rooms={rooms}
              routines={team.routines[bot.id] ?? []}
              send={send}
              actions={quietActions}
            />
          </Only>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {quickStates.map(({ label, state }) => (
          <Only key={label} label={`Quick message: ${label}`}>
            <div className="w-80">
              <QuickMessageField
                name="Wren"
                quick={{ text: "", setText: nothing, state, submit: nothing }}
                onOpen={nothing}
              />
            </div>
          </Only>
        ))}
      </div>
    </Section>
  );
}

function RosterOrganizeSection() {
  return (
    <Section title="Organizing the roster">
      <Frame
        label="The pinned bots as large avatars, the primary one marked; rooms and the bots in no section; a section with bots, one with none yet; the row to what is behind the scenes. Right-click a row or tile, or its “…”, for its menu"
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
      <Frame
        label="Behind the scenes: a bot and a room, each with Bring back to the list"
        width={340}
        height={240}
      >
        <div className="h-full bg-sidebar p-2">
          <Backstage
            items={hiddenConversations}
            selected={null}
            rowLink={() => rowButton(nothing)}
            onBack={nothing}
            onBringBack={nothing}
          />
        </div>
      </Frame>
    </Section>
  );
}

const timelineIntents: TimelineIntents = {
  answerQuestion: nothing,
  routineCard: nothing,
  dismissQuestion: nothing,
  decideApproval: nothing,
  provideSecret: nothing,
  declineSecret: nothing,
  answerBrowserHelp: nothing,
  openBrowser: nothing,
  declineSecretAsk: nothing,
  retryNotice: nothing,
  retryMessage: nothing,
  react: nothing,
  openWorkFold: nothing,
  openAttachment: nothing,
  openWorkImage: nothing,
  openRoutine: nothing,
  openConversation: nothing,
  signInConnector: nothing,
  answerConnectorInput: nothing,
  openConnectorPage: nothing,
  connectorAskSetup: sampleOwnAppSetup,
  allowConnectorAsk: nothing,
  declineConnectorAsk: nothing,
  connectorApp: sampleConnectorAppAccess,
  resendMessage: nothing,
  discardMessage: nothing,
  closeWorkFold: nothing,
};

const workSteps = (entryId: string) => team.workSteps[entryId] ?? null;

/** Every gallery entry is held: a quoted one shows at once, or was deleted since. */
const revealIn =
  (entries: ReadonlyArray<Entry>) =>
  (entryId: string): Promise<Revealed> =>
    Promise.resolve(entries.some((entry) => entry.id === entryId) ? "shown" : "missing");
const notSubmitting = () => false;

/** The connector apps' samples quote nothing, and offer no Reply or Quote. */
const appSampleQuotes = { reveal: revealIn([]), drafting: null };

function BubblesSection() {
  const gallerySecrets = useSampleSecrets({ state: "ready", now: () => SAMPLE_NOW });
  const { bubbles, visualBubbles, escapingVisual, embeddingVisual } = variants;
  const { t } = useI18n();
  return (
    <Section title="Bubbles">
      <Labeled label="Single bubbles, with no tightened corner: the operator, the operator from quick access with the window they wrote over, queued, cancelled, refused, perhaps delivered, being sent again, on its way from this device, not sent from it, answered with no record on this device, a bot with code, a bot with files, a bot with a picture, shown as a photo">
        <div className="flex flex-col gap-2">
          <MessageBubble
            message={bubbles.operator}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={bubbles.lookingAt}
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
          {/* In a room, refused because the member it mentions left: Send again sends it to the room. */}
          <MessageBubble
            message={bubbles.notSent}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onDiscard={nothing}
            refusedMentions={{ _tag: "left-room", names: ["Wren"] }}
            retryLabel={t("message.retry.room")}
          />
          {/* In a bot's conversation, refused because the room it mentions was archived since. */}
          <MessageBubble
            message={bubbles.notSent}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onDiscard={nothing}
            refusedMentions={{ _tag: "not-mentionable", names: [team.room.name] }}
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
          <GalleryDocuments>
            <MessageBubble
              message={bubbles.withFiles}
              position="single"
              onOpenAttachment={nothing}
              onRetry={nothing}
            />
          </GalleryDocuments>
          <AttachmentImagesProvider fetch={galleryImage}>
            <MessageBubble
              message={bubbles.withPhoto}
              position="single"
              onOpenAttachment={nothing}
              onRetry={nothing}
            />
          </AttachmentImagesProvider>
        </div>
      </Labeled>
      <Labeled label="Mentions in a room: each member's a chip with its face on a tint of its color, in the operator's bubble and in another bot's; @everyone and a deleted bot's name in the bubble's own text">
        <MentionBubbles />
      </Labeled>
      <Labeled label="Mentions in a bot's conversation: another bot as its chip, a room it is in as a chip with the room's mark on a neutral fill. In the app, a tap on either opens what it names">
        <ConversationMentionBubble />
      </Labeled>
      <Labeled label="A bot's visuals, each above its message: a chart, a table and a diagram">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          {visualBubbles.map((visualMessage) => (
            <MessageBubble
              key={visualMessage.id}
              message={visualMessage}
              position="single"
              onOpenAttachment={nothing}
              onRetry={nothing}
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="A visual that tries to get out of its frame: the client's storage and API, the window around it, a popup, the network, a peer connection, a frame of its own and spoofed messages; Leave takes its frame elsewhere, and Hang never ends">
        <div className="max-w-(--layout-text-column)">
          <MessageBubble
            message={escapingVisual}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="A visual that embeds another page, which a client never shows">
        <div className="max-w-(--layout-text-column)">
          <MessageBubble
            message={embeddingVisual}
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
            secrets={gallerySecrets}
            turnBot={{ bot: team.bots.scout, lastEntry: null }}
            onOpenPair={nothing}
            onOpenRoom={nothing}
            onOpenBot={nothing}
            quotes={{
              reveal: revealIn(team.entries[`bot:${ids.scout}`] ?? []),
              drafting: null,
            }}
            recordScreen={null}
          />
        </div>
      </Labeled>
      <Labeled label="A room: each speaker named over their messages, their face beside the last">
        <div className="max-w-(--layout-text-column)">
          <Timeline
            rows={buildTimeline(team.entries[`room:${ids.newsletter}`] ?? [])}
            room={team.room}
            workSteps={workSteps}
            submitting={notSubmitting}
            intents={timelineIntents}
            secrets={gallerySecrets}
            onOpenPair={nothing}
            onOpenRoom={nothing}
            onOpenBot={nothing}
            quotes={{
              reveal: revealIn(team.entries[`room:${ids.newsletter}`] ?? []),
              drafting: null,
            }}
            recordScreen={null}
          />
        </div>
      </Labeled>
    </Section>
  );
}

function ReactionsSection() {
  const { reactions } = variants;
  return (
    <Section title="Reactions">
      <Labeled label="Under a message, a bot's and the operator's: one pill per emoji, a count past one, the operator's own marked. Hover a pill for who reacted, a deleted bot among them; hover a message for React. Clicking your pill takes it off, another sets that emoji as yours">
        <ReactingBubbles />
      </Labeled>
      <Frame
        label="React open: the quick reactions, the operator's 🎉 marked, then More"
        width={420}
        height={150}
        replay
      >
        <div className="flex h-full flex-col justify-end p-4">
          <MessageBubble
            message={reactions.onBot}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onReact={nothing}
            reactionView="quick"
          />
        </div>
      </Frame>
      <Frame label="More open: every reaction, by group" width={420} height={470} replay>
        <div className="flex h-full flex-col justify-end p-4">
          <MessageBubble
            message={reactions.onBot}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            onReact={nothing}
            reactionView="picker"
          />
        </div>
      </Frame>
      <Labeled label="After taking off your 🎉: two left, and the pill no longer marked">
        <MessageBubble
          message={reactions.removed}
          position="single"
          onOpenAttachment={nothing}
          onRetry={nothing}
          onReact={nothing}
        />
      </Labeled>
    </Section>
  );
}

function RecordOfferSection() {
  const { recordOffer } = variants;
  return (
    <Section title="A bot's offer to record the screen">
      <Labeled label="In the desktop app and its quick access: Record your screen under the bot's message, which opens the recorder">
        <div className="max-w-(--layout-text-column)">
          <MessageBubble
            message={recordOffer}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            recordScreen={{ _tag: "here", record: nothing }}
          />
        </div>
      </Labeled>
      <Labeled label="In a browser, which cannot record: a quiet line saying to open the app on the computer">
        <div className="max-w-(--layout-text-column)">
          <MessageBubble
            message={recordOffer}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
            recordScreen={{ _tag: "elsewhere" }}
          />
        </div>
      </Labeled>
    </Section>
  );
}

/** A microphone's level held still, so every frame draws the same bars. */
const heldLevel: Level = { open: () => ({ read: () => 0.55, close: () => undefined }) };

/** What the sheet hears from the app on each system, as it first opens. */
const sheetChecks = {
  firstMac: {
    input: "everything",
    passwords: "hidden",
    screen: "needed",
    keys: "needed",
    space: "enough",
    busy: false,
  },
  windows: {
    input: "everything",
    passwords: "hidden",
    screen: "not-needed",
    keys: "not-needed",
    space: "enough",
    busy: false,
  },
  x11LowSpace: {
    input: "everything",
    passwords: "pause",
    screen: "not-needed",
    keys: "not-needed",
    space: "low",
    busy: false,
  },
  wayland: {
    input: "screen-and-voice",
    passwords: "pause",
    screen: "not-needed",
    keys: "not-needed",
    space: "enough",
    busy: false,
  },
} as const satisfies Record<string, RecordingCheck>;

const sheetMicrophones: ReadonlyArray<Microphone> = [
  { id: "mic-built-in", label: "MacBook Pro Microphone" },
  { id: "mic-headset", label: "USB Headset" },
];

function SheetFrame({
  label,
  height,
  ...props
}: { label: string; height: number } & Partial<Omit<RecordSheetBodyProps, "titleId">>) {
  const titleId = useId();
  return (
    <Frame label={label} width={448} height={height}>
      <div className="flex h-full flex-col gap-4 bg-surface p-5">
        <RecordSheetBody
          titleId={titleId}
          recipient={team.bots.scout.profile.name}
          check={sheetChecks.windows}
          microphones={sheetMicrophones}
          microphone="default"
          level={heldLevel}
          microphoneFailed={false}
          countdown={null}
          problem={null}
          onMicrophone={nothing}
          onAskAccess={nothing}
          onStart={nothing}
          onClose={nothing}
          {...props}
        />
      </div>
    </Frame>
  );
}

function PillFrame({ label, ...props }: { label: string } & Partial<PillProps>) {
  const { scout } = team.bots;
  return (
    <Frame label={label} width={320} height={64}>
      <div className="p-2">
        <Pill
          face={{ avatar: scout.profile.avatar, seed: scout.id }}
          phase="recording"
          level={heldLevel}
          space="enough"
          solid={false}
          onPause={nothing}
          onResume={nothing}
          onStop={nothing}
          onDiscard={nothing}
          {...props}
        />
      </div>
    </Frame>
  );
}

/** A recording's zip in the composer, on its way to the server. */
const recordingFile: DraftFile = {
  _tag: "uploading",
  key: "recording",
  name: "Screen recording 2026-11-20 14.32.zip",
  mediaType: "application/zip",
  size: 412_000_000,
  sent: 150_000_000,
};

/** The same zip just after Stop, its voice being written down before it uploads. */
const transcribingFile: DraftFile = {
  _tag: "uploading",
  key: "recording",
  name: "Screen recording 2026-11-20 14.32.zip",
  mediaType: "application/zip",
  size: 412_000_000,
  sent: 0,
  transcribing: 0.4,
};

function ScreenRecordingSection() {
  const scoutName = team.bots.scout.profile.name;
  const draftKey = useId();
  return (
    <Section title="Recording the screen">
      <Labeled label="In the desktop app, + offers files and Record your screen. Elsewhere it opens the file picker, as before">
        <div className="max-w-(--layout-text-column) pt-28">
          <Composer
            draftKey={draftKey}
            recipient={scoutName}
            value=""
            onValueChange={nothing}
            onAttachFiles={nothing}
            onRecordScreen={nothing}
            addMenuOpen
            onSend={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="The sheet before recording: what is recorded and where it goes, the microphone with its level live, then Start">
        <div className="flex flex-wrap gap-4">
          <SheetFrame label="Windows: everything, a password kept as typed" height={470} />
          <SheetFrame
            label="macOS the first time: its permissions, until they are given"
            height={600}
            check={sheetChecks.firstMac}
          />
          <SheetFrame
            label="X11 with a nearly full disk: pause before a password"
            height={520}
            check={sheetChecks.x11LowSpace}
            microphone="mic-headset"
          />
          <SheetFrame
            label="Wayland: the screens and the voice only"
            height={470}
            check={sheetChecks.wayland}
          />
          <SheetFrame
            label="A microphone it cannot open, and no voice picked after"
            height={500}
            microphoneFailed
            level={null}
          />
          <SheetFrame label="Counting down" height={230} countdown={2} />
        </div>
      </Labeled>
      <Labeled label="The floating control: the bot listening, a red dot, the voice's level, Discard, Pause and Stop; paused; a nearly full disk; in a room; saving">
        <div className="flex flex-wrap gap-4">
          <PillFrame label="Recording" />
          <PillFrame label="Paused" phase="paused" />
          <PillFrame label="Recording, the disk nearly full" space="low" />
          <PillFrame label="In a room, with no voice" face={null} level={null} />
          <PillFrame label="Saving" phase="finishing" />
        </div>
      </Labeled>
      <Labeled label="Stopped: the recording's zip in the composer, its voice being written down first (hover for how far), then uploading">
        <div className="max-w-(--layout-text-column)">
          <ComposerDemo initial="" recipient={scoutName} files={[transcribingFile]} />
        </div>
      </Labeled>
      <Labeled label="Uploading, once its transcript is in it, or it goes without one">
        <div className="max-w-(--layout-text-column)">
          <ComposerDemo initial="" recipient={scoutName} files={[recordingFile]} />
        </div>
      </Labeled>
    </Section>
  );
}

function QuotesSection() {
  const { quotes } = variants;
  const scoutName = team.bots.scout.profile.name;
  return (
    <Section title="Reply and quote">
      <Labeled label="Try it: hover a message for Reply, or select part of one's text for Quote. The composer gathers what you quote, and a sent message's card goes to its source and lights it">
        <QuotingDemo />
      </Labeled>
      <Labeled label="Composer replying: the reply as a chip inside the field, above the text: the reply arrow, Scout's face, the start of the message on one line, and Cancel reply">
        <div className="max-w-(--layout-text-column)">
          <ComposerDemo initial="" recipient={scoutName} quotes={[quotes.replyToScout]} />
        </div>
      </Labeled>
      <Labeled label="Composer with two passages quoted, each a chip inside the field with its quote mark, its author's face, the passage on one line, the pencil for a comment, and a way out; the first commented">
        <div className="max-w-(--layout-text-column)">
          <ComposerDemo initial="Let’s do this" recipient={scoutName} quotes={quotes.commented} />
        </div>
      </Labeled>
      <Labeled label="A comment being written, over a chip's pencil or by a selection's Quote: optional, Enter saves">
        <div className="w-fit rounded-lg border border-border bg-surface shadow-overlay">
          <QuoteCommentEditor
            passage="test ride on Saturday at 10"
            initial="Can we move this to 11?"
            saveLabel="Save"
            onSave={nothing}
            onCancel={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="Sent: a reply to Scout's message, a message quoting two passages, and a passage with the operator's comment under it; each quote a quiet block at the top of its bubble, with no colored bar">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          <MessageBubble
            message={quotes.reply}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={quotes.twoPassages}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
          <MessageBubble
            message={quotes.commentedSent}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="In a room: Wren replies to Juniper's draft">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          <MessageBubble
            message={quotes.roomReply}
            position="single"
            speaker={ids.wren}
            tint={team.bots.wren.profile.avatar}
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="The source a card went to, lit: a ring that shows and fades, without moving">
        <div className="max-w-(--layout-text-column)">
          <MessageBubble
            message={quotes.source}
            position="single"
            tint={team.bots.scout.profile.avatar}
            onOpenAttachment={nothing}
            onRetry={nothing}
            sourceLit
          />
        </div>
      </Labeled>
      <Frame
        label="A reply whose message was deleted since: its card says so once tapped"
        width={420}
        height={130}
        replay
      >
        <MissingSource message={quotes.missing} />
      </Frame>
    </Section>
  );
}

/** A reply whose source is gone, its card tapped as it shows. */
function MissingSource({ message }: { readonly message: (typeof variants)["quotes"]["missing"] }) {
  const own = useRef<HTMLDivElement>(null);
  useEffect(() => {
    own.current?.querySelector("button")?.click();
  }, []);
  return (
    <div ref={own} className="flex h-full flex-col justify-end p-4">
      <OpenQuote value={() => Promise.resolve("missing")}>
        <MessageBubble
          message={message}
          position="single"
          onOpenAttachment={nothing}
          onRetry={nothing}
        />
      </OpenQuote>
    </div>
  );
}

/** Scout's news, Wren's note and the operator's reply, over a composer that takes what they quote. */
function QuotingDemo() {
  const gallerySecrets = useSampleSecrets({ state: "ready", now: () => SAMPLE_NOW });
  const { quotes } = variants;
  const entries = ordered([quotes.source, quotes.wrenNote, quotes.reply]);
  const draftKey = useId();
  const field = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [drafted, setDrafted] = useState<ReadonlyArray<MessageQuote>>([]);
  const drafting: QuoteDrafting = {
    drafted,
    quote: (quote) => {
      const next = withQuote(drafted, quote);
      if (next === "full") return;
      setDrafted(next);
      focusAtEnd(field.current);
    },
    comments: true,
  };
  return (
    <div className="flex max-w-(--layout-text-column) flex-col gap-3">
      <Timeline
        rows={buildTimeline(entries)}
        room={null}
        workSteps={workSteps}
        submitting={notSubmitting}
        intents={timelineIntents}
        secrets={gallerySecrets}
        onOpenPair={nothing}
        onOpenRoom={nothing}
        onOpenBot={nothing}
        quotes={{ reveal: revealIn(entries), drafting }}
        recordScreen={null}
      />
      <Composer
        draftKey={draftKey}
        recipient={team.bots.scout.profile.name}
        value={value}
        onValueChange={setValue}
        quotes={drafted}
        onUnquote={(index) => setDrafted((current) => current.toSpliced(index, 1))}
        onCommentQuote={(index, comment) =>
          setDrafted((current) => {
            const quote = current[index];
            return quote === undefined ? current : current.with(index, withComment(quote, comment));
          })
        }
        onSend={() => {
          setValue("");
          setDrafted([]);
        }}
        inputRef={field}
      />
    </div>
  );
}

/** A bot's message and the operator's, whose reactions change as the operator picks. */
function ReactingBubbles() {
  const { onBot, onOperator } = variants.reactions;
  const [botReactions, setBotReactions] = useState(onBot.reactions ?? []);
  const [operatorReactions, setOperatorReactions] = useState(onOperator.reactions ?? []);
  return (
    <div className="flex max-w-(--layout-text-column) flex-col gap-2">
      <MessageBubble
        message={{ ...onBot, reactions: botReactions }}
        position="single"
        onOpenAttachment={nothing}
        onRetry={nothing}
        onReact={(emoji) => setBotReactions((current) => withOwnReaction(current, emoji))}
      />
      <MessageBubble
        message={{ ...onOperator, reactions: operatorReactions }}
        position="single"
        onOpenAttachment={nothing}
        onRetry={nothing}
        onReact={(emoji) => setOperatorReactions((current) => withOwnReaction(current, emoji))}
      />
    </div>
  );
}

/** The gallery's documents, read as the server's would be, in the gallery's language. */
function GalleryDocuments({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  return (
    <DocumentsProvider key={locale} fetch={sampleDocumentBytes} locale={locale}>
      {children}
    </DocumentsProvider>
  );
}

const documentCards = [
  SAMPLE_DOCUMENTS.pdf,
  SAMPLE_DOCUMENTS.word,
  SAMPLE_DOCUMENTS.sheet,
  SAMPLE_DOCUMENTS.csv,
  SAMPLE_DOCUMENTS.markdown,
  SAMPLE_DOCUMENTS.text,
  SAMPLE_DOCUMENTS.slides,
  SAMPLE_DOCUMENTS.large,
  SAMPLE_DOCUMENTS.damaged,
  SAMPLE_DOCUMENTS.unreachable,
  SAMPLE_DOCUMENTS.loading,
];

const documentViews = [
  { label: "A PDF: its pages, drawn as they come into view", file: SAMPLE_DOCUMENTS.pdf },
  {
    label: "A Word document: headings, bold and italic, a numbered list, a table and a picture",
    file: SAMPLE_DOCUMENTS.word,
  },
  {
    label: "A spreadsheet: its sheets as tabs, dates and percentages in the reader's language",
    file: SAMPLE_DOCUMENTS.sheet,
  },
  { label: "A CSV file, with semicolons and a quoted field", file: SAMPLE_DOCUMENTS.csv },
  {
    label: "Markdown: headings, lists, a task list, a quote and a table",
    file: SAMPLE_DOCUMENTS.markdown,
  },
  { label: "Plain text", file: SAMPLE_DOCUMENTS.text },
  {
    label: "A presentation: each slide as its title, text and pictures",
    file: SAMPLE_DOCUMENTS.slides,
  },
  {
    label: "Couldn't open: no Word document inside, so it says why that may be and offers Save",
    file: SAMPLE_DOCUMENTS.damaged,
  },
  {
    label: "Too big: it unpacks past what a device reads, and offers Save",
    file: SAMPLE_DOCUMENTS.tooBig,
  },
  { label: "Out of reach: the server did not give its bytes", file: SAMPLE_DOCUMENTS.unreachable },
  { label: "Opening", file: SAMPLE_DOCUMENTS.loading },
] as const;

function DocumentsSection() {
  return (
    <Section title="Documents">
      <GalleryDocuments>
        <Labeled label="Cards in a conversation: each kind with the top of its first page or its first rows, and what it holds once read; a PDF too large to fetch for a card, one that cannot be read, one out of reach and one arriving">
          <div className="flex flex-wrap gap-2">
            {documentCards.map((file) => (
              <MessageFile key={file.id} attachment={file} onOpen={nothing} />
            ))}
          </div>
        </Labeled>
        {documentViews.map(({ label, file }) => (
          <Labeled key={file.id} label={`The viewer. ${label}`}>
            <div className="flex h-[30rem] flex-col overflow-hidden rounded-lg bg-viewer text-viewer-foreground">
              <DocumentPane attachment={file} onClose={nothing} onSave={nothing} />
            </div>
          </Labeled>
        ))}
      </GalleryDocuments>
    </Section>
  );
}

function CardsSection() {
  return (
    <Section title="Questions, approvals and credentials">
      <Labeled label="Question: pending (tap an option), recommended and destructive options, a form of radio buttons, checkboxes and text, a harness question larger than a card used to hold (headers, previews, five questions stacked), answered, dismissed, expired, refused">
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
      <Labeled label="A bot asks for a secret: a login, a value, either while the secrets can’t be read; saved, declined, expired">
        <AskCards />
      </Labeled>
      <Labeled label="Connector sign-in: pending, signed in, removed">
        <div className="flex flex-col gap-3">
          {variants.connectorAuths.map((entry) => (
            <ConnectorAuthCard key={entry.id} entry={entry} onSignIn={nothing} />
          ))}
        </div>
      </Labeled>
      <Labeled label="A service asks: a form, a page to open, answered, declined, no longer needed">
        <div className="flex flex-col gap-3">
          {variants.connectorInputs.map((entry) => (
            <ConnectorInputCard
              key={entry.id}
              entry={entry}
              onAnswer={nothing}
              onOpenPage={nothing}
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="A bot asks your yes to add a connector: an address in your own network, an app you register; added, declined, failed, closed without an answer">
        <div className="flex flex-col gap-3">
          {variants.connectorAsks.map((entry) => (
            <ConnectorAskCard
              key={entry.id}
              entry={entry}
              setup={sampleOwnAppSetup}
              onAllow={nothing}
              onDecline={nothing}
              onOpenPage={nothing}
            />
          ))}
        </div>
      </Labeled>
      <Labeled label="Credential: one value pending with a link, provided, declined, expired; a sign-in asking for an email and a password, pending, provided, declined, expired">
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
      <Labeled label="Help in the browser: a check, a sign-in, a step on no site; done, declined, the tab closed, expired">
        <div className="flex flex-col gap-3">
          {variants.browserHelps.map((entry) => (
            <BrowserHelpCard
              key={entry.id}
              entry={entry}
              onOpen={nothing}
              onDone={nothing}
              onDecline={nothing}
            />
          ))}
        </div>
      </Labeled>
    </Section>
  );
}

/** A bot's ask for a secret in each state, each with secrets of its own. */
function AskCards() {
  const ready = useSampleSecrets({ state: "ready", now: () => SAMPLE_NOW });
  const unreadable = useSampleSecrets({ state: "unreadable", now: () => SAMPLE_NOW });
  const [login, value, values, ...closed] = variants.asks;
  if (login === undefined || value === undefined || values === undefined) return null;
  return (
    <div className="flex flex-col gap-3">
      <SecretAskCard entry={login} secrets={ready} onDecline={nothing} />
      <SecretAskCard entry={value} secrets={ready} onDecline={nothing} />
      <SecretAskCard entry={values} secrets={ready} onDecline={nothing} />
      <SecretAskCard entry={value} secrets={unreadable} onDecline={nothing} />
      {closed.map((entry) => (
        <SecretAskCard key={entry.id} entry={entry} secrets={ready} onDecline={nothing} />
      ))}
    </div>
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
      bot: as({
        _tag: "thinking",
        since: ago(7),
        stalled: false,
        typing: false,
        retrying: false,
      }),
      fold: null,
    },
    {
      name: "typing",
      bot: as({
        _tag: "thinking",
        since: ago(3),
        stalled: false,
        typing: true,
        retrying: false,
      }),
      fold: null,
    },
    {
      name: "working",
      bot: as({
        _tag: "working",
        since: ago(72),
        stalled: false,
        typing: false,
        retrying: false,
        activity: "pnpm test billing",
        activityKind: "command",
        tool: null,
        littleOnes: 0,
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
        typing: false,
        retrying: false,
        activity: null,
        activityKind: null,
        tool: null,
        littleOnes: 0,
      }),
      fold: running?.entry ?? null,
    },
    {
      name: "retrying",
      bot: as({
        _tag: "working",
        since: ago(95),
        stalled: false,
        typing: false,
        retrying: true,
        activity: "pnpm test billing",
        activityKind: "command",
        tool: null,
        littleOnes: 0,
      }),
      fold: running?.entry ?? null,
    },
    {
      name: "past an hour",
      bot: as({
        _tag: "working",
        since: ago(3723),
        stalled: false,
        typing: false,
        retrying: false,
        activity: null,
        activityKind: null,
        tool: "browser",
        littleOnes: 0,
      }),
      fold: running?.entry ?? null,
    },
  ] as const;
})();

/** A reply with a connector's app in it: the operator's question, the app, what Scout said after. */
const appReplies = () => {
  const scout = { _tag: "bot", botId: ids.scout } as const;
  let order = 0;
  const said = (author: Entry["author"], minutes: number, text: string): Entry => ({
    _tag: "message",
    id: EntryId.make(`app-reply-${++order}`),
    order: EntryOrder.make(order),
    author,
    createdAt: minutesAgo(minutes),
    text,
    attachments: [],
    mentions: { _tag: "bots", ids: [] },
    delivery: { _tag: "delivered" },
    commandId: null,
    reactions: [],
  });
  const app = (ref: typeof sampleConnectorAppRef, minutes: number): Entry => ({
    _tag: "connector-app",
    id: EntryId.make(`app-reply-${++order}`),
    order: EntryOrder.make(order),
    author: scout,
    createdAt: minutesAgo(minutes),
    app: ref,
  });
  const asked = said({ _tag: "operator" }, 6, "Which of the three does the shop have in my size?");
  const shown = [
    asked,
    app(sampleConnectorAppRef, 5),
    said(scout, 5, "Only the Ridge 7 comes in M right now, and there are two."),
  ];
  const reply = said(scout, 1, "Held: the Ridge 7 in M waits for you until Saturday.");
  const earlier = [
    said({ _tag: "operator" }, 40, "Any news from the shop about the test ride?"),
    said(scout, 39, "Saturday at ten works for them. I put it in your calendar."),
    said({ _tag: "operator" }, 38, "Great, thanks."),
  ];
  return {
    shown: buildTimeline(shown),
    asking: buildTimeline([asked, app(sampleAskingAppRef, 5)]),
    // Full screen once the operator asked to hold it: Scout's answer shows over the app.
    withReply: buildTimeline([...shown, reply]),
    fullscreen: {
      viewId: sampleConnectorAppRef.viewId,
      mode: "fullscreen",
      since: readThrough(buildTimeline(shown).map(rowOrder)),
    } satisfies StagedFrom,
    scrolled: buildTimeline([...earlier, ...shown]),
    pinned: { viewId: sampleConnectorAppRef.viewId, mode: "pip", since: null } satisfies StagedFrom,
  };
};

/** A conversation in a frame, its area and its composer, with an app shown other than in the reply. */
function StagedConversation({
  rows,
  staged,
}: {
  rows: ReturnType<typeof buildTimeline>;
  staged: StagedFrom;
}) {
  const gallerySecrets = useSampleSecrets({ state: "ready", now: () => SAMPLE_NOW });
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div className="flex h-full flex-col bg-background">
      <div ref={setArea} className="relative flex min-h-0 flex-1 flex-col">
        <div ref={setScroller} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
          <div className="px-3 py-4">
            <AppStageProvider area={area} scroller={scroller} rows={rows} initial={staged}>
              <Timeline
                rows={rows}
                room={null}
                workSteps={workSteps}
                submitting={notSubmitting}
                intents={timelineIntents}
                secrets={gallerySecrets}
                onOpenPair={nothing}
                onOpenRoom={nothing}
                onOpenBot={nothing}
                quotes={appSampleQuotes}
                recordScreen={null}
              />
            </AppStageProvider>
          </div>
        </div>
      </div>
      <div className="px-3 pt-1 pb-3">
        <ComposerDemo initial="" recipient={team.bots.scout.profile.name} />
      </div>
    </div>
  );
}

function ConnectorAppsSection() {
  const [appReply] = useState(appReplies);
  const gallerySecrets = useSampleSecrets({ state: "ready", now: () => SAMPLE_NOW });
  const timeline = (rows: ReturnType<typeof buildTimeline>) => (
    <div className="max-w-(--layout-text-column)">
      <Timeline
        rows={rows}
        room={null}
        workSteps={workSteps}
        submitting={notSubmitting}
        intents={timelineIntents}
        secrets={gallerySecrets}
        onOpenPair={nothing}
        onOpenRoom={nothing}
        onOpenBot={nothing}
        quotes={appSampleQuotes}
        recordScreen={null}
      />
    </div>
  );
  return (
    <Section title="Connector apps">
      <Labeled label="In the bot's reply, where its call happened, and the reply going on below it">
        {timeline(appReply.shown)}
      </Labeled>
      <Labeled label="An app asking to run one of its connector's tools: the operator allows it, under the frame, where the app cannot reach">
        {timeline(appReply.asking)}
      </Labeled>
      <Frame
        label="Full screen over the conversation, with its composer, and the bot's reply over the app"
        width={640}
        height={560}
      >
        <StagedConversation rows={appReply.withReply} staged={appReply.fullscreen} />
      </Frame>
      <Frame label="Pinned at the top while the conversation scrolls" width={640} height={460}>
        <StagedConversation rows={appReply.scrolled} staged={appReply.pinned} />
      </Frame>
    </Section>
  );
}

function WorkSection() {
  return (
    <AttachmentImagesProvider fetch={galleryImage}>
      <Section title="A turn's work">
        <Labeled label="Under way: thinking before any step, typing the next message of a first contact, working on a step (its steps open), waiting on the operator, stalled, having trouble reaching its AI while it is tried again, past an hour">
          <div className="flex max-w-(--layout-text-column) flex-col gap-2">
            {turnStates.map(({ name, bot, fold }) => (
              <WorkFold
                key={name}
                fold={fold}
                live={{ bot, lastEntry: null }}
                steps={fold === null ? null : (variants.folds[0]?.steps ?? null)}
                onOpenChange={nothing}
                onOpenImage={nothing}
              />
            ))}
          </div>
        </Labeled>
        <Labeled label="Folded: running with no turn seen, finished, images it looked at (shown, arriving, gone), finished with work it handed off still running, using a connector's skills, loading its steps, stopped, failed, filling saved logins (filled, refused on a lookalike, secrets unavailable)">
          <div className="flex flex-col gap-2">
            {variants.folds.map(({ entry, steps, open }) => (
              <WorkFold
                key={entry.id}
                fold={entry}
                live={null}
                steps={steps}
                defaultOpen={open}
                onOpenChange={nothing}
                onOpenImage={nothing}
              />
            ))}
          </div>
        </Labeled>
      </Section>
    </AttachmentImagesProvider>
  );
}

/** Scout at work on `doing`, with `littleOnes` of its little ones at work. */
const scoutWorking = (doing: string, littleOnes = 0): Bot => ({
  ...team.bots.scout,
  state: {
    _tag: "working",
    since: DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - 72_000),
    stalled: false,
    typing: false,
    retrying: false,
    activity: doing,
    activityKind: "command",
    tool: null,
    littleOnes,
  },
});

/** The gallery's running fold, carrying `work`; finished when the turn is not `live`. */
const foldWith = (id: string, work: TurnWork, live = true): WorkFoldEntry | null => {
  const running = variants.folds[0]?.entry;
  const finished = variants.folds[1]?.entry;
  const base = live ? running : finished;
  return base === undefined ? null : { ...base, id: EntryId.make(id), work };
};

/**
 * One turn played from its first step to its end, from `beats`, with `reply`
 * under its row once the turn is over. Replay starts it again.
 */
function PlayedTurn({
  beats,
  reply = null,
}: {
  readonly beats: ReadonlyArray<PlayedBeat>;
  readonly reply?: MessageEntry | null;
}) {
  const [run, setRun] = useState(0);
  return (
    <div className="flex min-h-64 max-w-(--layout-text-column) flex-col items-start gap-2">
      <Button variant="outline" size="sm" onClick={() => setRun(run + 1)}>
        Replay
      </Button>
      <PlayedOnce key={run} beats={beats} reply={reply} />
    </div>
  );
}

/** The turn played once, from its first beat, on its own timers. */
function PlayedOnce({
  beats,
  reply,
}: {
  readonly beats: ReadonlyArray<PlayedBeat>;
  readonly reply: MessageEntry | null;
}) {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timers = beats.map((played, index) => window.setTimeout(() => setBeat(index), played.at));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [beats]);
  const played = beats[beat];
  if (played === undefined) return null;
  const working = played.work.littleOnes.ones.filter((one) => one.status === "working").length;
  return (
    <div className="flex w-full flex-col">
      <WorkFold
        fold={foldWith("fold-played", played.work, played.live)}
        live={played.live ? { bot: scoutWorking(played.doing, working), lastEntry: null } : null}
        steps={null}
        onOpenChange={nothing}
        onOpenImage={nothing}
      />
      {!played.live && reply !== null && (
        <div className="arrive mt-3">
          <MessageBubble
            message={reply}
            position="single"
            onOpenAttachment={nothing}
            onRetry={nothing}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A member's turn in a room played whole, with no plan: its place arrives as
 * it splits into two, one does its part, the other fails, and its place goes
 * once the last is home. Replay starts it again.
 */
function PlayedRoom() {
  const [run, setRun] = useState(0);
  return (
    <div className="flex min-h-48 max-w-(--layout-text-column) flex-col items-start gap-2">
      <Button variant="outline" size="sm" onClick={() => setRun(run + 1)}>
        Replay
      </Button>
      <PlayedRoomOnce key={run} />
    </div>
  );
}

function PlayedRoomOnce() {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const timers = playedRoom.map((played, index) =>
      window.setTimeout(() => setBeat(index), played.at),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const work = playedRoom[beat]?.work ?? null;
  const room = {
    ...team.room,
    answering: [ids.juniper],
    memberWork: work === null ? [] : [{ botId: ids.juniper, work }],
  };
  return (
    <div className="flex w-full flex-col">
      <RoomWork room={room} />
      <AnsweringLine room={room} />
    </div>
  );
}

function PlanAndLittleOnesSection() {
  const none = sampleLittleOnes([]);
  const turn = (id: string, work: TurnWork, live = true) => (
    <WorkFold
      fold={foldWith(id, work, live)}
      live={live ? { bot: scoutWorking("Comparing the three vendors"), lastEntry: null } : null}
      steps={null}
      onOpenChange={nothing}
      onOpenImage={nothing}
    />
  );
  const split = (count: number): RosterItem => ({
    _tag: "bot",
    bot: scoutWorking("Comparing the three vendors", count),
    unread: false,
    lastEntry: null,
    lastActivityAt: null,
  });
  return (
    <Section title="A turn's plan and its little ones">
      <Labeled label="A turn played whole: the plan moves on, the bot splits into three, one fails, they go home, and the turn folds. Hover a little one for its line in full">
        <PlayedTurn beats={playedTurn} />
      </Labeled>
      <Labeled label="Work handed off: the bot splits into three and replies while they still work; they stay under its face, the row says it is working, and it folds once the last is home">
        <PlayedTurn beats={playedHandOff} reply={variants.bubbles.handOff} />
      </Labeled>
      <Labeled label="The plan while the turn runs: its first step, half way, a long plan around where the bot is">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          {turn("fold-plan-first", { plan: samplePlan(0), littleOnes: none })}
          {turn("fold-plan-half", { plan: samplePlan(2), littleOnes: none })}
          {turn("fold-plan-long", { plan: longPlan, littleOnes: none })}
        </div>
      </Labeled>
      <Labeled label="The little ones at work: three by the plan, four and more with no plan, one alone, one the engine gave no words for">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          {turn("fold-little-three", {
            plan: samplePlan(1),
            littleOnes: sampleLittleOnes(["working", "working", "working"]),
          })}
          {turn("fold-little-more", {
            plan: null,
            littleOnes: sampleLittleOnes(["working", "working", "done", "working", "working"], 2),
          })}
          {turn("fold-little-one", { plan: null, littleOnes: sampleLittleOnes(["working"]) })}
          {turn("fold-little-unnamed", { plan: null, littleOnes: unnamedLittleOne })}
        </div>
      </Labeled>
      <Labeled label="A reply with its little ones still out: the turn is over, and the three it handed off still work under the bot's face">
        <div className="flex max-w-(--layout-text-column) flex-col">
          {turn(
            "fold-handed-off",
            {
              plan: null,
              littleOnes: sampleLittleOnes(["working", "working", "working"]),
            },
            false,
          )}
          <div className="mt-3">
            <MessageBubble
              message={variants.bubbles.handOff}
              position="single"
              onOpenAttachment={nothing}
              onRetry={nothing}
            />
          </div>
        </div>
      </Labeled>
      <Labeled label="Once the turn is over: the plan done, a plan a stopped turn left half way, and no line for a plan of one step">
        <div className="flex flex-col gap-2">
          {turn("fold-plan-done", { plan: samplePlan(4), littleOnes: none }, false)}
          {turn("fold-plan-partial", { plan: samplePlan(2), littleOnes: none }, false)}
          {turn("fold-plan-single", { plan: samplePlan(0, ["Reply"]), littleOnes: none }, false)}
        </div>
      </Labeled>
      <Labeled label="In a room: under each member whose turn there has a plan or little ones, above who is answering">
        <div className="flex max-w-(--layout-text-column) flex-col">
          <RoomWork
            room={{
              ...team.room,
              memberWork: [
                {
                  botId: ids.juniper,
                  work: {
                    plan: samplePlan(1),
                    littleOnes: sampleLittleOnes(["working", "working"]),
                  },
                },
                { botId: ids.scout, work: { plan: samplePlan(2), littleOnes: none } },
              ],
            }}
          />
          <AnsweringLine room={team.room} />
        </div>
      </Labeled>
      <Labeled label="A member's turn in a room played whole, with no plan: it splits into two, one does its part, one fails, and its place goes once the last is home">
        <PlayedRoom />
      </Labeled>
      <Labeled label="In the roster: a dot by the avatar for each little one at work, four at most">
        <ul className="flex w-(--layout-roster-width) max-w-full flex-col gap-px rounded-md bg-sidebar p-2">
          {[1, 3, 6].map((count) => (
            <li key={count}>
              <RosterRow item={split(count)} selected={false} />
            </li>
          ))}
        </ul>
      </Labeled>
    </Section>
  );
}

function NoticesSection() {
  return (
    <Section title="Notices and event lines">
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
      <Labeled label="Event lines: handoffs, routine changes, a saved name, a team">
        <div className="flex flex-col">
          {variants.eventLines.map((line) => (
            <EventLine
              key={latestOfLine(line).id}
              line={line}
              room={null}
              onOpenRoutine={nothing}
              onOpenPair={nothing}
              onOpenRoom={nothing}
            />
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

/** Room messages that mention members, `@everyone` and a bot deleted since. */
function MentionBubbles() {
  const { bubbles } = variants;
  const { scout, wren, juniper } = team.bots;
  const gone = BotId.make("gallery-deleted-bot");
  return (
    <div className="flex max-w-(--layout-text-column) flex-col gap-2">
      <MessageBubble
        message={{ ...bubbles.operator, text: "@Scout and @Juniper, can you check the numbers?" }}
        position="single"
        mentionable={[
          { name: scout.profile.name, of: { _tag: "bot", botId: scout.id } },
          { name: juniper.profile.name, of: { _tag: "bot", botId: juniper.id } },
        ]}
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
      <MessageBubble
        message={{ ...bubbles.bot, text: "On it. @Wren, the photo from the workshop is yours." }}
        position="single"
        tint={scout.profile.avatar}
        mentionable={[{ name: wren.profile.name, of: { _tag: "bot", botId: wren.id } }]}
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
      <MessageBubble
        message={{ ...bubbles.operator, text: "@everyone, thanks. @Pip had it last week." }}
        position="single"
        mentionable={[
          { name: EVERYONE, of: null },
          { name: "Pip", of: { _tag: "bot", botId: gone } },
        ]}
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
    </div>
  );
}

/** The operator's message in Scout's conversation, naming another bot and a room Scout is in. */
function ConversationMentionBubble() {
  const { wren } = team.bots;
  return (
    <div className="flex max-w-(--layout-text-column) flex-col gap-2">
      <MessageBubble
        message={{
          ...variants.bubbles.operator,
          text: `Ask @${wren.profile.name} for the workshop photo, then tell @${team.room.name} it is in.`,
        }}
        position="single"
        mentionable={[
          { name: wren.profile.name, of: { _tag: "bot", botId: wren.id } },
          { name: team.room.name, of: { _tag: "room", roomId: team.room.id } },
        ]}
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
    </div>
  );
}

function ComposerDemo({
  initial,
  recipient,
  files: initialFiles = [],
  sending = false,
  notSaved = false,
  replaced: initialReplaced = null,
  mentionable,
  mentions: initialMentions = [],
  suggestion = null,
  quotes: initialQuotes = [],
  dictation,
  dictating = false,
}: {
  initial: string;
  recipient: string;
  /** What the draft quotes. */
  quotes?: ReadonlyArray<MessageQuote>;
  files?: ReadonlyArray<DraftFile>;
  sending?: boolean;
  /** The device could not keep the draft yet. */
  notSaved?: boolean;
  /** Text another tab replaced, on offer. */
  replaced?: string | null;
  /** What `@` offers: in a room, its members; in a bot's conversation, its bots and rooms. */
  mentionable?: MentionChoices;
  /** The mentions picked in `initial`. */
  mentions?: ReadonlyArray<DraftMention>;
  /** A reply the AI suggests. */
  suggestion?: SuggestedReply | null;
  /** Dictation: a microphone beside Send. */
  dictation?: DictationSource;
  /** The microphone is pressed as the frame shows, so it shows dictation under way. */
  dictating?: boolean;
}) {
  const draftKey = useId();
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dictating) frame.current?.querySelector<HTMLElement>("[data-dictation]")?.click();
  }, [dictating]);
  const [value, setValue] = useState(initial);
  const [mentions, setMentions] = useState<ReadonlyArray<DraftMention>>(initialMentions);
  const [files, setFiles] = useState(initialFiles);
  const [replaced, setReplaced] = useState(initialReplaced);
  const [quotes, setQuotes] = useState(initialQuotes);
  return (
    <div ref={frame}>
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
        quotes={quotes}
        onUnquote={(index) => setQuotes((current) => current.toSpliced(index, 1))}
        onCommentQuote={(index, comment) =>
          setQuotes((current) => {
            const quote = current[index];
            return quote === undefined ? current : current.with(index, withComment(quote, comment));
          })
        }
        sending={sending}
        notSaved={notSaved}
        onAttachFiles={nothing}
        onDetachFile={(key) => setFiles((current) => current.filter((file) => file.key !== key))}
        onSend={() => {
          setValue("");
          setMentions([]);
        }}
        dictation={dictation}
        {...(mentionable === undefined ? {} : { mentionable })}
        suggestion={suggestion}
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
    </div>
  );
}

function ComposerSection() {
  return (
    <Section title="Conversation header and composer">
      <Labeled label="Headers: a working bot, a waiting bot and a blocked bot, each its face and its name over its title; Moss, a bot from before titles, by its name alone; a room with work under way, the same room while its work stops, a room at rest. None offers Stop: it is in the details">
        <div className="flex flex-col gap-2">
          {(
            [
              { key: "working", subject: { _tag: "bot", bot: team.bots.scout } },
              { key: "waiting", subject: { _tag: "bot", bot: team.bots.atlas } },
              { key: "blocked", subject: { _tag: "bot", bot: team.bots.ledger } },
              { key: "untitled", subject: { _tag: "bot", bot: team.bots.moss } },
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
                folds={[]}
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
      <div className="flex flex-wrap gap-4">
        <Frame label="Dictation: at rest, the microphone beside Send" width={440} height={120}>
          <div className="p-3">
            <ComposerDemo
              initial=""
              recipient={team.bots.scout.profile.name}
              dictation={sampleDictation()}
            />
          </div>
        </Frame>
        <Frame
          label="Dictation: getting ready the first time, the model downloading"
          width={440}
          height={120}
        >
          <div className="p-3">
            <ComposerDemo
              initial="Remind me to "
              recipient={team.bots.scout.profile.name}
              dictation={sampleDictation({
                state: { _tag: "installing", received: 312_000_000, total: 751_000_000 },
              })}
              dictating
            />
          </div>
        </Frame>
        <Frame
          label="Dictation: listening, settled words in the text's color, open ones lighter, and the level"
          width={440}
          height={120}
        >
          <div className="p-3">
            <ComposerDemo
              initial="Hi Atlas,"
              recipient={team.bots.atlas.profile.name}
              dictation={sampleDictation({
                state: {
                  _tag: "listening",
                  live: true,
                  committed: "book the venue for the fourteenth",
                  tentative: "and ask about park",
                },
              })}
              dictating
            />
          </div>
        </Frame>
        <Frame label="Dictation: the microphone not allowed" width={440} height={140}>
          <div className="p-3">
            <ComposerDemo
              initial=""
              recipient={team.bots.scout.profile.name}
              dictation={sampleDictation({ refusedFor: "denied" })}
              dictating
            />
          </div>
        </Frame>
        <Frame
          label="Dictation: a page on plain http, where a press explains"
          width={440}
          height={160}
        >
          <div className="p-3">
            <ComposerDemo
              initial=""
              recipient={team.bots.scout.profile.name}
              dictation={sampleDictation({ reach: { _tag: "blocked", block: "insecure-page" } })}
              dictating
            />
          </div>
        </Frame>
      </div>
      <Labeled label="Composer offering a reply the AI suggests after the bot answered: faint in place of the placeholder, with Use (and Tab where there is a keyboard). Use or Tab puts it in the draft to send or change, typing hides it, Escape sets it aside">
        <div className="flex max-w-(--layout-text-column) flex-col gap-3">
          <ComposerDemo
            initial=""
            recipient={team.bots.scout.profile.name}
            suggestion={{
              text: "Move the second meeting to Friday morning",
              after: EntryId.make("gallery-answer"),
            }}
          />
        </div>
      </Labeled>
    </Section>
  );
}

const READY_BROWSER = { _tag: "ready" } as const;
const BROWSER_NEEDS_SETUP = { _tag: "setup-required", needs: ["sandbox"] } as const;

const detailsIntents = {
  setRoutineEnabled: nothing,
  openRoutine: nothing,
  openAttachment: nothing,
  openMemoryFile: nothing,
  editProfile: nothing,
  stop: nothing,
  forceStop: nothing,
  show: nothing,
  freshStart: nothing,
  deleteBot: nothing,
  shareTemplate: nothing,
  setBrowser: nothing,
  openConnectors: nothing,
  openPair: nothing,
};

const roomIntents = {
  editRoom: nothing,
  stop: nothing,
  forceStop: nothing,
  show: nothing,
  archiveRoom: () => Promise.resolve(),
  unarchiveRoom: () => Promise.resolve(),
  deleteRoom: nothing,
};

/** The sample room after deleting bots left it with one: archived. */
const archivedRoom: Room = {
  id: team.room.id,
  name: team.room.name,
  pinned: false,
  hidden: false,
  createdAt: team.room.createdAt,
  status: "archived",
  members: [team.bots.scout.id],
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

const trackEntry = (name: string) => EntryId.make(`gallery-track-${name}`);

/** A run of the sample routine on its card, answered, retried and stopped as the server would. */
function PlayableTrack({ run: first, label }: { run: RoutineRun; label: string }) {
  const [run, setRun] = useState(first);
  const [submitting, setSubmitting] = useState(false);
  const command = (next: RoutineCardCommand) => {
    setSubmitting(true);
    window.setTimeout(() => {
      setRun((current) => sampleTrackCommand(current, next));
      setSubmitting(false);
    }, 600);
  };
  return (
    <RoutineTrack
      entryId={trackEntry(label)}
      name={trackName}
      trigger={trackTrigger}
      owner={trackOwner}
      steps={trackSteps}
      run={run}
      submitting={submitting}
      onAnswer={(step, choice, note) =>
        command({ _tag: "answer", runId: run.id, step, choice, note })
      }
      onRetry={() => command({ _tag: "retry", runId: run.id })}
      onStop={() => command({ _tag: "stop", runId: run.id })}
    />
  );
}

/** The hand-off, played over and over: a step ends, the light runs down the line, the next bot catches it. */
function PlayedTrack() {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setAt((current) => (current + 1) % playedTrack.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <RoutineTrack
      entryId={trackEntry("played")}
      name={trackName}
      trigger={trackTrigger}
      owner={trackOwner}
      steps={trackSteps}
      run={playedTrack[at] ?? null}
      onStop={nothing}
    />
  );
}

/** A routine just made, its stations coming in again each time it is pressed. */
function ArrivingTrack() {
  const [key, setKey] = useState(0);
  return (
    <div className="flex flex-col items-start">
      <RoutineTrack
        key={key}
        entryId={trackEntry("new")}
        name={trackName}
        trigger={trackTrigger}
        owner={trackOwner}
        steps={trackSteps}
        run={null}
        arriving
      />
      <Button variant="ghost-muted" size="sm" className="mt-2" onClick={() => setKey(key + 1)}>
        Play again
      </Button>
    </div>
  );
}

const trackMomentFrames: ReadonlyArray<readonly [string, keyof typeof trackMoments]> = [
  ["Running: Scout at work, its row lit in its color", "gathering"],
  ["Past the condition: Atlas at work", "drafting"],
  ["Needs your yes: the ask inside the stop (answer it)", "waiting"],
  ["You said yes: Wren at work", "sending"],
  ["A failed step: what happened, what to do, what is kept, Try again (press it)", "failed"],
  ["Blocked, in the bot's own words", "blocked"],
  ["Trying again by itself after an attempt that never started", "retrying"],
  ["Stopped by you at the yes", "stopped"],
];

const trackEndings: ReadonlyArray<readonly [string, keyof typeof trackMoments]> = [
  ["Done, folded into its line (open it)", "done"],
  ["A condition that did not hold: stopped quietly, the light at the siding's bar", "nothingNew"],
  ["You said no", "saidNo"],
  ["No answer in time", "timedOut"],
  ["The yes was not needed", "notNeeded"],
];

function RoutineTracksSection() {
  const { scout } = team.bots;
  return (
    <Section title="Routines in steps (the Track)">
      <Labeled label="At rest, as a bot just made it: the sentence, then the stations coming in">
        <ArrivingTrack />
      </Labeled>
      <Labeled label="The hand-off, played: a step ends, the light runs down the line, the next bot catches it">
        <div className="flex flex-col">
          <PlayedTrack />
        </div>
      </Labeled>
      {trackMomentFrames.map(([label, moment]) => (
        <Labeled key={moment} label={label}>
          <div className="flex flex-col">
            <PlayableTrack run={trackMoments[moment]} label={moment} />
          </div>
        </Labeled>
      ))}
      <Labeled label="On a connector's event: the trigger reads in its words, with the connector's mark, at rest and in a run">
        <div className="flex flex-col">
          <RoutineTrack
            entryId={trackEntry("event-rest")}
            name={trackName}
            trigger={trackEventTrigger}
            owner={trackOwner}
            steps={trackSteps}
            run={null}
          />
          <RoutineTrack
            entryId={trackEntry("event-run")}
            name={trackName}
            trigger={trackEventTrigger}
            owner={trackOwner}
            steps={trackSteps}
            run={trackMoments.waiting}
            onAnswer={nothing}
            onStop={nothing}
          />
        </div>
      </Labeled>
      <Labeled label="How a run ends: each folds into one line that opens its whole rail">
        <div className="flex flex-col">
          {trackEndings.map(([label, moment]) => (
            <div key={moment} className="flex flex-col">
              <span className="mt-3 text-2xs text-muted-foreground">{label}</span>
              <RoutineTrack
                entryId={trackEntry(moment)}
                name={trackName}
                trigger={trackTrigger}
                owner={trackOwner}
                steps={trackSteps}
                run={trackMoments[moment]}
              />
            </div>
          ))}
        </div>
      </Labeled>
      <Labeled label="Where it lives: the bot's routines, with who does it and the sentence; its runs, on its track at rest and each run's mini rail; quick access around the stop">
        <div className="flex flex-wrap items-start gap-4">
          <Pane>
            <BotDetails
              bot={scout}
              routines={[trackRoutine, ...(team.routines[scout.id] ?? [])]}
              memory={team.memory[scout.id] ?? []}
              files={team.files[scout.id] ?? []}
              connectors={sampleConnectors}
              teammates={[]}
              modelName="Claude Code · Claude Sonnet 5.5"
              browserHost={READY_BROWSER}
              intents={detailsIntents}
              stopShortcut={shortcuts.stop}
              onClose={nothing}
            />
          </Pane>
          <Pane>
            <RoutineRunList
              routine={trackRoutine}
              runs={{ _tag: "ready", value: { runs: trackRuns, hasOlder: false }, stale: false }}
            />
          </Pane>
          <div className="w-80 rounded-md border border-border bg-surface p-3">
            <RoutineTrackWindow
              name={trackName}
              trigger={trackTrigger}
              owner={trackOwner}
              steps={trackSteps}
              run={trackMoments.waiting}
              onAnswer={nothing}
            />
          </div>
        </div>
      </Labeled>
    </Section>
  );
}

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
            connectors={sampleConnectors}
            teammates={teammatesOf(scout.id, team.pairs)}
            modelName="Claude Code · Claude Sonnet 5.5"
            browserHost={READY_BROWSER}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          {/* The browser off: the operator turned it off. */}
          <BotDetails
            bot={{ ...atlas, browser: false }}
            routines={team.routines[atlas.id] ?? []}
            memory={team.memory[atlas.id] ?? []}
            files={team.files[atlas.id] ?? []}
            connectors={sampleConnectors}
            teammates={[]}
            modelName="Claude Code · Claude Sonnet 5.5"
            browserHost={READY_BROWSER}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          {/* The browser on, and the server's machine still needs setting up for it. */}
          <BotDetails
            bot={atlas}
            routines={team.routines[atlas.id] ?? []}
            memory={team.memory[atlas.id] ?? []}
            files={team.files[atlas.id] ?? []}
            connectors={sampleConnectors}
            teammates={[]}
            modelName="Claude Code · Claude Sonnet 5.5"
            browserHost={BROWSER_NEEDS_SETUP}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          {/* Behind the scenes, with nothing to stop: the line under its profile. No connector yet: the line that says to ask it. */}
          <BotDetails
            bot={{ ...moss, hidden: true }}
            routines={[]}
            memory={[]}
            files={[]}
            connectors={[]}
            teammates={[]}
            modelName={null}
            browserHost={READY_BROWSER}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          {/* Its AI ignores the Stop: Force stop, with why. */}
          <BotDetails
            bot={{ ...scout, forceStop: true }}
            routines={team.routines[scout.id] ?? []}
            memory={team.memory[scout.id] ?? []}
            files={team.files[scout.id] ?? []}
            connectors={sampleConnectors}
            teammates={[]}
            modelName="Claude Code · Claude Sonnet 5.5"
            browserHost={READY_BROWSER}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
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
            connectors={null}
            teammates={[]}
            modelName="Claude Code · Claude Sonnet 5.5"
            browserHost={READY_BROWSER}
            intents={detailsIntents}
            stopShortcut={shortcuts.stop}
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
          {/* Behind the scenes while its work stops: the line after the Stop. */}
          <RoomDetails
            room={{ ...stoppingRoom, hidden: true }}
            intents={roomIntents}
            onClose={nothing}
          />
        </Pane>
        <Pane>
          {/* A member's AI ignores the room's Stop: Force stop, with why. */}
          <RoomDetails room={forceStopRoom} intents={roomIntents} onClose={nothing} />
        </Pane>
        <Pane>
          <RoomDetails room={archivedRoom} intents={roomIntents} onClose={nothing} />
        </Pane>
        <Pane>
          {/* A room of bots only left too small takes no members from the operator: it stays archived. */}
          <RoomDetails
            room={{ ...archivedRoom, botsOnly: true }}
            intents={roomIntents}
            onClose={nothing}
          />
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
          models: [
            {
              id: ModelId.make("gpt-5.5-codex"),
              name: "GPT-5.5 Codex",
              efforts: sampleEfforts("low", "medium", "high", "xhigh"),
            },
          ],
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
  const untitled = { ...scoutTemplate, profile: { ...scoutTemplate.profile, title: "" } };
  const { t } = useI18n();
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
        <TemplateFrame label="Create: a template from a bot with no title asks for one before Create">
          {(titleId) => (
            <TemplateForm
              template={untitled}
              engine={twoProviders}
              connected
              onCreate={() => new Promise(() => {})}
              onClose={nothing}
              titleId={titleId}
            />
          )}
        </TemplateFrame>
        <Frame
          label="New bot: a name and a title, both required; type a name and press Create to see the title asked for"
          width={448}
          height={640}
        >
          <div className="flex h-full flex-col gap-3 bg-popover p-5">
            <h2 className={dialogTitle}>{t("newBot.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("newBot.body")}</p>
            <NewBotForm
              bots={Object.values(team.bots)}
              onCreate={() => new Promise(() => {})}
              onCancel={nothing}
            />
          </div>
        </Frame>
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
          label="Edit: effort chosen; pick GPT-5.5 Codex to see it fall back"
          bot={{
            ...team.bots.scout,
            model: { ...team.bots.scout.model, modelId: ModelId.make("claude-opus-5-5") },
            effort: EffortLevel.make("max"),
          }}
        />
        <EditBotVariant
          label="Edit: the model no longer offers the bot's effort"
          bot={{ ...team.bots.scout, effort: EffortLevel.make("max") }}
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

/**
 * The connectors screen on one page, in a frame the size of a sheet, over a
 * server of the sample's that answers and keeps what changes in the frame.
 */
function ConnectorsVariant({
  label,
  at,
  route = { _tag: "paste" },
  connected = true,
  initial = sampleConnectors,
  initialSkills = sampleSkills,
}: {
  label: string;
  at: ConnectorsPlace;
  route?: SignInRoute;
  connected?: boolean;
  initial?: ReadonlyArray<Connector>;
  initialSkills?: ReadonlyArray<Skill>;
}) {
  const titleId = useId();
  const [connectors, setConnectors] = useState(initial);
  const [intents] = useState(() =>
    sampleConnectorsIntents(connectorsHolder(initial, setConnectors), route),
  );
  const [skills, setSkills] = useState(initialSkills);
  const [skillsIntents] = useState(() => {
    let current = initialSkills;
    return sampleSkillsIntents({
      get: () => current,
      set: (next) => {
        current = next;
        setSkills(next);
      },
    });
  });
  return (
    <Frame label={label} width={400} height={720}>
      <div className="flex h-full flex-col bg-background">
        <ConnectorsScreen
          titleId={titleId}
          opening={at}
          connectors={connectors}
          bots={Object.values(team.bots)}
          skills={skills}
          connected={connected}
          intents={intents}
          skillsIntents={skillsIntents}
          onClose={nothing}
        />
      </div>
    </Frame>
  );
}

const sampleConnectorId = (index: number) => {
  const connector = sampleConnectors[index];
  if (connector === undefined) throw new Error(`No sample connector ${index}`);
  return connector.id;
};

/** The desktop app's way back from a sign-in, listening on a port of the sample's. */
const relay: SignInRoute = {
  _tag: "relay",
  listen: () => Promise.resolve(51734),
  expect: () => Promise.resolve(true),
  onReturn: () => nothing,
  stop: nothing,
};

const connectorAt = (index: number, signIn = false): ConnectorsPlace => ({
  _tag: "connector",
  connectorId: sampleConnectorId(index),
  signIn,
});

/** J3 Bots' own skills alone: what a home has before any bot adds one. */
const shippedSkills = sampleSkills.filter((skill) => skill.shipped);

function ConnectorsGallerySection() {
  return (
    <Section title="MCP and skills">
      <Labeled label="Settings: the connectors, how many work and how many need you">
        <ConnectorsSection connectors={sampleConnectors} onOpen={nothing} />
      </Labeled>
      <Labeled label="Settings: none yet">
        <ConnectorsSection connectors={[]} onOpen={nothing} />
      </Labeled>
      <div className="flex flex-wrap gap-4">
        <ConnectorsVariant label="What the bots added" at={{ _tag: "home" }} />
        <ConnectorsVariant
          label="None yet: ask a bot"
          at={{ _tag: "home" }}
          initial={[]}
          initialSkills={shippedSkills}
        />
        <ConnectorsVariant label="Offline" at={{ _tag: "home" }} connected={false} />
        <ConnectorsVariant
          label="Connected, for all bots, with the skills its server offers"
          at={connectorAt(0)}
        />
        <ConnectorsVariant
          label="Signing in again from a browser: paste the address"
          at={connectorAt(1, true)}
        />
        <ConnectorsVariant
          label="Signing in again from the desktop app"
          at={connectorAt(1, true)}
          route={relay}
        />
        <ConnectorsVariant label="Can't reach, on an older revision" at={connectorAt(2)} />
        <ConnectorsVariant label="Secrets unavailable" at={connectorAt(3)} />
        <ConnectorsVariant label="Names a secret one of its bots may not use" at={connectorAt(4)} />
        <ConnectorsVariant label="Runs a command a bot added" at={connectorAt(5)} />
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

const roomMembers: MentionChoices = {
  candidates: team.room.members.flatMap((id): ReadonlyArray<MentionCandidate> => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot
      ? [
          {
            _tag: "bot",
            id,
            name: bot.profile.name,
            title: bot.profile.title,
            avatar: bot.profile.avatar,
          },
        ]
      : [];
  }),
  everyone: true,
};

/** What `@` offers in Scout's conversation: the other bots, and the room Scout is in. */
const scoutsMentions = conversationChoicesOf(team.bots.scout.id, team.roster);

/** The mention list as it opens above the composer, for `query` typed after `@`. */
function MentionVariant({
  label,
  query,
  active,
  choices = roomMembers,
}: {
  label: string;
  query: string;
  active: number;
  choices?: MentionChoices;
}) {
  const listId = useId();
  const { t } = useI18n();
  return (
    <Labeled label={label}>
      <div className="relative h-56 max-w-72">
        <MentionList
          id={listId}
          options={mentionOptions(query, choices.candidates, choices.everyone)}
          candidates={choices.candidates}
          label={t(choices.everyone ? "mention.label" : "mention.labelConversation")}
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
        <RoomFormVariant label="New room: empty; pick bots, then Create to see what is missing" />
        <RoomFormVariant
          label="New room: the server refused the bots, one of them deleted meanwhile"
          initial={{
            name: "Launch week",
            members: [scout.id, wren.id],
            hidden: false,
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
            hidden: team.room.hidden,
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
        <MentionVariant
          label="Mentions in a bot's conversation: after @, its other bots by their faces and the rooms it is in by their marks, no @everyone"
          query=""
          active={0}
          choices={scoutsMentions}
        />
        <MentionVariant
          label="Mentions in a bot's conversation: after @sp, the room it matches"
          query="sp"
          active={0}
          choices={scoutsMentions}
        />
      </div>
      <Labeled label="Composer in a room: type @ to open the list; arrows, Enter, Tab and Escape work, and so does a tap. Only a pick mentions">
        <div className="max-w-(--layout-text-column) pt-60">
          <ComposerDemo initial="" recipient={team.room.name} mentionable={roomMembers} />
        </div>
      </Labeled>
      <Labeled label="Composer in a room with picks: each a chip with its member's face, deleted whole; @everyone stays text, and so does a pick run into a word">
        <div className="max-w-(--layout-text-column)">
          <ComposerDemo
            initial="@Scout and @Wren, then @everyone and @Juniperish "
            recipient={team.room.name}
            mentionable={roomMembers}
            mentions={[
              { _tag: "bot", botId: scout.id, label: scout.profile.name, position: 0 },
              { _tag: "bot", botId: wren.id, label: wren.profile.name, position: 11 },
              { _tag: "everyone", position: 23 },
              { _tag: "bot", botId: juniper.id, label: juniper.profile.name, position: 37 },
            ]}
          />
        </div>
      </Labeled>
      <Labeled label="Composer in a bot's conversation with picks: another bot and a room it is in, each a chip, deleted whole. Type @ for the list">
        <div className="max-w-(--layout-text-column) pt-60">
          <ComposerDemo
            initial={`@${wren.profile.name} and @${team.room.name}, the photo is in `}
            recipient={scout.profile.name}
            mentionable={scoutsMentions}
            mentions={[
              { _tag: "bot", botId: wren.id, label: wren.profile.name, position: 0 },
              {
                _tag: "room",
                roomId: team.room.id,
                label: team.room.name,
                position: wren.profile.name.length + 6,
              },
            ]}
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
  padded = false,
  replay = false,
  children,
}: {
  label: string;
  width: number;
  height: number;
  /** As a page of Settings sets its groups in. */
  padded?: boolean;
  /** Offers Replay, which starts what the frame shows again from its first moment. */
  replay?: boolean;
  children: ReactNode;
}) {
  const [run, setRun] = useState(0);
  if (only.frame !== null && only.frame !== label) return null;
  return (
    <Labeled label={label} className="max-w-full">
      <div
        key={run}
        data-gallery-frame={label}
        // What a frame shows stays in it: a sheet's scrim, fixed to the window in the app, is fixed
        // to the frame here, so one frame's open sheet never covers the rest of the gallery.
        className={cn(
          "max-w-full overflow-hidden rounded-md border border-border [contain:layout]",
          padded && "overflow-y-auto p-5",
        )}
        style={{ width: `${width / 16}rem`, height: `${height / 16}rem` }}
      >
        {children}
      </div>
      {replay && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setRun(run + 1)}>
          Replay
        </Button>
      )}
    </Labeled>
  );
}

/** The sample engine with Claude Code's status `claude` and Codex's `codex`. */
const engineWith = (
  claude: ProviderStatus["status"],
  codex: ProviderStatus["status"],
): EngineStatus => ({
  ...team.engine,
  providers: team.engine.providers.map((p, index) => ({
    ...p,
    status: index === 0 ? claude : codex,
  })),
});

const notInstalled = { _tag: "unavailable", checking: false, reason: "not-installed" } as const;

/** The two providers with these versions and updates. */
type Versioned = Pick<ProviderStatus, "version" | "update">;
const withVersions = (claude: Versioned, codex: Versioned): EngineStatus => ({
  ...team.engine,
  providers: team.engine.providers.map((p, index) => ({ ...p, ...(index === 0 ? claude : codex) })),
});
const behindUpdatable: Versioned = {
  version: { installed: "2.1.0", latest: "2.2.0", canUpdate: true },
};

const minutesAgo = (minutes: number) =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(SAMPLE_NOW) - minutes * 60_000);

/** The sample engine with each provider's harness `copy` set: Claude Code's first, then Codex's. */
const engineWithCopies = (
  claude: Pick<ProviderStatus, "status" | "copy">,
  codex: Pick<ProviderStatus, "status" | "copy">,
): EngineStatus => ({
  ...team.engine,
  providers: team.engine.providers.map((p, index) => ({ ...p, ...(index === 0 ? claude : codex) })),
});

const noCopy = {
  source: "none",
  version: null,
  latest: "0.172.0",
  installable: true,
  task: null,
  last: null,
} as const;

/** The server's own copies as they arrive: Claude Code half downloaded, Codex being checked. */
const copiesArriving = {
  "claude-code": {
    ...noCopy,
    task: { _tag: "downloading", receivedBytes: 96_000_000, totalBytes: 200_434_347 },
  },
  codex: { ...noCopy, task: { _tag: "verifying" } },
} as const;

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
  /** The engine's download done, its move into place refused while another program held it. */
  installFailedInUse: {
    ...team.engine,
    state: { _tag: "unavailable", reason: "install-failed", installFailure: "in-use" },
  },
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
      status: index === 0 ? ({ _tag: "ready" } as const) : notInstalled,
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
          : notInstalled,
    })),
  },
  notInstalled: engineWith(notInstalled, notInstalled),
  failed: engineWith(
    {
      _tag: "unavailable",
      checking: false,
      reason: "failed",
      detail: "Claude Agent CLI is installed but failed to run. Timed out while running command.",
    },
    notInstalled,
  ),
  /** Claude Code found but failing, Codex signed out: the sign-in would not fix Claude Code. */
  failedBesideSignIn: engineWith(
    {
      _tag: "unavailable",
      checking: false,
      reason: "failed",
      detail: "Claude Agent CLI is installed but failed to run. Timed out while running command.",
    },
    { _tag: "sign-in-required", command: "j3-bots provider connect" },
  ),
  disabled: engineWith(
    { _tag: "unavailable", checking: false, reason: "disabled" },
    { _tag: "unavailable", checking: false, reason: "disabled" },
  ),
  /** Claude Code on the server's own copy, with a newer one out; Codex being installed. */
  ownCopies: engineWithCopies(
    {
      status: { _tag: "ready" },
      copy: {
        source: "j3",
        version: "2.1.300",
        latest: "2.1.330",
        installable: true,
        task: null,
        last: { _tag: "installed", version: "2.1.300", at: minutesAgo(3 * 24 * 60) },
      },
    },
    {
      status: notInstalled,
      copy: {
        ...noCopy,
        task: { _tag: "downloading", receivedBytes: 61_000_000, totalBytes: 200_434_347 },
      },
    },
  ),
  /**
   * The first run: neither harness on the machine, J3 Bots downloading both.
   * The engine's own "not found" detail is there, as it sends it, and stays off the screen.
   */
  bothInstalling: engineWithCopies(
    {
      status: { ...notInstalled, detail: "Claude Agent CLI (`claude`) is not installed." },
      copy: {
        ...noCopy,
        latest: "2.1.330",
        task: { _tag: "downloading", receivedBytes: 42_000_000, totalBytes: 230_000_000 },
      },
    },
    {
      status: { ...notInstalled, detail: "Codex CLI (`codex`) is not installed or not on PATH." },
      copy: { ...noCopy, task: { _tag: "verifying" } },
    },
  ),
  /** Claude Code's first install refused while another program held its new copy. */
  copyInUse: engineWithCopies(
    {
      status: { ...notInstalled, detail: "Claude Agent CLI (`claude`) is not installed." },
      copy: {
        ...noCopy,
        latest: "2.1.330",
        last: { _tag: "failed", reason: "in-use", at: minutesAgo(1) },
      },
    },
    { status: { _tag: "ready" }, copy: { ...noCopy, source: "j3", version: "0.172.0" } },
  ),
  /** The engine running, both harnesses on their way: Claude Code half downloaded, Codex being checked. */
  harnessesArriving: { ...team.engine, providers: [], harnesses: copiesArriving },
  /** A new machine as its server starts: the engine and both harnesses downloading at once. */
  allArriving: {
    ...team.engine,
    state: { _tag: "starting", install: { receivedBytes: 42_400_000, totalBytes: 180_200_000 } },
    providers: [],
    harnesses: copiesArriving,
  },
  /** Claude Code being downloaded for the first time, Codex still to be. */
  gettingClaude: engineWithCopies(
    {
      status: notInstalled,
      copy: {
        ...noCopy,
        task: { _tag: "downloading", receivedBytes: 84_000_000, totalBytes: 200_434_347 },
      },
    },
    { status: notInstalled, copy: noCopy },
  ),
  /** Claude Code's first download did not check, with the engine's own account of the missing harness. */
  gettingFailed: engineWithCopies(
    {
      status: {
        ...notInstalled,
        detail: "Claude Agent CLI (`claude`) was not found on PATH.",
      },
      copy: { ...noCopy, last: { _tag: "failed", reason: "checksum", at: minutesAgo(2) } },
    },
    { status: notInstalled, copy: noCopy },
  ),
  /** A machine J3 Bots installs no build for: the operator installs the harness themselves. */
  cannotGet: engineWithCopies(
    { status: notInstalled, copy: { ...noCopy, installable: false } },
    { status: notInstalled, copy: { ...noCopy, installable: false } },
  ),
  /** Claude Code's update waits for its bots; Codex's install failed its checksum. */
  copyWaitingAndFailed: engineWithCopies(
    {
      status: { _tag: "ready" },
      copy: {
        source: "j3",
        version: "2.1.300",
        latest: "2.1.330",
        installable: true,
        task: { _tag: "waiting" },
        last: null,
      },
    },
    {
      status: notInstalled,
      copy: { ...noCopy, last: { _tag: "failed", reason: "checksum", at: minutesAgo(2) } },
    },
  ),
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

/**
 * Settings as the dialog fills: on a wide screen, `page` beside the list of
 * pages, or the first page; on a phone's width, the list, or `page` alone.
 * The pages move as in the app; the sample team's settings fill them.
 */
/** The sample server's themes, read only: what the gallery's theme frames show. */
const galleryThemeIntents = sampleThemesIntents({ get: () => sampleThemeLibrary, set: nothing });
const galleryThemeChoices = themeChoices(sampleThemeLibrary);

/** Gives what is under it the sample's themes, with `shown` as this device's, drawing none on the page. */
function ThemesFor({ shown, children }: { shown: string; children: ReactNode }) {
  const value = useMemo(
    () => ({
      themes: { supported: true, library: sampleThemeLibrary, known: true },
      intents: galleryThemeIntents,
      shown: galleryThemeChoices.find((choice) => choice.id === shown) ?? null,
    }),
    [shown],
  );
  return <ShownThemesProvider value={value}>{children}</ShownThemesProvider>;
}

/** A conversation's pieces in a built-in theme's own colors, whatever the page shows. */
function ThemedSample({ choice, appearance }: { choice: ThemeChoice; appearance: keyof Themed }) {
  const i18n = useI18n();
  const style: CSSProperties & Readonly<Record<`--${string}`, string>> = {
    ...themeColorVariables(themePalettes(choice.definition)[appearance], appearance),
  };
  return (
    <div
      style={style}
      className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 text-foreground"
    >
      <p className="text-xs text-muted-foreground">{themeName(choice, i18n)}</p>
      <MessageBubble
        message={variants.bubbles.operator}
        position="single"
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
      <MessageBubble
        message={variants.bubbles.handOff}
        position="single"
        onOpenAttachment={nothing}
        onRetry={nothing}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm">
          Send
        </Button>
        <Button size="sm">Later</Button>
        <Switch checked readOnly={false} aria-label="On" />
      </div>
    </div>
  );
}

function ThemesSection() {
  const builtIns = galleryThemeChoices.filter((choice) => choice.origin._tag === "built-in");
  return (
    <Section title="Themes">
      {(theme) => (
        <>
          <div className="flex flex-wrap gap-4">
            <Frame
              padded
              label="The picker: Palco in use, new devices start with it"
              width={560}
              height={640}
            >
              <ThemesFor shown="palco">
                <ThemeSettings appearance={theme} />
              </ThemesFor>
            </Frame>
            <Frame
              padded
              label="A theme Scout made, in use: who made it, and Delete"
              width={560}
              height={640}
            >
              <ThemesFor shown="low-tide">
                <ThemeSettings appearance={theme} />
              </ThemesFor>
            </Frame>
            <Frame
              padded
              label="Create from colors: the theme in light and dark as it changes"
              width={448}
              height={600}
            >
              <ThemeForm
                editing={{ _tag: "new" }}
                save={galleryThemeIntents.save}
                onDone={nothing}
              />
            </Frame>
          </div>
          <Labeled label="Each built-in in its own colors: the operator's message, a bot's, buttons and a switch">
            <div className="grid gap-3 @wide:grid-cols-2">
              {builtIns.map((choice) => (
                <ThemedSample key={choice.id} choice={choice} appearance={theme} />
              ))}
            </div>
          </Labeled>
          <Labeled label="A bot's offer of a theme it saved: Apply theme, with the theme's colors">
            <div className="max-w-(--layout-text-column)">
              <ThemesFor shown="palco">
                <MessageBubble
                  message={variants.themeOffer}
                  position="single"
                  onOpenAttachment={nothing}
                  onRetry={nothing}
                />
              </ThemesFor>
            </div>
          </Labeled>
          <Labeled label="Once it shows on this device: a quiet line says so">
            <div className="max-w-(--layout-text-column)">
              <ThemesFor shown="low-tide">
                <MessageBubble
                  message={variants.themeOffer}
                  position="single"
                  onOpenAttachment={nothing}
                  onRetry={nothing}
                />
              </ThemesFor>
            </div>
          </Labeled>
          <Labeled label="A theme deleted since: no button, a line saying so">
            <div className="max-w-(--layout-text-column)">
              <ThemesFor shown="palco">
                <MessageBubble
                  message={variants.goneThemeOffer}
                  position="single"
                  onOpenAttachment={nothing}
                  onRetry={nothing}
                />
              </ThemesFor>
            </div>
          </Labeled>
        </>
      )}
    </Section>
  );
}

function SettingsFrame({
  label,
  wide,
  page = null,
  height = 640,
}: {
  label: string;
  wide: boolean;
  page?: SettingsPage | null;
  height?: number;
}) {
  const source = useSampleSource();
  const [shown, setShown] = useState<SettingsPage | null>(page);
  const profile = useProfileEdits(source.data.settingsSaves.profile);
  return (
    <Frame label={label} width={wide ? 768 : 390} height={height}>
      <Dialog.Root>
        <div className="flex h-full flex-col bg-surface">
          <SettingsPanel
            data={{ ...source.data, settingsPage: shown }}
            intents={{
              ...source.intents,
              showSettingsPage: setShown,
              serverUpdate: serverUpdate(said(serverStatuses.available)),
            }}
            profile={profile}
            titleId={`settings-${label}`}
            wide={wide}
          />
        </div>
      </Dialog.Root>
    </Frame>
  );
}

function SettingsPagesSection() {
  return (
    <Section title="Settings: its pages">
      <div className="flex flex-wrap gap-4">
        <SettingsFrame label="Wide: the list beside the first page" wide />
        <SettingsFrame label="Wide: devices, with signing out ruled off" wide page="devices" />
        <SettingsFrame label="Phone: the list, an update waiting" wide={false} />
        <SettingsFrame label="Phone: a page, with Back" wide={false} page="appearance" />
        <SettingsFrame label="Wide: voice, dictation's settings" wide page="voice" height={900} />
        <Frame
          padded
          label="Voice with OpenRouter: its key, saved, and its model"
          width={480}
          height={760}
        >
          <VoiceSection
            settings={{
              ...team.settings,
              voice: {
                place: "openrouter",
                language: "pt",
                words: ["J3 Bots"],
                removeFillers: true,
                cleanUp: true,
                model: null,
                openRouterModel: null,
              },
            }}
            save={{ _tag: "idle" }}
            connected
            onSave={nothing}
            voice={sampleVoice}
          />
        </Frame>
      </div>
    </Section>
  );
}

function EngineSettingsSection() {
  return (
    <Section title="Settings: the engine">
      <div className="flex flex-wrap gap-4">
        <Frame padded label="Downloading, on the first start" width={420} height={320}>
          <EngineSection engine={engines.downloading} stale={false} actions={providerActions} />
        </Frame>
        <Frame padded label="Downloading, with no size known" width={420} height={320}>
          <EngineSection
            engine={engines.downloadingNoTotal}
            stale={false}
            actions={providerActions}
          />
        </Frame>
        <Frame padded label="Starting, once downloaded" width={420} height={320}>
          <EngineSection engine={engines.engineStarting} stale={false} actions={providerActions} />
        </Frame>
        <Frame padded label="The download failed" width={420} height={320}>
          <EngineSection
            engine={{ ...engines.installFailed, providers: [] }}
            stale={false}
            actions={providerActions}
          />
        </Frame>
        <Frame
          padded
          label="The download failed: another program held the engine's files"
          width={420}
          height={340}
        >
          <EngineSection
            engine={{ ...engines.installFailedInUse, providers: [] }}
            stale={false}
            actions={providerActions}
          />
        </Frame>
        <Frame
          padded
          label="An account that failed to start, the engine's words under Details, and one not downloaded"
          width={420}
          height={460}
        >
          <EngineSection
            engine={engines.failed}
            stale={false}
            actions={providerActions}
            connect={{ _tag: "here", setup: localSetup(harnessesFound.claudeOnly) }}
          />
        </Frame>
        <Frame padded label="A newer version to update, and one updating" width={420} height={360}>
          <EngineSection
            engine={withVersions(behindUpdatable, {
              version: { installed: "0.170.0", latest: "0.171.0", canUpdate: true },
              update: { state: "running" },
            })}
            stale={false}
            actions={providerActions}
          />
        </Frame>
        <Frame
          padded
          label="An update that failed, and a version the engine cannot update"
          width={420}
          height={300}
        >
          <EngineSection
            engine={withVersions(
              { ...behindUpdatable, update: { state: "failed", detail: "npm exited with code 1" } },
              { version: { installed: "0.170.0", latest: "0.171.0", canUpdate: false } },
            )}
            stale={false}
            actions={providerActions}
          />
        </Frame>
        <Frame padded label="Accounts turned off on the server" width={420} height={260}>
          <EngineSection engine={engines.disabled} stale={false} actions={providerActions} />
        </Frame>
        <Frame padded label="On a server: each account with its command" width={420} height={560}>
          <EngineSection engine={engines.connect} stale={false} actions={providerActions} />
        </Frame>
        <Frame padded label="Offline: what the server last said, muted" width={420} height={260}>
          <EngineSection engine={engines.connect} stale actions={providerActions} />
        </Frame>
        <Frame
          padded
          label="The server's own copies: one with a newer version out, one downloading; then the switches to keep them up to date and to suggest replies"
          width={420}
          height={480}
        >
          <EngineSection
            engine={engines.ownCopies}
            stale={false}
            actions={providerActions}
            harnessSettings={{
              settings: team.settings,
              save: { _tag: "idle" },
              connected: true,
              onSave: () => undefined,
            }}
          />
        </Frame>
        <Frame
          padded
          label="An update waiting for its bots, and an install whose download did not check"
          width={420}
          height={320}
        >
          <EngineSection
            engine={engines.copyWaitingAndFailed}
            stale={false}
            actions={providerActions}
          />
        </Frame>
      </div>
    </Section>
  );
}

function SecretsGallerySection() {
  const now = () => SAMPLE_NOW;
  const saved = useSampleSecrets({ state: "ready", now, secrets: variants.savedSecrets });
  const empty = useSampleSecrets({ state: "ready", now });
  const unreadable = useSampleSecrets({ state: "unreadable", now });
  const newer = useSampleSecrets({ state: "newer", now });
  return (
    <Section title="Settings: secrets">
      <div className="flex flex-wrap gap-4">
        <Frame
          padded
          label="Saved: two logins and a value; open one for its page"
          width={420}
          height={520}
        >
          <SecretsSection secrets={saved} />
        </Frame>
        <Frame padded label="None saved yet; Add a secret opens the form" width={420} height={640}>
          <SecretsSection secrets={empty} />
        </Frame>
        <Frame padded label="The key file is missing" width={420} height={200}>
          <SecretsSection secrets={unreadable} />
        </Frame>
        <Frame padded label="Changed by a newer release" width={420} height={180}>
          <SecretsSection secrets={newer} />
        </Frame>
      </div>
    </Section>
  );
}

/** A diagnostics zip that never arrives: the gallery has no server to make one. */
const sampleDiagnostics: DiagnosticsIntents = { save: () => Promise.resolve(false) };

/**
 * The About page's privacy area, on a server whose `telemetry` is `setting`,
 * with `save`, and which makes a diagnostics zip.
 */
function PrivacyFrame({
  label,
  setting,
  save = { _tag: "idle" },
  connected = true,
}: {
  label: string;
  setting: { readonly enabled: boolean; readonly heldOff: boolean };
  save?: SettingsSaves["usage-data"];
  connected?: boolean;
}) {
  return (
    <Frame label={label} width={390} height={340} padded>
      <PrivacySection
        settings={{ ...team.settings, telemetry: setting }}
        save={save}
        connected={connected}
        intents={{
          updateSettings: nothing,
          usageData: { sent: () => Promise.resolve(sampleSentEvents), record: nothing },
        }}
        diagnostics={sampleDiagnostics}
      />
    </Frame>
  );
}

/** The sheet before Download diagnostics saves, as its popup shows it, in `state`. */
function DiagnosticsSheetFrame({ label, state }: { label: string; state: DiagnosticsSheetState }) {
  return (
    <Frame label={label} width={390} height={460}>
      <div className="flex h-full items-center bg-scrim p-4">
        <div className="w-full rounded-xl border border-border bg-surface p-5 shadow-overlay">
          <DiagnosticsSheet
            titleId={`diagnostics-${state}`}
            state={state}
            onSave={nothing}
            onCancel={nothing}
          />
        </div>
      </div>
    </Frame>
  );
}

function PrivacyGallerySection() {
  return (
    <Section title="Settings → About: privacy (usage data and diagnostics)">
      <div className="flex flex-wrap gap-4">
        <PrivacyFrame
          label="On, as a new install starts"
          setting={{ enabled: true, heldOff: false }}
        />
        <PrivacyFrame label="Usage data turned off" setting={{ enabled: false, heldOff: false }} />
        <PrivacyFrame
          label="Turning off: the switch shows the save under way"
          setting={{ enabled: true, heldOff: false }}
          save={{ _tag: "saving", changes: { enabled: false } }}
        />
        <PrivacyFrame
          label="The save failed"
          setting={{ enabled: true, heldOff: false }}
          save={{ _tag: "failed", changes: { enabled: false } }}
        />
        <PrivacyFrame
          label="Held off on the server's computer (DO_NOT_TRACK, CI, or J3_TELEMETRY_ENABLED)"
          setting={{ enabled: true, heldOff: true }}
        />
        <Frame label="See what is sent" width={448} height={640}>
          <SentPanel
            titleId="gallery-usage-sent"
            sent={{ _tag: "read", events: sampleSentEvents }}
            onRetry={nothing}
            onClose={nothing}
          />
        </Frame>
        <Frame label="See what is sent: nothing yet" width={448} height={260}>
          <SentPanel
            titleId="gallery-usage-sent-empty"
            sent={{ _tag: "read", events: [] }}
            onRetry={nothing}
            onClose={nothing}
          />
        </Frame>
        <Frame label="See what is sent: the read failed" width={448} height={260}>
          <SentPanel
            titleId="gallery-usage-sent-failed"
            sent={{ _tag: "failed" }}
            onRetry={nothing}
            onClose={nothing}
          />
        </Frame>
        <DiagnosticsSheetFrame label="Diagnostics: what is in it, and Save" state="ready" />
        <DiagnosticsSheetFrame label="Diagnostics: the server makes the file" state="preparing" />
        <DiagnosticsSheetFrame label="Diagnostics: the file did not arrive" state="failed" />
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
        <Frame
          padded
          label="Limits and the day's turns, by provider and bot"
          width={420}
          height={640}
        >
          {usage(team.engine, turnsRead(team.recentTurns))}
        </Frame>
        <Frame
          padded
          label="More turns than one read: the latest, and the oldest shown"
          width={420}
          height={520}
        >
          {usage(team.engine, turnsRead(firstPage))}
        </Frame>
        <Frame padded label="Loading earlier turns" width={420} height={520}>
          {usage(team.engine, turnsRead(firstPage, { loadingMore: true }))}
        </Frame>
        <Frame padded label="The most turns shown" width={420} height={520}>
          {usage(team.engine, turnsRead({ ...firstPage, canLoadMore: false }))}
        </Frame>
        <Frame
          padded
          label="A provider at its limit; another reports none"
          width={420}
          height={640}
        >
          {usage(usageEngines.atLimit, turnsRead(team.recentTurns))}
        </Frame>
        <Frame padded label="One model at its weekly limit" width={420} height={640}>
          {usage(usageEngines.modelAtLimit, turnsRead(team.recentTurns))}
        </Frame>
        <Frame padded label="A reset passed since the last check" width={420} height={640}>
          {usage(usageEngines.resetPassed, turnsRead(team.recentTurns))}
        </Frame>
        <Frame
          padded
          label="No provider reports limits, as through a provider connection"
          width={420}
          height={520}
        >
          {usage(usageEngines.noWindows, turnsRead(team.recentTurns))}
        </Frame>
        <Frame padded label="Offline: limits and turns last known" width={420} height={640}>
          {usage(team.engine, turnsRead(team.recentTurns, { stale: true }), { engineStale: true })}
        </Frame>
        <Frame padded label="Turns loading" width={420} height={320}>
          {usage(team.engine, turnsNotRead)}
        </Frame>
        <Frame padded label="The turns couldn't be read" width={420} height={320}>
          {usage(team.engine, { ...turnsNotRead, failed: true })}
        </Frame>
        <Frame padded label="Earlier turns couldn't be read" width={420} height={520}>
          {usage(team.engine, turnsRead(firstPage, { failed: true }))}
        </Frame>
        <Frame padded label="Long names on a phone" width={320} height={640}>
          {usage(team.engine, turnsRead(longNames.turns), { roster: longNames.roster })}
        </Frame>
        <Frame padded label="The engine isn't running" width={420} height={120}>
          {usage(engines.down, turnsRead(team.recentTurns))}
        </Frame>
        <Frame padded label="No provider can run bots yet" width={420} height={200}>
          {usage(usageEngines.signedOut, turnsRead({ ...team.recentTurns, turns: [] }))}
        </Frame>
      </div>
    </Section>
  );
}

/** A bot just created: its first turn has started and nothing is in its conversation yet. */
const speakingFirst = {
  ...team.bots.moss,
  state: {
    _tag: "thinking",
    since: SAMPLE_NOW,
    stalled: false,
    typing: false,
    retrying: false,
  },
  opening: true,
} as const;

/** A bot just created on a provider not connected yet: its hello waits for it. */
const waitingFirst = { ...team.bots.moss, opening: true } as const;

/** The first run at `step`, as a phone shows it, with the engine `engine`. */
function FirstRunAt({
  step,
  engine = team.engine,
  providerSetup,
  starting = false,
  inDesktopApp = false,
}: {
  step: OnboardingStep;
  engine?: EngineStatus | null;
  providerSetup?: LocalProviderSetup;
  /** The server on this computer has not answered yet. */
  starting?: boolean;
  /** Seen from a device that reaches the desktop app's server. */
  inDesktopApp?: boolean;
}) {
  return (
    <Onboarding
      engine={engine}
      initialStep={step}
      initialName="Maya"
      providerSetup={providerSetup}
      starting={starting}
      serverUpdate={inDesktopApp ? said(serverStatuses.desktopManaged) : undefined}
      onCreate={() => Promise.resolve({ _tag: "done", value: ids.scout })}
      onArrived={arrived}
      providerActions={providerActions}
    />
  );
}

/**
 * The first run on this computer while its harnesses arrive, which they do
 * after a moment: the quiet line says the computer is ready, once, and goes.
 */
function FirstRunGettingReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const done = window.setTimeout(() => setReady(true), 3200);
    return () => window.clearTimeout(done);
  }, []);
  return (
    <FirstRunAt
      step="mind"
      engine={ready ? team.engine : engines.harnessesArriving}
      providerSetup={localSetup(harnessesFound.both)}
    />
  );
}

const arrived = () => {};
/** The engine takes every request to check a provider again. */
const providerActions = sampleProviderActions;

function FirstRunSection() {
  return (
    <Section title="First run">
      <div className="flex flex-wrap gap-4">
        <Frame label="Welcome: what J3 Bots is" width={390} height={760} replay>
          <FirstRunAt step="welcome" />
        </Frame>
        <Frame
          label="What the bots do: the light goes round, a line each"
          width={390}
          height={760}
          replay
        >
          <FirstRunAt step="work" />
        </Frame>
        <Frame label="What they think with: the lights down" width={390} height={760} replay>
          <FirstRunAt step="mind" />
        </Frame>
        <Frame label="The first bot's name, with a default" width={390} height={760} replay>
          <FirstRunAt step="name" />
        </Frame>
        <Frame label="Its look" width={390} height={760} replay>
          <FirstRunAt step="look" />
        </Frame>
        <Frame
          label="The AI, on a server: one row each, How to connect beside Not connected"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.connect} />
        </Frame>
        <Frame
          label="From a device that reaches the desktop app: How to connect says where"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.connect} inDesktopApp />
        </Frame>
        <Frame label="Claude still being checked" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.checking} />
        </Frame>
        <Frame
          label="Claude downloading: calm progress, and Create works meanwhile"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.gettingClaude} />
        </Frame>
        <Frame
          label="The download did not finish: why, Try again, and the rest under Details"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.gettingFailed} />
        </Frame>
        <Frame
          label="A machine J3 Bots downloads nothing for: its maker's page, and Look again"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.cannotGet} />
        </Frame>
        <Frame
          label="Claude found but not starting: Try again, the engine's words under Details"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.failed} />
        </Frame>
        <Frame label="Claude turned off on the server" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.disabled} />
        </Frame>
        <Frame label="Claude connected, at its usage limit" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.unusable} />
        </Frame>
        <Frame
          label="As the server starts: Claude downloading by itself, with the engine's “not found” kept off"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.bothInstalling} />
        </Frame>
        <Frame
          label="Claude's download refused while another program held it: the true reason, Try again"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.copyInUse} />
        </Frame>
        <Frame label="J3 Bots still starting: Create waits, and says so" width={390} height={760}>
          <FirstRunAt step="connect" engine={engines.downloading} />
        </Frame>
        <Frame
          label="Still starting, a download that does not say its size"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={engines.downloadingNoTotal} />
        </Frame>
        <Frame
          label="Still starting, the account already downloading beside it, as the server reports from its start"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={{
              ...engines.downloading,
              harnesses: {
                "claude-code": {
                  ...noCopy,
                  task: { _tag: "downloading", receivedBytes: 61_000_000, totalBytes: 230_000_000 },
                },
                codex: noCopy,
              },
            }}
          />
        </Frame>
        <Frame
          label="J3 Bots could not finish getting ready: a full disk, said so it can be acted on"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={{
              ...engines.installFailed,
              state: { _tag: "unavailable", reason: "install-failed", installFailure: "storage" },
              providers: [],
            }}
          />
        </Frame>
        <Frame label="J3 Bots restarting: said plainly, nothing to choose" width={390} height={760}>
          {/* As the server sends it: no provider is reported while the engine is out. */}
          <FirstRunAt step="connect" engine={{ ...engines.down, providers: [] }} />
        </Frame>
        <Frame
          label="J3 Bots cannot run bots: said plainly, its own account under Details"
          width={390}
          height={760}
        >
          <FirstRunAt step="connect" engine={{ ...engines.portInUse, providers: [] }} />
        </Frame>
        <Frame label="Connected: unmistakable" width={390} height={760}>
          <FirstRunAt step="connect" />
        </Frame>
        <Frame
          label="Its look, with a provider: create it to see it arrive"
          width={390}
          height={760}
          replay
        >
          <Onboarding
            engine={team.engine}
            initialStep="look"
            initialName="Maya"
            providerSetup={undefined}
            onCreate={() =>
              new Promise((resolve) =>
                window.setTimeout(() => resolve({ _tag: "done", value: ids.scout }), 400),
              )
            }
            onArrived={arrived}
            providerActions={providerActions}
          />
        </Frame>
        <Frame label="The arrival, saying hello" width={390} height={760} replay>
          <FirstRunAt step="arrival" />
        </Frame>
        <Frame label="The arrival, before a provider is connected" width={390} height={760}>
          <FirstRunAt step="arrival" engine={engines.connect} />
        </Frame>
        <Frame label="The whole first run, live, with a provider" width={390} height={760} replay>
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
        <Frame
          label="Preparing this computer, before its server answers"
          width={390}
          height={760}
          replay
        >
          <FirstRunAt
            step="welcome"
            engine={null}
            providerSetup={localSetup(harnessesFound.both)}
            starting
          />
        </Frame>
        <Frame
          label="Preparing: the engine and both harnesses downloading as the server starts"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="work"
            engine={engines.allArriving}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
        <Frame label="Preparing: a download that doesn't say its size" width={390} height={760}>
          <FirstRunAt
            step="name"
            engine={engines.downloadingNoTotal}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
        <Frame
          label="Preparing: the harnesses arriving, then ready, said once"
          width={390}
          height={760}
          replay
        >
          <FirstRunGettingReady />
        </Frame>
        <Frame label="Preparing a server elsewhere" width={390} height={760}>
          <FirstRunAt step="look" engine={engines.harnessesArriving} />
        </Frame>
        <Frame
          label="The AI, on a server: one row each, How to connect beside Not connected"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
        <Frame
          label="On this computer: Sign in with Claude beside Not connected"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both)}
          />
        </Frame>
        <Frame label="Opening the sign-in page" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [["claude-code", { _tag: "starting" }]])}
          />
        </Frame>
        <Frame
          label="Signing in: the browser opened by itself, Cancel beside it, the page again if it did not"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["claude-code", { _tag: "waiting-for-browser", url: signInPage, opened: false }],
            ])}
          />
        </Frame>
        <Frame label="Signed in, being checked" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["claude-code", { _tag: "succeeded", endpoint: null }],
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
        <Frame label="The sign-in timed out: why, Try again, Details" width={390} height={760}>
          <FirstRunAt
            step="connect"
            engine={engines.connect}
            providerSetup={localSetup(harnessesFound.both, [
              ["codex", { _tag: "failed", reason: "timed-out" }],
            ])}
          />
        </Frame>
        <Frame
          label="A sign-in that cannot run here: said plainly, the reason under Details"
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
        <Frame
          label="Claude downloading: press Sign in now, the browser opens when it is done"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.gettingClaude}
            providerSetup={localSetup(harnessesFound.none)}
          />
        </Frame>
        <Frame
          label="J3 Bots still starting, Claude already here: sign in meanwhile"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.downloading}
            providerSetup={localSetup(harnessesFound.claudeOnly)}
          />
        </Frame>
        <Frame
          label="Claude found but not starting, with where the log is under Details"
          width={390}
          height={760}
        >
          <FirstRunAt
            step="connect"
            engine={engines.failed}
            providerSetup={localSetup(harnessesFound.claudeOnly)}
          />
        </Frame>
        <Frame
          padded
          label="Settings: both accounts to sign in, an endpoint folded away"
          width={420}
          height={560}
        >
          <EngineSection
            engine={engines.connect}
            stale={false}
            actions={providerActions}
            connect={{ _tag: "here", setup: localSetup(harnessesFound.claudeOnly) }}
          />
        </Frame>
        <Frame
          padded
          label="Settings: Claude signed in and being checked, ChatGPT not connected"
          width={420}
          height={560}
        >
          <EngineSection
            engine={engines.connect}
            stale={false}
            actions={providerActions}
            connect={{
              _tag: "here",
              setup: localSetup(harnessesFound.both, [
                ["claude-code", { _tag: "succeeded", endpoint: null }],
              ]),
            }}
          />
        </Frame>
        <Frame
          padded
          label="Settings: a sign-in that did not finish, Try again beside why"
          width={420}
          height={560}
        >
          <EngineSection
            engine={engines.connect}
            stale={false}
            actions={providerActions}
            connect={{
              _tag: "here",
              setup: localSetup(harnessesFound.both, [
                ["codex", { _tag: "failed", reason: "timed-out" }],
              ]),
            }}
          />
        </Frame>
        <Frame
          padded
          label="Settings on another device: How to connect beside Not connected"
          width={420}
          height={560}
        >
          <EngineSection
            engine={engines.connect}
            stale={false}
            actions={providerActions}
            connect={{ _tag: "server" }}
          />
        </Frame>
        <Frame
          padded
          label="Settings: one account connected, the other signing in"
          width={420}
          height={560}
        >
          <EngineSection
            engine={team.engine}
            stale={false}
            actions={providerActions}
            connect={{
              _tag: "here",
              setup: localSetup(harnessesFound.both, [
                ["codex", { _tag: "waiting-for-browser", url: signInPage, opened: false }],
              ]),
            }}
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
        <Frame label="Wide, live, with a provider" width={1280} height={760} replay>
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
          <QuietConversation
            bot={team.bots.moss}
            engine={team.engine}
            connect={{ _tag: "server" }}
            actions={providerActions}
          />
        </Frame>
        <Frame label="A new bot, about to speak first" width={340} height={360}>
          <QuietConversation
            bot={speakingFirst}
            engine={team.engine}
            connect={{ _tag: "server" }}
            actions={providerActions}
          />
        </Frame>
        <Frame
          label="A new bot whose AI is not connected: its hello waits, with the way to connect one"
          width={340}
          height={560}
        >
          <QuietConversation
            bot={waitingFirst}
            engine={engines.connect}
            connect={{ _tag: "server" }}
            actions={providerActions}
          />
        </Frame>
        <Frame
          label="Its hello waits, on a server the desktop app runs, seen from another device"
          width={340}
          height={560}
        >
          <QuietConversation
            bot={waitingFirst}
            engine={engines.connect}
            connect={{ _tag: "desktop-app" }}
            actions={providerActions}
          />
        </Frame>
        <Frame
          label="Its hello waits, in the app on this computer: Claude signing in"
          width={340}
          height={560}
        >
          <QuietConversation
            bot={waitingFirst}
            engine={engines.connect}
            connect={{
              _tag: "here",
              setup: localSetup(harnessesFound.both, [
                ["claude-code", { _tag: "waiting-for-browser", url: signInPage, opened: false }],
              ]),
            }}
            actions={providerActions}
          />
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

/** A server on this computer that did not start, as the app reports it: its words, its fix, its last lines. */
const notStarted: LocalServerState = {
  state: "failed",
  attempt: 3,
  reason: "J3 Bots stopped three times as it started.",
  fix: "Free some space on this computer's disk, then try again.",
  logTail: [
    "starting J3 Bots 0.3.0",
    "reading the bots kept on this computer",
    "error: no space left on the disk to write the bots' data",
    "stopped",
  ].join("\n"),
};

const localLine = (server: LocalServerState): LocalLine => ({
  server,
  restartAt: server.state === "restarting" ? retryAt : null,
  onRetry: nothing,
  onDetails: nothing,
  onRetryUpdate: nothing,
});

/** An update of the server on this computer that did not become ready, rolled back as the app reports it. */
const rolledBack = {
  _tag: "rolled-back",
  running: "0.3.0",
  failed: "0.3.1",
  reason: "it stopped with exit code 1: The engine could not be started: its runtime is damaged.",
  logTail: [
    "starting J3 Bots 0.3.1",
    "moving the bots' data to 0.3.1",
    "error: the engine could not be started: its runtime is damaged",
    "stopped",
  ].join("\n"),
} satisfies ServerUpdate;

/** What "Use this computer" answers when the folder where the bots keep their data is open to others. */
const homeRefused = {
  _tag: "home-refused",
  reason:
    "Other users on this computer can open C:\\Users\\ana\\AppData\\Roaming\\J3 Bots\\server\\home, where this computer's bots keep their data and their keys.",
  fix: "In PowerShell, run `icacls 'C:\\Users\\ana\\AppData\\Roaming\\J3 Bots\\server\\home' /inheritance:r /remove:d '*S-1-5-21-1004336348-1177238915-682003330-1001' '*S-1-5-18' '*S-1-5-32-544' /grant:r '*S-1-5-21-1004336348-1177238915-682003330-1001:(OI)(CI)F' /grant:r '*S-1-5-18:(OI)(CI)F' /grant:r '*S-1-5-32-544:(OI)(CI)F' /remove '*S-1-5-32-545'`, then try again.",
} satisfies UseThisComputerResult;

/** The first screen and, on its second choice, the server address screen with a way back. */
function WhereFlow({ notice = null }: { notice?: string | null }) {
  const [where, setWhere] = useState<"choice" | "address">("choice");
  return where === "choice" ? (
    <WhereBotsLive
      notice={notice}
      onUseThisComputer={() => Promise.resolve("failed")}
      onConnectToServer={() => setWhere("address")}
    />
  ) : (
    <ServerAddress
      onConnect={() => Promise.resolve({ _tag: "refused", reason: "unreachable" })}
      onBack={() => setWhere("choice")}
    />
  );
}

const PHONE_OFF: PhoneAccess = { on: false, origins: [] };
const LAN_ORIGIN = ServerOrigin.make("http://192.168.1.20:3747");
const WIRED_ORIGIN = ServerOrigin.make("http://10.0.0.8:3747");
const PHONE_ON: PhoneAccess = { on: true, origins: [LAN_ORIGIN] };

/**
 * Phone access as the gallery fakes it: it starts at `access`; turning it on
 * or off asks first, as `bots` bots have work running (`null`: the server
 * could not say), then holds at once.
 */
const galleryPhone = (
  access: PhoneAccess,
  system: DesktopSystem,
  pairingLink: DesktopPhone["pairingLink"] = () => Promise.resolve({ _tag: "unavailable" }),
  bots: number | null = 2,
): DesktopPhone => ({
  access,
  follow: () => () => {},
  system,
  set: (on, stopWork) =>
    Promise.resolve(
      stopWork
        ? { _tag: "changed", access: on ? PHONE_ON : PHONE_OFF }
        : { _tag: "work-running", bots },
    ),
  pairingLink,
});

const grantedLink: Extract<LocalPairingLink, { readonly _tag: "granted" }> = {
  _tag: "granted",
  code: PairingCode.make("7KQ2M9XH4D"),
  expiresAt: DateTime.add(SAMPLE_NOW, { minutes: 4, seconds: 32 }),
  origins: [LAN_ORIGIN, WIRED_ORIGIN],
};

/**
 * Bots that moved from this computer the day before the sample's now,
 * leaving out their secrets, whose key was missing, and two files.
 */
const movedAway = {
  file: "/exports/j3-bots-export-2026-11-19.tar.gz",
  at: DateTime.subtract(SAMPLE_NOW, { days: 1 }),
  leftOut: {
    secrets: "unreadable",
    links: 0,
    names: 2,
    firstNames: ["bots/ana/files/report\\draft.md", "shared/memory/notes\\old.md"],
    attachmentsMissing: 0,
  },
} as const;

/**
 * Settings' section for where the bots live, alone: the rest of Settings is
 * in the shell's. `leftHere`: on a server, with the data of bots that moved
 * from this computer still here.
 */
function WhereSettings({ local, leftHere = false }: { local: boolean; leftHere?: boolean }) {
  const [startWithSystem, setStartWithSystem] = useState(false);
  return (
    <div className="flex flex-col gap-4 p-4">
      <WhereSection
        server={
          local
            ? undefined
            : {
                address: "https://j3.example.test",
                forget: () => Promise.resolve(false),
                chooseThisComputer: () => Promise.resolve("failed"),
                ...(leftHere
                  ? { leftHere: { moved: movedAway, deleteData: () => Promise.resolve(false) } }
                  : {}),
              }
        }
        local={
          local
            ? {
                stopUsing: () => Promise.resolve(false),
                moveAway: () =>
                  Promise.resolve({ _tag: "failed", reason: "There is no room left on the disk." }),
                serverUpdate: undefined,
                retryServerUpdate: nothing,
                showUpdateDetails: nothing,
                startWithSystem,
                setStartWithSystem: (on) => {
                  setStartWithSystem(on);
                  return Promise.resolve(on);
                },
                phone: galleryPhone(PHONE_OFF, "linux"),
              }
            : undefined
        }
      />
    </div>
  );
}

function WhereBotsLiveSection() {
  const { t } = useI18n();
  return (
    <Section title="Where the bots live (desktop app)">
      <Labeled label="The connection line on this computer: starting, stopped, restarting with a retry waiting, failed; updating, an update rolled back, a server newer than the app">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          {(
            [
              { state: "starting" },
              { state: "stopped" },
              { state: "restarting", attempt: 2, retryInSeconds: 30 },
              notStarted,
              { state: "starting", update: { _tag: "updating", from: "0.3.0", to: "0.3.1" } },
              { state: "ready", update: rolledBack },
              { state: "ready", update: { _tag: "older-app", running: "0.3.1", app: "0.3.0" } },
            ] satisfies ReadonlyArray<LocalServerState>
          ).map((server) => (
            <ConnectionBanner
              key={`${server.state}-${server.update?._tag ?? "none"}`}
              state={{ _tag: "connected" }}
              local={localLine(server)}
              everConnected
              onRetryNow={nothing}
            />
          ))}
        </div>
      </Labeled>
      <div className="flex flex-wrap gap-4">
        <Frame
          label="The first screen; Use this computer is refused here, to show how; Connect to a server leads to the address, with a way back"
          width={390}
          height={760}
        >
          <WhereFlow />
        </Frame>
        <Frame
          label="The first screen; Use this computer finds the bots' folder open to others here, with how to close it"
          width={390}
          height={760}
        >
          <WhereBotsLive
            onUseThisComputer={() => Promise.resolve(homeRefused)}
            onConnectToServer={nothing}
          />
        </Frame>
        <Frame label="The first screen, opened from a pairing link" width={390} height={760}>
          <WhereFlow notice={t("links.chooseFirst")} />
        </Frame>
        <Frame
          label="The first run while the bots start, with a way to a server instead"
          width={390}
          height={760}
        >
          <Onboarding
            engine={null}
            footer={<ConnectInstead onConnect={nothing} />}
            providerSetup={localSetup(harnessesFound.both)}
            starting
            onCreate={() => Promise.resolve({ _tag: "done", value: ids.scout })}
            onArrived={arrived}
            providerActions={providerActions}
          />
        </Frame>
        <Frame
          label="The first bot asked for before the bots run: create it to see it wait"
          width={390}
          height={760}
        >
          <Onboarding
            engine={team.engine}
            initialStep="look"
            initialName="Maya"
            providerSetup={localSetup(harnessesFound.both)}
            starting
            onCreate={() => new Promise(() => {})}
            onArrived={arrived}
            providerActions={providerActions}
          />
        </Frame>
        <Frame label="The bots did not start, before the first bot" width={390} height={760}>
          <LocalServerFailed
            server={notStarted}
            onRetry={nothing}
            footer={<ConnectInstead onConnect={nothing} />}
          />
        </Frame>
        <Frame
          label="The bots did not start, from the connection line once there are bots"
          width={448}
          height={420}
        >
          <div className="flex flex-col gap-3 p-5">
            <p className="text-lg font-semibold">{t("local.failed.title")}</p>
            <LocalServerFailedBody server={notStarted} onRetry={nothing} />
          </div>
        </Frame>
        <Frame
          label="An update rolled back, from the connection line: why, and Try again"
          width={448}
          height={460}
        >
          <div className="flex flex-col gap-3 p-5">
            <p className="text-lg font-semibold">
              {t("local.update.title", { failed: rolledBack.failed })}
            </p>
            <p className="text-sm text-pretty text-muted-foreground">
              {t("local.update.body", { running: rolledBack.running })}
            </p>
            <LocalServerFailedBody server={rolledBack} onRetry={nothing} />
          </div>
        </Frame>
        <Frame label="This computer was signed out (signing in fails)" width={390} height={560}>
          <LocalSignIn
            reason="signed-out"
            onSignIn={() => Promise.resolve(false)}
            footer={<StopUsingComputer quiet onStop={() => Promise.resolve(false)} />}
          />
        </Frame>
        <Frame label="This computer could not sign in" width={390} height={560}>
          <LocalSignIn
            reason="failed"
            onSignIn={() => Promise.resolve(false)}
            footer={<StopUsingComputer quiet onStop={() => Promise.resolve(false)} />}
          />
        </Frame>
        <Frame
          label="This computer's sign-in can't be read, as while a keyring is locked"
          width={390}
          height={420}
        >
          <StorageFailed
            onRetry={nothing}
            desktop={{
              _tag: "local",
              restart: nothing,
              leave: <StopUsingComputer quiet onStop={() => Promise.resolve(false)} />,
            }}
          />
        </Frame>
        <Frame label="Stopping the bots on this computer" width={390} height={360}>
          <StoppingLocal />
        </Frame>
        <Frame
          label="Settings, on this computer: Move to another server asks for the passphrase twice (and fails here); Stop using this computer asks first (and fails here)"
          width={420}
          height={300}
        >
          <WhereSettings local />
        </Frame>
        <Frame
          label="Settings, on a server: Use this computer asks first (and fails here)"
          width={420}
          height={220}
        >
          <WhereSettings local={false} />
        </Frame>
        <Frame
          label="The bots moved to another server: the file, what's next there, and the ways on (each fails here)"
          width={390}
          height={820}
        >
          <MovedAwayScreen
            moved={movedAway}
            onConnect={() => Promise.resolve(false)}
            onRunHere={() => Promise.resolve(false)}
            onDelete={() => Promise.resolve(false)}
          />
        </Frame>
        <Frame
          label="Settings, on the new server: the data the bots left on this computer, and deleting it (fails here)"
          width={420}
          height={300}
        >
          <WhereSettings local={false} leftHere />
        </Frame>
      </div>
    </Section>
  );
}

/** "Use from your phone" alone, starting at `access`, as Settings shows it on this computer. */
function PhoneSetting({
  access,
  system = "linux",
  pairingLink,
  bots,
}: {
  access: PhoneAccess;
  system?: DesktopSystem;
  pairingLink?: DesktopPhone["pairingLink"];
  bots?: number | null;
}) {
  return (
    <div className="p-4">
      <PhoneAccessSetting phone={galleryPhone(access, system, pairingLink, bots)} />
    </div>
  );
}

function PhoneAccessSection() {
  const pairing = (initial: PhonePairing) => (
    <div className="p-4">
      <PairPhone initial={initial} pairingLink={() => Promise.resolve(grantedLink)} />
    </div>
  );
  return (
    <Section title="Use from your phone (desktop app, on this computer)">
      <div className="flex flex-wrap gap-4">
        <Frame
          label="Off: turning it on asks first here, as two bots are working, then holds"
          width={420}
          height={300}
        >
          <PhoneSetting access={PHONE_OFF} />
        </Frame>
        <Frame
          label="Off: turning it on asks first here, as the server could not say whether bots are working"
          width={420}
          height={300}
        >
          <PhoneSetting access={PHONE_OFF} bots={null} />
        </Frame>
        <Frame label="Turning on: the bots restart on the network" width={420} height={300}>
          <PhoneSetting access={{ on: true, origins: [] }} />
        </Frame>
        <Frame
          label="On, on Linux: the address, Pair a phone (which shows a code), and ufw"
          width={420}
          height={460}
        >
          <PhoneSetting access={PHONE_ON} pairingLink={() => Promise.resolve(grantedLink)} />
        </Frame>
        <Frame label="On, on Windows: the firewall may ask" width={420} height={380}>
          <PhoneSetting access={PHONE_ON} system="windows" />
        </Frame>
        <Frame label="On, on macOS" width={420} height={380}>
          <PhoneSetting access={PHONE_ON} system="mac" />
        </Frame>
        <Frame
          label="Refused: this network gives the computer a public address"
          width={420}
          height={360}
        >
          <PhoneSetting access={{ on: true, origins: [], refusedReason: "public-address" }} />
        </Frame>
        <Frame
          label="Unavailable: the bots did not start on the network, and run on this computer only"
          width={420}
          height={380}
        >
          <PhoneSetting
            access={{
              on: true,
              origins: [],
              refusedReason: "unavailable",
              detail: "Port 3747 is in use on 0.0.0.0.",
            }}
          />
        </Frame>
        <Frame label="On, with no local network" width={420} height={340}>
          <PhoneSetting access={{ on: true, origins: [], refusedReason: "no-network" }} />
        </Frame>
        <Frame label="On, while the bots on this computer have stopped" width={420} height={340}>
          <PhoneSetting access={{ on: true, origins: [], refusedReason: "not-running" }} />
        </Frame>
        <Frame
          label="A code for a phone: QR, address and code typed out, the time left; two addresses to pick from"
          width={420}
          height={340}
        >
          {pairing({ _tag: "answered", link: grantedLink })}
        </Frame>
        <Frame label="A code that expired" width={420} height={140}>
          {pairing({
            _tag: "answered",
            link: { ...grantedLink, expiresAt: DateTime.subtract(SAMPLE_NOW, { seconds: 1 }) },
          })}
        </Frame>
        <Frame label="Pairing locked by wrong codes: unlock from here" width={420} height={180}>
          {pairing({
            _tag: "answered",
            link: { _tag: "locked", until: DateTime.add(SAMPLE_NOW, { minutes: 12 }) },
          })}
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

/** Settings' updates section alone, on a phone's width: the rest of Settings is in the shell's. */
function UpdatesFrame({
  label,
  server,
  app,
  local,
  height = 420,
}: {
  label: string;
  server?: RemoteServerUpdate;
  app?: DesktopUpdate;
  local?: DesktopLocal;
  height?: number;
}) {
  return (
    <Frame label={label} width={390} height={height} padded>
      <UpdatesSection server={server} app={app} local={local} onUpdate={nothing} />
    </Frame>
  );
}

/** The bots on this computer, the app having done `serverUpdate` to them. */
const localBots = (serverUpdate?: ServerUpdate): DesktopLocal => ({
  stopUsing: () => Promise.resolve(false),
  moveAway: () => Promise.resolve(null),
  serverUpdate,
  retryServerUpdate: nothing,
  showUpdateDetails: nothing,
  startWithSystem: false,
  setStartWithSystem: (on) => Promise.resolve(on),
  phone: galleryPhone(PHONE_OFF, "linux"),
});

const desktopServer = {
  address: "https://j3.example.test",
  forget: () => Promise.resolve(false),
} as const;

/** The update prompt's dialog in one state, as it shows in front of the app. */
function PromptFrame({ label, view }: { label: string; view: UpdatePromptView }) {
  return (
    <Frame label={label} width={448} height={520}>
      <div className="h-full overflow-y-auto bg-surface">
        <UpdatePromptPanel view={view} />
      </div>
    </Frame>
  );
}

function UpdatesGallerySection() {
  const s = serverStatuses;
  const source = useSampleSource();
  return (
    <Section title="Updating the server and the app" stacked>
      <div className="flex flex-wrap gap-4">
        <PromptFrame label="The prompt: the server and this app" view={promptViews.desktop} />
        <PromptFrame label="The prompt in a browser" view={promptViews.browser} />
        <PromptFrame label="The prompt: only the app, in local mode" view={promptViews.appLocal} />
        <PromptFrame label="Updating: the server" view={promptViews.updatingServer} />
        <PromptFrame label="Updating: the app, after the server" view={promptViews.updatingApp} />
        <PromptFrame
          label="Updating: the app's restart waits for a save"
          view={promptViews.appWaitingForSave}
        />
        <PromptFrame label="Bots at work on the server" view={promptViews.workRunning} />
        <PromptFrame label="The server's update rolled back" view={promptViews.serverFailed} />
        <PromptFrame label="The server updated, the app did not" view={promptViews.appFailed} />
        <PromptFrame label="Done: the app was current" view={promptViews.done} />
      </div>
      <Labeled label="The roster's footer after Later">
        <div className="w-72 rounded-md border border-border">
          <SettingsButton
            data={source.data}
            intents={{
              ...source.intents,
              serverUpdate: serverUpdate(said(s.available)),
              updatePrompt: { entry: laterEntry, reopen: nothing },
            }}
          />
        </div>
      </Labeled>
      <Labeled label="The roster's footer after the server updated: What's new is marked">
        <div className="w-72 rounded-md border border-border">
          <SettingsButton
            data={source.data}
            intents={{ ...source.intents, whatsNew: { view: whatsNewViews.marked, open: nothing } }}
          />
        </div>
      </Labeled>
      <Labeled label="The roster's footer once What's new was opened: no row until the next release">
        <div className="w-72 rounded-md border border-border">
          <SettingsButton
            data={source.data}
            intents={{ ...source.intents, whatsNew: { view: whatsNewViews.opened, open: nothing } }}
          />
        </div>
      </Labeled>
      <Labeled label="Settings → About and updates: What's new is always there">
        <div className="max-w-xl">
          <WhatsNewSection whatsNew={{ view: whatsNewViews.opened, open: nothing }} />
        </div>
      </Labeled>
      <Frame label="What's new, opened" width={576} height={640}>
        <div className="h-full overflow-y-auto bg-surface">
          <WhatsNewPage releases={whatsNewViews.opened.releases} />
        </div>
      </Frame>
      <Labeled label="The connection line while an update restarts the server">
        <div className="flex max-w-(--layout-text-column) flex-col gap-2">
          <ConnectionBanner
            state={{ _tag: "waiting", reason: "dropped", attempt: 3, retryAt }}
            updatingTo={SAMPLE_NEXT}
            everConnected
            onRetryNow={nothing}
          />
        </div>
      </Labeled>
      <div className="flex flex-wrap gap-4">
        <UpdatesFrame label="In a browser: up to date" server={serverUpdate(said(s.upToDate))} />
        <UpdatesFrame
          label="On the desktop: the server has an update, the app's is ready"
          server={serverUpdate(said(s.available))}
          app={appUpdate(appPhases.ready)}
          height={640}
        />
        <UpdatesFrame label="Checking the feed" server={serverUpdate(said(s.checking))} />
        <UpdatesFrame
          label="The feed could not be checked"
          server={serverUpdate(said(s.checkFailed))}
        />
        <UpdatesFrame label="Downloading" server={serverUpdate(said(s.downloading))} />
        <UpdatesFrame label="Verifying the signature" server={serverUpdate(said(s.verifying))} />
        <UpdatesFrame label="Installing" server={serverUpdate(said(s.installing))} />
        <UpdatesFrame
          label="Restarting: the server does not answer"
          server={serverUpdate(serverViews.restarting)}
        />
        <UpdatesFrame label="No answer for ten minutes" server={serverUpdate(serverViews.lost)} />
        <UpdatesFrame
          label="Done, as this device saw it end"
          server={serverUpdate(said(s.done), endedDone)}
        />
        <UpdatesFrame label="Done, a day later" server={serverUpdate(said(s.done))} />
        <UpdatesFrame
          label="Rolled back, with details"
          server={serverUpdate(said(s.rolledBack))}
          height={520}
        />
        <UpdatesFrame
          label="Failed, the rollback unfinished"
          server={serverUpdate(said(s.failed))}
          height={560}
        />
        <UpdatesFrame
          label="Cannot update from here: started by hand"
          server={serverUpdate(said(s.startedByHand))}
        />
        <UpdatesFrame
          label="Cannot update from here: inside the desktop app elsewhere"
          server={serverUpdate(said(s.desktopManaged))}
        />
        <UpdatesFrame
          label="Nightly, a newer one on offer"
          server={serverUpdate(said(s.nightly))}
        />
        <UpdatesFrame
          label="Moved to stable, waiting for a newer stable"
          server={serverUpdate(said(s.waitingForStable))}
        />
        <UpdatesFrame
          label="A release whose signature failed"
          server={serverUpdate(said(s.refused))}
        />
        <UpdatesFrame
          label="The app: downloading"
          app={appUpdate(appPhases.downloading)}
          height={300}
        />
        <UpdatesFrame
          label="The app: checking its download's signature"
          app={appUpdate(appPhases.verifying)}
          height={300}
        />
        <UpdatesFrame
          label="The app: the download did not match"
          app={appUpdate(appPhases.verifyFailed)}
          height={300}
        />
        <UpdatesFrame
          label="The app: its restart waits for a save"
          app={appUpdate(appPhases.waitingForSave)}
          height={300}
        />
        <UpdatesFrame
          label="The app: the install failed"
          app={appUpdate(appPhases.installFailed)}
          height={300}
        />
        <UpdatesFrame
          label="The app on nightly"
          app={appUpdate(appPhases.upToDate, { current: SAMPLE_NIGHTLY, channel: "nightly" })}
          height={300}
        />
        <UpdatesFrame
          label="The app moved to stable, waiting for a newer stable"
          app={appUpdate(appPhases.upToDate, { current: SAMPLE_NIGHTLY })}
          height={300}
        />
        <UpdatesFrame
          label="Local mode: the app updates the server it runs"
          app={appUpdate(appPhases.ready)}
          local={localBots()}
          height={320}
        />
        <UpdatesFrame
          label="Local mode: the app's update of its server was rolled back"
          app={appUpdate(appPhases.upToDate, { current: "0.3.1" })}
          local={localBots(rolledBack)}
          height={360}
        />
        <UpdatesFrame
          label="A deb or Mac build: the release to download"
          app={appUpdate(appPhases.released)}
          height={300}
        />
        <UpdatesFrame
          label="The app, not updating by itself: the restart is the operator's"
          app={appUpdate(appPhases.ready, { automatic: false })}
          height={340}
        />
      </div>
      <div className="flex flex-wrap gap-4">
        <Frame label="Updating as it starts: checking" width={390} height={360}>
          <LaunchUpdate update={appUpdate({ _tag: "checking" }, { launch: "checking" })} />
        </Frame>
        <Frame label="Updating as it starts: downloading" width={390} height={360}>
          <LaunchUpdate update={appUpdate(appPhases.downloading, { launch: "updating" })} />
        </Frame>
        <Frame label="Updating as it starts: restarting" width={390} height={360}>
          <LaunchUpdate update={appUpdate(appPhases.installing, { launch: "updating" })} />
        </Frame>
      </div>
      <div className="flex flex-wrap gap-4">
        <Frame label="Mismatch: the server is behind, one tap updates it" width={390} height={560}>
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(said(s.available))}
          />
        </Frame>
        <Frame
          label="Mismatch: the server is behind, asked to check for the release"
          width={390}
          height={560}
        >
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(said(s.upToDate), null, false)}
          />
        </Frame>
        <Frame
          label="Mismatch: the server is behind, nothing newer on its channel"
          width={390}
          height={560}
        >
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(said(s.upToDate))}
          />
        </Frame>
        <Frame label="Mismatch: the server is behind, updating" width={390} height={560}>
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(serverViews.restarting)}
          />
        </Frame>
        <Frame
          label="Mismatch: the server is behind and cannot update itself"
          width={390}
          height={560}
        >
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(said(s.startedByHand))}
          />
        </Frame>
        <Frame
          label="Mismatch: the server is behind, cannot update itself, and has nothing on offer"
          width={390}
          height={560}
        >
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "server", serverVersion: "0.3.1" }}
            serverUpdate={serverUpdate(said({ ...s.startedByHand, available: null }))}
          />
        </Frame>
        <Frame label="Mismatch: the app is behind, it updates in place" width={390} height={560}>
          <Incompatible
            server={desktopServer}
            mismatch={{ behind: "client", serverVersion: "0.5.0" }}
            update={appUpdate(appPhases.ready)}
          />
        </Frame>
        <Frame label="Mismatch in a browser: a stale page" width={390} height={360}>
          <Incompatible />
        </Frame>
      </div>
    </Section>
  );
}

/**
 * Quick access as the desktop app's small window shows it, on one bot of the
 * sample team. Where the window is see-through, a wallpaper stands in for the
 * desktop behind its corners and its shadow. "Shortcut" does what the global
 * shortcut does.
 */
/** A picture of a window, as quick access takes one: a sample drawn for the gallery. */
const WINDOW_PICTURE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
    <rect width="640" height="400" rx="10" fill="#f6f7f9"/>
    <rect width="640" height="40" rx="10" fill="#e3e6eb"/>
    <rect y="30" width="640" height="10" fill="#e3e6eb"/>
    <circle cx="22" cy="20" r="6" fill="#c9ced6"/><circle cx="42" cy="20" r="6" fill="#c9ced6"/>
    <rect x="80" y="12" width="360" height="16" rx="8" fill="#fff"/>
    <rect x="40" y="72" width="260" height="22" rx="4" fill="#3b4252"/>
    <rect x="40" y="112" width="540" height="10" rx="5" fill="#c9ced6"/>
    <rect x="40" y="132" width="500" height="10" rx="5" fill="#c9ced6"/>
    <rect x="40" y="152" width="420" height="10" rx="5" fill="#c9ced6"/>
    <rect x="40" y="196" width="560" height="160" rx="8" fill="#fff" stroke="#e3e6eb"/>
    <rect x="64" y="222" width="120" height="12" rx="6" fill="#7aa874"/>
    <rect x="64" y="250" width="480" height="10" rx="5" fill="#dfe3e8"/>
    <rect x="64" y="270" width="440" height="10" rx="5" fill="#dfe3e8"/>
  </svg>`,
)}`;

const GALLERY_WINDOW = { app: "Example Browser", title: "Invoice 2026-031 · Paid" } as const;

/** What the chips of a frame show, which a tap changes as quick access would. */
function useGalleryWindow(initial: WindowChipsView | null) {
  const [view, setView] = useState(initial);
  const picture = (next: PictureChip) =>
    setView((before) => (before === null ? null : { ...before, picture: next }));
  return view === null
    ? null
    : {
        view,
        intents: {
          removeWindow: () => setView(null),
          turnPictureOn: () => picture({ _tag: "on", url: WINDOW_PICTURE }),
          turnPictureOff: () => picture({ _tag: "off" }),
          allowScreen: () => picture({ _tag: "on", url: WINDOW_PICTURE }),
          notNow: () => picture({ _tag: "off" }),
        },
      };
}

function QuickAccessFrame({
  label,
  botId,
  solid = false,
  window: seen = null,
  preview,
}: {
  label: string;
  botId: BotId;
  solid?: boolean;
  /** The window the shortcut was pressed over, as its chips start. */
  window?: WindowChipsView | null;
  preview?: "window" | "picture";
}) {
  const source = useSampleSource();
  const [shown, setShown] = useState(true);
  const [asked, setAsked] = useState(0);
  const chips = useGalleryWindow(seen);
  const row = source.data.roster?.flatMap((item) =>
    item._tag === "bot" && item.bot.id === botId ? [item] : [],
  )[0];
  if (only.frame !== null && only.frame !== label) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <Frame label={label} width={solid ? 380 : 436} height={solid ? 580 : 612} replay>
        {!solid && (
          <div
            aria-hidden
            className="absolute inset-0 bg-[linear-gradient(160deg,#dfe9f7,#f3e9f5_55%,#fbeedd)] dark:bg-[radial-gradient(120%_90%_at_20%_10%,#23304f,#141824_55%,#0a0b10)]"
          />
        )}
        {row !== undefined && (
          <QuickAccess
            bot={row.bot}
            lastEntry={row.lastEntry}
            data={source.data}
            intents={source.intents}
            card={sampleCardIntents(source)}
            solid={solid}
            shown={shown}
            asked={asked}
            onOpenConversation={() => {}}
            onOpenPair={() => {}}
            onOpenRoom={() => {}}
            onOpenBot={() => {}}
            onClose={() => setShown(false)}
            onLeft={() => {}}
            window={
              chips === null
                ? null
                : { ...chips, ...(preview === undefined ? {} : { initialPreview: preview }) }
            }
          />
        )}
      </Frame>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setShown(!shown);
          if (!shown) setAsked(asked + 1);
        }}
      >
        Shortcut
      </Button>
    </div>
  );
}

/** What quick access reads, as the settings show it, changed in place as the app would. */
function LookingAtFrame({ label, initial }: { label: string; initial: LookingAtSettings }) {
  const [settings, setSettings] = useState(initial);
  const answer = (next: LookingAtSettings) => {
    setSettings(next);
    return Promise.resolve(next);
  };
  return (
    <Frame label={label} width={420} height={300}>
      <div className="p-4">
        <LookingAtSetting
          lookingAt={{
            settings,
            change: (change) => answer({ ...settings, ...change }),
            askScreenAccess: () => answer({ ...settings, screen: "granted" }),
          }}
        />
      </div>
    </Frame>
  );
}

function QuickAccessSection() {
  return (
    <Section title="Quick access (desktop app)">
      <div className="flex flex-wrap gap-6">
        <QuickAccessFrame
          label="Open on the primary bot while it works: its face beside its name, its conversation, the composer with the cursor"
          botId={ids.scout}
        />
        <QuickAccessFrame
          label="A bot waiting on an approval: the card is the conversation's own"
          botId={ids.atlas}
        />
        <QuickAccessFrame label="A bot at rest, with nothing said yet" botId={ids.moss} />
        <QuickAccessFrame
          label="Opened over another app: its name and window title above the composer, the picture off"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "off" } }}
        />
        <QuickAccessFrame
          label="The window chip tapped: what the bot gets, whole"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "off" } }}
          preview="window"
        />
        <QuickAccessFrame
          label="The picture turned on, tapped: what goes with the message"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "on", url: WINDOW_PICTURE } }}
          preview="picture"
        />
        <QuickAccessFrame
          label="Taking the picture"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "taking" } }}
        />
        <QuickAccessFrame
          label="No picture could be taken: a tap tries again"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "failed" } }}
        />
        <QuickAccessFrame
          label="macOS: the picture needs Screen Recording, asked as the operator turns it on; the title too, so the app shows alone"
          botId={ids.moss}
          window={{ lookingAt: { app: "Example Browser" }, picture: { _tag: "asking" } }}
        />
        <QuickAccessFrame
          label="Where no picture can be taken (Linux without a compositor): the app and title alone"
          botId={ids.moss}
          window={{ lookingAt: GALLERY_WINDOW, picture: { _tag: "none" } }}
        />
        <QuickAccessFrame
          label="Where the window is not see-through (Linux without a compositor): the card fills it, square"
          botId={ids.scout}
          solid
        />
      </div>
      <div className="mt-6 flex flex-wrap gap-4">
        <LookingAtFrame
          label="Settings: what quick access reads of the window in front, the title on and the picture off"
          initial={{ reach: "window", title: true, pictureByDefault: false, screen: "not-needed" }}
        />
        <LookingAtFrame
          label="Settings on macOS, before Screen Recording is allowed"
          initial={{ reach: "window", title: true, pictureByDefault: false, screen: "needed" }}
        />
        <LookingAtFrame
          label="Settings on Wayland, where no app sees another's window"
          initial={{ reach: "none", title: true, pictureByDefault: false, screen: "not-needed" }}
        />
      </div>
    </Section>
  );
}

/** A whole shell in a frame, with its own selection and its own copy of the sample team. */
function ShellFrame({
  initial,
  initialPair = null,
  details = false,
  browser = false,
  firstRun = false,
  engine,
}: {
  initial: RosterItemKey | null;
  /** A teammate conversation shown in place of a conversation. */
  initialPair?: PairBotIds | null;
  details?: boolean;
  /** The bot's browser open on its front tab. */
  browser?: boolean;
  firstRun?: boolean;
  engine?: EngineStatus;
}) {
  const source = useSampleSource(engine === undefined ? { firstRun } : { firstRun, engine });
  const [selected, setSelected] = useState(initial);
  const [pair, setPair] = useState<{ botIds: PairBotIds; at: EntryId | null } | null>(
    initialPair === null ? null : { botIds: initialPair, at: null },
  );
  const openPair = (botIds: PairBotIds, at: EntryId | null) => {
    setSelected(null);
    setPair({ botIds, at });
  };
  const [detailsOpen, setDetailsOpen] = useState(details);
  const [browserTarget, setBrowserTarget] = useState<BrowserTabRef | "front" | null>(
    browser ? "front" : null,
  );
  return (
    // One app, one memory of a sign-in asked for: the first run's carries into the conversation.
    <AiSessionProvider>
      <Shell
        data={source.data}
        intents={source.intents}
        browser={source.browser}
        keyboard={false}
        navigation={{
          selected,
          detailsOpen: detailsOpen && selected !== null,
          select: (key) => {
            setSelected(key);
            setPair(null);
            setBrowserTarget(null);
          },
          setDetailsOpen: (open) => {
            setDetailsOpen(open);
            if (open) setBrowserTarget(null);
          },
          browser: browserTarget,
          setBrowser: (target) => {
            setBrowserTarget(target);
            if (target !== null) setDetailsOpen(false);
          },
          rowLink: (item) =>
            rowButton(() => {
              setSelected(rowKey(item));
              setPair(null);
            }),
          pair,
          openPair,
          pairLink: (botIds) => rowButton(() => openPair(botIds, null)),
        }}
      />
    </AiSessionProvider>
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
          label="Desktop, 1280 px: a room of bots only with its details: no Edit, and it says only bots talk there"
          width={1280}
          height={760}
        >
          <ShellFrame initial={{ _tag: "room", roomId: ids.fairStands }} details />
        </Frame>
        <Frame
          label="Desktop, 1440 px: Scout's browser beside the conversation; Take control hands the page to the operator, Done gives it back"
          width={1440}
          height={800}
        >
          <ShellFrame initial={scout} browser />
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
          <Frame
            label="Phone: Scout's browser, a sheet over the conversation"
            width={390}
            height={760}
          >
            <ShellFrame initial={scout} browser />
          </Frame>
          <Frame
            label="Phone: what Scout and Wren wrote each other, read-only"
            width={390}
            height={760}
          >
            <ShellFrame initial={null} initialPair={pairBotIds(ids.scout, ids.wren)} />
          </Frame>
          <Frame
            label="Phone: a room of bots only, read-only: the bots' reactions show, none to add, and it paused at its round limit"
            width={390}
            height={760}
          >
            <ShellFrame initial={{ _tag: "room", roomId: ids.fairStands }} />
          </Frame>
        </div>
      </div>
    </Section>
  );
}
