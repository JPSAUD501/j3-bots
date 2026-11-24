// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VaultStatus } from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { clockTime } from "../presentation/time.ts";
import type { VaultFailure } from "../stores/Vault.ts";
import type { TimeContext } from "./time.ts";

/** Why a request to the vault failed, in a sentence. */
export const vaultFailureText = (failure: VaultFailure, ctx: TimeContext): string => {
  const { t } = ctx.i18n;
  if (failure._tag !== "refused") return t("vault.failed");
  const { error } = failure;
  switch (error._tag) {
    case "RateLimited":
      return t("vault.wait", { time: clockTime(error.retryAt, ctx) });
    case "Invalid":
      return error.reason === "master-password"
        ? t("vault.wrong")
        : error.reason === "totp"
          ? t("login.totpInvalid")
          : t("vault.failed");
    case "Conflict":
      return error.reason === "vault-locked"
        ? t("vault.lockedBody")
        : error.reason === "vault-not-set-up"
          ? t("vault.notSetUp")
          : error.reason === "vault-newer"
            ? t("vault.newer")
            : error.reason === "vault-damaged"
              ? t("vault.damaged")
              : t("vault.failed");
    case "NotFound":
      return t("vault.failed");
  }
};

/** Until when unlocking waits, while it does now. */
export const unlockWaitsUntil = (status: VaultStatus, now: DateTime.Utc): DateTime.Utc | null =>
  status.retryAt !== null && DateTime.isLessThan(now, status.retryAt) ? status.retryAt : null;
