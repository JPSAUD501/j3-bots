// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stdio from "effect/Stdio";
import { Command, Flag, Prompt } from "effect/cli";
import { type DataDeletion, plan, uninstall } from "../install/uninstall.ts";
import { installation } from "../installation.ts";
import * as Unit from "../service/unit.ts";
import { refuse, userFacing } from "./errors.ts";

const deleteDataFlag = Flag.Boolean("delete-data").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Also delete J3 Bots' data: every bot, conversation, memory and provider sign-in. Asks first.",
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "With --delete-data, delete it without asking, as a script needs: there is no terminal to ask on.",
  ),
);

/** What became of the data directory in `home`, in a sentence. */
const dataLine = (home: string, data: Option.Option<DataDeletion>) => {
  if (Option.isNone(data)) return `Your data in ${home} is kept. \`--delete-data\` deletes it.`;
  switch (data.value) {
    case "deleted":
      return `Deleted the data directory, ${home}.`;
    case "web-kept":
      return `Deleted J3 Bots' data in ${home}. The web client in its web folder is yours, so it is kept, and with it ${home}.`;
    case "kept":
      return `Deleted J3 Bots' data in ${home}. It holds other files, so it is kept.`;
    case "link-kept":
      return `Deleted J3 Bots' data in the folder ${home} links to. The link and that folder are kept.`;
    case "not-j3":
      return `${home} is not a J3 Bots data directory: no server has used it. Nothing in it was deleted.`;
    case "absent":
      return `There was no data directory at ${home}.`;
  }
};

export const uninstallCommand = Command.make("uninstall", {
  deleteData: deleteDataFlag,
  yes: yesFlag,
}).pipe(
  Command.withDescription(
    "Remove what install.sh installed: the service, the j3-bots command and the versions it unpacked. The data directory is kept unless --delete-data.",
  ),
  Command.withHandler(({ deleteData, yes }) =>
    Effect.gen(function* () {
      const found = yield* userFacing(plan(yield* userFacing(installation)));
      if (deleteData && !yes) {
        if (!(yield* (yield* Stdio.Stdio).stdinIsTerminal)) {
          return yield* refuse(
            `Deleting J3 Bots' data in ${found.home} needs a yes, and there is no terminal to ask on. Nothing was removed. Run this again with --yes to delete it.`,
          );
        }
        const sure = yield* Prompt.run(
          Prompt.Confirm({
            message: `Delete J3 Bots' data in ${found.home} too, every bot, conversation, memory and provider sign-in? This cannot be undone.`,
            initial: false,
          }),
        ).pipe(Effect.orElseSucceed(() => false));
        if (!sure) return yield* Console.log("Nothing was removed.");
      }

      const done = yield* userFacing(uninstall(found, { deleteData }));
      const lines: Array<string> = [];
      if (done.serviceRemoved) lines.push(`Stopped and removed ${Unit.UNIT_NAME}.`);
      if (Option.isSome(found.service) && !found.service.value.own) {
        lines.push(
          `Kept ${found.service.value.unitFile}: it is the service of another J3 Bots, not of this install.`,
        );
      }
      if (Option.isSome(done.launcher)) {
        const { path, state } = done.launcher.value;
        lines.push(
          state === "removed"
            ? `Removed the j3-bots command, ${path}.`
            : state === "kept"
              ? `Kept ${path}: install.sh did not write it.`
              : `There was no j3-bots command at ${path}.`,
        );
      }
      lines.push(
        done.installRemoved
          ? `Removed the installed versions, and ${found.install}.`
          : `Removed the installed versions. ${found.install} holds other files, so it is kept.`,
      );
      lines.push(dataLine(found.home, done.data));
      yield* Console.log(lines.join("\n"));
    }),
  ),
);
