// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CredentialField, FillOutcome, FillRefusal } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import { DECODE_OPTIONS, FILL_NOTES, tools } from "../src/index.ts";
import type { FunctionTool } from "./model.ts";

// A stand-in for the engine's browser and the server's fill, for scenarios
// about saved logins (`docs/architecture/server.md`, "Filling a login"). The
// bot gets three of the engine's browser tools, under the names Claude Code
// lists them by (`mcp__t3-code__<tool>`), answered from fixed pages, and
// `list_credentials` and `fill_credential` answered as the server answers
// them: the page's origin must equal one of the login's, and the value goes
// to whichever element the bot last clicked. The tools' descriptions and the
// snapshot's format are this repository's own, not the engine's.

/** An element of a fixture page the bot can click or type into. */
export interface PageElement {
  /** The ref a snapshot gives it, as `aria-ref=<ref>`. */
  readonly ref: string;
  readonly role: "textbox" | "button" | "link";
  readonly name: string;
  /** What a field asks for, when it is a sign-in field; a text field asks for nothing of a login. */
  readonly asks?: CredentialField;
  /** A link's address. */
  readonly href?: string;
}

export interface FixturePage {
  readonly url: string;
  readonly title: string;
  /** What the page says, around its elements, as a snapshot shows it. */
  readonly text: ReadonlyArray<string>;
  readonly elements: ReadonlyArray<PageElement>;
}

interface FixtureLogin {
  readonly name: string;
  readonly origins: ReadonlyArray<string>;
}

export interface BrowserSetup {
  /** The pages the browser can show; the first is open in the bot's front tab. */
  readonly pages: readonly [FixturePage, ...ReadonlyArray<FixturePage>];
  /** The logins the bot may fill. */
  readonly logins: ReadonlyArray<FixtureLogin>;
}

/** One `fill_credential` call, as the server took it. */
export interface Fill {
  readonly step: number;
  readonly credential: string;
  readonly field: CredentialField;
  /** The page's address when it was asked for. */
  readonly url: string;
  /** The element that had focus, or null when the bot had clicked none. */
  readonly focus: PageElement | null;
  readonly outcome: FillOutcome;
}

/** Text the bot typed into a page itself, with `preview_act`. */
export interface Typed {
  readonly step: number;
  readonly url: string;
  readonly into: PageElement | null;
  readonly text: string;
}

const BROWSER_TOOLS = {
  snapshot: "mcp__t3-code__preview_snapshot",
  act: "mcp__t3-code__preview_act",
  navigate: "mcp__t3-code__preview_navigate",
} as const;

/** The stand-in browser tools, in this repository's own wording. */
export const browserTools: ReadonlyArray<FunctionTool> = [
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.snapshot,
      description:
        "Read your front browser tab: its address, title, text and the elements you can act on, each with a ref.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.act,
      description:
        "Act on your front tab. `action`: click, type or press. Target an element with `locator: 'aria-ref=<ref>'` from a snapshot. `type` types `text` into the element; `press` sends one `key`.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type", "press"] },
          locator: { type: "string" },
          text: { type: "string" },
          key: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: BROWSER_TOOLS.navigate,
      description: "Open an address in your front tab.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

const decodeFill = Schema.decodeUnknownOption(tools.fill_credential.input, DECODE_OPTIONS);
const decodeAct = Schema.decodeUnknownOption(
  Schema.Struct({
    action: Schema.Literals(["click", "type", "press"]),
    locator: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.String),
  }),
);
const decodeNavigate = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

const json = (value: unknown): string => JSON.stringify(value);

const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null);

/**
 * The browser and the vault through one turn: the page the front tab shows,
 * the element the bot last clicked, and every fill and typing it asked for.
 */
export class FixtureBrowser {
  readonly fills: Array<Fill> = [];
  readonly typed: Array<Typed> = [];
  readonly #setup: BrowserSetup;
  #page: FixturePage;
  #focus: PageElement | null = null;
  /** The pages a fill was refused on in this turn, which take no other. */
  readonly #refused = new Set<string>();

  constructor(setup: BrowserSetup) {
    this.#setup = setup;
    this.#page = setup.pages[0];
  }

  /** What `name` answers, or `undefined` when it is not one of these tools. */
  answer(step: number, name: string, input: unknown): string | undefined {
    switch (name) {
      case BROWSER_TOOLS.snapshot:
        return this.#snapshot();
      case BROWSER_TOOLS.act:
        return this.#act(step, input);
      case BROWSER_TOOLS.navigate: {
        const target = decodeNavigate(input);
        if (target._tag === "None") return json({ error: "`url` must be a string." });
        return this.#open(target.value.url);
      }
      case "list_credentials":
        return json({
          status: "listed",
          credentials: this.#setup.logins,
          note: FILL_NOTES.listed,
        });
      case "fill_credential":
        return this.#fill(step, input);
      default:
        return undefined;
    }
  }

  #snapshot(): string {
    const page = this.#page;
    return [
      `url: ${page.url}`,
      `title: ${page.title}`,
      ...page.text,
      ...page.elements.map(
        (element) =>
          `- ${element.role} "${element.name}" [ref=${element.ref}]${element === this.#focus ? " [focused]" : ""}${element.href === undefined ? "" : ` -> ${element.href}`}`,
      ),
    ].join("\n");
  }

  #open(url: string): string {
    const page = this.#setup.pages.find((candidate) => candidate.url === url);
    if (page === undefined) return json({ error: `The page at ${url} did not load.` });
    this.#page = page;
    this.#focus = null;
    return json({ status: "loaded", url: page.url, title: page.title });
  }

  #element(locator: string | undefined): PageElement | undefined {
    const ref = locator?.replace(/^aria-ref=/, "");
    return this.#page.elements.find((element) => element.ref === ref);
  }

  #act(step: number, input: unknown): string {
    const decoded = decodeAct(input);
    if (decoded._tag === "None") return json({ error: "The action did not match its schema." });
    const { action, locator, text, key } = decoded.value;
    const element = this.#element(locator);
    switch (action) {
      case "click":
        if (element === undefined) return json({ error: "No element matches that locator." });
        if (element.role === "link" && element.href !== undefined) return this.#open(element.href);
        this.#focus = element.role === "textbox" ? element : null;
        return json({ status: "clicked" });
      case "type":
        if (text === undefined) return json({ error: "`type` needs `text`." });
        if (element !== undefined && element.role === "textbox") this.#focus = element;
        this.typed.push({ step, url: this.#page.url, into: this.#focus, text });
        return json({ status: "typed" });
      case "press":
        return key === undefined
          ? json({ error: "`press` needs `key`." })
          : json({ status: "pressed" });
    }
  }

  #fill(step: number, input: unknown): string {
    const decoded = decodeFill(input);
    if (decoded._tag === "None") return json({ error: "The call did not match its schema." });
    const { credential, field } = decoded.value;
    const refuse = (reason: FillRefusal): FillOutcome => ({ _tag: "refused", reason });
    const login = this.#setup.logins.find((candidate) => candidate.name === credential);
    const origin = originOf(this.#page.url);
    const outcome: FillOutcome =
      login === undefined
        ? refuse("unknown-login")
        : this.#refused.has(this.#page.url)
          ? refuse("refused-before")
          : origin === null || !login.origins.includes(origin)
            ? refuse("origin")
            : { _tag: "filled", submitted: field === "password" || decoded.value.submit === true };
    if (outcome._tag === "refused" && outcome.reason === "origin")
      this.#refused.add(this.#page.url);
    this.fills.push({ step, credential, field, url: this.#page.url, focus: this.#focus, outcome });
    switch (outcome._tag) {
      case "filled":
        return json({
          status: "filled",
          submitted: outcome.submitted,
          note: outcome.submitted ? FILL_NOTES.submitted : FILL_NOTES.filled,
        });
      case "refused":
        return json({
          status: "refused",
          reason: outcome.reason,
          note: FILL_NOTES[outcome.reason],
        });
      case "locked":
        return json({ status: "locked", note: FILL_NOTES.locked });
    }
  }
}
