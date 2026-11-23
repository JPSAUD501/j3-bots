// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import type { ConnectEndpointResult, SignInView } from "@j3-bots/client-runtime";
import { endpointInstead, signInLine, type SignInLine } from "@j3-bots/client-runtime/wording";
import {
  type HarnessLocation,
  MAX_PROVIDER_KEY_LENGTH,
  normalizeBaseUrl,
  type ProviderConnectionRequest,
  type SignInHarness,
  signInHarnesses,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import type { I18n } from "@j3-bots/i18n";
import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { lineField } from "./ui/field";

/**
 * Setting the providers up from this app, while the server it talks to runs
 * on this computer, so a harness's sign-in page opens in a browser here,
 * where the page returns to the harness.
 */
export interface ProviderSetupIntents {
  /** Starts the harness's sign-in on the server, or follows the one under way. */
  readonly signIn: (harness: SignInHarness) => void;
  readonly cancelSignIn: (harness: SignInHarness) => void;
  /** Where the server finds each harness; null when it cannot say. */
  readonly harnesses: () => Promise<ReadonlyArray<HarnessLocation> | null>;
  readonly connectEndpoint: (request: ProviderConnectionRequest) => Promise<ConnectEndpointResult>;
}

/** The intents, with each harness's sign-in as this app follows it. */
export interface LocalProviderSetup extends ProviderSetupIntents {
  readonly signIns: ReadonlyMap<SignInHarness, SignInView>;
}

const idle: SignInView = { _tag: "idle" };

/** Where the server finds each harness: `looking` until it said, null when it could not. */
type Found = ReadonlyArray<HarnessLocation> | null | "looking";

/** The harnesses the server finds, asked once as this mounts and again on `look`. */
function useHarnesses(ask: ProviderSetupIntents["harnesses"]) {
  const [found, setFound] = useState<Found>("looking");
  const askNow = () =>
    ask().then(
      (locations) => setFound(locations),
      () => setFound(null),
    );
  // Asked as this mounts, not each time the intents are made anew.
  const askOnMount = useEffectEvent(askNow);
  useEffect(() => {
    void askOnMount();
  }, []);
  const look = () => {
    setFound("looking");
    void askNow();
  };
  return { found, look };
}

const lineTone = {
  waiting: "text-waiting",
  ready: "text-success",
  blocked: "text-blocked",
} as const satisfies Record<SignInLine["tone"], string>;

/**
 * Signing the providers in from this app: a button for each harness the
 * server finds, which runs the harness's own sign-in there and opens its page
 * in the browser; the install pages when it finds none; and, folded away, an
 * endpoint instead. `fallback` is what shows when the server cannot say where
 * its harnesses are, as one from before it could.
 */
export function LocalSignIn({
  setup,
  fallback,
}: {
  readonly setup: LocalProviderSetup;
  readonly fallback: ReactNode;
}) {
  const { t } = useI18n();
  const { found, look } = useHarnesses(setup.harnesses);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const endpointRef = useRef<HTMLDivElement>(null);
  // From a sign-in that cannot work here: the form opens, in sight.
  const openEndpoint = () => {
    setEndpointOpen(true);
    requestAnimationFrame(() => endpointRef.current?.scrollIntoView({ block: "start" }));
  };
  if (found === null) return fallback;
  if (found === "looking") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("providers.notFound.looking")}
      </p>
    );
  }
  const installed = found.filter((location) => location.path !== null);
  const views = installed.map(({ harness }) => setup.signIns.get(harness) ?? idle);
  // A server that cannot run a sign-in says so once, with the fallback, for every harness.
  if (views.some((view) => view._tag === "unsupported")) return fallback;
  return (
    <div className="flex w-full flex-col gap-3 text-start">
      {installed.length === 0 ? (
        <NotFound locations={found} onLook={look} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {installed.map(({ harness }) => (
              <HarnessSignIn
                key={harness}
                harness={harness}
                view={setup.signIns.get(harness) ?? idle}
                onSignIn={() => setup.signIn(harness)}
                onCancel={() => setup.cancelSignIn(harness)}
                onEndpoint={openEndpoint}
              />
            ))}
          </ul>
          <p className="text-center text-xs text-pretty text-muted-foreground">
            {t("providers.signIn.plan")}
          </p>
        </>
      )}
      <Collapsible.Root ref={endpointRef} open={endpointOpen} onOpenChange={setEndpointOpen}>
        <Collapsible.Trigger className="pressable group -ms-2 flex min-h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90 rtl:-scale-x-100"
          />
          {t("providers.endpoint.open")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
          <EndpointForm onConnect={setup.connectEndpoint} />
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

/**
 * One harness's sign-in: its button, or, while it runs, where it stands, with
 * its page to open again and a way to stop it. Once it ended, what became of
 * it, and the button again to try once more, or the endpoint when that is the
 * way forward.
 */
function HarnessSignIn({
  harness,
  view,
  onSignIn,
  onCancel,
  onEndpoint,
}: {
  readonly harness: SignInHarness;
  readonly view: SignInView;
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
  readonly onEndpoint: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const line = signInLine(harness, view, i18n);
  const running = view._tag === "starting" || view._tag === "waiting-for-browser";
  return (
    <li className="flex flex-col gap-2">
      {!running && view._tag !== "succeeded" && (
        <Button className="h-11 w-full" onClick={onSignIn}>
          {t(harness === "claude-code" ? "providers.signIn.claude-code" : "providers.signIn.codex")}
        </Button>
      )}
      {line !== null && (
        <p role="status" className={cn("text-sm text-pretty", lineTone[line.tone])}>
          {line.text}
        </p>
      )}
      {running && (
        <div className="flex flex-wrap items-center gap-2">
          {view._tag === "waiting-for-browser" && (
            <Button
              variant="secondary"
              size="sm"
              render={<a href={view.url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {t("providers.signIn.openAgain")}
            </Button>
          )}
          <Button variant="ghost-muted" size="sm" onClick={onCancel}>
            {t("providers.signIn.cancel")}
          </Button>
        </div>
      )}
      {endpointInstead(view) && (
        <Button variant="secondary" size="sm" className="self-start" onClick={onEndpoint}>
          {t("providers.endpoint.use")}
        </Button>
      )}
    </li>
  );
}

/** Neither harness on this computer: where to install each, and a way to look again once one is. */
function NotFound({
  locations,
  onLook,
}: {
  readonly locations: ReadonlyArray<HarnessLocation>;
  readonly onLook: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-pretty text-muted-foreground">{t("providers.notFound")}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {locations.map(({ harness }) => (
          <li key={harness}>
            <a
              href={signInHarnesses[harness].installPage}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-foreground underline underline-offset-2"
            >
              {t("providers.notFound.install", { harness: signInHarnesses[harness].name })}
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </li>
        ))}
      </ul>
      <Button className="h-11 w-full" onClick={onLook}>
        {t("providers.notFound.lookAgain")}
      </Button>
    </div>
  );
}

type EndpointPhase =
  | { readonly _tag: "editing" }
  | { readonly _tag: "sending" }
  | { readonly _tag: "answered"; readonly result: ConnectEndpointResult };

/**
 * An endpoint for both harnesses, as `j3-bots provider connect` takes one:
 * its base URL, checked here as the server checks it, and its key, which only
 * the server keeps. When bots have work running, which the engine's restart
 * stops, the form says so and restarts only once asked again.
 */
function EndpointForm({
  onConnect,
}: {
  readonly onConnect: ProviderSetupIntents["connectEndpoint"];
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const urlId = useId();
  const keyId = useId();
  const problemId = useId();
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [badUrl, setBadUrl] = useState(false);
  const [phase, setPhase] = useState<EndpointPhase>({ _tag: "editing" });
  const sending = phase._tag === "sending";
  const ready = url.trim() !== "" && key.trim() !== "";

  const send = (stopWork: boolean) => {
    if (sending || !ready) return;
    const root = normalizeBaseUrl(url);
    if (root._tag === "problem") {
      setBadUrl(true);
      return;
    }
    setBadUrl(false);
    setUrl(root.url);
    setPhase({ _tag: "sending" });
    void onConnect({ baseUrl: root.url, key: Redacted.make(key.trim()), stopWork }).then(
      (result) => {
        // Once the server keeps the key, this page does not.
        if (result._tag === "applied" || result._tag === "stored") setKey("");
        setPhase({ _tag: "answered", result });
      },
    );
  };

  const answer = phase._tag === "answered" ? endpointAnswer(phase.result, i18n) : null;
  return (
    <form
      className="flex flex-col gap-3 pt-2 pb-1"
      onSubmit={(event) => {
        event.preventDefault();
        send(false);
      }}
    >
      <p className="text-sm text-pretty text-muted-foreground">{t("providers.endpoint.body")}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor={urlId} className="text-xs">
          {t("providers.endpoint.url")}
        </label>
        <input
          id={urlId}
          value={url}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://proxy.example.com"
          readOnly={sending}
          aria-invalid={badUrl}
          aria-describedby={badUrl ? problemId : undefined}
          onChange={(event) => {
            setUrl(event.currentTarget.value);
            setBadUrl(false);
          }}
          className={lineField}
        />
        {badUrl && (
          <p id={problemId} className="text-xs text-pretty text-blocked">
            {t("providers.endpoint.badUrl")}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={keyId} className="text-xs">
          {t("providers.endpoint.key")}
        </label>
        <input
          id={keyId}
          type="password"
          value={key}
          maxLength={MAX_PROVIDER_KEY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          readOnly={sending}
          onChange={(event) => setKey(event.currentTarget.value)}
          className={lineField}
        />
      </div>
      <Button type="submit" aria-disabled={!ready || sending} className="self-start">
        {sending ? t("providers.endpoint.connecting") : t("providers.endpoint.connect")}
      </Button>
      {answer !== null && (
        <p role="status" className={cn("text-sm text-pretty", lineTone[answer.tone])}>
          {answer.text}
        </p>
      )}
      {phase._tag === "answered" && phase.result._tag === "work-running" && (
        <Button variant="destructive-outline" className="self-start" onClick={() => send(true)}>
          {t("providers.endpoint.restartAnyway")}
        </Button>
      )}
    </form>
  );
}

function endpointAnswer(result: ConnectEndpointResult, { t, plural }: I18n): SignInLine {
  switch (result._tag) {
    case "applied":
      return { text: t("providers.endpoint.applied", { baseUrl: result.baseUrl }), tone: "ready" };
    case "stored":
      return {
        text: t("providers.endpoint.stored", { baseUrl: result.baseUrl }),
        tone: "waiting",
      };
    case "work-running":
      return { text: plural("providers.endpoint.workRunning", result.bots), tone: "blocked" };
    case "refused":
      return {
        text:
          result.active === null
            ? t("providers.endpoint.refused")
            : t("providers.endpoint.refusedActive", { active: result.active }),
        tone: "blocked",
      };
    case "failed":
      return { text: t("providers.endpoint.failed"), tone: "blocked" };
  }
}

/** Where the server finds each harness, for Settings: its path, or that it is not there. */
export function HarnessLocations({ setup }: { readonly setup: ProviderSetupIntents }) {
  const { t } = useI18n();
  const { found } = useHarnesses(setup.harnesses);
  if (found === null || found === "looking") return null;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      {found.map(({ harness, path }) => {
        const name = signInHarnesses[harness].name;
        return (
          <li key={harness} className="break-all">
            {path === null
              ? t("settings.engine.harness.missing", { harness: name })
              : t("settings.engine.harness.found", { harness: name, path })}
          </li>
        );
      })}
    </ul>
  );
}
