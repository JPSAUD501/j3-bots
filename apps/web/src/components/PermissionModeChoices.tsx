// SPDX-License-Identifier: AGPL-3.0-or-later
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { PermissionMode } from "@j3-bots/contracts";
import { permissionModeText } from "@j3-bots/client-runtime/wording";
import * as Schema from "effect/Schema";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { ChoiceIndicator, choiceRow } from "./ui/choice";

const modes = PermissionMode.literals;
const isMode = Schema.is(PermissionMode);

/** Every permission mode, each with what it lets a bot do, as one choice. */
export function PermissionModeChoices({
  value,
  onChange,
  readOnly,
  labelledBy,
}: {
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
  readonly readOnly: boolean;
  /** The id of the text that names the choice. */
  readonly labelledBy: string;
}) {
  const i18n = useI18n();
  return (
    <RadioGroup
      aria-labelledby={labelledBy}
      value={value}
      onValueChange={(picked: unknown) => {
        if (isMode(picked)) onChange(picked);
      }}
      readOnly={readOnly}
      className="flex flex-col gap-1.5"
    >
      {modes.map((option) => {
        const text = permissionModeText(option, i18n);
        return (
          <Radio.Root
            key={option}
            value={option}
            className={cn(
              choiceRow,
              "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-readonly:hover:bg-transparent",
            )}
          >
            <ChoiceIndicator shape="round">
              <Radio.Indicator className="size-2 rounded-pill bg-background" />
            </ChoiceIndicator>
            <span className="flex flex-col">
              <span>{text.name}</span>
              <span className="text-xs text-muted-foreground">{text.description}</span>
            </span>
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}
