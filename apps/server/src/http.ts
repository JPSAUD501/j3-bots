import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Rpc from "./rpc.ts";

/** 200 once the server is serving, which is after the database is migrated. */
const health = HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" }));

/** Every route, served on whichever `HttpServer` is provided. */
export const layer = HttpRouter.serve(Layer.mergeAll(health, Rpc.layer));
