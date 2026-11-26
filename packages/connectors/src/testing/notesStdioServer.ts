#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The notes server (`notesServer.ts`) over standard input and output, as a
// command connector starts it: it speaks 2026-07-28 to a client that asks
// with `server/discover`, and 2025-11-25 to one that starts with `initialize`.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { notesServer } from "./notesServer.ts";

serveStdio(() => notesServer());
