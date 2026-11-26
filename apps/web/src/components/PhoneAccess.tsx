// SPDX-License-Identifier: AGPL-3.0-or-later
import { clockTime } from "@j3-bots/client-runtime/presentation";
import { type PairingCode, PairingLink, type ServerOrigin } from "@j3-bots/contracts";
import type { LocalPairingLink, PhoneAccess } from "@j3-bots/desktop-bridge";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useEffect, useId, useState } from "react";
import { useSeconds } from "../app/clock";
import { useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import type { DesktopPhone, DesktopSystem } from "../shell/data";
import { CommandLine } from "./CommandLine";
import { PairingQr } from "./PairingQr";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm";
import { lineField } from "./ui/field";
import { Switch } from "./ui/switch";

// "Use from your phone", in Settings while the bots live on this computer:
// the switch that lets phones on this network reach them, what holds, and,
// once it does, a code to pair a phone with and what the firewall may need.
// Turning it on or off restarts the bots; the operator is asked first only
// while some have work running.

const encodeLink = Schema.encodeSync(PairingLink);

/** The link a phone's camera opens to pair: `<server>/pair#<code>`, and nothing else. */
const phonePairingLink = (server: ServerOrigin, code: PairingCode): string =>
  encodeLink({ server, code });

/** A code as the operator types it: two groups of five. */
const typedCode = (code: PairingCode) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** What the line under the switch says, while phone access is on. */
type AccessLine =
  | { readonly _tag: "turning-on" }
  | { readonly _tag: "held"; readonly origins: readonly [ServerOrigin, ...ServerOrigin[]] }
  | {
      readonly _tag: "refused";
      readonly reason: NonNullable<PhoneAccess["refusedReason"]>;
      readonly detail?: string;
    };

const lineOf = (access: PhoneAccess): AccessLine | null => {
  if (!access.on) return null;
  if (access.refusedReason !== undefined) {
    return access.detail === undefined
      ? { _tag: "refused", reason: access.refusedReason }
      : { _tag: "refused", reason: access.refusedReason, detail: access.detail };
  }
  const [first, ...others] = access.origins;
  return first === undefined
    ? { _tag: "turning-on" }
    : { _tag: "held", origins: [first, ...others] };
};

const REFUSAL_KEY = {
  "public-address": "settings.phone.public",
  unavailable: "settings.phone.unavailable",
  "no-network": "settings.phone.noNetwork",
  "not-running": "settings.phone.notRunning",
} as const;

/** The switch, what holds, and, while phones reach the bots, pairing one and the firewall. */
export function PhoneAccessSetting({ phone }: { readonly phone: DesktopPhone }) {
  const { t, plural } = useI18n();
  const switchId = useId();
  const hintId = useId();
  const [access, setAccess] = useState(phone.access);
  const { follow } = phone;
  useEffect(() => follow(setAccess), [follow]);
  /** What the switch shows while a change is under way. */
  const [shown, setShown] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * The change that waits for the operator's yes, as bots have work running,
   * or may have: `bots` is `null` when the server could not say.
   */
  const [asking, setAsking] = useState<{
    readonly on: boolean;
    readonly bots: number | null;
  } | null>(null);
  const pending = shown !== null;

  const send = (on: boolean, stopWork: boolean) => {
    setShown(on);
    setFailed(false);
    void phone.set(on, stopWork).then((answer) => {
      setShown(null);
      if (answer === null) return setFailed(true);
      switch (answer._tag) {
        case "changed":
          return setAccess(answer.access);
        case "not-saved":
          setAccess(answer.access);
          return setFailed(true);
        case "work-running":
          return setAsking({ on, bots: answer.bots });
      }
    });
  };

  const line = lineOf(access);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={switchId} className="text-sm">
            {t("settings.phone")}
          </label>
          <span id={hintId} className="text-2xs text-muted-foreground">
            {t("settings.phone.hint")}
          </span>
        </span>
        <Switch
          id={switchId}
          checked={shown ?? access.on}
          readOnly={pending}
          aria-describedby={hintId}
          onCheckedChange={(next) => send(next, false)}
        />
      </div>
      <ul className="flex flex-col gap-1 text-2xs text-pretty text-muted-foreground">
        <li>{t("settings.phone.trust")}</li>
        <li>{t("settings.phone.sameNetwork")}</li>
        <li>{t("settings.phone.awake")}</li>
      </ul>
      <div role="status" className="flex flex-col gap-2 empty:hidden">
        {failed && <p className="text-xs text-blocked">{t("settings.phone.failed")}</p>}
        {line?._tag === "turning-on" && (
          <p className="text-sm text-muted-foreground">{t("settings.phone.turningOn")}</p>
        )}
        {line?._tag === "held" && (
          <p className="text-sm break-all">
            {t("settings.phone.on", { address: line.origins[0] })}
          </p>
        )}
        {line?._tag === "refused" && (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-sm text-pretty text-blocked">{t(REFUSAL_KEY[line.reason])}</p>
            {line.detail !== undefined && (
              <p className="text-2xs break-words text-muted-foreground">{line.detail}</p>
            )}
            {/* The server's own failure says why, and starts it again. */}
            {line.reason !== "not-running" && (
              <Button
                size="sm"
                aria-disabled={pending}
                onClick={() => !pending && send(true, false)}
              >
                {t("settings.phone.retry")}
              </Button>
            )}
          </div>
        )}
      </div>
      {line?._tag === "held" && (
        <>
          <PairPhone pairingLink={phone.pairingLink} />
          <Firewall system={phone.system} origin={line.origins[0]} />
        </>
      )}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={t("settings.phone.restart.title")}
        body={
          asking === null
            ? ""
            : asking.bots === null
              ? t("settings.phone.restart.unknown")
              : plural("settings.phone.restart.body", asking.bots)
        }
        cancel={t("settings.phone.restart.cancel")}
        confirm={t("settings.phone.restart")}
        onConfirm={() => {
          if (asking !== null) send(asking.on, true);
        }}
      />
    </div>
  );
}

/** What the firewall on this system may need for a phone to connect, at `origin`'s port. */
function Firewall({
  system,
  origin,
}: {
  readonly system: DesktopSystem;
  readonly origin: ServerOrigin;
}) {
  const { t } = useI18n();
  if (system !== "linux") {
    return (
      <p className="text-2xs text-pretty text-muted-foreground">
        {t(
          system === "windows" ? "settings.phone.firewall.windows" : "settings.phone.firewall.mac",
        )}
      </p>
    );
  }
  const url = new URL(origin);
  const port = url.port === "" ? "80" : url.port;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-2xs text-pretty text-muted-foreground">
        {t("settings.phone.firewall.linux")}
      </p>
      <CommandLine
        command={`sudo ufw allow ${port}/tcp`}
        copyLabel={t("settings.phone.firewall.copy")}
      />
    </div>
  );
}

export type Pairing =
  | { readonly _tag: "idle" }
  | { readonly _tag: "asking" }
  | { readonly _tag: "answered"; readonly link: LocalPairingLink | null };

/**
 * "Pair a phone": a code from the bots on this computer, as a QR code of the
 * pairing link and typed out with the address, until it expires; then
 * another. While wrong codes lock pairing, the operator, at this computer,
 * can lift the lock.
 */
export function PairPhone({
  pairingLink,
  initial = { _tag: "idle" },
}: {
  readonly pairingLink: DesktopPhone["pairingLink"];
  /** What shows at first, for the gallery. */
  readonly initial?: Pairing;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [pairing, setPairing] = useState<Pairing>(initial);
  const asking = pairing._tag === "asking";
  const ask = (unlock: boolean) => {
    if (asking) return;
    setPairing({ _tag: "asking" });
    void pairingLink(unlock).then((link) => setPairing({ _tag: "answered", link }));
  };
  const link = pairing._tag === "answered" ? pairing.link : null;
  const granted = link?._tag === "granted" ? link : null;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" variant="primary" aria-disabled={asking} onClick={() => ask(false)}>
        {granted === null ? t("settings.phone.pair") : t("settings.phone.pair.again")}
      </Button>
      <div role="status" className="w-full empty:hidden">
        {granted !== null && <CodeShown link={granted} />}
        {link?._tag === "locked" && (
          <div className="flex flex-col items-start gap-1.5">
            <p className="text-xs text-pretty text-blocked">
              {t("settings.phone.pair.locked", { time: clockTime(link.until, ctx) })}
            </p>
            <Button size="sm" aria-disabled={asking} onClick={() => ask(true)}>
              {t("settings.phone.pair.unlock")}
            </Button>
          </div>
        )}
        {pairing._tag === "answered" &&
          (link === null || link._tag === "phone-access-off" || link._tag === "unavailable") && (
            <p className="text-xs text-blocked">{t("settings.phone.pair.failed")}</p>
          )}
      </div>
    </div>
  );
}

/** `m:ss` of a span of milliseconds. */
const minutesAndSeconds = (millis: number) => {
  const seconds = Math.ceil(millis / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The code: a QR code of the link for the address picked (the first the
 * server offers, unless the operator picks another), the address and the
 * code typed out, and how long it still works.
 */
function CodeShown({
  link,
}: {
  readonly link: Extract<LocalPairingLink, { readonly _tag: "granted" }>;
}) {
  const { t } = useI18n();
  const addressId = useId();
  const [picked, setPicked] = useState<ServerOrigin | null>(null);
  // The code came with the addresses it works at; the pick holds while it is one of them.
  const { origins } = link;
  const server = picked !== null && origins.includes(picked) ? picked : origins[0];
  const now = useSeconds(true);
  const left = DateTime.toEpochMillis(link.expiresAt) - now;
  if (server === undefined) return null;
  if (left <= 0) {
    return <p className="text-xs text-muted-foreground">{t("settings.phone.pair.expired")}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-pretty text-muted-foreground">{t("settings.phone.pair.scan")}</p>
      <div className="flex flex-wrap items-start gap-4">
        <PairingQr
          text={phonePairingLink(server, link.code)}
          label={t("settings.pair.qr", { address: server })}
        />
        <dl className="flex min-w-0 flex-col gap-1">
          <dt className="text-2xs text-muted-foreground">{t("settings.phone.pair.address")}</dt>
          <dd className="font-mono text-sm break-all">{server}</dd>
          <dt className="pt-1 text-2xs text-muted-foreground">{t("settings.phone.pair.code")}</dt>
          <dd className="font-mono text-lg tracking-wider">{typedCode(link.code)}</dd>
          <dd className="pt-1 text-2xs text-muted-foreground tabular-nums">
            {t("settings.phone.pair.expiresIn", { time: minutesAndSeconds(left) })}
          </dd>
        </dl>
      </div>
      {origins.length > 1 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={addressId} className="text-xs">
            {t("settings.pair.address")}
          </label>
          <select
            id={addressId}
            value={server}
            onChange={(event) => {
              const chosen = origins.find((origin) => origin === event.currentTarget.value);
              if (chosen !== undefined) setPicked(chosen);
            }}
            className={cn(lineField, "max-w-xs")}
          >
            {origins.map((origin) => (
              <option key={origin} value={origin}>
                {origin}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
