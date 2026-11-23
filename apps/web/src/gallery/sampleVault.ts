// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A vault that answers in memory, for the gallery and the sample team: the
 * client runtime's `VaultHandle`, with nothing sealed and nothing sent.
 * Development only.
 */
import {
  Cell,
  type NewCredential,
  type VaultFailure,
  type VaultHandle,
  type VaultResult,
  type VaultView,
} from "@j3-bots/client-runtime";
import {
  type BotId,
  Conflict,
  type Credential,
  type CredentialField,
  CredentialId,
  DeviceId,
  type EntryId,
  Invalid,
  NotFound,
  type VaultState,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { useState, useSyncExternalStore } from "react";
import type { VaultAccess } from "../components/vault/VaultForms";

/** The sample vault's master password, in the gallery's notes. */
export const SAMPLE_VAULT_PASSWORD = "correct horse";

/** A saved login's values, as the sample vault keeps them in the clear. */
export interface SampleValues {
  readonly username: string;
  readonly password: string;
  readonly totp: string | null;
}

interface Options {
  /** Where it starts; `unsupported` is a server from before the vault. */
  readonly state: VaultState | "unsupported";
  readonly credentials?: ReadonlyArray<readonly [Credential, SampleValues]>;
  /** A login saved from a save-login card, for the sample to close it. */
  readonly onSaved?: (request: EntryId, credential: Credential) => void;
  readonly now: () => DateTime.Utc;
}

const done = <A>(value: A): Promise<VaultResult<A>> => Promise.resolve({ _tag: "done", value });
const failed = (failure: VaultFailure): Promise<VaultResult<never>> =>
  Promise.resolve({ _tag: "failed", failure });
const refused = (error: Conflict | Invalid | NotFound) => failed({ _tag: "refused", error });

export function sampleVault({ state, credentials = [], onSaved, now }: Options): VaultHandle {
  let master = Redacted.make(SAMPLE_VAULT_PASSWORD);
  let current: VaultState = state === "unsupported" ? "locked" : state;
  let revision = 0;
  const logins = new Map<CredentialId, { credential: Credential; values: SampleValues }>(
    credentials.map(([credential, values]) => [credential.id, { credential, values }]),
  );
  const viewOf = (): VaultView =>
    state === "unsupported"
      ? { _tag: "unsupported" }
      : {
          _tag: "ready",
          status: { state: current, revision, retryAt: null },
          credentials:
            current === "unlocked"
              ? [...logins.values()].map(({ credential }) => credential)
              : null,
          listFailure: null,
          stale: false,
        };
  const view = new Cell<VaultView>(viewOf());
  const changed = () => {
    revision += 1;
    view.set(viewOf());
  };
  const gate = (): Promise<VaultResult<never>> | null =>
    current === "unlocked"
      ? null
      : refused(
          new Conflict({
            reason:
              current === "uninitialized"
                ? "vault-not-set-up"
                : current === "newer"
                  ? "vault-newer"
                  : "vault-locked",
          }),
        );
  const found = (id: CredentialId) => logins.get(id);
  const replace = (id: CredentialId, update: (credential: Credential) => Credential) => {
    const login = found(id);
    if (login === undefined) return refused(new NotFound({ resource: "credential" }));
    const credential = update(login.credential);
    logins.set(id, { ...login, credential });
    changed();
    return done(credential);
  };

  return {
    view,
    setup: (password) => {
      if (current !== "uninitialized") return refused(new Conflict({ reason: "vault-set-up" }));
      master = password;
      current = "unlocked";
      changed();
      return done(undefined);
    },
    unlock: (password) => {
      if (current === "uninitialized") return refused(new Conflict({ reason: "vault-not-set-up" }));
      if (Redacted.value(password) !== Redacted.value(master)) {
        return refused(new Invalid({ reason: "master-password" }));
      }
      current = "unlocked";
      changed();
      return done(undefined);
    },
    lock: () => {
      if (current === "unlocked") current = "locked";
      changed();
      return done(undefined);
    },
    changePassword: (was, next) => {
      if (Redacted.value(was) !== Redacted.value(master)) {
        return refused(new Invalid({ reason: "master-password" }));
      }
      master = next;
      current = "unlocked";
      changed();
      return done(undefined);
    },
    save: (draft: NewCredential, request) => {
      const closed = gate();
      if (closed !== null) return closed;
      const id = CredentialId.make(`cred_sample${String(logins.size + 1).padStart(10, "0")}`);
      const at = now();
      const credential: Credential = {
        id,
        name: draft.name,
        origins: draft.origins,
        hasTotp: draft.totp !== null,
        allowedBots: [...draft.allowedBots],
        createdAt: at,
        updatedAt: at,
        lastReveal: null,
      };
      logins.set(id, {
        credential,
        values: {
          username: Redacted.value(draft.username),
          password: Redacted.value(draft.password),
          totp: draft.totp === null ? null : Redacted.value(draft.totp),
        },
      });
      changed();
      if (request !== null) onSaved?.(request, credential);
      return done(credential);
    },
    update: (id, changes) => {
      const closed = gate();
      if (closed !== null) return closed;
      const login = found(id);
      if (login === undefined) return refused(new NotFound({ resource: "credential" }));
      logins.set(id, {
        credential: login.credential,
        values: {
          username:
            changes.username === undefined
              ? login.values.username
              : Redacted.value(changes.username),
          password:
            changes.password === undefined
              ? login.values.password
              : Redacted.value(changes.password),
          totp:
            changes.totp === undefined
              ? login.values.totp
              : changes.totp === null
                ? null
                : Redacted.value(changes.totp),
        },
      });
      return replace(id, (credential) => ({
        ...credential,
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.origins === undefined ? {} : { origins: changes.origins }),
        ...(changes.totp === undefined ? {} : { hasTotp: changes.totp !== null }),
        updatedAt: now(),
      }));
    },
    remove: (id) => {
      const closed = gate();
      if (closed !== null) return closed;
      logins.delete(id);
      changed();
      return done(undefined);
    },
    setAllowedBots: (id, bots: ReadonlyArray<BotId>) => {
      const closed = gate();
      return closed ?? replace(id, (credential) => ({ ...credential, allowedBots: [...bots] }));
    },
    reveal: (id, field: CredentialField) => {
      const closed = gate();
      if (closed !== null) return closed;
      const login = found(id);
      const value = login?.values[field] ?? null;
      if (login === undefined || value === null) {
        return refused(new NotFound({ resource: "credential" }));
      }
      void replace(id, (credential) => ({
        ...credential,
        lastReveal: { at: now(), deviceId: DeviceId.make("sample-device"), field },
      }));
      return done(Redacted.make(value));
    },
    totpPreview: (id) => {
      const closed = gate();
      if (closed !== null) return closed;
      if ((found(id)?.values.totp ?? null) === null)
        return refused(new NotFound({ resource: "credential" }));
      const at = DateTime.toEpochMillis(now());
      const period = 30_000;
      return done({
        code: Redacted.make(String(Math.floor(at / period) % 1_000_000).padStart(6, "0")),
        validUntil: DateTime.makeUnsafe((Math.floor(at / period) + 1) * period),
      });
    },
  };
}

/** A sample vault for one gallery frame, as it changes. */
export function useSampleVault(options: Options): VaultAccess {
  const [vault] = useState(() => sampleVault(options));
  const view = useSyncExternalStore(vault.view.subscribe, vault.view.get);
  return { view, intents: vault };
}
