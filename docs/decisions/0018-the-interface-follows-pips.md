# 0018: The interface follows Pips: lively bots on quiet chrome

**Status:** Accepted. Its motion rules are amended by [0052](0052-motion-follows-palco.md): the eye follows the pointer only from close by, an entrance plays for what was just made, and what can be interrupted moves on the spring itself.

## Context

The first design language set J3 Bots' manner after a developer tool: quiet motion that marks a change and stops, nothing that loops, avatars that are a geometric shape with an inner mark (expressly not characters with eyes), and ten muted bot colors chosen so every pair stays apart for every color vision.

It worked, and it read as a tool. The project owner judges J3 Bots against persistent-agent products whose bots feel alive: they look at you, react, and show what they are doing through their own bodies. Next to that reference, J3 Bots' bots read as status icons, not teammates. The owner had three directions prototyped and chose the first, **Pips**.

## Decision

**J3 Bots adopts the Pips direction.** Every surface follows it, and the [design language](../design/design-language.md) describes it.

- **The bots are characters.** Each is a small creature with one lens eye and an antenna, in one of twelve silhouettes and twelve vivid colors. The eye blinks, glances and follows the pointer from close by; it narrows while the bot works and widens when the bot needs the operator. The antenna's tip is the status light. The avatar carries every state, so no corner badge carries a state and there is no spinner; the one mark at an avatar's corner, the primary bot's star, names a role.
- **The chrome stays quiet**: near-monochrome, with a true-black dark canvas. The focus ring, links and the primary action are the text color; color belongs to the bots and to state.
- **Three bundled faces**: Bricolage Grotesque for display, Instrument Sans for text, JetBrains Mono for code. They ship with the app under the SIL Open Font License, and nothing loads from a font service.
- **Motion is quick and springy.** Moves run on three springs, `pop`, `soft` and `slide`, named by frequency and damping so the web and Android draw the same motion: Android as a Reanimated spring, the web as the spring's own solution for what can be interrupted and as a CSS `linear()` easing for what cannot ([0052](0052-motion-follows-palco.md)). Pressed controls go down and spring back.

### What it reverses

| Before | Now |
| --- | --- |
| Quiet motion: a change animates once and stops | Springs that overshoot a little and settle fast; avatars move while idle |
| Nothing loops at full frame rate | Avatars run a shared frame loop, under the guard rails below |
| No faces, no eyes, no blob characters | Each bot is a character with an eye and an antenna |
| A geometric shape with an inner mark for state | A silhouette, with state in the eye, the antenna and the body |
| Ten muted hues, equal in distinguishability over weight | Twelve vivid colors |
| The platform's system font, with Inter Variable shipped on the web as a fallback | Three bundled faces |

The reason is the same for each: the owner's reference is lively, and J3 Bots read as inert beside it. The developer tool's manner survives where it serves the operator: density, keyboard reach, work that is inspectable and never in the way.

### Guard rails

What the earlier rules protected still holds, by other means:

- **Reduced motion** stops every loop and every move. Each state keeps a still form that reads on its own, which is also what a notification draws.
- **Off-screen avatars pause.** One shared frame loop drives every avatar, seeded per bot so no two move in step; an avatar out of view stops, and one at list size runs at half rate.
- **A cap on how many avatars animate at once**, so a long roster cannot hold the display at full refresh rate.
- **Legibility at 24 px**: each silhouette and state reads at roster size, not only at profile size.
- **Contrast**: every text color reaches 4.5:1 on the fills it is drawn on, and focus rings and state marks 3:1, in both themes. The tokens' tests measure them.

## Consequences

- The avatar system is replaced: new silhouettes, a new palette and a new renderer on each platform, and avatar appearance changes in the contract and the server. The old shapes and colors are migrated.
- On the web the bundled faces take about 100 KB, in place of the 213 KB of Inter Variable shipped as a fallback, so the bundle shrinks. Inter was fetched only where none of the system fonts listed before it existed; the new faces are fetched on every first load, then kept by the service worker. On Android they add about 230 KB. Their license travels with every release in the third-party notices.
- Continuous avatar motion costs battery and frames that the earlier rules did not spend; the guard rails bound it, and they are part of the design, not an optimization.
- Twelve vivid colors cannot all stay apart for every color vision the way ten muted ones did. Color is never the only thing that tells two bots apart: the silhouette does too.

## Rejected

**Keeping the quiet language and adding expression only to the avatar.** It leaves the rest of the app in a different register from its bots, and the owner's judgment was about the whole.

**The two other prototyped directions.** The owner preferred Pips.
