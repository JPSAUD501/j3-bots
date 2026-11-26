// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  GitRef,
  GitRepository,
  RepositoryPath,
  Skill,
  SkillName,
  SkillScope,
  SkillText,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Connection } from "../connection/Connection.ts";
import { Actions, type IntentResult, intentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/** A skill to install: the folder of a public git repository, at a branch, tag or commit. */
export interface SkillInstall {
  readonly scope: SkillScope;
  readonly name: SkillName;
  readonly repository: GitRepository;
  readonly path: RepositoryPath;
  readonly ref: GitRef;
}

/**
 * The skills every bot and each bot has, kept live on every socket, and the
 * operator's changes to them, which the server records as the operator's.
 * Each change carries a command id, so one that runs again on a new socket
 * changes nothing twice.
 */
export class Skills extends Context.Service<
  Skills,
  {
    readonly state: Readable<Synced<ReadonlyArray<Skill>>>;
    /** A skill's `SKILL.md`, to edit. */
    readonly read: (scope: SkillScope, name: SkillName) => Effect.Effect<IntentResult<SkillText>>;
    /** Creates the skill, or replaces its `SKILL.md`. */
    readonly save: (
      scope: SkillScope,
      name: SkillName,
      text: SkillText,
    ) => Effect.Effect<IntentResult<Skill>>;
    readonly install: (install: SkillInstall) => Effect.Effect<IntentResult<Skill>>;
    readonly remove: (scope: SkillScope, name: SkillName) => Effect.Effect<IntentResult>;
  }
>()("@j3-bots/client-runtime/stores/Skills") {}

export const layer = Layer.effect(
  Skills,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const state = new Cell<Synced<ReadonlyArray<Skill>>>(loading);

    yield* connection
      .eachSession((client) =>
        client["skills.subscribe"]().pipe(
          Stream.runForEach((skills) => Effect.sync(() => state.update(() => ready(skills)))),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const read = Effect.fn("Skills.read")(function* (scope: SkillScope, name: SkillName) {
      return yield* connection
        .call((client) => client["skill.read"]({ scope, name }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const save = Effect.fn("Skills.save")(function* (
      scope: SkillScope,
      name: SkillName,
      text: SkillText,
    ) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["skill.save"]({ commandId, scope, name, text }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const install = Effect.fn("Skills.install")(function* (input: SkillInstall) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["skill.install"]({ commandId, ...input }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    const remove = Effect.fn("Skills.remove")(function* (scope: SkillScope, name: SkillName) {
      const commandId = yield* actions.commandId;
      return yield* connection
        .call((client) => client["skill.remove"]({ commandId, scope, name }))
        .pipe(Effect.exit, Effect.map(intentResult));
    });

    return Skills.of({ state, read, save, install, remove });
  }),
);
