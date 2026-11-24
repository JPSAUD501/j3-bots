// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UpdateChannel } from "@j3-bots/contracts";
import { useId } from "react";
import { useI18n } from "../app/context";
import { Segmented } from "./ui/segmented";

/**
 * The releases something follows, stable ones or nightly builds too, with
 * what nightly means and, on the stable channel while it still runs a
 * nightly build, that it stays on it until a stable release is newer. Only
 * an update forward is ever installed, so a channel never moves back.
 */
export function UpdateChannelChoice({
  channel,
  onChange,
  disabled,
  waitingForStable,
  label,
}: {
  channel: UpdateChannel;
  onChange: (channel: UpdateChannel) => void;
  /** While a version is on its way or installing, the channel stays as it is. */
  disabled: boolean;
  /** The nightly version it runs while it waits for a newer stable one, or null. */
  waitingForStable: string | null;
  /** What it names: the app or the server. */
  label: string;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const options: ReadonlyArray<{ value: UpdateChannel; label: string }> = [
    { value: "stable", label: t("updateChannel.stable") },
    { value: "nightly", label: t("updateChannel.nightly") },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-xs">
        {label}
      </span>
      <Segmented
        value={channel}
        options={options}
        onChange={onChange}
        labelledBy={labelId}
        disabled={disabled}
      />
      <p className="text-2xs text-muted-foreground">
        {waitingForStable !== null
          ? t("updateChannel.waitingForStable", { version: waitingForStable })
          : channel === "nightly"
            ? t("updateChannel.nightly.hint")
            : t("updateChannel.stable.hint")}
      </p>
    </div>
  );
}
