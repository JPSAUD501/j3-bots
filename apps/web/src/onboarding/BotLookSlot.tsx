// SPDX-License-Identifier: AGPL-3.0-or-later
import { firstLooks } from "@j3-bots/client-runtime/presentation";
import type { AvatarChoice } from "@j3-bots/contracts";
import { useI18n } from "../app/context";
import { BotAvatar } from "../components/BotAvatar";
import { cn } from "../lib/cn";

const idle = { _tag: "idle" } as const;

/**
 * Where the first run lets the operator choose the first bot's look. The
 * large preview above it is the first run's own; this is the choice. It
 * offers today's avatars until the avatar picker takes its place, which takes
 * the same `look` and `onLook`. Until then each option is named by its place
 * ("Look 3 of 8") and reached with Tab: the picker brings names for each look
 * and arrow keys between them, as a radio group has.
 */
export function BotLookSlot({
  look,
  onLook,
}: {
  readonly look: AvatarChoice;
  readonly onLook: (look: AvatarChoice) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="radiogroup"
      aria-label={t("onboarding.look.options")}
      className="grid grid-cols-4 gap-2 [--avatar-cutout:var(--surface)]"
    >
      {firstLooks.map((option, index) => {
        const chosen = option.shape === look.shape && option.color === look.color;
        return (
          <button
            key={`${option.shape}/${option.color}`}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={t("onboarding.look.option", {
              number: index + 1,
              count: firstLooks.length,
            })}
            onClick={() => onLook(option)}
            className={cn(
              "pressable flex size-16 items-center justify-center rounded-lg border-2 border-transparent bg-surface hover:bg-muted pointer-coarse:size-18",
              chosen && "border-foreground",
            )}
          >
            <BotAvatar avatar={option} state={idle} size={40} still />
          </button>
        );
      })}
    </div>
  );
}
