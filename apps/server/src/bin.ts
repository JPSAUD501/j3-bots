// SPDX-License-Identifier: AGPL-3.0-or-later
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { run } from "./cli/main.ts";

run.pipe(NodeRuntime.runMain);
