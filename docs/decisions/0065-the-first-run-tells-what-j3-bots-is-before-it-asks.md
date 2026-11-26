# 0065: The first run tells what J3 Bots is before it asks, in a light drawn as light

**Status:** Accepted. Amends the first run of [0052](0052-motion-follows-palco.md): its steps, its lights and its finale.

## Context

The owner sat a person who is not technical in front of 0.9.0's first run on a Windows computer. Three of the things that went wrong belong to the first run itself, the others to what it installs ([0064](0064-the-harnesses-install-as-the-server-starts-and-fail-with-the-true-reason.md)) and how it signs in (decision 0066):

- **Nothing said what J3 Bots is.** One sentence under the cast, then "What should we call your first bot?", and a few screens later it was installing Claude Code and Codex. The person did not know what a bot here is, what it would do for them, or why two programs with unfamiliar names were being installed.
- **The spotlight looked fake.** It was a trapezoid cut with a hard edge and filled with a straight gradient, ending in a line at the floor; the bots outside it were drawn see-through.
- **The arrival glitched.** Three rings spread behind the bot when it was created. Read frame by frame in the gallery, on `main`:
  - they were scaled by three things at once: their own keyframes, the bot's growth on `pop`, which overshoots, and the camera's spring pulling back, so their radius wobbled and their line thickened as they spread;
  - they were centred on the avatar's box, not on its body, and the box moved as the bot grew;
  - the last one ended about 2.1 s after the bot existed, and the conversation opened at 1.9 s, so the page's transition caught the rings mid-way and froze them;
  - a band of light crossed the whole window at the same time, over the words;
  - on Android the rings reached 55 px above the view that clips the steps, so they showed as arcs.

It also waited where it did not need to: the arrival held 1.9 s only because the rings took that long.

## Decision

**The first run opens with a story of three steps, told by the stage, before it asks anything.** Each is one idea in a few words; the motion carries it, and Continue is live from the first frame.

1. **Welcome.** The cast comes down into its lights. "A small team of bots of your own. They live on this computer, and you talk to them like people." Where the bots live elsewhere it says "on your own machine".
2. **What they do.** The light goes from one bot to the next across the stage, and each says its own line as it has it, in the first person, with its mouth: tidying files and folders, looking things up, writing and reviewing, reminding and doing things on a schedule, keeping an eye on things. The last turn is everyone's: "And we work together, in a room." It goes once round, 2.1 s a turn, and rests there.
3. **What they think with.** The lights go to one wide, cool light the whole cast shares, and every bot thinks. "They think with an AI you already have. Claude or ChatGPT. J3 Bots installs what they need for you." This is where the person learns what is being installed, before the step that connects it.

Then the name, the look, the connect step when it is needed, and the arrival, as before. Every step before the arrival has a dot in the progress, so the person sees how short it is.

**One quiet line under every step says what the server is still getting ready**, read from the status the clients already have: the engine's first download and the harnesses' copies, which start together as the server starts (0064), as one share of all of it while something downloads and the sizes are known. It holds no step back, keeps its room whether it says anything or not, and says "ready" once, only after it was seen getting ready. An install that failed or never started, or an engine that is out, is neither: the connect step says those.

**A light is drawn the way stage light is seen** ([design language](../design/design-language.md#motion)):

- a cone through the air from a lamp above the stage, brightest by the lamp, its edge a falloff across an angle, so the edge widens as the cone does;
- a little dust in the lead's cone, rising slowly;
- an oval pool where it lands, and the floor dark where the bot stands;
- on the bot, a thin bright rim along its top, where the lamp is;
- a bot with no light of its own is dark, not see-through, with an edge of the color that spills from the bot that is lit.

How each bot is lit in each scene is decided once (`stageLight` in the client runtime), and each client draws it with what it has: CSS gradients and filters on the web, `react-native-svg` and Reanimated on Android. Nothing renders per frame for it.

**The finale is one move.** Once the bot exists its light swells, wider, and settles in 0.9 s, a glow opens around the bot and goes, soft at every edge, the camera pulls back, the cast's lights come up, and everyone cheers. Nothing else on the stage is scaled while it plays, and it ends before the arrival does. The arrival holds 1.5 s.

## What it costs

- Three more presses before the first bot's name, for someone who already knows what J3 Bots is. They go through in under a second, and a first run left mid-way still starts again where it was.
- The lines the bots say change by themselves for about eleven seconds. A screen reader gets them as one list, and reduced motion shows the list with the whole cast lit.
- On the web a lit bot is drawn through a filter, so it is rasterized again while it moves. It is at most five bots of under 100 px, for a few screens.
- The Android side was written to the same model and has not run on a device, as the rest of 0052's stage.

## What was rejected

- **A page of text, or a carousel of cards, before the stage.** It is the paragraph the owner asked not to have, and it would stand between the person and the bots.
- **Explaining inside the connect step.** By then the person is being asked to do something. They should already know why.
- **A video.** It cannot be skipped a step at a time, cannot answer the person, weighs megabytes and needs a second language track.
- **A canvas or WebGL for the light.** Gradients and masks draw it without a frame loop of its own, and the same picture can be drawn on Android.
- **A progress screen for what is being installed.** It would make the person wait for something that does not need them. The story takes the time instead, and the downloads go on under it.
- **Keeping the rings, fixed.** Thin lines spreading over soft light are two ways of drawing in one picture. One move of the light itself says the same.
