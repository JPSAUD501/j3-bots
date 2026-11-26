// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  acrossStage,
  type AvatarState,
  type Featured,
  stageCast,
  stageLight,
  type StageScene,
} from "@j3-bots/client-runtime/presentation";
import type { AvatarChoice } from "@j3-bots/contracts";
import { stage } from "@j3-bots/design-tokens";
import { type CSSProperties, type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar";
import { cn } from "../lib/cn";
import { type Sprung, sprung } from "../lib/sprung";
import { ARRIVING } from "./handoff";
import { useReducedMotion } from "./motion";

/** The stage's height, in px, and how far above its bottom the floor is, which leaves room for the lead's name. */
const STAGE_HEIGHT = 216;
const FLOOR = 44;
/** How much higher each step upstage stands, in px. */
const UPSTAGE = 11;

/**
 * The rig: how far above a bot's feet its light starts being drawn, and how
 * far above that its lamp hangs, in px. Every lamp hangs at the same height,
 * so a small bot upstage has a narrower cone, as it would.
 */
const RIG = 304;
const LAMP_ABOVE = 28;
/**
 * The angle from the middle of a bot's cone to where its light ends, in
 * degrees: the cone is fully lit over a little more than the bot's width at
 * its feet, and falls away over as much again.
 */
const coneOf = (size: number): number =>
  Math.round(((Math.atan((size * 1.24) / (RIG + LAMP_ABOVE)) * 180) / Math.PI) * 10) / 10;

/** How large the stage is drawn for each place the camera can be. */
const cameraScale = { wide: 1, close: stage.close, finale: stage.wide } as const;

/** When each of the cast sets off, in ms from the stage first showing: the lead first, into a light already on. */
const cue = (index: number): number => stage.spotLead + index * stage.stagger;
/** How long after it sets off a bot has landed, in ms: when the floor under it darkens. */
const LANDS = 520;

/** What the stage's owner can do to its cast. */
export interface StageHandle {
  /** The bot being made answers: a key typed, a look picked, a step taken. */
  readonly lead: AvatarHandle["poke"];
}

interface StageProps {
  readonly scene: StageScene;
  /** Who has the light while the cast takes turns in it (`scene.cast` is `turns`). */
  readonly featured?: Featured;
  /** The look of the bot being made, which the lead wears. */
  readonly look: AvatarChoice;
  /** The lead's name, shown under it while the scene has it named. */
  readonly name: string;
  /** The bot exists: its light swells, and everyone cheers. */
  readonly arrived: boolean;
  readonly ref?: Ref<StageHandle>;
}

type StageVars = CSSProperties & Record<`--stage-${string}`, string>;

/** How far the fall of a cone's light is drawn down the rig: strongest under the lamp, thin at the floor. */
const fall =
  "linear-gradient(to bottom, transparent, #000 10%, rgb(0 0 0 / 0.6) 48%, rgb(0 0 0 / 0.3) 86%, transparent)";

/**
 * The first run's stage: the cast standing on a dark floor, each in its own
 * light, the bot being made at the front. It stays up for the whole first run
 * and only its set changes (`StageScene`): the light goes from one bot to the
 * next as each says what it does, the lights go down while they think, the
 * camera closes in on the lead as the others step back into the dark and
 * watch, and for the finale the lights come back up and everyone cheers.
 *
 * Each bot comes down into its light, lands and lights its antenna, which is
 * the avatar's own entrance. The camera rides `soft` on the frame loop, so a
 * scene changed before the last one settled bends into the new one. The lights
 * are layers the stylesheet draws (`.stage-light` in `index.css`): this only
 * says how each bot is lit, and they cross over as opacities and filters on
 * the `out` ease. Under reduced motion the cast is simply there, and the sets
 * only change their lights.
 */
export function Stage({ scene, featured = "all", look, name, arrived, ref }: StageProps) {
  const reduced = useReducedMotion();
  const camera = useRef<HTMLDivElement>(null);
  const travel = useRef<Sprung<"scale"> | null>(null);
  const actors = useRef(new Map<number, AvatarHandle>());
  const scale = cameraScale[scene.camera];

  useEffect(() => {
    const element = camera.current;
    if (element === null) return;
    // The first scene is where the camera starts; every later one is a move.
    if (travel.current === null) {
      travel.current = sprung({ scale }, "soft", (now) => {
        element.style.scale = String(Math.round(now.scale * 10_000) / 10_000);
      });
      travel.current.jump({ scale });
    } else travel.current.to({ scale });
  }, [scale]);
  useEffect(
    () => () => {
      travel.current?.stop();
      travel.current = null;
    },
    [],
  );

  // The finale: everyone cheers, one after another across the stage.
  useEffect(() => {
    if (!arrived) return;
    const cheers = acrossStage.map((index, turn) =>
      window.setTimeout(() => actors.current.get(index)?.poke("cheer"), turn * 110),
    );
    return () => {
      for (const cheer of cheers) window.clearTimeout(cheer);
    };
  }, [arrived]);

  // A bot whose turn in the light comes steps up to it; when it is everyone's, they all do.
  const turns = scene.cast === "turns";
  useEffect(() => {
    if (!turns) return;
    if (featured === "all") for (const actor of actors.current.values()) actor.poke("nod");
    else actors.current.get(featured)?.poke("hop");
  }, [turns, featured]);

  useImperativeHandle(ref, () => ({ lead: (poke) => actors.current.get(0)?.poke(poke) }), []);

  // Where the light a dark bot catches comes from: the bot that is lit.
  const litAt = stageCast[turns && featured !== "all" ? featured : 0]?.x ?? 50;
  const set: StageVars = {
    height: STAGE_HEIGHT,
    "--stage-rig": `${RIG}px`,
    "--stage-lamp-at": `${-Math.round((LAMP_ABOVE / RIG) * 100)}%`,
    "--stage-fall": fall,
    "--stage-spot-in": `${stage.spotIn}ms`,
    "--stage-swell": `${stage.swell}ms`,
  };
  return (
    <div
      aria-hidden
      className="stage-set pointer-events-none relative w-full shrink-0 [--avatar-cutout:var(--background)]"
      style={set}
      data-cast={scene.cast}
      data-spot={scene.spot}
      data-arrived={arrived ? "" : undefined}
    >
      <div ref={camera} className="absolute inset-0 origin-[50%_100%]">
        <span className="stage-floor" style={{ bottom: FLOOR - 26 }} />
        <span className="stage-wash" />
        {stageCast.map((actor, index) => {
          const lead = index === 0;
          const delay = cue(index);
          const light = stageLight(scene, index, featured);
          const state: AvatarState =
            scene.cast === "thinking"
              ? "thinking"
              : turns && featured === index
                ? "speaking"
                : "idle";
          const place: StageVars = {
            left: `${actor.x}%`,
            bottom: FLOOR + actor.depth * UPSTAGE,
            width: actor.size,
            zIndex: 3 - actor.depth,
            "--stage-cue": `${Math.max(0, delay - stage.spotLead)}ms`,
            "--stage-lands": `${delay + LANDS}ms`,
            "--stage-cone": `${coneOf(actor.size)}deg`,
            "--stage-spill": `${Math.sign(litAt - actor.x) * 1.5}px`,
          };
          return (
            <div
              key={`${actor.look.shape}/${actor.look.color}`}
              className={cn("stage-actor", lead && "stage-lead")}
              style={place}
              data-light={light}
            >
              <span className="stage-light">
                <span className="stage-beam" />
                {lead && (
                  <span className="stage-dust">
                    <span />
                  </span>
                )}
                <span className="stage-pool" />
              </span>
              {lead && arrived && !reduced && <span className="stage-bloom" />}
              <span className="stage-shadow" />
              <span className="stage-body pointer-events-auto">
                {/* The lead is what travels into the conversation's header once the bot is there. */}
                <span
                  className="block"
                  style={{
                    viewTransitionName: lead && arrived && !reduced ? ARRIVING : undefined,
                  }}
                >
                  <BotAvatar
                    ref={(handle) => {
                      if (handle === null) return;
                      actors.current.set(index, handle);
                      return () => {
                        actors.current.delete(index);
                      };
                    }}
                    avatar={lead ? look : actor.look}
                    seed={lead ? "first-bot" : `cast-${actor.look.shape}`}
                    state={state}
                    size={actor.size}
                    entrance={{ delay }}
                  />
                </span>
              </span>
              {lead && (
                <span
                  className="stage-name"
                  data-shown={scene.named && name !== "" ? "" : undefined}
                >
                  {name}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The cast alone, smaller, for a screen before the first run that is not one
 * of its steps, as pairing: the same bots coming down into the same lights,
 * with no set to change.
 */
export function Cast() {
  const look = stageCast[0]?.look;
  if (look === undefined) return null;
  const style: CSSProperties & Record<"--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${look.color})`,
    height: STAGE_HEIGHT * 0.76,
  };
  return (
    <div className="w-full" style={style}>
      <div className="origin-top" style={{ scale: "0.76", height: STAGE_HEIGHT }}>
        <Stage
          scene={{ camera: "wide", cast: "lit", spot: "open", named: false }}
          look={look}
          name=""
          arrived={false}
        />
      </div>
    </div>
  );
}
