// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderId } from "@j3-bots/contracts";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AiAccount,
  aiAccountProvider,
  type AiAccountState,
  aiAccountStates,
  type AiAction,
  aiAction,
  type AiFacts,
  type AiPlace,
  queuedSignIn,
} from "../presentation/aiAccount.ts";
import { Cell, type Readable } from "../Store.ts";

// Connecting an AI, as the screens hold it: each account's one button,
// carried through what must happen before a sign-in can start. The same on
// every client.

/**
 * What a screen asks of the server for the accounts. Each request resolves
 * with whether the server took it.
 * - `signIn` and `cancelSignIn`: null where this client cannot run a sign-in,
 *   as anywhere but the app on the server's own computer;
 * - `download`: the server downloads what the account needs;
 * - `cancelDownload`: it stops that download;
 * - `recheck`: the engine checks a provider again.
 */
export interface AiIntents {
  readonly signIn: ((account: AiAccount) => void) | null;
  readonly cancelSignIn: ((account: AiAccount) => void) | null;
  readonly download: (account: AiAccount) => Promise<boolean>;
  readonly cancelDownload: (account: AiAccount) => Promise<boolean>;
  readonly recheck: (providerId: ProviderId) => Promise<boolean>;
}

/** What the screens of one app share about connecting an AI. */
interface AiSessionState {
  /** The accounts they asked to sign in to before it could start. */
  readonly wanted: ReadonlySet<AiAccount>;
  /** The accounts whose last sign-in already led to a connection (`AiFacts.spent`). */
  readonly spent: ReadonlySet<AiAccount>;
  /** The accounts whose download, asked for on the way to a sign-in, the server did not take. */
  readonly refused: ReadonlySet<AiAccount>;
}

const withMember = <A>(set: ReadonlySet<A>, member: A, present: boolean): ReadonlySet<A> => {
  if (set.has(member) === present) return set;
  const next = new Set(set);
  if (present) next.add(member);
  else next.delete(member);
  return next;
};

/**
 * What an app remembers of connecting an AI while it runs, whichever screen
 * the operator is on: a sign-in they asked for before it could start, so
 * creating the bot meanwhile does not lose it. A sign-in that waits is acted on by
 * whichever screen shows the account, once, however many show it.
 */
interface AiSession extends Readable<AiSessionState> {
  /** Asks to sign in to `account` as soon as it can. */
  readonly want: (account: AiAccount) => void;
  /** Forgets a sign-in asked for early. */
  readonly forget: (account: AiAccount) => void;
  /**
   * Sees to what `account` in `state` asks of a sign-in that waits
   * (`queuedSignIn`): the download it still needs, its start, or dropping it.
   */
  readonly settle: (account: AiAccount, state: AiAccountState, intents: AiIntents) => void;
}

const createAiSession = (): AiSession => {
  const cell = new Cell<AiSessionState>({
    wanted: new Set(),
    spent: new Set(),
    refused: new Set(),
  });
  // The accounts a download was asked for and has not been seen to start.
  const asked = new Set<AiAccount>();
  const mark = (key: "wanted" | "spent" | "refused", account: AiAccount, present: boolean) =>
    cell.update((now) => {
      const next = withMember(now[key], account, present);
      return next === now[key] ? now : { ...now, [key]: next };
    });
  const forget = (account: AiAccount) => {
    asked.delete(account);
    mark("wanted", account, false);
  };
  return {
    get: cell.get,
    subscribe: cell.subscribe,
    want: (account) => {
      mark("refused", account, false);
      mark("wanted", account, true);
    },
    forget,
    settle: (account, state, intents) => {
      // A sign-in that led to a connection is spent, until another one starts.
      if (state._tag === "ready") mark("spent", account, true);
      if (state._tag === "signing-in") mark("spent", account, false);
      if (state._tag !== "missing") asked.delete(account);
      if (!cell.get().wanted.has(account)) return;
      switch (queuedSignIn(state)) {
        case "keep":
          return;
        case "drop":
          forget(account);
          return;
        case "start":
          forget(account);
          intents.signIn?.(account);
          return;
        case "download":
          if (asked.has(account)) return;
          asked.add(account);
          void intents.download(account).then((took) => {
            if (took) return;
            // Nothing is coming: the wait ends, and the account says the request did not go.
            forget(account);
            mark("refused", account, true);
          });
          return;
      }
    },
  };
};

const SessionContext = createContext<AiSession | null>(null);

/**
 * Shares one `AiSession` among the screens under it. One already shared
 * above is kept, so the app's own is the one every screen uses.
 */
export function AiSessionProvider(props: { readonly children?: ReactNode }) {
  const above = useContext(SessionContext);
  const [own] = useState(createAiSession);
  return createElement(SessionContext.Provider, { value: above ?? own }, props.children);
}

export interface AiConnectInput {
  readonly facts: AiFacts;
  readonly place: AiPlace;
  readonly intents: AiIntents;
}

/** A request to the server: none under way, one under way, or the last one the server did not take. */
type AiAsking = "idle" | "asking" | "failed";

/** One account, as a screen draws and drives it. */
export interface AiAccountModel {
  readonly account: AiAccount;
  readonly state: AiAccountState;
  /** Its one button now, or null when there is nothing for one to do. */
  readonly action: AiAction | null;
  /** Presses that button. */
  readonly act: () => void;
  /** Whether the operator asked to sign in and it waits for the account to be able to. */
  readonly queued: boolean;
  /** Stops waiting to sign in, and a sign-in under way. */
  readonly cancel: () => void;
  /** Stops the download of what the account needs. */
  readonly stopDownload: () => void;
  readonly asking: AiAsking;
}

function useAiAccount(
  account: AiAccount,
  input: AiConnectInput,
  session: AiSession,
): AiAccountModel {
  const { place, intents } = input;
  const shared = useSyncExternalStore(session.subscribe, session.get, session.get);
  const facts: AiFacts = { ...input.facts, spent: shared.spent };
  const state = aiAccountStates(facts)[account];
  const queued = shared.wanted.has(account);
  const [asking, setAsking] = useState<AiAsking>("idle");
  const ask = (request: Promise<boolean>) => {
    setAsking("asking");
    void request.then((took) => setAsking(took ? "idle" : "failed"));
  };
  // As the account's state changes, a sign-in that waits is seen to. The
  // session acts once, whichever screen tells it.
  // Told what it follows, since it reads the latest state rather than these.
  const settle = useEffectEvent((_state: AiAccountState["_tag"], _next: string, _queued: boolean) =>
    session.settle(account, state, intents),
  );
  const next = queuedSignIn(state);
  useEffect(() => {
    settle(state._tag, next, queued);
  }, [state._tag, next, queued]);

  const offered = aiAction(state, place);
  // Once asked for, a sign-in that waits has no button: the screen says it is coming.
  const action = offered?._tag === "sign-in" && offered.queued && queued ? null : offered;
  const act = () => {
    if (action === null || asking === "asking") return;
    switch (action._tag) {
      case "sign-in":
        if (action.queued) session.want(account);
        else intents.signIn?.(account);
        return;
      case "download":
        ask(intents.download(account));
        return;
      case "retry":
      case "look": {
        const provider = aiAccountProvider(facts.engine, account);
        if (provider !== undefined) ask(intents.recheck(provider.id));
        return;
      }
    }
  };
  const cancel = () => {
    session.forget(account);
    if (state._tag === "signing-in") intents.cancelSignIn?.(account);
  };
  const stopDownload = () => {
    session.forget(account);
    ask(intents.cancelDownload(account));
  };
  return {
    account,
    state,
    action,
    act,
    queued,
    cancel,
    stopDownload,
    asking: asking === "idle" && shared.refused.has(account) ? "failed" : asking,
  };
}

/** The accounts, as one screen connects them. */
export interface AiConnectModel {
  readonly place: AiPlace;
  readonly accounts: Readonly<Record<AiAccount, AiAccountModel>>;
}

/**
 * The accounts as one screen connects them (`AiConnectModel`), from the
 * app's `AiSession` when one is shared above it, else from one of its own.
 */
export function useAiConnect(input: AiConnectInput): AiConnectModel {
  const above = useContext(SessionContext);
  const [own] = useState(createAiSession);
  const session = above ?? own;
  const claude = useAiAccount("claude-code", input, session);
  const chatgpt = useAiAccount("codex", input, session);
  return { place: input.place, accounts: { "claude-code": claude, codex: chatgpt } };
}
