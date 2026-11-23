// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import type { FunctionTool } from "./model.ts";

/**
 * The engine's browser, as far as the browser scenarios need it: a tab the
 * bot opens, reads and acts on, and the operator may hold.
 *
 * The engine offers a bot its preview tools under the `t3-code` server name
 * (Read in this repository, `packages/engine-t3/src/t3/toolNames.ts`). The
 * stand-in offers four of them, in this repository's own wording, with
 * arguments of its own: their real schemas are not what is measured.
 * While the operator holds the tab, an action fails with the engine's own
 * words (Verified at the pinned engine, `docs/architecture/engine.md`,
 * Control), and a snapshot still reads the page. The stand-in also fails
 * opening a new tab then, which the engine may allow (Assumed): a bot told to
 * stop on that error should not look for another way in.
 */

/** A page the stand-in serves, at every address on its host. */
export interface BrowserPage {
  readonly url: string;
  readonly title: string;
  /** What a snapshot reads: the page's text, its fields and buttons in brackets. */
  readonly text: string;
}

export interface BrowserStage {
  readonly pages: ReadonlyArray<BrowserPage>;
  /** The page the bot's tab shows as the turn starts; none has no tab open. */
  readonly open?: string;
  /** Whether the operator holds the bot's tab for the whole turn. */
  readonly held?: boolean;
}

export const BROWSER_TOOLS = {
  open: "mcp__t3-code__preview_open",
  navigate: "mcp__t3-code__preview_navigate",
  snapshot: "mcp__t3-code__preview_snapshot",
  act: "mcp__t3-code__preview_act",
} as const;

const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(BROWSER_TOOLS));

/** Whether `name` is one of the stand-in browser tools. */
export const isBrowserTool = (name: string): boolean => BROWSER_TOOL_NAMES.has(name);

/** What the engine answers an action on a tab a human holds (Verified at the pinned engine). */
export const HUMAN_CONTROL = "A human controls this browser tab. Wait until they release control.";

const URL_INPUT = {
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
  additionalProperties: false,
} as const;

export const browserTools: ReadonlyArray<FunctionTool> = [
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.open,
      description: "Open a page in a new tab of your browser.",
      parameters: URL_INPUT,
    },
  },
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.navigate,
      description: "Load another page in your browser's current tab.",
      parameters: URL_INPUT,
    },
  },
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.snapshot,
      description:
        "Read the page in your browser's current tab: its address, title and text, with its fields and buttons in brackets.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.act,
      description:
        "Act on the page in your browser's current tab: click a button or link, or type text into a field, each named as the snapshot shows it.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type"] },
          target: { type: "string" },
          text: { type: "string" },
        },
        required: ["action", "target"],
        additionalProperties: false,
      },
    },
  },
];

const decodeUrl = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

/** The host of an address, with `https://` assumed when it names none. */
const hostOf = (url: string): string | undefined => {
  const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  return URL.canParse(full) ? new URL(full).hostname : undefined;
};

/** One turn's browser: which page its tab shows, answered from the stage. */
export class StandInBrowser {
  readonly #stage: BrowserStage;
  #current: BrowserPage | undefined;

  constructor(stage: BrowserStage) {
    this.#stage = stage;
    this.#current = stage.open === undefined ? undefined : this.#find(stage.open);
  }

  #find(url: string): BrowserPage | undefined {
    const host = hostOf(url);
    return this.#stage.pages.find((page) => hostOf(page.url) === host);
  }

  #shown(page: BrowserPage): Schema.Json {
    return { url: page.url, title: page.title, text: page.text };
  }

  /** What the stand-in tool `name` answers to `input`. */
  answer(name: string, input: unknown): Schema.Json {
    const acting = name !== BROWSER_TOOLS.snapshot;
    if (acting && this.#stage.held === true) return { error: HUMAN_CONTROL };
    switch (name) {
      case BROWSER_TOOLS.open:
      case BROWSER_TOOLS.navigate: {
        const url = decodeUrl(input);
        if (url._tag === "None") return { error: "`url` must be a string." };
        const page = this.#find(url.value.url);
        if (page === undefined) {
          return { error: `${url.value.url} could not be reached: the site did not answer.` };
        }
        this.#current = page;
        return this.#shown(page);
      }
      case BROWSER_TOOLS.snapshot:
        return this.#current === undefined
          ? { error: "No tab is open. Open a page first." }
          : this.#shown(this.#current);
      default:
        return this.#current === undefined
          ? { error: "No tab is open. Open a page first." }
          : { done: true, url: this.#current.url };
    }
  }
}
