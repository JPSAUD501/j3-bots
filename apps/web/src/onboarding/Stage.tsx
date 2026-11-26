// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StageScene } from "@j3-bots/client-runtime/presentation";
import type { AvatarChoice } from "@j3-bots/contracts";
import { avatarCast, stage } from "@j3-bots/design-tokens";
import { type CSSProperties, type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { type AvatarHandle, BotAvatar } from "../components/avatar/BotAvatar";
import { cn } from "../lib/cn";
import { type Sprung, sprung } from "../lib/sprung";
import { ARRIVING } from "./handoff";
import { useReducedMotion } from "./motion";

interface Actor {
  readonly look: AvatarChoice;
  /** In px. */
  readonly size: number;
  /** Where it stands across the stage, in % of its width. */
  readonly x: number;
  /** How far upstage it stands: each step back is a little higher and a little dimmer. */
  readonly depth: 0 | 1 | 2;
}

/** The cast's look at `index`: the first is the one the first bot starts with. */
const at = (index: number): AvatarChoice => avatarCast[index % avatarCast.length] ?? avatarCast[0];

/** The cast: the lead at the front, in the middle, and four more around and behind it, in the order they come in. */
const cast: ReadonlyArray<Actor> = [
  { look: at(0), size: 96, x: 50, depth: 0 },
  { look: at(3), size: 60, x: 16, depth: 1 },
  { look: at(1), size: 64, x: 84, depth: 1 },
  { look: at(2), size: 50, x: 31, depth: 2 },
  { look: at(5), size: 46, x: 70, depth: 2 },
];

/** The stage's height, in px, and how far above its bottom the floor is, which leaves room for the lead's name. */
const STAGE_HEIGHT = 216;
const FLOOR = 44;
/** How much higher each step upstage stands, in px. */
const UPSTAGE = 11;

/** How large the stage is drawn for each place the camera can be. */
const cameraScale = { wide: 1, close: stage.close, finale: stage.wide } as const;

/** When each of the cast sets off, in ms from the stage first showing: the lead first, into a light already on. */
const cue = (index: number): number => stage.spotLead + index * stage.stagger;

/** What the stage's owner can do to its cast. */
export interface StageHandle {
  /** The bot being made answers: a key typed, a look picked, a step taken. */
  readonly lead: AvatarHandle["poke"];
}

interface StageProps {
  readonly scene: StageScene;
  /** The look of the bot being made, which the lead wears. */
  readonly look: AvatarChoice;
  /** The lead's name, shown under it while the scene has it named. */
  readonly name: string;
  /** The bot exists: the lead grows, rings spread from it, and everyone cheers. */
  readonly arrived: boolean;
  readonly ref?: Ref<StageHandle>;
}

/**
 * The first run's stage: the cast standing on a dark floor, each in its own
 * light, the bot being made at the front. It stays up for the whole first run
 * and only its set changes (`StageScene`): the camera closes in on the lead,
 * the others step back into the dark and watch, and for the finale the lights
 * come back up and everyone cheers.
 *
 * Each bot comes down into its light, lands and lights its antenna, which is
 * the avatar's own entrance. The camera rides `soft` on the frame loop, so a
 * scene changed before the last one settled bends into the new one. The lights
 * are opacities on the `out` ease. Under reduced motion the cast is simply
 * there, and the sets only change their lights.
 */
export function Stage({ scene, look, name, arrived, ref }: StageProps) {
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
    const order = [...cast.keys()].sort((a, b) => (cast[a]?.x ?? 0) - (cast[b]?.x ?? 0));
    const cheers = order.map((index, turn) =>
      window.setTimeout(() => actors.current.get(index)?.poke("cheer"), turn * 110),
    );
    return () => {
      for (const cheer of cheers) window.clearTimeout(cheer);
    };
  }, [arrived]);

  useImperativeHandle(ref, () => ({ lead: (poke) => actors.current.get(0)?.poke(poke) }), []);

  const rings: CSSProperties & Record<"--stage-reach", string> = {
    "--stage-reach": String(stage.rings.reach),
  };
  return (
    <div
      aria-hidden
      className="stage-set pointer-events-none relative w-full shrink-0 [--avatar-cutout:var(--background)]"
      style={{ height: STAGE_HEIGHT }}
      data-cast={scene.cast}
      data-spot={scene.spot}
    >
      <div ref={camera} className="absolute inset-0 origin-[50%_100%]">
        <span className="stage-floor" style={{ bottom: FLOOR - 26 }} />
        {cast.map((actor, index) => {
          const lead = index === 0;
          const delay = cue(index);
          const timing: CSSProperties & Record<"--stage-cue", string> = {
            "--stage-cue": `${Math.max(0, delay - stage.spotLead)}ms`,
          };
          return (
            <div
              key={`${actor.look.shape}/${actor.look.color}`}
              className={cn("stage-actor", lead && "stage-lead")}
              style={{
                left: `${actor.x}%`,
                bottom: FLOOR + actor.depth * UPSTAGE,
                width: actor.size,
                zIndex: 3 - actor.depth,
                ...timing,
              }}
              data-depth={actor.depth}
            >
              <span className="stage-spot" />
              <span
                className={cn("pointer-events-auto relative block", lead && "stage-grows")}
                data-arrived={lead && arrived ? "" : undefined}
              >
                {lead && arrived && !reduced && (
                  <span className="absolute inset-0" style={rings}>
                    {Array.from({ length: stage.rings.count }, (_, ring) => (
                      <span
                        key={ring}
                        className="stage-ring absolute inset-0 rounded-full border-2"
                        style={{
                          animationDelay: `calc(var(--duration-pop) / 2 + ${ring * stage.rings.gap}ms)`,
                          animationDuration: `${stage.rings.duration}ms`,
                        }}
                      />
                    ))}
                  </span>
                )}
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
                    state="idle"
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
  const style: CSSProperties & Record<"--onboarding-bot", string> = {
    "--onboarding-bot": `var(--bot-${at(0).color})`,
    height: STAGE_HEIGHT * 0.76,
  };
  return (
    <div className="w-full" style={style}>
      <div className="origin-top" style={{ scale: "0.76", height: STAGE_HEIGHT }}>
        <Stage
          scene={{ camera: "wide", cast: "lit", spot: "open", named: false }}
          look={at(0)}
          name=""
          arrived={false}
        />
      </div>
    </div>
  );
}
