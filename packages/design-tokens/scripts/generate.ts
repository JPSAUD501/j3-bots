// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes the web stylesheet and the mobile theme generated from the tokens. tokens.test.ts fails when either is stale.
import * as NodeFS from "node:fs";
import { renderUniwindCss } from "../src/uniwind.ts";
import { renderWebCss } from "../src/web.ts";

NodeFS.writeFileSync(new URL("../generated/web.css", import.meta.url), renderWebCss());
NodeFS.writeFileSync(new URL("../generated/uniwind.css", import.meta.url), renderUniwindCss());
