# 0007: Client and server stack

**Status:** Accepted

J3 Bots uses the same stack and the same client structure as T3 Code.

## Server

Node and TypeScript, built on Effect: services and layers for structure, Effect Schema at every boundary, typed errors, an injectable clock. SQLite for storage.

- It is the same foundation as T3 Code, so the engine adapter decodes T3 Code's contracts with their own schemas instead of hand-written copies. A change in the engine's protocol then shows up as a type error in one package.
- Typed errors, schema-decoded boundaries and controllable time are practices J3 Bots wants regardless.

**Cost accepted:** Effect is a large commitment with a real learning curve. The adapter must use exactly the Effect version T3 Code pins, which ties J3 Bots' Effect upgrades to the engine's.

**Rejected:** plain TypeScript with a small schema library and a hand-written engine client. The probe that verified the protocol was written that way in sixty lines, so it works. The engine's types would be J3 Bots' own copies, kept in step by hand.

Still to verify: T3 Code's contracts package is not published and ships TypeScript source. Consuming it from outside T3 Code's monorepo is [open question 5](../open-questions.md).

## Clients

Two interface codebases over shared logic.

- **Web** in React DOM with Tailwind and Base UI primitives. **Desktop** is Electron around the web build.
- **Mobile** in Expo with React Native components.
- Connection, state, commands, vocabulary and design tokens are shared packages. Components are not shared.

A desktop interface that feels right needs real DOM behavior: text selection, menus, focus, keyboard reach, a command palette. A phone interface that feels right needs native navigation and lists. With the logic outside the components, each interface is thin.

**Cost accepted:** every screen is built twice.

**Rejected:** one universal Expo codebase with React Native for Web. One set of components and a faster start, with the desktop experience paying for it.

## Order of work

All three clients are part of the product from the start. The web client leads each milestone because it is the fastest way to see a bot behave. Desktop follows it closely as a shell around the same build. Mobile screens are built once the conversation model they render is stable.
