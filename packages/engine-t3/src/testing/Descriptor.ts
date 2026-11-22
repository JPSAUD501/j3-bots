// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { descriptorUrl } from "../t3/Supervisor.ts";

/**
 * The highest migration the database of the engine on `port` holds, as the
 * engine itself reports it in its descriptor. None when it does not say.
 */
export const databaseMigration = Effect.fn("testing.databaseMigration")(function* (port: number) {
  const client = yield* HttpClient.HttpClient;
  const descriptor = yield* client
    .get(descriptorUrl(port))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    );
  return Option.fromNullishOr(descriptor.databaseMigration);
});
