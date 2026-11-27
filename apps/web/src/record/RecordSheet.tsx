// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import type {
  RecorderFace,
  RecordingCheck,
  RecordingStart,
  RecordingStartResult,
} from "@j3-bots/desktop-bridge";
import type { DeviceId, EntryTarget } from "@j3-bots/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useI18n } from "../app/context";
import { Button } from "../components/ui/button";
import { alertDialog, dialogBackdrop, dialogTitle } from "../components/ui/dialog";
import { lineField } from "../components/ui/field";
import type { Desktop } from "../live/desktop";
import { type Level, streamLevel } from "./level";
import { LevelBars } from "./LevelBars";

/** The system's default microphone, as the picker and the recorder name it. */
const DEFAULT_MICROPHONE = "default";
/** The picker's value for recording no voice. */
const NO_MICROPHONE = "";
/** Seconds counted down before the recording starts. */
const COUNT_FROM = 3;

/** A microphone the picker offers. */
export interface Microphone {
  readonly id: string;
  readonly label: string;
}

/** Why the last Start did not record. */
export type StartProblem = Exclude<RecordingStartResult, "started">;

export interface RecordSheetBodyProps {
  /** The id its title takes, which names the dialog. */
  readonly titleId: string;
  /** The bot's or the room's name. */
  readonly recipient: string;
  /** What the app says before a recording; `null` until it has. */
  readonly check: RecordingCheck | null;
  readonly microphones: ReadonlyArray<Microphone>;
  /** The picked microphone's id, `default`, or `null` for none. */
  readonly microphone: string | null;
  /** The picked microphone's level; `null` without one, or while it opens. */
  readonly level: Level | null;
  /** The picked microphone could not be opened. */
  readonly microphoneFailed: boolean;
  /** Seconds left before it records, `0` while it starts; `null` until Start. */
  readonly countdown: number | null;
  readonly problem: StartProblem | null;
  readonly onMicrophone: (id: string | null) => void;
  readonly onAskAccess: (access: "screen" | "keys") => void;
  readonly onStart: () => void;
  readonly onClose: () => void;
}

/**
 * The sheet before a recording (decision 0098): what is recorded and where
 * it goes, in plain words; the microphone, with its level live; macOS's
 * permissions while they are missing; then a 3-2-1. Every whole screen is
 * recorded, so there is nothing to pick but the microphone.
 */
export function RecordSheetBody({
  titleId,
  recipient,
  check,
  microphones,
  microphone,
  level,
  microphoneFailed,
  countdown,
  problem,
  onMicrophone,
  onAskAccess,
  onStart,
  onClose,
}: RecordSheetBodyProps) {
  const { t } = useI18n();
  const microphoneId = useId();
  const needs =
    check === null
      ? []
      : (["screen", "keys"] as const).filter((access) => check[access] !== "not-needed");
  const missing = needs.some((access) => check?.[access] === "needed");
  const blocked = check === null || check.busy || check.screen === "needed";
  // What a recording started now holds: on a Mac, keys and clicks only once Accessibility is allowed.
  const recorded =
    check?.input === "screen-and-voice"
      ? "screen-and-voice"
      : check?.keys === "needed"
        ? "without-keys"
        : "everything";
  return (
    <>
      <h2 id={titleId} className={dialogTitle}>
        {t("recordSheet.title")}
      </h2>
      {countdown !== null ? (
        <>
          {countdown === 0 ? (
            <p aria-live="assertive" className="py-9 text-center text-sm text-muted-foreground">
              {t("recorder.starting")}
            </p>
          ) : (
            <p
              aria-live="assertive"
              aria-label={t("recordSheet.countdown", { count: countdown })}
              className="display-type py-6 text-center text-6xl tabular-nums"
            >
              {countdown}
            </p>
          )}
          {/* Once it is starting, the app answers in a moment: there is nothing to cancel. */}
          {countdown > 0 && (
            <div className="flex justify-end">
              <Button onClick={onClose}>{t("recordSheet.cancel")}</Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p className="text-foreground">
              {recorded === "screen-and-voice"
                ? t("recordSheet.what.screenAndVoice")
                : recorded === "without-keys"
                  ? t("recordSheet.what.withoutKeys")
                  : t("recordSheet.what.everything")}
            </p>
            <p>{t("recordSheet.where", { name: recipient })}</p>
            <p>
              {recorded !== "everything"
                ? t("recordSheet.pauseHides")
                : check?.passwords === "pause"
                  ? t("recordSheet.passwords.pause")
                  : t("recordSheet.passwords.hidden")}
            </p>
          </div>

          {missing && (
            <section className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
              <p>{t("recordSheet.access")}</p>
              <ul className="flex flex-col gap-1.5">
                {needs.map((access) => (
                  <li key={access} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {t(
                        access === "screen"
                          ? "recordSheet.access.screen"
                          : "recordSheet.access.keys",
                      )}
                    </span>
                    {check?.[access] === "granted" ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <CheckIcon aria-hidden className="size-3.5" />
                        {t("recordSheet.access.granted")}
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onAskAccess(access)}>
                        {t("recordSheet.access.open")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t("recordSheet.access.after")}</p>
            </section>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={microphoneId} className="text-sm font-medium">
              {t("recordSheet.microphone")}
            </label>
            <div className="flex items-center gap-3">
              <select
                id={microphoneId}
                value={microphone ?? NO_MICROPHONE}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onMicrophone(value === NO_MICROPHONE ? null : value);
                }}
                className={lineField}
              >
                <option value={DEFAULT_MICROPHONE}>{t("recordSheet.microphone.default")}</option>
                {microphones.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.label}
                  </option>
                ))}
                <option value={NO_MICROPHONE}>{t("recordSheet.microphone.none")}</option>
              </select>
              <span className="flex w-8 shrink-0 justify-center text-muted-foreground">
                {level !== null && <LevelBars level={level} label={t("recorder.voice")} />}
              </span>
            </div>
            {microphoneFailed && (
              <p className="text-xs text-blocked">{t("recordSheet.microphone.failed")}</p>
            )}
          </div>

          {check?.space === "low" && (
            <p className="text-sm text-waiting">{t("recordSheet.lowSpace")}</p>
          )}
          {(problem !== null || check?.busy === true) && (
            <p role="alert" className="text-sm text-blocked">
              {t(
                problem === "space"
                  ? "recordSheet.space"
                  : problem === "failed"
                    ? "recordSheet.failed"
                    : "recordSheet.busy",
              )}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("recordSheet.cancel")}</Button>
            <Button
              variant="primary"
              aria-disabled={blocked}
              onClick={() => {
                if (!blocked) onStart();
              }}
            >
              {t("recordSheet.start")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/** The sheet as a dialog over the window, while `open`. */
function RecordSheetView({
  open,
  ...body
}: Omit<RecordSheetBodyProps, "titleId"> & { readonly open: boolean }) {
  const titleId = useId();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) body.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup aria-labelledby={titleId} className={`${alertDialog} max-w-md gap-4 p-5`}>
          <RecordSheetBody titleId={titleId} {...body} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The microphones the system lists, its default and communications aliases left to "System default". */
const listMicrophones = (t: (number: number) => string) =>
  navigator.mediaDevices.enumerateDevices().then((devices) =>
    devices
      .filter(
        (device) =>
          device.kind === "audioinput" &&
          device.deviceId !== DEFAULT_MICROPHONE &&
          device.deviceId !== "communications" &&
          device.deviceId !== "",
      )
      .map((device, index): Microphone => ({
        id: device.deviceId,
        label: device.label === "" ? t(index + 1) : device.label,
      })),
  );

/** What the sheet records for, and with what face. */
export interface RecordSheetFor {
  readonly target: EntryTarget;
  readonly pairing: DeviceId;
  readonly recipient: string;
  readonly face: RecorderFace | null;
}

/**
 * The sheet before a recording, live: it asks the app what it can record,
 * opens the picked microphone for its level, counts down, and starts. The
 * app hides its windows as the recording starts, and the sheet closes.
 */
export function RecordSheet({
  app,
  recording,
  onClose,
}: {
  readonly app: Desktop["recording"];
  /** What to record for; `null` closes the sheet. */
  readonly recording: RecordSheetFor | null;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const open = recording !== null;
  const [check, setCheck] = useState<RecordingCheck | null>(null);
  const [microphones, setMicrophones] = useState<ReadonlyArray<Microphone>>([]);
  const [microphone, setMicrophone] = useState<string | null>(DEFAULT_MICROPHONE);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [microphoneFailed, setMicrophoneFailed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [problem, setProblem] = useState<StartProblem | null>(null);
  const level = useMemo(() => (stream === null ? null : streamLevel(stream)), [stream]);

  // What the app can record, again each time the operator comes back to the
  // window, as from the system's settings.
  useEffect(() => {
    if (!open) return;
    let current = true;
    const look = () => {
      void app.check().then((answer) => {
        if (current) setCheck(answer);
      });
    };
    look();
    window.addEventListener("focus", look);
    return () => {
      current = false;
      window.removeEventListener("focus", look);
    };
  }, [app, open]);

  // The picked microphone, open while the sheet is, for its level; and the
  // system's microphones, named once one is open.
  useEffect(() => {
    if (!open || microphone === null) return;
    let current = true;
    let opened: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({
        audio: microphone === DEFAULT_MICROPHONE ? true : { deviceId: { exact: microphone } },
        video: false,
      })
      .then(
        (got) => {
          if (!current) {
            for (const track of got.getTracks()) track.stop();
            return;
          }
          opened = got;
          setStream(got);
          setMicrophoneFailed(false);
        },
        () => {
          if (current) setMicrophoneFailed(true);
        },
      )
      .then(() => listMicrophones((number) => t("recordSheet.microphone.unnamed", { number })))
      .then(
        (listed) => {
          if (current) setMicrophones(listed);
        },
        () => undefined,
      );
    return () => {
      current = false;
      if (opened !== null) for (const track of opened.getTracks()) track.stop();
      setStream(null);
    };
  }, [open, microphone, t]);

  // Closed, the next opening starts afresh.
  const close = () => {
    setCountdown(null);
    setProblem(null);
    onClose();
  };

  const start = useEffectEvent(() => {
    if (recording === null) return;
    const request: RecordingStart = {
      target: recording.target,
      pairing: recording.pairing,
      microphone: microphoneFailed ? null : microphone,
      face: recording.face,
    };
    void app.start(request).then((result) => {
      setCountdown(null);
      if (result === "started") close();
      else setProblem(result);
    });
  });
  // The app is starting the recording: closing now would not stop it.
  const dismiss = () => {
    if (countdown !== 0) close();
  };

  // 3, 2, 1, then it records.
  useEffect(() => {
    if (countdown === null || countdown === 0) return;
    const tick = window.setTimeout(() => {
      if (countdown === 1) {
        setCountdown(0);
        start();
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);
    return () => window.clearTimeout(tick);
  }, [countdown]);

  return (
    <RecordSheetView
      open={open}
      recipient={recording?.recipient ?? ""}
      check={check}
      microphones={microphones}
      microphone={microphone}
      level={level}
      microphoneFailed={microphoneFailed}
      countdown={countdown}
      problem={problem}
      onMicrophone={setMicrophone}
      onAskAccess={(access) => {
        void app.askAccess(access).then((answer) => {
          if (answer !== null) setCheck(answer);
        });
      }}
      onStart={() => {
        setProblem(null);
        setCountdown(COUNT_FROM);
      }}
      onClose={dismiss}
    />
  );
}
