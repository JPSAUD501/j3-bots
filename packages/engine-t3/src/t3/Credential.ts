// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthSessionState, sessionGrantsScope } from "@t3tools/contracts";
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

/**
 * The scopes the adapter needs: read threads and projects, and operate them;
 * act on a bot's browser tab for a person who took control of it (without
 * `preview:operate` the engine silently drops a viewer's input; **Read** at
 * `bc0f04d`, `apps/server/src/preview/ServerBrowserStream.ts` L74-77);
 * write the engine's settings, for each bot's browser access
 * (`BrowserAccess.ts`); and manage providers, for the operator's update of
 * a harness (`server.updateProvider`) and to replace a provider instance
 * for the harness J3 Bots installed (`setHarnessExecutable`), both of which
 * need `providers:manage` (**Read** at `bc0f04d`,
 * `apps/server/src/auth/RpcAuthorization.ts`). A stored token without one of
 * them is refused by `checkAccess`, and the supervisor mints a new one with
 * all of them.
 */
const CREDENTIAL_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "preview:operate",
  "settings:write",
  "providers:manage",
] as const;

/** Renew this long before the token expires, so a running engine never sees an expired one. */
const RENEW_BEFORE = Duration.days(2);
/** How long a minted token lives. */
const TOKEN_LIFETIME = "30d";
/** The label the engine keeps with each session J3 Bots minted, to find them again. */
const SESSION_LABEL = "J3 Bots";

/** What `t3 auth session issue --json` prints. **Verified** at the pin. */
const IssuedSession = Schema.Struct({
  sessionId: Schema.String.check(Schema.isNonEmpty()),
  token: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.DateTimeUtcFromString,
});

/**
 * What `t3 auth session list --json` prints, as far as the adapter reads it: no
 * token, only each session's id and the label it was issued with (**Read** at
 * `bc0f04d`, `apps/server/src/cliAuthFormat.ts` `formatSessionList`).
 */
const ListedSessions = Schema.Array(
  Schema.Struct({
    sessionId: Schema.String.check(Schema.isNonEmpty()),
    client: Schema.optionalKey(Schema.Struct({ label: Schema.optionalKey(Schema.String) })),
  }),
);

/**
 * What `credential.json` holds. `scopes` is what the token was minted with; a
 * file written before it was recorded has none, and its token is minted again.
 */
const StoredCredential = Schema.Struct({
  token: Schema.String.check(Schema.isNonEmpty()),
  expiresAt: Schema.DateTimeUtcFromString,
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodeSession = HttpClientResponse.schemaBodyJson(AuthSessionState);
const decodeIssued = Schema.decodeUnknownEffect(Schema.fromJsonString(IssuedSession));
const decodeListed = Schema.decodeUnknownEffect(Schema.fromJsonString(ListedSessions));
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

/** Runs the engine's CLI, `auth session` and `args`, against the engine's data directory. */
const authSession = Effect.fnUntraced(function* (
  executable: string,
  home: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [command, ...rest] = args;
  const run = boundedCommand(executable, [
    "auth",
    "session",
    ...(command === undefined ? [] : [command]),
    "--base-dir",
    home,
    ...rest,
  ]);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(run);
      const [stdout, exitCode] = yield* Effect.all(
        [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.orElseSucceed(() => ({ stdout: "", exitCode: -1 })));
});

const mint = Effect.fnUntraced(function* (executable: string, home: string) {
  const output = yield* authSession(executable, home, [
    "issue",
    ...CREDENTIAL_SCOPES.flatMap((scope) => ["--scope", scope]),
    "--ttl",
    TOKEN_LIFETIME,
    "--label",
    SESSION_LABEL,
    "--json",
  ]);
  if (output.exitCode !== 0) return yield* new CredentialMintFailed({ stage: "mint" });
  return yield* decodeIssued(output.stdout).pipe(
    Effect.mapError(() => new CredentialMintFailed({ stage: "mint" })),
  );
});

/**
 * Revokes every session J3 Bots minted before `kept`, so a token it no longer
 * uses stops working at once instead of at its expiry. Only while the engine is
 * stopped: the CLI then changes the engine's data directly, and no connection
 * that still uses an older token is cut. A failure leaves the older tokens to
 * expire, and is logged without any of them.
 */
const revokeOlderSessions = Effect.fnUntraced(
  function* (executable: string, home: string, kept: string) {
    const listed = yield* authSession(executable, home, ["list", "--json"]);
    if (listed.exitCode !== 0) return yield* Effect.fail("list" as const);
    const sessions = yield* decodeListed(listed.stdout).pipe(
      Effect.mapError(() => "list" as const),
    );
    for (const session of sessions) {
      if (session.client?.label !== SESSION_LABEL || session.sessionId === kept) continue;
      const revoked = yield* authSession(executable, home, ["revoke", session.sessionId]);
      if (revoked.exitCode !== 0) return yield* Effect.fail("revoke" as const);
    }
  },
  Effect.catch((stage) =>
    Effect.logWarning(
      `The engine's older J3 Bots tokens could not be revoked (${stage}); they expire on their own.`,
    ),
  ),
);

/** Mints a token and stores it, answering it and the engine's id for its session. */
const mintAndStore = Effect.fnUntraced(function* (input: {
  readonly executable: string;
  readonly home: string;
  readonly files: PrivateFiles;
}) {
  const path = yield* Path.Path;
  const issued = yield* mint(input.executable, input.home);
  const text = yield* encodeStored({
    token: issued.token,
    expiresAt: issued.expiresAt,
    scopes: CREDENTIAL_SCOPES,
  }).pipe(Effect.orDie);
  yield* input.files
    .write(credentialFile(path, input.home), text)
    .pipe(Effect.mapError(() => new CredentialMintFailed({ stage: "store" })));
  const credential: Credential = {
    token: Redacted.make(issued.token),
    expiresAt: issued.expiresAt,
  };
  return { credential, sessionId: issued.sessionId };
});

/**
 * Mints a new token and stores it in place of the old one, whatever the old
 * one's state: for renewal, and when the engine refused the stored one. It
 * revokes nothing, because the engine is running: the older token expires
 * within `RENEW_BEFORE`, or the engine refused it.
 */
export const issueCredential = Effect.fn("engine.issueCredential")(function* (input: {
  readonly executable: string;
  readonly home: string;
  readonly files: PrivateFiles;
}) {
  const { credential } = yield* mintAndStore(input);
  return credential;
});

/**
 * A token that is valid for at least `RENEW_BEFORE` and carries every scope
 * of `CREDENTIAL_SCOPES`: the stored one, or a new one minted and stored. A
 * stored token minted with fewer scopes, by an older J3 Bots, is replaced
 * before the engine ever sees it. A new token revokes every one J3 Bots
 * minted before it. The engine's data directory must exist, and the engine
 * must be stopped.
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
    CREDENTIAL_SCOPES.every((scope) => stored.value.scopes?.includes(scope) === true) &&
    DateTime.isGreaterThan(stored.value.expiresAt, DateTime.addDuration(now, RENEW_BEFORE))
  ) {
    return {
      token: Redacted.make(stored.value.token),
      expiresAt: stored.value.expiresAt,
    } satisfies Credential;
  }
  const { credential, sessionId } = yield* mintAndStore(input);
  yield* revokeOlderSessions(input.executable, input.home, sessionId);
  return credential;
});

/** What the engine makes of a token. */
export type Access = "granted" | "refused" | "unreachable";

/**
 * Whether the engine accepts `token` with every scope the adapter needs. It
 * answers `GET /api/auth/session` for any caller, with `authenticated: false`
 * for a token it does not accept, so a refusal is definitive and a failed
 * request only says the engine was not reached. **Read** at `bc0f04d`,
 * `packages/contracts/src/environmentHttp.ts` (`session`, `OptionalBearerHeaders`).
 * The answer's `scopes` lists only the scopes older clients know; what the
 * token is granted is its `permissions`, which the engine's own
 * `sessionGrantsScope` reads (**Read** at `bc0f04d`, `contracts/src/auth.ts`,
 * `authScopeResponse`, which lists `preview:operate` there alone; **Verified**:
 * a token issued with `settings:write` reports it only there).
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
          Effect.map((session): Access =>
            CREDENTIAL_SCOPES.every((scope) => sessionGrantsScope(session, scope))
              ? "granted"
              : "refused",
          ),
        );
      }),
      Effect.timeout(Duration.seconds(5)),
      Effect.orElseSucceed((): Access => "unreachable"),
    );
});

/** When the token must be renewed. */
export const renewalDue = (credential: Credential) =>
  DateTime.subtractDuration(credential.expiresAt, RENEW_BEFORE);
