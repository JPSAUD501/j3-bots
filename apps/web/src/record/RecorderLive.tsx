// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecorderCue, RecorderJob } from "@j3-bots/desktop-bridge";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from "react";
import type { Desktop } from "../live/desktop";
import { type Capture, startCapture } from "./capture";
import { streamLevel } from "./level";
import { Pill, type PillPhase } from "./Pill";

type Session =
  | { readonly _tag: "none" }
  | { readonly _tag: "failed"; readonly job: RecorderJob }
  | { readonly _tag: "started"; readonly job: RecorderJob; readonly capture: Capture };

// One recording per page: the page exists for it, and a second mount (as
// React's development checks make) finds the one already started.
let session: Promise<Session> | null = null;

const begin = (app: Desktop, onJob: (job: RecorderJob) => void): Promise<Session> => {
  session ??= app.recorder.job().then(async (job): Promise<Session> => {
    if (job === null) return { _tag: "none" };
    onJob(job);
    const started = await startCapture(job, app.recorder);
    if (started._tag === "failed") {
      app.recorder.failed(started.reason);
      return { _tag: "failed", job };
    }
    return { _tag: "started", job, capture: started.capture };
  });
  return session;
};

/** The page's background: see-through around the control, or the control's own color. */
function useRecorderPage(solid: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["recorder"] = solid ? "solid" : "clear";
    return () => {
      delete root.dataset["recorder"];
    };
  }, [solid]);
}

/**
 * The page of the recorder's floating control (decision 0098): it records
 * what the app asks, shows the control, and does what the operator presses
 * on it and what the app cues. The app destroys the window once the
 * recording is kept or thrown away.
 */
export function RecorderLive({ app, solid }: { readonly app: Desktop; readonly solid: boolean }) {
  useRecorderPage(solid);
  const [job, setJob] = useState<RecorderJob | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [phase, setPhase] = useState<PillPhase>("starting");
  const [space, setSpace] = useState<"enough" | "low">("enough");
  const voice = capture?.voice ?? null;
  const level = useMemo(() => (voice === null ? null : streamLevel(voice)), [voice]);

  useEffect(() => {
    let mounted = true;
    void begin(app, (asked) => {
      if (mounted) setJob(asked);
    }).then((started) => {
      if (!mounted || started._tag === "none") return;
      setJob(started.job);
      if (started._tag === "started") {
        setCapture(started.capture);
        setPhase("recording");
      } else {
        setPhase("finishing");
      }
    });
    return () => {
      mounted = false;
    };
  }, [app]);

  const finish = useEffectEvent((how: "stop" | "discard") => {
    if (capture === null || phase === "finishing") return;
    setPhase("finishing");
    void capture.finish(how);
  });

  const cued = useEffectEvent((cue: RecorderCue) => {
    switch (cue._tag) {
      case "frame":
        capture?.still(cue.screen, cue.name);
        return;
      case "space":
        setSpace(cue.state);
        return;
      case "stop":
        finish("stop");
        return;
    }
  });
  useEffect(() => app.recorder.onCue(cued), [app]);

  return (
    <Pill
      face={job?.face ?? null}
      phase={phase}
      level={level}
      space={space}
      solid={solid}
      onPause={() => {
        if (capture === null || phase !== "recording") return;
        capture.pause();
        setPhase("paused");
      }}
      onResume={() => {
        if (capture === null || phase !== "paused") return;
        capture.resume();
        setPhase("recording");
      }}
      onStop={() => finish("stop")}
      onDiscard={() => finish("discard")}
    />
  );
}
