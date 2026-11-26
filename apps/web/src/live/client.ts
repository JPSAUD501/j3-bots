// SPDX-License-Identifier: AGPL-3.0-or-later
import { createJ3Client, type J3Client } from "@j3-bots/client-runtime";
import { desktop } from "./desktop";
import { makePlatform } from "./platform";

/**
 * The server this page talks to: the one that serves it in a browser, the one
 * the operator named in the desktop app. `null` in the desktop app until they
 * have named one.
 */
export const server = desktop === null ? new URL(window.location.origin) : desktop.server;

let started: Promise<J3Client> | null = null;

/** One client for the page, made on first use. */
export const client = (origin: URL) => (started ??= createJ3Client(makePlatform(origin)));
