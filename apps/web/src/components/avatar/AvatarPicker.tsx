// SPDX-License-Identifier: AGPL-3.0-or-later
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { type Avatar, AvatarChoice } from "@j3-bots/contracts";
import { avatarShapeText, botColorText } from "@j3-bots/client-runtime/wording";
import { avatarShapeNames, botColors, resolveAvatar } from "@j3-bots/design-tokens";
import * as Schema from "effect/Schema";
import { useEffect, useId, useRef } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";
import { type AvatarHandle, BotAvatar } from "./BotAvatar";

const isShape = Schema.is(AvatarChoice.fields.shape);
const isColor = Schema.is(AvatarChoice.fields.color);

export interface AvatarPickerProps {
  /** The avatar shown. A token this version does not know shows, and is picked from, as its fallback. */
  readonly value: Avatar;
  readonly onChange: (value: AvatarChoice) => void;
  /** The name typed so far: the preview perks up as it changes. */
  readonly name: string;
  /** What gives the preview its own way of moving: the bot's id, or any stable text before it has one. */
  readonly seed: string;
  readonly readOnly?: boolean;
  readonly className?: string;
}

const option =
  "flex aspect-square items-center justify-center pressable rounded-md outline-offset-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent data-checked:bg-muted data-checked:ring-1 data-checked:ring-foreground/60 data-readonly:hover:bg-transparent";

/**
 * A bot's look: its silhouette and its color (`AvatarChoices`), beside a live
 * preview that reacts to a new name, shape or color.
 */
export function AvatarPicker({
  value,
  onChange,
  name,
  seed,
  readOnly = false,
  className,
}: AvatarPickerProps) {
  const picked = resolveAvatar(value);
  const preview = useRef<AvatarHandle>(null);

  // The preview answers each change after the first render: typing nods, a new shape morphs.
  const seen = useRef({ name, shape: picked.shape, color: picked.color });
  useEffect(() => {
    const last = seen.current;
    seen.current = { name, shape: picked.shape, color: picked.color };
    if (picked.shape !== last.shape) preview.current?.poke("morph");
    else if (picked.color !== last.color) preview.current?.poke("hop");
    else if (name !== last.name) preview.current?.poke("type");
  }, [name, picked.shape, picked.color]);

  return (
    <div className={cn("flex gap-4", className)}>
      <div className="flex size-24 shrink-0 items-center justify-center">
        <BotAvatar ref={preview} avatar={picked} seed={seed} state="idle" size={88} />
      </div>
      <AvatarChoices
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        className="min-w-0 flex-1"
      />
    </div>
  );
}

/**
 * The choices of a bot's look, without a preview, for a place that shows the
 * bot already: its silhouette and its color, each a group of radios. Each
 * shape shows in the color picked, so the operator sees the pair they will get.
 */
export function AvatarChoices({
  value,
  onChange,
  readOnly = false,
  className,
}: Pick<AvatarPickerProps, "value" | "onChange" | "readOnly" | "className">) {
  const i18n = useI18n();
  const { t } = i18n;
  const shapeId = useId();
  const colorId = useId();
  const picked = resolveAvatar(value);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-1">
        <p id={shapeId} className="text-xs">
          {t("avatar.shape")}
        </p>
        <RadioGroup
          aria-labelledby={shapeId}
          value={picked.shape}
          readOnly={readOnly}
          onValueChange={(shape: unknown) => {
            if (isShape(shape)) onChange({ shape, color: picked.color });
          }}
          className="grid grid-cols-6 gap-1"
        >
          {avatarShapeNames.map((shape) => (
            <Radio.Root
              key={shape}
              value={shape}
              aria-label={avatarShapeText(shape, i18n)}
              className={option}
            >
              <BotAvatar
                avatar={{ shape, color: picked.color }}
                seed={shape}
                state="idle"
                size={26}
                still
              />
            </Radio.Root>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-1">
        <p id={colorId} className="text-xs">
          {t("avatar.color")}
        </p>
        <RadioGroup
          aria-labelledby={colorId}
          value={picked.color}
          readOnly={readOnly}
          onValueChange={(color: unknown) => {
            if (isColor(color)) onChange({ shape: picked.shape, color });
          }}
          className="grid grid-cols-6 gap-1"
        >
          {botColors.map((color) => (
            <Radio.Root
              key={color}
              value={color}
              aria-label={botColorText(color, i18n)}
              className={option}
            >
              <span
                aria-hidden
                className="size-5 rounded-pill"
                style={{ background: `var(--bot-${color})` }}
              />
            </Radio.Root>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
