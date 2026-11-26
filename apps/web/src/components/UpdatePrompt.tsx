// SPDX-License-Identifier: AGPL-3.0-or-later
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type {
  AppRelease,
  ClientFollow,
  Release,
  UpdatePlan,
  UpdatePromptEntry,
  UpdateRun,
} from "@j3-bots/client-runtime";
import { type ServerUpdateLine, serverFailureLine } from "@j3-bots/client-runtime/wording";
import { CheckIcon, DownloadIcon, ExternalLinkIcon, SparklesIcon } from "lucide-react";
import { createContext, type ReactNode, use, useId } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { CommandLine } from "./CommandLine";
import { Working } from "./EmptyStates";
import { Button } from "./ui/button";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";

// The update prompt: one dialog in front of the app when a newer release is
// ready for the server this device talks to or for the app itself, with the
// version, what it brings and one action. "Update now" updates the server
// first and this app after it (decision 0051); the dialog shows each part as
// it goes, why one did not go through, and what the operator can do then.
// "Later" puts it away for a day, and the quiet entry point brings it back.

/** What the dialog shows, as the shared runner and this platform report it. */
export interface UpdatePromptView {
  readonly open: boolean;
  readonly run: UpdateRun;
  /** The server's release on offer now. */
  readonly server: Release | null;
  /** This app's newer version ready now. */
  readonly app: AppRelease | null;
  readonly follow: ClientFollow;
  /** The app runs the bots on this computer, which its restart stops and starts again. */
  readonly local: boolean;
  /** How the server's update goes now, in the shared words. */
  readonly serverLine: ServerUpdateLine | null;
  /** How this app's update goes now. */
  readonly appLine: string | null;
  readonly updateNow: () => void;
  readonly later: () => void;
  readonly stopWork: () => void;
  readonly retry: () => void;
  readonly hide: () => void;
}

/** The ids the dialog is named and described by, which each state gives its title and sentence. */
const Ids = createContext<{ readonly title: string; readonly body: string }>({
  title: "",
  body: "",
});

export function UpdatePromptDialog({ view }: { view: UpdatePromptView }) {
  const title = useId();
  const body = useId();
  return (
    <AlertDialog.Root
      open={view.open}
      onOpenChange={(open) => {
        // Escape puts the dialog away as its secondary action does.
        if (!open) dismiss(view);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
        <AlertDialog.Popup
          aria-labelledby={title}
          aria-describedby={body}
          className={cn(alertDialog, "z-50 max-h-[85dvh] max-w-md overflow-y-auto")}
        >
          <Ids value={{ title, body }}>
            <UpdatePromptPanel view={view} />
          </Ids>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** What the dialog holds, in each state: also what the gallery shows of it. */
export function UpdatePromptPanel({ view }: { view: UpdatePromptView }) {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Body view={view} />
    </div>
  );
}

/** What putting the dialog away means in each state: Later while nothing runs, Hide while a part does. */
const dismiss = (view: UpdatePromptView) => {
  switch (view.run._tag) {
    case "server":
    case "client":
    case "done":
      return view.hide();
    case "idle":
    case "work-running":
    case "server-failed":
    case "client-failed":
      return view.later();
  }
};

function Body({ view }: { view: UpdatePromptView }) {
  const i18n = useI18n();
  const { run } = view;
  switch (run._tag) {
    case "idle":
      return <Offer view={view} />;
    case "server":
    case "client":
      return <Progress view={view} plan={run.plan} part={run._tag} />;
    case "work-running":
      return <WorkRunning view={view} side={run.side} count={run.runningBots} />;
    case "server-failed":
      return <ServerFailed view={view} line={serverFailureLine(run.failure, i18n)} />;
    case "client-failed":
      return <ClientFailed view={view} plan={run.plan} />;
    case "done":
      return <Done view={view} plan={run.plan} />;
  }
}

function Title({ children }: { children: ReactNode }) {
  const { title } = use(Ids);
  return (
    <h2 id={title} className={cn(dialogTitle, "text-2xl")}>
      {children}
    </h2>
  );
}

/** The state's sentence, which describes the dialog. */
function Description({
  children,
  alert = false,
  className,
}: {
  children: ReactNode;
  alert?: boolean;
  className?: string;
}) {
  const { body } = use(Ids);
  return (
    <p id={body} role={alert ? "alert" : undefined} className={cn("text-sm", className)}>
      {children}
    </p>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap justify-end gap-2">{children}</div>;
}

/** The release on offer: its version, what Update now does, what it brings, and the two choices. */
function Offer({ view }: { view: UpdatePromptView }) {
  const { t } = useI18n();
  const release = view.server ?? view.app;
  if (release === null) return null;
  const download = view.server === null && view.app?.how === "download";
  return (
    <>
      <span className="appear flex size-12 items-center justify-center rounded-pill bg-accent text-accent-foreground">
        <SparklesIcon aria-hidden className="size-5" />
      </span>
      <Title>
        {view.server !== null
          ? t("updatePrompt.title", { version: view.server.version })
          : t("updatePrompt.titleApp", { version: release.version })}
      </Title>
      <Description className="text-muted-foreground">{planText(view, t)}</Description>
      <Highlights release={release} />
      <div className="flex flex-col items-end gap-1.5">
        <Actions>
          <Button onClick={view.later}>{t("updatePrompt.later")}</Button>
          <Button variant="primary" onClick={view.updateNow}>
            {download && <DownloadIcon aria-hidden />}
            {download ? t("update.download") : t("updatePrompt.update")}
          </Button>
        </Actions>
        <p className="text-2xs text-muted-foreground">{t("updatePrompt.later.hint")}</p>
      </div>
    </>
  );
}

/** What Update now will do, in one sentence. */
const planText = (view: UpdatePromptView, t: ReturnType<typeof useI18n>["t"]): string => {
  if (view.server !== null) {
    switch (view.follow) {
      case "install":
        return t("updatePrompt.plan.serverThenApp", { version: view.server.version });
      case "reload":
        return t("updatePrompt.plan.serverThenPage", { version: view.server.version });
      case "none":
        return t("updatePrompt.plan.server");
    }
  }
  if (view.app?.how === "download") return t("updatePrompt.plan.download");
  return view.local ? t("updatePrompt.plan.appLocal") : t("updatePrompt.plan.app");
};

/** What the release brings, from its notes, and the way to read them all. */
function Highlights({ release }: { release: Release }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3">
      {release.highlights.length > 0 && (
        <>
          <p className="text-xs font-medium text-muted-foreground">{t("updatePrompt.whatsNew")}</p>
          <ul className="flex list-disc flex-col gap-1 ps-4 text-sm">
            {release.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        </>
      )}
      <a
        href={release.notesUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 self-start text-xs underline underline-offset-2"
      >
        {t("updatePrompt.notes")}
        <ExternalLinkIcon aria-hidden className="size-3" />
      </a>
    </div>
  );
}

type StepState = "pending" | "active" | "done";

/** One part of the sequence: its name, where it stands, and how it goes while it runs. */
function Step({ label, state, line }: { label: string; state: StepState; line: string | null }) {
  const { t } = useI18n();
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-pill",
          state === "done" && "bg-foreground text-background",
          state === "active" && "bg-accent",
          state === "pending" && "border border-border",
        )}
      >
        {state === "done" && <CheckIcon className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm", state === "pending" && "text-muted-foreground")}>
          {label}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {state === "active" && <Working />}
          {state === "done" ? t("updatePrompt.step.done") : line}
        </span>
      </span>
    </li>
  );
}

/** The sequence under way: the server, then this app, each as it goes. */
function Progress({
  view,
  plan,
  part,
}: {
  view: UpdatePromptView;
  plan: UpdatePlan;
  part: "server" | "client";
}) {
  const { t } = useI18n();
  const version = plan.server?.version ?? plan.app?.version ?? null;
  const clientLabel =
    plan.client === "reload" ? t("updatePrompt.step.page") : t("updatePrompt.step.app");
  const clientLine =
    part === "server"
      ? t("updatePrompt.step.waiting")
      : plan.client === "reload"
        ? t("updatePrompt.reloading")
        : view.appLine;
  return (
    <>
      <Title>
        {version === null
          ? t("updatePrompt.entry.running")
          : t("updatePrompt.updating", { version })}
      </Title>
      <ol role="status" className="flex flex-col gap-3">
        {plan.server !== null && (
          <Step
            label={t("updatePrompt.step.server")}
            state={part === "server" ? "active" : "done"}
            line={view.serverLine?.text ?? t("updatePrompt.starting")}
          />
        )}
        {plan.client !== null && (
          <Step
            label={clientLabel}
            state={part === "client" ? "active" : "pending"}
            line={clientLine}
          />
        )}
      </ol>
      <Actions>
        <Button onClick={view.hide}>{t("updatePrompt.hide")}</Button>
      </Actions>
    </>
  );
}

/** Bots have work running that the update would stop: later, or stop it now. */
function WorkRunning({
  view,
  side,
  count,
}: {
  view: UpdatePromptView;
  side: "server" | "client";
  /** Null when this client cannot tell yet. */
  count: number | null;
}) {
  const { t, plural } = useI18n();
  return (
    <>
      <Title>{t("updatePrompt.work.title")}</Title>
      <Description className="text-muted-foreground">
        {count === null
          ? t("updatePrompt.work.appUnknown")
          : plural(
              side === "server" ? "updatePrompt.work.server" : "updatePrompt.work.app",
              count,
            )}{" "}
        {t("updatePrompt.work.hint")}
      </Description>
      <Actions>
        <Button onClick={view.later}>{t("updatePrompt.later")}</Button>
        <Button variant="primary" onClick={view.stopWork}>
          {t("updatePrompt.work.stop")}
        </Button>
      </Actions>
    </>
  );
}

/** The server's part did not go through: why, what to run when there is something, and Try again. */
function ServerFailed({ view, line }: { view: UpdatePromptView; line: ServerUpdateLine }) {
  const { t } = useI18n();
  return (
    <>
      <Title>{t("updatePrompt.serverFailed.title")}</Title>
      <div className="flex flex-col gap-1.5">
        <Description alert>{line.text}</Description>
        {line.hint !== null && <p className="text-sm text-muted-foreground">{line.hint}</p>}
        {line.command !== null && (
          <CommandLine command={line.command} copyLabel={t("updates.copyCommand")} />
        )}
        <p className="text-xs text-muted-foreground">{t("updatePrompt.serverFailed.hint")}</p>
      </div>
      <Actions>
        <Button onClick={view.later}>{t("updatePrompt.later")}</Button>
        <Button variant="primary" onClick={view.retry}>
          {t("updatePrompt.retry")}
        </Button>
      </Actions>
    </>
  );
}

/** The server updated and this app did not: Try again its part alone. */
function ClientFailed({ view, plan }: { view: UpdatePromptView; plan: UpdatePlan }) {
  const { t } = useI18n();
  const version = plan.server?.version ?? plan.app?.version ?? "";
  return (
    <>
      <Title>{t("updatePrompt.appFailed.title", { version })}</Title>
      <Description alert className="text-muted-foreground">
        {view.appLine === null ? "" : `${view.appLine} `}
        {t("updatePrompt.appFailed.hint")}
      </Description>
      <Actions>
        <Button onClick={view.later}>{t("updatePrompt.later")}</Button>
        <Button variant="primary" onClick={view.retry}>
          {t("updatePrompt.retry")}
        </Button>
      </Actions>
    </>
  );
}

/** The server runs the new version, and this app had nothing to install. */
function Done({ view, plan }: { view: UpdatePromptView; plan: UpdatePlan }) {
  const { t } = useI18n();
  return (
    <>
      <Title>{t("updatePrompt.done.title", { version: plan.server?.version ?? "" })}</Title>
      {plan.client !== null && (
        <Description className="text-muted-foreground">{t("updatePrompt.done.body")}</Description>
      )}
      <Actions>
        <Button variant="primary" onClick={view.hide}>
          {t("updatePrompt.close")}
        </Button>
      </Actions>
    </>
  );
}

/**
 * The quiet way back to the prompt, in the roster's footer: a release waits
 * after "Later", or an update runs behind the dialog the operator put aside.
 */
export function UpdatePromptEntryButton({
  entry,
  onOpen,
}: {
  entry: UpdatePromptEntry;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <Button variant="ghost-muted" className="w-full justify-start px-2" onClick={onOpen}>
      <span aria-hidden className="size-1.5 rounded-full bg-accent" />
      {entry._tag === "offer"
        ? t("updatePrompt.entry.offer", { version: entry.version })
        : t("updatePrompt.entry.running")}
    </Button>
  );
}
