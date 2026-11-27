// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Secrets that answer in memory, for the gallery and the sample team: the
 * client runtime's `SecretsHandle`, with nothing sealed and nothing sent.
 * Development only.
 */
import {
  Cell,
  type NewSecret,
  type SecretsFailure,
  type SecretsHandle,
  type SecretsResult,
  type SecretsView,
} from "@j3-bots/client-runtime";
import {
  Conflict,
  DeviceId,
  type EntryId,
  Invalid,
  NotFound,
  type Secret,
  type SecretChanges,
  type SecretField,
  SecretId,
  type SecretKind,
  type SecretsState,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { useState, useSyncExternalStore } from "react";
import type { SecretsAccess } from "../components/secrets/parts";
import { writeClipboard } from "../lib/clipboard";

/** A secret's values, as the sample keeps them in the clear. */
export type SampleValues =
  | {
      readonly _tag: "login";
      readonly username: string;
      readonly password: string;
      readonly totp: string | null;
    }
  | { readonly _tag: "value"; readonly value: string };

interface Options {
  readonly state: SecretsState;
  readonly secrets?: ReadonlyArray<readonly [Secret, SampleValues]>;
  /** A bot's ask answered, for the sample to close its card. */
  readonly onSaved?: (request: EntryId) => void;
  readonly now: () => DateTime.Utc;
}

const done = <A>(value: A): Promise<SecretsResult<A>> => Promise.resolve({ _tag: "done", value });
const failed = (failure: SecretsFailure): Promise<SecretsResult<never>> =>
  Promise.resolve({ _tag: "failed", failure });
const refused = (error: Conflict | Invalid | NotFound) => failed({ _tag: "refused", error });
const gone = () => refused(new NotFound({ resource: "secret" }));

/** Roughly what the server takes as a one-time code key: base32, or an `otpauth://totp/` address. */
const looksLikeTotp = (typed: string) =>
  /^otpauth:\/\/totp\//i.test(typed) || /^[a-z2-7=\s]{16,}$/i.test(typed);

const kindOf = (values: SampleValues, current: SecretKind): SecretKind =>
  values._tag === "value" || current._tag === "value"
    ? { _tag: "value" }
    : { ...current, hasTotp: values.totp !== null };

/** The values of a secret after `changes`; null when they are for another kind of secret. */
const changedValues = (values: SampleValues, changes: SecretChanges): SampleValues | null => {
  const read = (value: Redacted.Redacted<string> | undefined, kept: string) =>
    value === undefined ? kept : Redacted.value(value);
  if (values._tag === "value") {
    const forLogin = [changes.origins, changes.username, changes.password, changes.totp];
    if (forLogin.some((change) => change !== undefined)) return null;
    return { _tag: "value", value: read(changes.value, values.value) };
  }
  if (changes.value !== undefined) return null;
  return {
    _tag: "login",
    username: read(changes.username, values.username),
    password: read(changes.password, values.password),
    totp:
      changes.totp === undefined
        ? values.totp
        : changes.totp === null
          ? null
          : Redacted.value(changes.totp),
  };
};

export function sampleSecrets({ state, secrets = [], onSaved, now }: Options): SecretsHandle {
  let current: SecretsState = state;
  let revision = 0;
  let added = 0;
  const saved = new Map<SecretId, { secret: Secret; values: SampleValues }>(
    secrets.map(([secret, values]) => [secret.id, { secret, values }]),
  );
  const viewOf = (): SecretsView => ({
    _tag: "ready",
    status: { state: current, revision },
    secrets: current === "ready" ? [...saved.values()].map(({ secret }) => secret) : null,
    listFailure: null,
    stale: false,
  });
  const view = new Cell<SecretsView>(viewOf());
  const changed = () => {
    revision += 1;
    view.set(viewOf());
  };
  const unavailable = () =>
    current === "ready" ? null : refused(new Conflict({ reason: "secrets-unavailable" }));
  const taken = (name: string, except: SecretId | null) =>
    [...saved.values()].some(({ secret }) => secret.name === name && secret.id !== except);
  const replace = (id: SecretId, update: (secret: Secret) => Secret) => {
    const found = saved.get(id);
    if (found === undefined) return gone();
    const secret = update(found.secret);
    saved.set(id, { ...found, secret });
    changed();
    return done(secret);
  };

  const store = ({ name, draft, access }: NewSecret): Secret => {
    added += 1;
    const at = now();
    const secret: Secret = {
      id: SecretId.make(`sec_sampleadded${String(added).padStart(6, "0")}`),
      name,
      kind:
        draft._tag === "login"
          ? { _tag: "login", origins: draft.origins, hasTotp: draft.totp !== null }
          : { _tag: "value" },
      access,
      createdAt: at,
      updatedAt: at,
      lastUse: null,
      lastReveal: null,
    };
    saved.set(secret.id, {
      secret,
      values:
        draft._tag === "login"
          ? {
              _tag: "login",
              username: Redacted.value(draft.username),
              password: Redacted.value(draft.password),
              totp: draft.totp === null ? null : Redacted.value(draft.totp),
            }
          : { _tag: "value", value: Redacted.value(draft.value) },
    });
    changed();
    return secret;
  };

  return {
    view,
    add: (secret, request) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      if (taken(secret.name, null)) return refused(new Conflict({ reason: "secret-name-taken" }));
      const { draft } = secret;
      if (
        draft._tag === "login" &&
        draft.totp !== null &&
        !looksLikeTotp(Redacted.value(draft.totp))
      ) {
        return refused(new Invalid({ reason: "totp" }));
      }
      const stored = store(secret);
      if (request !== null) onSaved?.(request);
      return done(stored);
    },
    addFromAsk: ({ request, access, values }) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      if (values.some(({ name }) => taken(name, null))) {
        return refused(new Conflict({ reason: "secret-name-taken" }));
      }
      const stored = values.map(({ name, value }) =>
        store({ name, draft: { _tag: "value", value }, access }),
      );
      onSaved?.(request);
      return done(stored);
    },
    update: (id, changes) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      const found = saved.get(id);
      if (found === undefined) return gone();
      if (changes.name !== undefined && taken(changes.name, id)) {
        return refused(new Conflict({ reason: "secret-name-taken" }));
      }
      if (
        changes.totp !== undefined &&
        changes.totp !== null &&
        !looksLikeTotp(Redacted.value(changes.totp))
      ) {
        return refused(new Invalid({ reason: "totp" }));
      }
      const values = changedValues(found.values, changes);
      if (values === null) return refused(new Invalid({ reason: "secret-kind" }));
      saved.set(id, { secret: found.secret, values });
      return replace(id, (secret) => {
        const kind = kindOf(values, secret.kind);
        return {
          ...secret,
          ...(changes.name === undefined ? {} : { name: changes.name }),
          kind:
            kind._tag === "login" && changes.origins !== undefined
              ? { ...kind, origins: changes.origins }
              : kind,
          updatedAt: now(),
        };
      });
    },
    remove: (id) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      if (!saved.delete(id)) return gone();
      changed();
      return done(undefined);
    },
    setAccess: (id, access) => unavailable() ?? replace(id, (secret) => ({ ...secret, access })),
    reveal: (id, field: SecretField) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      const values = saved.get(id)?.values;
      const value =
        values === undefined
          ? null
          : values._tag === "value"
            ? field === "value"
              ? values.value
              : null
            : field === "value"
              ? null
              : values[field];
      if (value === null) return gone();
      void replace(id, (secret) => ({
        ...secret,
        lastReveal: { at: now(), deviceId: DeviceId.make("sample-device"), field },
      }));
      return done(Redacted.make(value));
    },
    totpPreview: (id) => {
      const closed = unavailable();
      if (closed !== null) return closed;
      const values = saved.get(id)?.values;
      if (values?._tag !== "login" || values.totp === null) return gone();
      const at = DateTime.toEpochMillis(now());
      const period = 30_000;
      return done({
        code: Redacted.make(String(Math.floor(at / period) % 1_000_000).padStart(6, "0")),
        validUntil: DateTime.makeUnsafe((Math.floor(at / period) + 1) * period),
      });
    },
  };
}

/** Copies a sample value as a browser does: it stays on the clipboard. */
export const copySample = (value: Redacted.Redacted<string>): Promise<boolean> =>
  writeClipboard(Redacted.value(value));

/** Sample secrets for one gallery frame, as they change. */
export function useSampleSecrets(options: Options): SecretsAccess {
  const [secrets] = useState(() => sampleSecrets(options));
  const view = useSyncExternalStore(secrets.view.subscribe, secrets.view.get);
  return { view, intents: { ...secrets, copy: copySample } };
}
