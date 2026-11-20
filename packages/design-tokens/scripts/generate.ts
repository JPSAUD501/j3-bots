// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes the web stylesheet generated from the tokens. tokens.test.ts fails when it is stale.
import * as NodeFS from "node:fs";
import { renderWebCss } from "../src/web.ts";

NodeFS.writeFileSync(new URL("../generated/web.css", import.meta.url), renderWebCss());
