// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecorderFace } from "@j3-bots/desktop-bridge";
import { HardDriveIcon, PauseIcon, PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../app/context";
import { BotAvatar } from "../components/avatar/BotAvatar";
import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import type { Level } from "./level";
import { LevelBars } from "./LevelBars";

/** Where a recording is, as the control shows it. */
export type PillPhase = "starting" | "recording" | "paused" | "finishing";

export interface PillProps {
  /** The bot's face, listening; `null` in a room. */
  readonly face: RecorderFace | null;
  readonly phase: PillPhase;
  /** The microphone's level; `null` when no voice is recorded. */
  readonly level: Level | null;
  /** The disk runs low: the recording stops by itself before it fills. */
  readonly space: "enough" | "low";
  /** The window is not see-through, so the control fills it. */
  readonly solid: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onDiscard: () => void;
}

const noDrag = "[-webkit-app-region:no-drag]";

/**
 * The floating control while the screens are recorded (decision 0098): the
 * bot listening, a red dot, the voice's level, and Pause or Resume, Stop and
 * Discard. No clock: what matters is that it records, not for how long. It
 * is dragged by any part that is not a button, and Discard asks once more,
 * in place, since it throws the recording away.
 */
export function Pill({
  face,
  phase,
  level,
  space,
  solid,
  onPause,
  onResume,
  onStop,
  onDiscard,
}: PillProps) {
  const { t } = useI18n();
  const [discarding, setDiscarding] = useState(false);
  const busy = phase === "starting" || phase === "finishing";
  const status =
    phase === "starting"
      ? t("recorder.starting")
      : phase === "finishing"
        ? t("recorder.finishing")
        : phase === "paused"
          ? t("recorder.paused")
          : null;
  return (
    <div
      className={cn(
        "flex h-12 items-center gap-2.5 bg-surface ps-2 pe-1.5 text-foreground [-webkit-app-region:drag]",
        solid ? "h-full w-full" : "w-full rounded-pill border border-border shadow-overlay",
      )}
    >
      {face !== null && (
        <BotAvatar
          avatar={face.avatar}
          seed={face.seed}
          state={phase === "recording" ? "listening" : "idle"}
          size={32}
        />
      )}
      <span
        role="img"
        aria-label={phase === "paused" ? t("recorder.paused") : t("recorder.recording")}
        className={cn(
          "size-2.5 shrink-0 rounded-full transition-colors duration-(--duration-state)",
          // Red while it records; an empty ring while it does not.
          phase === "recording" ? "bg-blocked" : "border-2 border-muted-foreground",
        )}
      />
      {status !== null ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{status}</span>
      ) : (
        level !== null && (
          <LevelBars level={level} label={t("recorder.voice")} className="text-muted-foreground" />
        )
      )}
      {space === "low" && (
        <span
          role="img"
          aria-label={t("recorder.lowSpace")}
          title={t("recorder.lowSpace")}
          className="flex shrink-0 text-waiting [&_svg]:size-4"
        >
          <HardDriveIcon aria-hidden />
        </span>
      )}
      <span className={cn("ms-auto flex shrink-0 items-center gap-0.5", noDrag)}>
        {discarding ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDiscarding(false)}>
              {t("recorder.keep")}
            </Button>
            <Button size="sm" variant="destructive" onClick={onDiscard}>
              {t("recorder.discard")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-disabled={busy}
              aria-label={t("recorder.discard")}
              title={t("recorder.discard")}
              onClick={() => {
                if (!busy) setDiscarding(true);
              }}
            >
              <Trash2Icon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-disabled={busy}
              aria-label={phase === "paused" ? t("recorder.resume") : t("recorder.pause")}
              title={phase === "paused" ? t("recorder.resume") : t("recorder.pause")}
              onClick={() => {
                if (phase === "paused") onResume();
                else if (phase === "recording") onPause();
              }}
            >
              {phase === "paused" ? <PlayIcon /> : <PauseIcon />}
            </Button>
            <Button
              size="icon-sm"
              variant="primary"
              aria-disabled={busy}
              aria-label={t("recorder.stop")}
              title={t("recorder.stop")}
              onClick={() => {
                if (!busy) onStop();
              }}
            >
              <SquareIcon className="fill-current" />
            </Button>
          </>
        )}
      </span>
    </div>
  );
}
