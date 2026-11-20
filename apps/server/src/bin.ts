// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";
import * as Server from "./server.ts";

Layer.launch(Server.layer).pipe(NodeRuntime.runMain);
