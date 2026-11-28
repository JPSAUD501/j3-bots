# 0111: The bot's pointer moves on a model taken from cursor-motion

**Status:** Accepted for 0.17.

## Context

Until 0.16 a bot's pointer glided on one fixed ease, along a gentle curve that bent to alternate sides, and a new point mid-glide started the ease again from rest. Thinking, it bobbed up and back. It never turned: the design language said it "never tilts or wiggles". Watched closely, that read as a machine. A long move and a short one had the same shape, a retarget stopped and set off again, and a click played the moment it was sent, wherever the arrow was on its way.

[cursor-motion](https://github.com/xnmeet/cursor-motion) by xnmeet, a JavaScript port of [open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) by iFurySt, both MIT, draw an agent's pointer with a model that reads as a hand: a few candidate paths scored on how they turn, progress on a spring, a soft filter on the drawn tip, and the arrow turned by its speed. Their tuning tables were reverse-engineered from a commercial product's pointer.

## Decision

**The pointer moves on cursor-motion's method, credited, with J3 Bots' own families, weights and springs. The arrow leans into a move; nothing else of the pointer turns.**

- **One core for every drawing.** `presentation/pointerMotion.ts` in the client runtime: pure worklet functions on numbers, which the web over a server tab's pictures, the desktop tab's own page and Android all run.
- **The method, not the tables.** Seven path families (direct, lead, settle and sweep, each way) are scored on excess length, turn energy, the sharpest and the total turn, and how far a path leaves from the heading the pointer already has; the cheapest that stays 8 px inside the page wins. Progress rides a spring, ending at "close enough" and snapping to the point. The tip follows through a filter. The numbers were tuned in our own mock, at the owner's tempo: 0.45 s for the shortest move to 0.85 s across half the page. None of the reverse-engineered tables are used, and the code is our own.
- **The lean replaces "never turns".** The arrow turns on its tip, at most 24°, only past 40 px/s, never moving along its own axis, and eases back to exactly 0° at rest. The tag, the ring and the bloom stay upright. Under reduced motion it does not turn.
- **A click plays where the pointer lands,** not as it is sent. A newer point that takes the pointer elsewhere first drops it.
- **A pointer at rest draws nothing.** Every spring ends in a snap, so in the desktop tab's page, where each painted frame is a picture for whoever watches, a resting pointer sends none. There the thinking drift runs one cycle per point at most.

## Consequences

- The motion's tokens (`pointer.progressDamping`, `response`, `follow`, `lean`, `drift` and the rest) replace the glide's (`motion.glide`, `glideFor`, `eases.glide`, `pointer.bend`, `pointer.bob`).
- A followed view on a phone or the web moves on the same progress spring, in a straight line, and arrives with the pointer.
- The README credits both projects. Changing the weights or the springs is a design change, made in the tokens and the design language, never by copying another table in.
