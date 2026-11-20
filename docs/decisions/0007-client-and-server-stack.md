# 0007: Client and server stack

**Status:** Proposed. This record recommends; the project owner decides.

## Server

**Recommendation:** Node and TypeScript, built on Effect: services and layers for structure, Effect Schema for every boundary, typed errors, an injectable clock. SQLite for storage.

- It is the same foundation as T3 Code, so the engine adapter can decode T3 Code's contracts with their own schemas instead of hand-written copies.
- Typed errors, schema-decoded boundaries and controllable time are the practices Roster wants anyway.

**Cost:** Effect is a large commitment with a real learning curve, and the adapter must use exactly the Effect version T3 Code pins, which ties Roster's Effect upgrades to the engine's.

**Alternative:** plain TypeScript with a small schema library and a hand-written engine client that speaks the JSON frames directly. The probe that verified the protocol was written this way in sixty lines. Less to learn, more to maintain by hand, and the engine types would be Roster's own copies.

## Clients

**Recommendation:** two interface codebases over shared logic.

- **Web** in React DOM with Tailwind and Base UI primitives. **Desktop** is Electron around the web build.
- **Mobile** in Expo with React Native components.
- Connection, state, commands, vocabulary and design tokens are shared packages. Components are not shared.

This is how T3 Code is built, and the reason holds for Roster: a desktop interface that feels right needs real DOM behavior (text selection, menus, focus, keyboard reach, a command palette), and a phone interface that feels right needs native navigation and lists. With the logic outside the components, each interface is thin.

**Cost:** every screen is built twice.

**Alternative:** one universal Expo codebase, using React Native for Web for the browser and desktop. One set of components and a faster start. The desktop experience is the one that suffers: menus, selection, keyboard handling and long-list behavior on the web would be worked around per platform, and that is where "well made" is judged.

## Order of work

The web client comes first because it is the fastest way to see a bot behave and it is installable on a phone as a PWA. Desktop follows as a shell. Mobile follows once the conversation model is stable, so its screens are built once.
