// SPDX-License-Identifier: AGPL-3.0-or-later
import { avatarShapeText, botColorText } from "@j3-bots/client-runtime/wording";
import type { Avatar, AvatarChoice } from "@j3-bots/contracts";
import {
  avatarBodyColor,
  avatarShapeNames,
  botColors,
  resolveAvatar,
} from "@j3-bots/design-tokens";
import { type ReactNode, useEffect, useRef } from "react";
import { View } from "react-native";
import { useUniwind } from "uniwind";
import { useI18n } from "../../i18n.ts";
import { PressScale } from "../../press.tsx";
import { Text } from "../../text.tsx";
import { type AvatarHandle, BotAvatar } from "./BotAvatar.tsx";

export interface AvatarPickerProps {
  /** The avatar shown. A token this version does not know shows, and is picked from, as its fallback. */
  readonly value: Avatar;
  readonly onChange: (value: AvatarChoice) => void;
  /** The name typed so far: the preview perks up as it changes. */
  readonly name: string;
  /** What gives the preview its own way of moving: the bot's id, or any stable text before it has one. */
  readonly seed: string;
  readonly readOnly?: boolean;
}

/**
 * A bot's look: its silhouette and its color, each a group of radios, under
 * a live preview that reacts to a new name, shape or color. Each shape shows
 * in the color picked, so the operator sees the pair they will get.
 */
export function AvatarPicker({ value, onChange, name, seed, readOnly = false }: AvatarPickerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
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
    <View className="gap-3">
      <View className="items-center py-1">
        <BotAvatar ref={preview} avatar={picked} seed={seed} state="idle" size={88} />
      </View>
      <Group
        label={t("avatar.shape")}
        values={avatarShapeNames}
        renderOption={(shape) => (
          <Option
            key={shape}
            label={avatarShapeText(shape, i18n)}
            selected={shape === picked.shape}
            readOnly={readOnly}
            onPress={() => onChange({ shape, color: picked.color })}
          >
            <BotAvatar
              avatar={{ shape, color: picked.color }}
              seed={shape}
              state="idle"
              size={30}
              still
            />
          </Option>
        )}
      />
      <Group
        label={t("avatar.color")}
        values={botColors}
        renderOption={(color) => (
          <Option
            key={color}
            label={botColorText(color, i18n)}
            selected={color === picked.color}
            readOnly={readOnly}
            onPress={() => onChange({ shape: picked.shape, color })}
          >
            <View
              className="size-6 rounded-pill"
              style={{ backgroundColor: avatarBodyColor(color, theme, false) }}
            />
          </Option>
        )}
      />
    </View>
  );
}

/** Options to a row. Rows of their own, since six sixths of a width can round past it and wrap. */
const PER_ROW = 6;

/** A labelled group of options, one per value, six to a row. */
function Group<Value extends string>({
  label,
  values,
  renderOption,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<Value>;
  readonly renderOption: (value: Value) => ReactNode;
}) {
  const rows = Array.from({ length: Math.ceil(values.length / PER_ROW) }, (_, row) =>
    values.slice(row * PER_ROW, (row + 1) * PER_ROW),
  );
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label}>
        {rows.map((row) => (
          <View key={row.join(" ")} className="flex-row">
            {row.map(renderOption)}
          </View>
        ))}
      </View>
    </View>
  );
}

function Option({
  label,
  selected,
  readOnly,
  onPress,
  children,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <View className="aspect-square flex-1 p-0.5">
      <PressScale
        frame={{ flex: 1 }}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={{ selected, disabled: readOnly }}
        onPress={() => {
          if (!readOnly && !selected) onPress();
        }}
        className={`flex-1 items-center justify-center rounded-md border ${selected ? "border-foreground bg-muted" : "border-transparent active:bg-muted"}`}
      >
        {children}
      </PressScale>
    </View>
  );
}
