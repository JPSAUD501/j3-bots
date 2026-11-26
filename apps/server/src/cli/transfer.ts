// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import * as ServerConfig from "../config.ts";
import { PASSPHRASE_MIN_LENGTH } from "../secrets/transfer.ts";
import type { ArchivedSecrets } from "../transfer/archive.ts";
import { exportHome } from "../transfer/Export.ts";
import { importHome } from "../transfer/Import.ts";
import { type ExportReport, ExportReportJson } from "../transfer/report.ts";
import { refuse, userFacing } from "./errors.ts";

// `j3-bots export` and `j3-bots import` (docs/operations/operating.md,
// "Move to another server"). Both run with the server stopped: each holds
// the data directory while it works.

/** How many times a wrong passphrase may be typed again at a terminal. */
const ATTEMPTS = 3;

/** The most bytes a passphrase on stdin may take. */
const STDIN_LIMIT = 4096;

const passphraseStdinFlag = Flag.Boolean("passphrase-stdin").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Read the passphrase from the first line of stdin instead of asking at the terminal, for a program that runs this command.",
  ),
);

/**
 * The first line of stdin, as a passphrase: read up to its end, so a program
 * that keeps stdin open after it is not waited on.
 */
const passphraseFromStdin = Effect.gen(function* () {
  const read = yield* (yield* Stdio.Stdio).stdin.pipe(
    Stream.decodeText,
    Stream.scan(
      () => "",
      (held: string, chunk: string) => held + chunk,
    ),
    Stream.takeUntil((held) => held.includes("\n") || held.length > STDIN_LIMIT),
    Stream.runLast,
    Effect.mapError(() => refuse("stdin could not be read for the passphrase.")),
  );
  const line = Option.getOrElse(read, () => "").split(/\r?\n/)[0] ?? "";
  if (line.length > STDIN_LIMIT) return yield* refuse("The passphrase on stdin is too long.");
  return Redacted.make(line);
});

/** Fails, as a command does, when there is no terminal to ask on. */
const needsTerminal = Effect.fn("transfer.needsTerminal")(function* (what: string) {
  if (yield* (yield* Stdio.Stdio).stdinIsTerminal) return;
  return yield* refuse(
    `${what} needs a passphrase, and there is no terminal to ask on. Run it at a terminal, or pass the passphrase on stdin with --passphrase-stdin.`,
  );
});

const tooShort = (typed: Redacted.Redacted<string>) =>
  Redacted.value(typed).length < PASSPHRASE_MIN_LENGTH;

/** The export's new passphrase, typed twice at the terminal, or read once from stdin. */
const newPassphrase = Effect.fn("transfer.newPassphrase")(
  function* (records: number, fromStdin: boolean) {
    if (fromStdin) {
      const typed = yield* passphraseFromStdin;
      if (tooShort(typed)) {
        return yield* refuse(
          `The passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters. Nothing was exported.`,
        );
      }
      return typed;
    }
    yield* needsTerminal("The export");
    yield* Console.log(
      [
        `The export holds ${records} secret${records === 1 ? "" : "s"}, sealed under a passphrase of its own, which the import asks for.`,
        "It cannot be recovered: without it, the secrets in the export are lost.",
      ].join("\n"),
    );
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const typed = yield* Prompt.run(
        Prompt.Hidden({
          message: "Passphrase for the export",
          validate: (value) =>
            value.length < PASSPHRASE_MIN_LENGTH
              ? Effect.fail(`At least ${PASSPHRASE_MIN_LENGTH} characters.`)
              : Effect.succeed(value),
        }),
      );
      const again = yield* Prompt.run(Prompt.Hidden({ message: "The same passphrase again" }));
      if (Redacted.value(typed) === Redacted.value(again)) return typed;
      yield* Console.log("The two passphrases differ. Type them again.");
    }
    return yield* refuse("The passphrases differed each time. Nothing was exported.");
  },
  Effect.catchTag("QuitError", () => Effect.fail(refuse("Nothing was exported."))),
);

/** The passphrase an import asks for, at the terminal or from stdin. */
const askPassphrase = (fromStdin: boolean) =>
  fromStdin
    ? passphraseFromStdin
    : needsTerminal("The import").pipe(
        Effect.andThen(Prompt.run(Prompt.Hidden({ message: "The export's passphrase" }))),
        Effect.catchTag("QuitError", () => Effect.fail(refuse("Nothing was imported."))),
      );

/** What became of the secrets, in a line. */
const secretsLine = (secrets: ArchivedSecrets, verb: "exported" | "imported") => {
  switch (secrets._tag) {
    case "none":
      return "There were no secrets.";
    case "sealed":
      return verb === "exported"
        ? `${secrets.records} secret${secrets.records === 1 ? "" : "s"}, sealed under the passphrase.`
        : `${secrets.records} secret${secrets.records === 1 ? "" : "s"}, sealed again under this server's key.`;
    case "left-out":
      switch (secrets.reason) {
        case "old-vault":
          return "The secrets were left out: they are in an old vault that waits for its password. Unlock it on that server, then export again.";
        case "unreadable":
          return "The secrets were left out: the key they are sealed under is missing or another one.";
        case "newer":
          return "The secrets were left out: a newer release of J3 Bots changed them.";
      }
  }
};

const outputFlag = Flag.String("output").pipe(
  Flag.withDescription(
    "The file to write the export to, which must not exist yet. When left out, j3-bots-export-<date>.tar.gz in this folder.",
  ),
  Flag.optional,
);

const reportFlag = Flag.String("report").pipe(
  Flag.withDescription(
    "Also write what the export holds and left out to this file, as JSON, for a program that runs this command. It holds no secret.",
  ),
  Flag.optional,
);

const encodeReport = Schema.encodeEffect(ExportReportJson);

/** Writes the export's report where `--report` names, once the archive is in place. */
const writeReport = Effect.fn("transfer.writeReport")(function* (
  to: string,
  archive: string,
  report: ExportReport,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.resolve(to);
  yield* encodeReport(report).pipe(
    Effect.flatMap((json) => fs.writeFileString(file, json)),
    Effect.mapError(() =>
      refuse(`The export is at ${archive}, but its report could not be written to ${file}.`),
    ),
  );
});

export const exportCommand = Command.make("export", {
  output: outputFlag,
  passphraseStdin: passphraseStdinFlag,
  report: reportFlag,
}).pipe(
  Command.withDescription(
    "Write the bots, their conversations, memory, skills and files, the shared memory and skills, the attachments and the secrets to one file, for `j3-bots import` on another server. The secrets are sealed under a passphrase of the export's own. Paired devices, provider sign-ins and the configuration stay here. The server must be stopped.",
  ),
  Command.withHandler(({ output, passphraseStdin, report }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* userFacing(ServerConfig.resolveHome);
      const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
      const file = path.resolve(Option.getOrElse(output, () => `j3-bots-export-${today}.tar.gz`));
      const done = yield* userFacing(
        exportHome({
          home,
          file,
          passphrase: (records) => newPassphrase(records, passphraseStdin),
        }),
      );
      if (Option.isSome(report)) {
        yield* writeReport(report.value, done.file, {
          bots: done.bots,
          secrets:
            done.secrets._tag === "sealed"
              ? { _tag: "sealed", records: done.secrets.records }
              : done.secrets,
          linksLeftOut: done.linksLeftOut,
          namesLeftOut: done.namesLeftOut,
          attachmentsMissing: done.attachmentsMissing,
        });
      }
      yield* Console.log(
        [
          `Exported ${done.bots} bot${done.bots === 1 ? "" : "s"} to ${done.file}.`,
          secretsLine(done.secrets, "exported"),
          ...(done.linksLeftOut > 0
            ? [
                `${done.linksLeftOut} link${done.linksLeftOut === 1 ? "" : "s"} in the bots' folders ${done.linksLeftOut === 1 ? "was" : "were"} left out: an export holds files only.`,
              ]
            : []),
          ...(done.namesLeftOut.length > 0
            ? [
                `${done.namesLeftOut.length} file${done.namesLeftOut.length === 1 ? " was" : "s were"} left out: no import takes a name with a backslash in it. Rename ${done.namesLeftOut.length === 1 ? "it" : "them"} and export again to bring ${done.namesLeftOut.length === 1 ? "it" : "them"}:`,
                ...done.namesLeftOut.map((name) => `  ${name}`),
              ]
            : []),
          ...(done.attachmentsMissing > 0
            ? [
                `${done.attachmentsMissing} attachment${done.attachmentsMissing === 1 ? " was" : "s were"} already missing here, and ${done.attachmentsMissing === 1 ? "is" : "are"} not in it.`,
              ]
            : []),
          "Keep the file private: it holds every conversation. On the other server, run `j3-bots import` with it.",
        ].join("\n"),
      );
    }),
  ),
);

const replaceFlag = Flag.Boolean("replace").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Delete the bots, secrets and files this server holds and put the export's in their place, or put this export in place of another one whose import stopped halfway.",
  ),
);

export const importCommand = Command.make("import", {
  file: Argument.String("file").pipe(Argument.withDescription("The file `j3-bots export` wrote.")),
  replace: replaceFlag,
  passphraseStdin: passphraseStdinFlag,
}).pipe(
  Command.withDescription(
    "Put what `j3-bots export` wrote in this server's data directory: the bots, their conversations, memory, skills and files, the shared memory and skills, the attachments and the secrets. This server's configuration and provider sign-ins stay. Refused while it holds bots, secrets or their files, unless --replace. The server must be stopped.",
  ),
  Command.withHandler(({ file, replace, passphraseStdin }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = yield* userFacing(ServerConfig.resolveHome);
      const done = yield* userFacing(
        importHome({
          home,
          file: path.resolve(file),
          replace,
          passphrase: {
            ask: askPassphrase(passphraseStdin),
            attempts: passphraseStdin ? 1 : ATTEMPTS,
          },
        }),
      );
      yield* Console.log(
        [
          `Imported ${done.bots} bot${done.bots === 1 ? "" : "s"}, exported by J3 Bots ${done.version} on ${DateTime.formatIsoDateUtc(done.exportedAt)}.`,
          secretsLine(done.secrets, "imported"),
          ...(done.replaced ? ["What this server held before is gone."] : []),
          "",
          "Before the bots work here:",
          "  - Start the server: `systemctl --user start j3-bots` (or `j3-bots serve`). Each bot starts a new session; its conversation and memory are all there.",
          "  - Pair every device again: run `j3-bots pair`.",
          "  - Provider sign-ins stay on the server they were made on: if this one has none, run `j3-bots provider login` or `j3-bots provider connect`.",
          "  - Each webhook has a new address, on this server, with a new secret: give it to the service that calls it.",
        ].join("\n"),
      );
    }),
  ),
);
