// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stdio from "effect/Stdio";
import { Command, Flag, Prompt } from "effect/cli";
import { plan, uninstall } from "../install/uninstall.ts";
import { installation } from "../installation.ts";
import * as Unit from "../service/unit.ts";
import { refuse, userFacing } from "./errors.ts";

const deleteDataFlag = Flag.Boolean("delete-data").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Also delete the data directory: every bot, conversation, memory and provider sign-in. Asks first.",
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "With --delete-data, delete it without asking, as a script needs: there is no terminal to ask on.",
  ),
);

export const uninstallCommand = Command.make("uninstall", {
  deleteData: deleteDataFlag,
  yes: yesFlag,
}).pipe(
  Command.withDescription(
    "Remove what install.sh installed: the service, the j3-bots command and every version. The data directory is kept unless --delete-data.",
  ),
  Command.withHandler(({ deleteData, yes }) =>
    Effect.gen(function* () {
      const found = yield* userFacing(plan(yield* userFacing(installation)));
      if (deleteData && !yes) {
        if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
          return yield* refuse(
            `Deleting the data directory ${found.home} needs a yes, and there is no terminal to ask on. Nothing was removed. Run this again with --yes to delete it.`,
          );
        }
        const sure = yield* Prompt.run(
          Prompt.Confirm({
            message: `Delete ${found.home} too, with every bot, conversation, memory and provider sign-in in it? This cannot be undone.`,
            initial: false,
          }),
        ).pipe(Effect.orElseSucceed(() => false));
        if (!sure) return yield* Console.log("Nothing was removed.");
      }

      const done = yield* userFacing(uninstall(found, { deleteData }));
      const lines: Array<string> = [];
      if (done.serviceRemoved) lines.push(`Stopped and removed ${Unit.UNIT_NAME}.`);
      if (Option.isSome(done.launcher)) {
        const { path, removed } = done.launcher.value;
        lines.push(
          removed
            ? `Removed the j3-bots command, ${path}.`
            : `Kept ${path}: install.sh did not write it.`,
        );
      }
      lines.push(
        done.installRemoved
          ? `Removed every version, and ${found.install}.`
          : `Removed every version. ${found.install} holds other files, so it is kept.`,
      );
      lines.push(
        done.dataDeleted
          ? `Deleted the data directory, ${found.home}.`
          : deleteData
            ? `There was no data directory at ${found.home}.`
            : `Your data in ${found.home} is kept. \`--delete-data\` deletes it.`,
      );
      yield* Console.log(lines.join("\n"));
    }),
  ),
);
