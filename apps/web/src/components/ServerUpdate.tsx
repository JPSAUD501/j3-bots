// SPDX-License-Identifier: AGPL-3.0-or-later
import { isRunning, type ServerUpdateView, type UpdateResult } from "@j3-bots/client-runtime";
import {
  type ServerUpdateLine,
  serverBehindLine,
  serverUpdateLine,
  startRefusalText,
  type UpdateTone,
  updateResultLine,
} from "@j3-bots/client-runtime/wording";
import type { ReceivedUpdateStatus } from "@j3-bots/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { RemoteServerUpdate } from "../shell/data";
import { CommandLine } from "./CommandLine";
import { UpdateChannelChoice } from "./UpdateChannelChoice";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm";

// Updating the server from this device, in the words every client shares:
// what it runs, whether a newer verified release is out on its channel, one
// button that updates it, the update's progress, and how the last one ended.
// A server that cannot update itself from here says why and what to run
// instead, never a button that cannot work.

/** What the server last said, while this device still has it to show. */
const statusOf = (view: ServerUpdateView): ReceivedUpdateStatus | null => {
  switch (view._tag) {
    case "status":
      return view.status;
    case "unreachable":
    case "restarting":
    case "lost":
      return view.last;
    case "unread":
    case "unsupported":
      return null;
  }
};

/** Whether an update is under way, by what the server said or by its silence in the middle of one. */
const underWay = (view: ServerUpdateView): boolean =>
  view._tag === "restarting" ||
  view._tag === "lost" ||
  (view._tag === "status" && isRunning(view.status.state));

/** Whether this device can update the server now, to a verified newer release. */
export const serverUpdateOffered = ({ view }: RemoteServerUpdate): boolean =>
  view._tag === "status" &&
  view.status.available !== null &&
  view.status.canUpdate._tag === "able" &&
  !isRunning(view.status.state);

/** The version a server this device follows the update of restarts on, while it does not answer. */
export const restartingTo = ({ view }: RemoteServerUpdate): string | null =>
  view._tag === "restarting" ? view.to : null;

/**
 * The last update, while it did not end on its new version and that still
 * says where the server stands: it rolled back and the server runs the
 * version it rolled back to, or its rollback did not finish. A server keeps
 * its last result after it goes back to idle, so this is what it means now.
 */
const standingResult = (status: ReceivedUpdateStatus): UpdateResult | null => {
  const result = status.lastResult;
  if (result === null) return null;
  switch (result.outcome) {
    case "rolled-back":
      return status.current.version === result.from ? result : null;
    case "failed":
      return status.canUpdate._tag === "unable" && status.canUpdate.reason === "rollback-unfinished"
        ? result
        : null;
    case "done":
    case "unknown":
      return null;
  }
};

const TONE: Record<UpdateTone, string> = {
  quiet: "text-muted-foreground",
  working: "text-muted-foreground",
  offer: "text-foreground",
  blocked: "text-foreground",
};

/** How the update stands, in the shared wording, announced as it changes: its text, what happens next, and the command to run instead. */
function Line({ line }: { line: ServerUpdateLine }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5">
      <p role="status" className={cn("text-xs", TONE[line.tone])}>
        {line.text}
      </p>
      {line.hint !== null && <p className="text-xs text-muted-foreground">{line.hint}</p>}
      {line.command !== null && (
        <CommandLine command={line.command} copyLabel={t("updates.copyCommand")} />
      )}
    </div>
  );
}

/**
 * The button that updates the server to the verified release on offer,
 * which asks first only when bots have work running, as that work stops.
 * Why the server did not start it shows under it, until it is pressed again.
 */
function UpdateServerButton({
  update,
  version,
  label,
}: {
  update: RemoteServerUpdate;
  version: string;
  label: string;
}) {
  const i18n = useI18n();
  const { t, plural } = i18n;
  const [busy, setBusy] = useState(false);
  const [runningBots, setRunningBots] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const start = (stopWork: boolean) => {
    setRefusal(null);
    setBusy(true);
    void update.start(version, stopWork).then((outcome) => {
      setBusy(false);
      switch (outcome._tag) {
        case "started":
          return;
        case "unsupported":
          return update.refresh();
        case "unreachable":
        case "not-paired":
          return setRefusal(t("serverUpdate.notReached"));
        case "refused":
          if (outcome.reason === "work-running" && !stopWork) {
            return setRunningBots(outcome.runningBots ?? 1);
          }
          update.refresh();
          return setRefusal(startRefusalText(outcome.reason, i18n));
      }
    });
  };
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button size="sm" variant="primary" disabled={busy} onClick={() => start(false)}>
        {label}
      </Button>
      {refusal !== null && (
        <p role="alert" className="text-xs text-blocked">
          {refusal}
        </p>
      )}
      <ConfirmDialog
        open={runningBots !== null}
        onOpenChange={(open) => {
          if (!open) setRunningBots(null);
        }}
        title={t("serverUpdate.stopWork.title")}
        body={plural("serverUpdate.stopWork.body", runningBots ?? 1)}
        cancel={t("serverUpdate.stopWork.cancel")}
        confirm={t("serverUpdate.stopWork.confirm")}
        tone="primary"
        onConfirm={() => start(true)}
      />
    </div>
  );
}

/**
 * How the server's update stands now, in one line, with what to do: the
 * release on offer with "What's new" and the button (Try again after it
 * rolled back), progress while it runs, or what to run on its machine.
 * With `onUpdate`, the button opens the update prompt, which updates the
 * server and then this app; without, it updates the server alone, as on the
 * screen for a server this app cannot talk to.
 */
function ServerUpdateNow({
  update,
  line,
  retry = false,
  onUpdate,
}: {
  update: RemoteServerUpdate;
  /** The line for `update`'s view; null before the status is read. */
  line: ServerUpdateLine | null;
  /** The release on offer is the one that just rolled back. */
  retry?: boolean;
  onUpdate?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  if (line === null) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("updates.server.reading")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Line line={line} />
      {line.offer !== null && (
        <>
          <a
            href={line.offer.notesUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 self-start text-xs underline underline-offset-2"
          >
            {t("serverUpdate.whatsNew")}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
          {onUpdate === undefined ? (
            <UpdateServerButton
              update={update}
              version={line.offer.version}
              label={retry ? t("local.line.update.retry") : t("serverUpdate.update")}
            />
          ) : (
            <Button size="sm" variant="primary" className="self-start" onClick={onUpdate}>
              {retry ? t("local.line.update.retry") : t("updatePrompt.update")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** How the last update ended, when it did not end on the new version, or as this device just saw it end. */
function Result({ result }: { result: UpdateResult }) {
  const i18n = useI18n();
  const line = updateResultLine(result, i18n);
  // Its sentence leads to the command, when there is one; why it ended comes after.
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs">{line.text}</p>
      {line.command !== null && (
        <CommandLine command={line.command} copyLabel={i18n.t("updates.copyCommand")} />
      )}
      {line.hint !== null && <p className="text-xs text-muted-foreground">{line.hint}</p>}
      {result.detail !== null && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{i18n.t("local.failed.details")}</summary>
          <p className="mt-1 font-mono text-2xs break-words whitespace-pre-wrap">{result.detail}</p>
        </details>
      )}
    </div>
  );
}

/**
 * The server's row in Settings: its version, how its last update ended
 * while that still matters, how its update stands now, a check, and its
 * channel.
 */
export function ServerUpdateRow({
  update,
  onUpdate,
  className,
}: {
  update: RemoteServerUpdate;
  /** Opens the update prompt; see `ServerUpdateNow`. */
  onUpdate: (() => void) | undefined;
  className?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = statusOf(update.view);
  const running = underWay(update.view);
  const standing = status === null ? null : standingResult(status);
  // The result this device saw come in shows until it is dismissed; after that, the standing one.
  const result = running ? null : (update.ended ?? standing);
  const retry =
    standing !== null && status?.available != null && standing.to === status.available.version;
  const checkable =
    update.view._tag === "unreachable" ||
    (update.view._tag === "status" &&
      !running &&
      update.view.status.state._tag !== "checking" &&
      update.view.status.available === null);
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1.5">
        {status !== null && (
          <p className="text-sm">{t("serverUpdate.runs", { version: status.current.version })}</p>
        )}
        {result !== null && <Result result={result} />}
        {/* A rollback that did not finish comes first, and its result already says what to run. */}
        {standing?.outcome !== "failed" && (
          <ServerUpdateNow
            update={update}
            line={serverUpdateLine(update.view, i18n)}
            retry={retry}
            onUpdate={onUpdate}
          />
        )}
        {checkable && (
          <Button size="sm" className="self-start" onClick={() => void update.check()}>
            {t("update.check")}
          </Button>
        )}
      </div>
      {status !== null && status.channel !== "unknown" && (
        <UpdateChannelChoice
          label={t("updateChannel.server")}
          channel={status.channel}
          onChange={update.setChannel}
          disabled={running || update.view._tag !== "status"}
          waitingForStable={null}
        />
      )}
    </div>
  );
}

/**
 * Bringing a server that is behind this app forward, on the screen that
 * says so: how its update stands and the button, what to run on its machine,
 * or that its channel has no newer release yet. The server looks for one
 * only every few hours, so it may not have seen the release this app came
 * from: the screen has it check once before it says there is none.
 */
export function ServerBehind({ update }: { update: RemoteServerUpdate }) {
  const i18n = useI18n();
  const { view, check } = update;
  const unsure =
    view._tag === "status" &&
    view.status.available === null &&
    view.status.canUpdate._tag === "able" &&
    !isRunning(view.status.state);
  const asked = useRef(false);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!unsure || asked.current) return;
    asked.current = true;
    void check().finally(() => setChecked(true));
  }, [unsure, check]);
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5 text-start">
      <ServerUpdateNow update={update} line={serverBehindLine(view, checked, i18n)} />
    </div>
  );
}
