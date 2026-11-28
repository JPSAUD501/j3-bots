// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FillField, FillOutcome, FillRefusal } from "@j3-bots/contracts";
import * as Schema from "effect/Schema";
import {
  BROWSER_NOTES,
  browserToolList,
  browserTools,
  DECODE_OPTIONS,
  FILL_NOTES,
  tools,
} from "../src/index.ts";
import type { FunctionTool } from "./model.ts";

// A stand-in for J3 Bots' browser and the server's fill, as far as the
// browser and secrets scenarios need them: tabs the bot opens, reads and acts
// on, the one open as the turn starts held by the operator when the scenario
// says so, and, when the scenario gives saved logins, `list_secrets` and
// `fill_credential` answered as the server answers them
// (`docs/architecture/server.md`, "Filling a login"): the page's origin must
// equal one of the login's, and the value goes to whichever element the bot
// last clicked.
//
// The bot is offered the server's own `browser_*` tools, with their names,
// descriptions and schemas, and a refusal in the server's own words
// (`BROWSER_NOTES`). The answers keep the server's shapes, with a page tree
// of the stand-in's own format: the driver's real snapshots are not what is
// measured. Actions other than click, type and press, and the tools for
// scripts, waits and dialogs, answer as if they did nothing of note.

/** An element of a fixture page the bot can act on. */
export interface PageElement {
  /** The ref a snapshot gives it, as `aria-ref=<ref>`. */
  readonly ref: string;
  readonly role: "textbox" | "button" | "link" | "checkbox";
  readonly name: string;
  /** What a field asks for, when it is a sign-in field; a text field asks for nothing of a login. */
  readonly asks?: FillField;
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
  /**
   * The pages the browser can show. Opening an address shows the page at
   * exactly that address, or else the first page on its host; any other
   * address does not load.
   */
  readonly pages: readonly [FixturePage, ...ReadonlyArray<FixturePage>];
  /** The address of the page the bot's front tab shows as the turn starts; none has no tab open. */
  readonly open?: string;
  /**
   * Whether the operator asked the bots to wait for them on the tab open as
   * the turn starts, and holds it for the whole turn.
   */
  readonly held?: boolean;
  /** The logins the bot may fill; none offers no saved login. */
  readonly logins?: ReadonlyArray<FixtureLogin>;
}

/** One `fill_credential` call, as the server took it. */
export interface Fill {
  readonly step: number;
  readonly secret: string;
  readonly field: FillField;
  /** The page's address when it was asked for, or null with no tab open. */
  readonly url: string | null;
  /** The element that had focus, or null when the bot had clicked none. */
  readonly focus: PageElement | null;
  readonly outcome: FillOutcome;
}

/** Text the bot typed into a page itself, with `browser_act`. */
export interface Typed {
  readonly step: number;
  readonly url: string;
  readonly into: PageElement | null;
  readonly text: string;
}

/** A tab with no page loaded. */
const BLANK: FixturePage = { url: "about:blank", title: "", text: [], elements: [] };

/** Whether `name` is one of the `browser_*` tools. */
export const isBrowserTool = (name: string): boolean => Object.hasOwn(browserTools, name);

/** The `browser_*` tools, as the server lists them to a bot whose browser is on. */
export const browserFunctionTools: ReadonlyArray<FunctionTool> = browserToolList.map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
}));

const decodeFill = Schema.decodeUnknownOption(tools.fill_credential.input, DECODE_OPTIONS);
const decodeOpen = Schema.decodeUnknownOption(browserTools.browser_open.input, DECODE_OPTIONS);
const decodeNavigate = Schema.decodeUnknownOption(
  browserTools.browser_navigate.input,
  DECODE_OPTIONS,
);
const decodeTabOnly = Schema.decodeUnknownOption(
  Schema.Struct({ tab: Schema.optionalKey(Schema.String) }),
);
const decodeAct = Schema.decodeUnknownOption(
  Schema.Struct({
    tab: Schema.optionalKey(Schema.String),
    action: Schema.String,
    locator: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.String),
  }),
);

const json = (value: unknown): string => JSON.stringify(value);

/** A refusal, as the bridge passes the server's on to the bot. */
const refusal = (note: string): string => json({ error: note });

const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null);

/** The host of an address, with `https://` assumed when it names none. */
const hostOf = (url: string): string | undefined => {
  const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
  return URL.canParse(full) ? new URL(full).hostname : undefined;
};

/** The tab the scenario opens first: the bot's, unless it is held. */
const FIRST_TAB = "tab-1";

const pageState = (tab: string, page: FixturePage) => ({
  tab,
  url: page.url,
  title: page.title,
  loading: false,
  loadError: null,
  dialog: null,
});

/** What `browser_open` and `browser_navigate` answer once `page` loaded in `tab`. */
export const loaded = (page: FixturePage, tab: string = FIRST_TAB): string =>
  json(pageState(tab, page));

/** What `browser_snapshot` answers on `page` in `tab`, with `focus` the element last clicked. */
export const snapshotOf = (
  page: FixturePage,
  tab: string = FIRST_TAB,
  focus: PageElement | null = null,
): string =>
  json({
    ...pageState(tab, page),
    tree: [
      ...page.text,
      ...page.elements.map(
        (element) =>
          `- ${element.role} "${element.name}" [ref=${element.ref}]${element === focus ? " [focused]" : ""}${element.href === undefined ? "" : ` -> ${element.href}`}`,
      ),
    ].join("\n"),
    truncated: false,
  });

interface StandInTab {
  readonly ref: string;
  page: FixturePage | null;
  focus: PageElement | null;
  readonly held: boolean;
}

/**
 * The browser and the secrets through one turn: the tabs and the page each
 * shows, the bot's current tab, the element it last clicked in each, and
 * every fill and typing it asked for.
 */
export class FixtureBrowser {
  readonly fills: Array<Fill> = [];
  readonly typed: Array<Typed> = [];
  readonly #setup: BrowserSetup;
  readonly #tabs: Array<StandInTab> = [];
  #current: StandInTab | undefined;
  /** The pages a fill was refused on in this turn, which take no other. */
  readonly #refused = new Set<string>();

  constructor(setup: BrowserSetup) {
    this.#setup = setup;
    if (setup.open !== undefined) {
      const page = this.#find(setup.open) ?? null;
      const tab = { ref: FIRST_TAB, page, focus: null, held: setup.held === true };
      this.#tabs.push(tab);
      // The operator's held tab is the one they look at: the bot's current one until it opens another.
      this.#current = tab;
    }
  }

  #find(url: string): FixturePage | undefined {
    const host = hostOf(url);
    return (
      this.#setup.pages.find((page) => page.url === url) ??
      this.#setup.pages.find((page) => hostOf(page.url) === host)
    );
  }

  /** The tab `ref` names, or the bot's current tab; a refusal when there is none. */
  #tab(ref: string | undefined): StandInTab | string {
    if (ref === undefined) return this.#current ?? refusal(BROWSER_NOTES.noCurrent);
    return this.#tabs.find((tab) => tab.ref === ref) ?? refusal(BROWSER_NOTES.noTab(ref));
  }

  /** What `name` answers, or `undefined` when it is not one of these tools. */
  answer(step: number, name: string, input: unknown): string | undefined {
    switch (name) {
      case "browser_tabs":
        return json({
          tabs: this.#tabs.map((tab) => ({
            tab: tab.ref,
            url: tab.page?.url ?? "about:blank",
            title: tab.page?.title ?? "",
            loading: false,
            where: "app",
            looking: tab.ref === FIRST_TAB,
            current: tab === this.#current,
            openedBy: tab.ref === FIRST_TAB ? "person" : { bot: "bot-self", name: "You" },
            onIt: [],
            using: tab.held ? "person" : "nobody",
            dialog: null,
          })),
        });
      case "browser_open": {
        const decoded = decodeOpen(input);
        if (decoded._tag === "None") return refusal("The call did not match its schema.");
        const tab: StandInTab = {
          ref: `tab-${this.#tabs.length + 1}`,
          page: null,
          focus: null,
          held: false,
        };
        this.#tabs.push(tab);
        this.#current = tab;
        const url = decoded.value.url;
        return url === undefined ? json(pageState(tab.ref, BLANK)) : this.#load(tab, url);
      }
      case "browser_navigate": {
        const decoded = decodeNavigate(input);
        if (decoded._tag === "None") return refusal("The call did not match its schema.");
        const tab = this.#tab(decoded.value.tab);
        if (typeof tab === "string") return tab;
        if (tab.held) return refusal(BROWSER_NOTES.waitingForUser);
        this.#current = tab;
        // Back, forward and reload keep the stand-in's page as it is.
        const url = decoded.value.url;
        return url === undefined
          ? json(pageState(tab.ref, tab.page ?? BLANK))
          : this.#load(tab, url);
      }
      case "browser_snapshot": {
        const decoded = decodeTabOnly(input);
        const tab = this.#tab(decoded._tag === "Some" ? decoded.value.tab : undefined);
        if (typeof tab === "string") return tab;
        return snapshotOf(tab.page ?? BLANK, tab.ref, tab.focus);
      }
      case "browser_act": {
        const decoded = decodeAct(input);
        if (decoded._tag === "None") return refusal("The call did not match its schema.");
        const tab = this.#tab(decoded.value.tab);
        if (typeof tab === "string") return tab;
        if (tab.held) return refusal(BROWSER_NOTES.waitingForUser);
        this.#current = tab;
        return this.#act(step, tab, decoded.value);
      }
      case "browser_wait_for":
      case "browser_dialog":
      case "browser_close": {
        const decoded = decodeTabOnly(input);
        const tab = this.#tab(decoded._tag === "Some" ? decoded.value.tab : undefined);
        if (typeof tab === "string") return tab;
        if (tab.held && name !== "browser_wait_for") return refusal(BROWSER_NOTES.waitingForUser);
        return json(pageState(tab.ref, tab.page ?? BLANK));
      }
      case "browser_evaluate":
        return json({ value: null });
      case "list_secrets":
        if (this.#setup.logins === undefined) return undefined;
        return json({
          status: "listed",
          secrets: this.#setup.logins.map((login) => ({
            reference: `secret:${login.name}`,
            kind: "login",
            origins: login.origins,
          })),
          note: FILL_NOTES.listed,
        });
      case "fill_credential":
        return this.#setup.logins === undefined ? undefined : this.#fill(step, input);
      default:
        return undefined;
    }
  }

  #load(tab: StandInTab, url: string): string {
    const page = this.#find(url);
    if (page === undefined) {
      return json({
        ...pageState(tab.ref, BLANK),
        url,
        loadError: { code: "name-not-resolved", message: `The page at ${url} did not load.` },
      });
    }
    tab.page = page;
    tab.focus = null;
    return loaded(page, tab.ref);
  }

  #act(
    step: number,
    tab: StandInTab,
    {
      action,
      locator,
      text,
      key,
    }: { action: string; locator?: string; text?: string; key?: string },
  ): string {
    const page = tab.page;
    if (page === null) return refusal("The tab shows no page.");
    const ref = locator?.replace(/^aria-ref=/, "");
    const element = page.elements.find((each) => each.ref === ref);
    switch (action) {
      case "click":
        if (element === undefined) return refusal("No element matches that locator.");
        if (element.role === "link" && element.href !== undefined) {
          this.#load(tab, element.href);
          return json({});
        }
        tab.focus = element.role === "textbox" ? element : null;
        return json({});
      case "type":
        if (text === undefined) return refusal("`type` needs `text`.");
        if (element !== undefined && element.role === "textbox") tab.focus = element;
        this.typed.push({ step, url: page.url, into: tab.focus, text });
        return json({});
      case "press":
        return key === undefined ? refusal("`press` needs `key`.") : json({});
      default:
        return json({});
    }
  }

  #fill(step: number, input: unknown): string {
    const decoded = decodeFill(input);
    if (decoded._tag === "None") return json({ error: "The call did not match its schema." });
    const { secret, field } = decoded.value;
    const refuse = (reason: FillRefusal): FillOutcome => ({ _tag: "refused", reason });
    const name = secret.replace(/^secret:/, "");
    const login = this.#setup.logins?.find((candidate) => candidate.name === name);
    const tab = this.#current;
    const url = tab?.page?.url ?? null;
    const origin = url === null ? null : originOf(url);
    const outcome: FillOutcome =
      login === undefined
        ? refuse("unknown-login")
        : url === null
          ? refuse("no-tab")
          : tab?.held === true
            ? refuse("held")
            : this.#refused.has(url)
              ? refuse("refused-before")
              : origin === null || !login.origins.includes(origin)
                ? refuse("origin")
                : {
                    _tag: "filled",
                    submitted: field === "password" || decoded.value.submit === true,
                  };
    if (url !== null && outcome._tag === "refused" && outcome.reason === "origin") {
      this.#refused.add(url);
    }
    this.fills.push({ step, secret, field, url, focus: tab?.focus ?? null, outcome });
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
    }
  }
}
