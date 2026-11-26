// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The export is a child whose stdin takes the passphrase and whose output is read back, which only Node's own spawn gives as streams.
import * as NodeChildProcess from "node:child_process";
import { LEFT_OUT_NAMES_SHOWN, type LeftOut } from "@j3-bots/desktop-bridge";
import { type ExportReport, ExportReportJson } from "@j3-bots/server/transfer-report";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// `j3-bots export` on the home of the server this computer runs, as the
// server the app carries runs it:
//
//   <runtime>/node/bin/node <runtime>/server/bin.mjs export --output <file> --passphrase-stdin --report <report>
//
// The passphrase is the first line of its stdin, which is then closed. Its
// output is kept, the last few kilobytes of it, to tell why it failed, and
// its report says what it left out.

/** How many characters of the export's last output the app keeps. */
const TAIL_CHARACTERS = 8192;

export interface ExportSpec {
  readonly node: string;
  readonly entry: string;
  /** The export's whole environment, `J3_HOME` included: nothing else is inherited. */
  readonly env: Record<string, string>;
  /** Where it writes the archive: a file that must not exist yet. */
  readonly file: string;
  /** Where it writes its report, as JSON, once the archive is in place. */
  readonly report: string;
  readonly passphrase: Redacted.Redacted<string>;
}

/** The export did not write the archive, for `reason`: its own words when it gave them. */
export class ExportFailed extends Schema.TaggedError<ExportFailed>()("ExportFailed", {
  reason: Schema.optionalKey(Schema.String),
}) {}

const CONTROL = /\u001b\[[0-9;]*m/g;

/**
 * Why the export failed, from its output: the command writes its refusal
 * last, under a line that reads `ERROR`. The server's own logs, JSON lines,
 * are not a reason.
 */
const failureOf = (output: string): string | undefined => {
  const lines = output
    .replace(CONTROL, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const heading = lines.lastIndexOf("ERROR");
  const said = (heading === -1 ? lines : lines.slice(heading + 1)).filter(
    (line) => line.length > 0 && !line.startsWith("{"),
  );
  return said.length === 0 ? undefined : said.join(" ").slice(0, 4096);
};

/** Runs the export to its end; fails with why when it wrote nothing. */
const exported = (spec: ExportSpec): Effect.Effect<void, ExportFailed> =>
  Effect.callback<void, ExportFailed>((resume) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-TAIL_CHARACTERS);
    };
    const child = NodeChildProcess.spawn(
      spec.node,
      [spec.entry, "export", "--output", spec.file, "--passphrase-stdin", "--report", spec.report],
      { env: spec.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // An export that ends before it reads the passphrase closes its stdin.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) =>
      resume(
        Effect.fail(new ExportFailed({ reason: `The export could not start: ${error.message}` })),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) return resume(Effect.void);
      const reason = failureOf(output);
      resume(Effect.fail(new ExportFailed(reason === undefined ? {} : { reason })));
    });
    child.stdin.end(`${Redacted.value(spec.passphrase)}\n`);
    // Interrupted, the export is stopped: on Unix it removes what it wrote so
    // far, as on any SIGTERM. Quitting the app waits for it instead.
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });

const decodeReport = Schema.decodeEffect(ExportReportJson);

/** What the operator is told the export left out. */
const leftOutOf = (report: ExportReport): LeftOut => ({
  ...(report.secrets._tag === "left-out" ? { secrets: report.secrets.reason } : {}),
  links: report.linksLeftOut,
  names: report.namesLeftOut.length,
  firstNames: report.namesLeftOut.slice(0, LEFT_OUT_NAMES_SHOWN),
  attachmentsMissing: report.attachmentsMissing,
});

/**
 * Runs the export and reads its report: what it left out. An export whose
 * report cannot be read counts as failed, and its archive is removed, so
 * the operator is never told the bots moved whole when they did not.
 */
export const run = Effect.fn("ExportProcess.run")(function* (spec: ExportSpec) {
  yield* exported(spec);
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(spec.report).pipe(
    Effect.flatMap(decodeReport),
    Effect.map(leftOutOf),
    Effect.catch(() =>
      fs
        .remove(spec.file, { force: true })
        .pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.fail(new ExportFailed({ reason: "The export did not say what it holds." })),
          ),
        ),
    ),
  );
});
