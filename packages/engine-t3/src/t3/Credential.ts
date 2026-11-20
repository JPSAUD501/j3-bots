// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthSessionState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { boundedCommand } from "./Command.ts";
import { engineFolders, type PrivateFiles } from "./PrivateFiles.ts";

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

const decodeSession = HttpClientResponse.schemaBodyJson(AuthSessionState);
const decodeIssued = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession));
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCredential));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredCredential));

export interface Credential {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
}

/** A token could not be minted (the engine CLI failed) or stored (the disk refused it). */
class CredentialMintFailed extends Schema.TaggedError<CredentialMintFailed>()(
  "CredentialMintFailed",
  { stage: Schema.Literals(["mint", "store"]) },
) {
  override get message(): string {
    return this.stage === "mint"
      ? "The engine CLI could not mint a token."
      : "The engine token could not be stored.";
  }
}

const credentialFile = (path: Path.Path, home: string) =>
  path.join(engineFolders(path, home).j3, "credential.json");

const mint = Effect.fnUntraced(function* (executable: string, home: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const issue = boundedCommand(executable, [
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
      const handle = yield* spawner.spawn(issue);
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.orElseSucceed(() => ({ stdout: "", exitCode: -1 })));
  if (output.exitCode !== 0) return yield* new CredentialMintFailed({ stage: "mint" });
  const issued = yield* decodeIssued(output.stdout).pipe(
    Effect.mapError(() => new CredentialMintFailed({ stage: "mint" })),
  );
  return issued;
});

/**
 * Mints a new token and stores it in place of the old one, whatever the old
 * one's state: for renewal, and when the engine refused the stored one.
 */
export const issueCredential = Effect.fn("engine.issueCredential")(function* (input: {
  readonly executable: string;
  readonly home: string;
  readonly files: PrivateFiles;
}) {
  const path = yield* Path.Path;
  const issued = yield* mint(input.executable, input.home);
  const text = yield* encodeStored(issued).pipe(Effect.orDie);
  yield* input.files
    .write(credentialFile(path, input.home), text)
    .pipe(Effect.mapError(() => new CredentialMintFailed({ stage: "store" })));
  return {
    token: Redacted.make(issued.token),
    expiresAt: issued.expiresAt,
  } satisfies Credential;
});

/**
 * A token that is valid for at least `RENEW_BEFORE`: the stored one, or a new
 * one minted and stored. The engine's data directory must exist; the engine
 * does not have to be running.
 */
export const ensureCredential = Effect.fn("engine.ensureCredential")(function* (input: {
  readonly executable: string;
  readonly home: string;
  readonly files: PrivateFiles;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* DateTime.now;
  const stored = yield* fs.readFileString(credentialFile(path, input.home)).pipe(
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
    } satisfies Credential;
  }
  return yield* issueCredential(input);
});

/** What the engine makes of a token. */
export type Access = "granted" | "refused" | "unreachable";

/**
 * Whether the engine accepts `token` with both scopes the adapter needs. It
 * answers `GET /api/auth/session` for any caller, with `authenticated: false`
 * for a token it does not accept, so a refusal is definitive and a failed
 * request only says the engine was not reached. **Read** at `db51b67`,
 * `packages/contracts/src/environmentHttp.ts` (`session`, `OptionalBearerHeaders`).
 */
export const checkAccess = Effect.fn("engine.checkAccess")(function* (input: {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string>;
}) {
  const http = yield* HttpClient.HttpClient;
  return yield* http
    .execute(
      HttpClientRequest.get(`${input.baseUrl}/api/auth/session`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(input.token)),
      ),
    )
    .pipe(
      Effect.flatMap((response): Effect.Effect<Access, unknown> => {
        if (response.status === 401 || response.status === 403) return Effect.succeed("refused");
        return HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(decodeSession),
          Effect.map((session): Access => {
            const scopes = session.scopes ?? [];
            return session.authenticated &&
              CREDENTIAL_SCOPES.every((scope) => scopes.includes(scope))
              ? "granted"
              : "refused";
          }),
        );
      }),
      Effect.timeout(Duration.seconds(5)),
      Effect.orElseSucceed((): Access => "unreachable"),
    );
});

/** When the token must be renewed. */
export const renewalDue = (credential: Credential) =>
  DateTime.subtractDuration(credential.expiresAt, RENEW_BEFORE);
