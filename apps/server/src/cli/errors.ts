// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import { CliError } from "effect/cli";

/**
 * A command's typed failure, shown to the operator as its own message: every
 * error a command can meet is written to be read.
 */
export const userFacing = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError(
      (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
    ),
  );

/** A failure with only a sentence to show. */
export const refuse = (message: string) =>
  new CliError.UserError({ cause: message, userMessage: message });
