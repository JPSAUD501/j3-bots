// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectEndpointResult, SignInView } from "@j3-bots/client-runtime";
import {
  type EngineStatus,
  type HarnessLocation,
  MAX_PROVIDER_KEY_LENGTH,
  normalizeBaseUrl,
  type ProviderConnectionRequest,
  type SignInHarness,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import type { I18n } from "@j3-bots/i18n";
import { useEffect, useEffectEvent, useId, useState } from "react";
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

/** Where the server finds each harness: `looking` until it said, null when it could not. */
type Found = ReadonlyArray<HarnessLocation> | null | "looking";

/**
 * What changes when the engine finds a harness or stops finding one, from
 * its providers' states and the copies J3 Bots installed: a reason to ask
 * the server again where the harnesses are, as after **Look again** found
 * one installed since, or once J3 Bots' own copy is made current, which may
 * come after the engine reported the provider with it.
 */
export const engineFindings = (engine: EngineStatus | null): string =>
  engine === null
    ? ""
    : engine.providers
        .map(({ id, status, copy }) => {
          const state =
            status._tag === "unavailable"
              ? `${id}:unavailable:${status.reason ?? ""}`
              : `${id}:${status._tag}`;
          return copy === undefined ? state : `${state}:${copy.source}:${copy.version ?? ""}`;
        })
        .join(",");

/**
 * The harnesses the server finds, asked as this mounts and again each time
 * `findings` changes.
 */
export function useHarnesses(ask: ProviderSetupIntents["harnesses"], findings: string) {
  const [found, setFound] = useState<Found>("looking");
  const askNow = () =>
    ask().then(
      (locations) => setFound(locations),
      () => setFound(null),
    );
  // Asked as this mounts and as the engine's findings change, not each time
  // the intents are made anew: the findings are what the effect follows.
  const askFor = useEffectEvent((_findings: string) => askNow());
  useEffect(() => {
    void askFor(findings);
  }, [findings]);
  return { found };
}

const lineTone = {
  waiting: "text-waiting",
  ready: "text-success",
  blocked: "text-blocked",
} as const;

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
export function EndpointForm({
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

function endpointAnswer(
  result: ConnectEndpointResult,
  { t, plural }: I18n,
): { readonly text: string; readonly tone: keyof typeof lineTone } {
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
