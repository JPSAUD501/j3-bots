# 0052: Motion follows Palco: a stage for entrances, and motion that carries on

**Status:** Accepted. Amends the motion rules of [0018](0018-the-interface-follows-pips.md).

## Context

[Decision 0018](0018-the-interface-follows-pips.md) made the bots characters and the motion quick and springy. In use it still read as stiff next to the products the owner judges J3 Bots against, and the owner asked for three things: a first run that is "almost an interactive video", an animation when a bot or a room is created, and avatars whose idle life and answers to the pointer do not fall behind.

Three directions were prototyped. The owner chose the first, **Palco**: a dark stage, each bot coming down into a spotlight and landing with weight, text that pulls into focus, a camera that eases in. The owner also said what was wrong in the prototype, and each point was a fault of how the motion was made, not of how it was drawn:

- **It was stiff.** CSS keyframes, the Web Animations API and a hand-written loop each wrote the same transforms, and springs stepped a frame at a time could run away at a low frame rate.
- **The eye followed the pointer from anywhere.** A roster of bots all staring at a pointer on the far side of the window is not attention.
- **A click was buggy.** A poke reset the body to the start of a canned move, and pokes on top of each other added their pushes up.

0018 had rules that stood in the way of the ask: nothing plays when an avatar first appears, the eye follows the pointer wherever it is, and a spring on the web is a CSS easing, which starts again from rest when it is given a new target.

## Decision

**Motion follows the Palco direction, and whatever can be interrupted moves on the spring itself.** The [design language](../design/design-language.md#motion) describes it.

- **One place an avatar moves from.** Every part of an avatar has one channel in its model (`presentation/avatar.ts` in the client runtime): the body's height, its squash and stretch, its lean, the antenna's lag, the eye's gaze, pupil and lids, the light. A renderer draws what the model says and writes nothing of its own to those parts.
- **What an avatar does replaces what it was doing.** A hop, a happy squint, a glance around is an _act_: a few beats, each a set of targets its channels travel toward. A new act takes the place of the one under way, and each channel goes on from where it is, at the speed it has. A throw sets the body's speed and never adds to it. So nothing an avatar does resets it, and the same thing asked ten times in a second adds up to a little more than once, never to ten times.
- **Springs are solved, not stepped.** A spring's next place comes from its own solution (`springStep` in the design tokens), so a frame of any length draws the same motion and no frame rate can make it run away. The three springs of 0018 stay, with the same numbers.
- **Weight.** On the ground the body rides `pop`. Off it, it falls as a thrown thing does, at one gravity for every size, so a hop hangs a quarter of a second and an entrance a little over half. The landing's squash comes from how fast it came down, which is what "lands with weight" means.
- **The eye follows the pointer only from close by.** Within two of the avatar's own widths it has the avatar's whole attention; past three it has none; between the two the attention eases in and out, and it eases over time as well, so the eye never snaps. Close by, the body leans a little toward it and the pupil widens. On a phone a finger on the screen is the pointer.
- **A press is held, a tap is answered.** A press holds the body down, squashed; letting go lets it spring up; a tap gets one of three answers, never the one before.
- **The stage.** The first run is one stage that stays up while its set changes: the cast comes down into its lights, the camera closes in on the bot being made, each step's lines pull into focus under it, and the finale brings the lights up. On the web it is drawn dark whatever the app's appearance. A bot or a room new to the roster comes down into its row in a light of its own color.
- **What plays in a spring a CSS easing cannot interrupt well moves on the frame loop.** On the web that is the avatars, the stage's camera and the roster's rows, which travel on `translate` from their own springs. A fade, a light, and text that arrives once stay CSS, on the compositor. On Android everything runs on the UI thread through Reanimated, whose springs already carry their speed over.

### What it changes in 0018

| 0018 | Now |
| --- | --- |
| Nothing plays when an avatar first appears | An entrance plays for a bot or a room new to the roster and for the first run's cast. Nothing plays for the rows a roster loads with, or for more than three new at once |
| The eye follows the pointer | Only within about two to three of the avatar's widths, easing in and out at the edge |
| A change of state kicks the body once, as a push added to its speed | It starts an act, which replaces the one under way |
| Motion runs on three springs, drawn on the web as a CSS `linear()` easing | The same three springs; what can be interrupted is drawn from the spring's own solution on the frame loop, and the CSS easing is for what nothing interrupts |
| The body hops on `pop` | On the ground it rides `pop`; in the air it falls under gravity |

### Guard rails

0018's guard rails hold as they were: reduced motion stops every loop and every move and each state keeps its still form; an avatar off screen is not stepped; one at list size steps at half rate; at most 24 move at once; every state reads at 24 px. Two are added:

- **Motion never waits on the operator's hands, and never makes them wait.** Every control of the first run is live from its first frame. Pressing on cuts to the next scene from wherever this one is.
- **An entrance is rare.** It marks something that was just made. A list that loads, a search that changes what is listed and a section that opens show their rows at once.

## Consequences

- The avatar's model is rewritten around channels and acts, and both renderers draw from it. Its tests hold the rules above: the close radius, that taps do not add up, that what is drawn never jumps, and that the motion is the same at any frame rate and survives a frame of any length.
- On the web the roster's rows and the stage's camera cost script on each frame while they move, where a compositor animation cost none. They move for under a second at a time, and the frame loop stops when nothing moves.
- The first run looks the same in the light and the dark appearance on the web. On Android it keeps the app's appearance: its lights are the bots' colors on the app's canvas.
- A first run left mid-way starts again where it was, from what the device kept: the step, the name typed and the look picked. Nothing of it goes to the server.
- The Android side of this was written to the same model and has not run on a device. CI checks its types, lints it and runs its tests; it does not build the app.

## Rejected

**The two other prototyped directions.** The owner preferred Palco.

**Keeping CSS and the Web Animations API for moves that can be interrupted, and retargeting them from where they are drawn.** That is what the roster did. It keeps the place and loses the speed, which shows as a hitch each time a burst of changes lands, and it is the first fault the owner named.

**An eye that follows the pointer anywhere, more gently.** The fault was not how hard the eye turned but that every bot on screen turned at once.

**Stepping the springs in small fixed steps.** It bounds the error and still draws a different motion at a different frame rate, and an entrance that lands inside a frame would land late.
