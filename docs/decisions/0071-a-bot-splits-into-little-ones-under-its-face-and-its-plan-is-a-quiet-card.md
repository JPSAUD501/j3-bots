# 0071: A bot splits into little ones under its face, and its plan is a quiet card

**Status:** Accepted. Draws what [0070](0070-a-turns-plan-and-its-little-ones-are-its-work.md) sends, under the motion rules of [0052](0052-motion-follows-palco.md).

## Context

[Decision 0070](0070-a-turns-plan-and-its-little-ones-are-its-work.md) made a turn's plan and its parallel work data of their own, sent to the turn's audience. This record is how they are drawn.

The owner asked for two things. The plan, "done well": visible while the turn runs, without opening anything, and calm. And the parallel work as the bot's own body: when the harness splits work into subagents, the bot divides like a slime into small copies of itself, which work beside the plan and come back into it. The owner's words on that: it has to be animated really well.

Three directions were prototyped as one page that plays by itself, for the owner to judge: **Pop** (the bot braces, wobbles and pops its little ones out, which land in a column under its face and jump back in), **Drip** (they slide down on long strands and are reeled back) and **Thread** (one thread from the bot, a bead of light for each). Pop was recommended and is what this record describes.

## Decision

**A bot's little ones stand in a column under its face, moved by one shared model; its plan is a short card under them with one live mark.** The [design language](../design/design-language.md#little-ones) describes both.

- **Where.** Under the line of a turn under way: first the little ones, each by one line of what it does, in the empty column under the bot's face; then the plan's card, indented to the turn's words. The family keeps to that column, so nothing ever travels over text, and what a little one does reads on the same edge as what the bot does.
- **What a little one is.** The bot's own silhouette at three quarters of its size, in its color made lighter with a rim of the color itself, a larger eye set lower, and a sprout where the antenna is. It has no name, no conversation and no result: a tap or a hover shows its line in full and how long it has worked, and nothing else.
- **Which are drawn.** Only the ones that work, four at most, and a count of the rest ("+2 more"). One that ended before this client saw it never appears. One that ends while it is drawn goes home. A turn that is over draws none.
- **The split.** The plan steps down to make room. The bot squashes and wobbles, then the little ones come out from under it one after another, each held for a moment by a strand of the bot's color that snaps; the bot springs up off each one. Each falls as a thrown thing does, lands with a squash as deep as it came down fast, and its words come in. The first out goes furthest, so none passes another.
- **The return.** Its words go, it ducks and jumps back up into the bot, passing behind the ones that stand, which look up after it. The bot stretches up to meet it, gulps, swells a little and its light glows once. The lines below close up once it has jumped.
- **A failure.** The little one turns grey, its eye shuts and its sprout falls; it keeps its line for about a second, then goes home in a jump that only just makes it. The bot takes it in with a blink and a look down, and no glow. The bot's message says what went wrong.
- **One place they move from.** The family's model is pure and shared (`presentation/littleOnes.ts` in the client runtime), as the avatar's is: each stage of a little one's life is solved, not stepped, so a frame of any length draws the same motion and a landing lands inside the frame it happens in. What the bot itself does is its own avatar's: five new acts (brace, pop, reach, gulp, sulk) and a swell, which the family asks for and the avatar's model plays, replacing whatever it was doing.
- **The plan.** A card of one-line steps: done ones checked and quiet, steps still to do ringed, and one live mark in the bot's color on the step being done, which travels from the step that ended to the one that starts on `slide`. A plan longer than six lines shows around where the bot is, with a line that counts the steps before and one for those after. When the turn ends the card folds into one line, "Plan done, 4 of 4", that opens every step, and the row's height closes on `slide`. A plan of one step is not drawn: the turn's own line already says it.
- **A room and the roster.** A room shows the same under the face and name of each member whose turn there has a plan or little ones, above the line that says who is answering. In the roster a bot that is split carries one dot by its avatar for each little one at work, four at most, and nothing more.
- **Reduced motion.** Little ones appear by their lines and leave, with no travel; the bot does not squash; one that failed is grey at its line, then gone; the live mark is on its step at once.

## Costs

- **The family's block changes height on the frame loop while it opens and closes,** which lays the conversation out on those frames, where the motion rules ask a spring to write only transforms. Holding the height still would make everything after the turn jump when a little one comes or goes; the block moves for under half a second at a time.
- **A travelling family steps on every frame** though its little ones are under the size where an avatar steps at half rate: a fall drawn on every other frame shows as jumps. At rest, bobbing, it steps at half rate like any small avatar.
- **A family takes its place among the 24 that move at once before any avatar that only idles,** though a little one is the smallest thing on screen: what is happening outranks what is breathing. On the web the bot's own face does too for a moment after it is asked to answer; on Android it does not, so on a screen where 24 avatars already move the family travels while the bot's face holds still.
- **A turn that ends takes its family with it at once.** The bot's face leaves the row as it folds into its line, so a little one still on its way home has nowhere to go. A turn normally ends after they are back.
- **Progress is not shown.** The contract carries what a little one last said of how far it got; the owner asked for the line and the time, nothing else.
- **One line each.** A little one's words and a step of the running card are cut to one line, so each line is a known height and nothing is measured to move the family or the live mark. The words show in full on a tap or a hover, and a plan's steps in full once its line is opened.
- **The Android side was written to the same model and has not run on a device.** CI checks its types, lints it and runs its tests; it does not build the app.

## Rejected

- **Drip and Thread, the two other prototyped directions.** Drip reads as slime and loses the pop and the landing; Thread is a diagram of a split, not a bot dividing.
- **The little ones beside the turn's words, thrown there in arcs.** Each arc crossed the turn's line of text on its way out and again on its way home.
- **Little ones listed under the plan step that started them.** The engine does not say which step a subagent belongs to, and a turn may split with no plan at all.
- **Keeping ended ones on screen, checked.** It would make the family a list of results; the result is the bot's to tell, in its message.
- **CSS or the Web Animations API for the travel.** A little one may be told it ended while it is still falling, and the lines move under one in the air; an easing would stop and start again each time, which is the fault [0052](0052-motion-follows-palco.md) removed.
