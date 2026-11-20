// SPDX-License-Identifier: AGPL-3.0-or-later
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// The bearer token J3 Bots signs in to its engine with. It is minted by the
// engine's own CLI against the engine's data directory, so no pairing step and
// no person is involved, and it is kept next to that data with mode 0600.

/** The scopes the adapter needs: read threads and projects, and operate them. */
const CREDENTIAL_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

/** Renew this long before the token expires, so a running engine never sees an expired one. */
const RENEW_BEFORE = Duration.days(2);
/** How long a minted token lives. */
const TOKEN_LIFETIME = "30d";

/** What `t3 auth session issue --json` prints. **Verified** at the pin. */
const IssuedSession = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.DateTimeUtcFromString,
});

const StoredCredential = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.DateTimeUtcFromString,
});

const decodeIssued = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession));
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCredential));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredCredential));

export interface Credential {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
}

/** The engine CLI could not mint a token. */
class CredentialMintFailed extends Schema.TaggedError<CredentialMintFailed>()(
  "CredentialMintFailed",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `The engine CLI could not mint a token (exit code ${this.exitCode}).`;
  }
}

const credentialFile = (path: Path.Path, home: string) => path.join(home, "j3", "credential.json");

const mint = Effect.fnUntraced(function* (executable: string, home: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(executable, [
    "auth",
    "session",
    "issue",
    "--base-dir",
    home,
    ...CREDENTIAL_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    TOKEN_LIFETIME,
    "--label",
    "J3 Bots",
    "--json",
  ]);
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.orElseSucceed(() => ({ stdout: "", exitCode: -1 })));
  if (output.exitCode !== 0) return yield* new CredentialMintFailed({ exitCode: output.exitCode });
  const issued = yield* decodeIssued(output.stdout).pipe(
    Effect.mapError(() => new CredentialMintFailed({ exitCode: output.exitCode })),
  );
  return issued;
});

/**
 * A token that is valid for at least `RENEW_BEFORE`: the stored one, or a new
 * one minted and stored. The engine's data directory must exist; the engine
 * does not have to be running.
 */
export const ensureCredential = Effect.fn("engine.ensureCredential")(function* (input: {
  readonly executable: string;
  readonly home: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = credentialFile(path, input.home);
  const now = yield* DateTime.now;

  const stored = yield* fs.readFileString(file).pipe(
    Effect.map(decodeStored),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (
    Option.isSome(stored) &&
    DateTime.isGreaterThan(stored.value.expiresAt, DateTime.addDuration(now, RENEW_BEFORE))
  ) {
    return {
      token: Redacted.make(stored.value.token),
      expiresAt: stored.value.expiresAt,
    };
  }

  const issued = yield* mint(input.executable, input.home);
  const text = yield* encodeStored(issued).pipe(Effect.orDie);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const temporary = `${file}.tmp`;
  yield* fs.writeFileString(temporary, text, { mode: 0o600 }).pipe(Effect.orDie);
  yield* fs.chmod(temporary, 0o600).pipe(Effect.orDie);
  yield* fs.rename(temporary, file).pipe(Effect.orDie);
  return {
    token: Redacted.make(issued.token),
    expiresAt: issued.expiresAt,
  } satisfies Credential;
});

/** When the token must be renewed. */
export const renewalDue = (credential: Credential) =>
  DateTime.subtractDuration(credential.expiresAt, RENEW_BEFORE);
