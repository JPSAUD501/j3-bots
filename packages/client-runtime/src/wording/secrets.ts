// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SecretsStatus } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type { SecretsFailure } from "../stores/Secrets.ts";

/** Why a request about secrets failed, in a sentence. */
export const secretsFailureText = (failure: SecretsFailure, i18n: I18n): string => {
  const { t } = i18n;
  if (failure._tag !== "refused") return t("secrets.failed");
  const { error } = failure;
  switch (error._tag) {
    case "Invalid":
      return error.reason === "totp" ? t("secrets.totpInvalid") : t("secrets.failed");
    case "Conflict":
      return error.reason === "secret-name-taken"
        ? t("secrets.nameTaken")
        : error.reason === "secrets-damaged"
          ? t("secrets.damaged")
          : error.reason === "secrets-unavailable"
            ? t("ask.unavailable")
            : t("secrets.failed");
    case "NotFound":
      return t("secrets.gone");
  }
};

/**
 * What stands between the operator and their secrets, in a sentence, while
 * their state is not `ready`; null when it is.
 */
export const secretsStateText = (status: SecretsStatus, i18n: I18n): string | null => {
  const { t } = i18n;
  switch (status.state) {
    case "ready":
      return null;
    case "unreadable":
      return t("secrets.unreadable");
    case "newer":
      return t("secrets.newer");
  }
};
