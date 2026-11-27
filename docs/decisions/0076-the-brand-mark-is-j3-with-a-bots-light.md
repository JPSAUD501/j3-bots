# 0076: The brand mark is "j3", with a bot's light on

**Status:** Accepted.

## Context

Until now every platform's icon was one Pip, an iris loaf seen close on a black plate, drawn by the avatar's own geometry, so the icon and the bots were one design. It read badly: a close crop on a centered pupil looked like a webcam, the art was flat, and the plate cut the body off. At 16 px it needed a special case, a light grown half as large again, to keep its antenna from blurring into a line.

The project owner had four directions drawn as full icon sets, each at 512 px and with its own 16, 24, 32 and 48 px drawings, in a macOS dock, a Windows taskbar and Android launchers with their masks and themed icons: A, a Pip whole in its light; B, three Pips stacked; C, a bot splitting into little ones; and D, "j3, with its light on". The page recommended A. The owner chose **D**.

## Decision

**The brand mark is "j3" as a white lettermark in one weight on the chrome's near-black, where the dot of the j is a bot's status light. It is the icon on every platform and every surface that stands for the app; a Pip stands for a bot.**

- **Why this mark.** It is the product's chrome as a mark: near-black and white, with color only where a bot's state is, as in the app itself. A stalk with a light on top is what every bot wears, so the j reads as an antenna without drawing a robot. Two strokes and a dot hold up at 16 px where a face does not, and the mark sits as well on a favicon or a terminal as on a home screen.
- **One drawing per small size.** The art (`packages/design-tokens/src/appIconArt.ts`) holds one drawing for 16, 24, 32 and 48 px and one from 64 px up. The smaller the icon, the heavier the strokes (from 10.5 to 14.5 units of a 100-unit plate) and the more of the plate the letters fill. The glow shows from 64 px up; below 48 px the plate is one flat color and the light is a size larger and a step brighter, so it stays a dot of color.
- **Gradients in the rasterizer.** From 48 px up the plate is shaded top to bottom, and from 64 px up the light glows, as drawn. The repository's rasterizer gained linear and radial gradient fills, typed and tested, rather than flattening the art; it stays the one renderer of every icon file.
- **Where the mark replaces a Pip.** The tray (the light is what changes while something waits on the operator), the splash screen, Android's adaptive, themed and notification icons, iOS's icons, the desktop's and the web's. A notification about a bot still shows that bot's avatar, since it says who wrote; the mark stands in where there is no avatar to draw.
- **The bots do not change.** Avatars, their palette and their geometry are untouched.

## Costs

- **It has no face.** To someone non-technical, two white characters on black say "developer tool" more than "friendly helpers", and the icon no longer previews the characters the app is built around. The first run and the roster carry that instead.
- **A lowercase j.** The name is written J3; the mark reads "j3". The lowercase j is what gives the light its place.
- **Shaded layers on Android.** The adaptive icon's background is now an image, not a color, so the plate's shading survives a launcher's mask and parallax.

## Rejected

- **A, a Pip whole in its light.** The page's recommendation: it answers every complaint about the earlier icon and stays one design with the bots. It is also the quietest change, one bot and not a team, and it keeps the app's icon looking like one of the operator's bots.
- **B, three Pips stacked.** The only one that says "team", at the cost of three faces in the space of one, recognisable at 16 px by color more than by face, and a white plate that needs a hairline to hold its edge on a white window.
- **C, a bot splitting into little ones.** The idea no other product could use, but it leads with something an operator meets later, and someone who has not met little ones reads a parent and a child.
- **Flattening the glow and the shading.** The rasterizer could have drawn the art in flat colors only. A small, tested gradient fill draws it as designed, where rings of flat color would only approximate a glow.
