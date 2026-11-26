// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  movedOption,
  type PromptOption,
  promptArguments,
  promptOptions,
  promptQuery,
} from "@j3-bots/client-runtime/presentation";
import type { PromptArguments } from "@j3-bots/contracts";
import { SquareSlashIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../app/context";
import { fieldText, selectInField } from "./ChipField";
import { FieldFrame, type FieldControl } from "./connectors/parts";
import { Button } from "./ui/button";
import { lineField } from "./ui/field";

/** The prompt a connector's server wrote, or null when it did not. */
export type RenderedPrompt = { readonly text: string; readonly cut: boolean } | null;

/** What the composer of a bot's conversation needs for its `/` menu. */
export interface PromptMenu {
  /** The prompts the bot's connectors offer now; null when they could not be read. */
  readonly load: () => Promise<ReadonlyArray<PromptOption> | null>;
  readonly render: (prompt: PromptOption, given: PromptArguments) => Promise<RenderedPrompt>;
}

/** The prompt the operator picked, while they fill in its arguments or its server writes it. */
export interface ChosenPrompt {
  readonly prompt: PromptOption;
  readonly drafts: Readonly<Record<string, string>>;
  readonly writing: boolean;
  readonly failed: boolean;
  /** Use was pressed: an empty required argument says so. */
  readonly tried: boolean;
}

/**
 * The `/` menu of a bot's conversation: while the whole draft is `/` and a
 * word, the prompts its connectors offer that match it, read when the `/` is
 * typed. A pick with no arguments is written at once; one with arguments opens
 * a small form first. What the server writes replaces the draft, for the
 * operator to read and send as their own message. Without `menu` it never opens.
 */
export function usePromptPicker({
  draftKey,
  value,
  onValueChange,
  field,
  menu,
}: {
  draftKey: string;
  value: string;
  onValueChange: (value: string) => void;
  field: RefObject<HTMLDivElement | null>;
  menu: PromptMenu | undefined;
}) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [prompts, setPrompts] = useState<ReadonlyArray<PromptOption>>([]);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<ChosenPrompt | null>(null);
  const [cut, setCut] = useState(false);
  // Where the caret goes once the written prompt has reached the field: its end.
  const placeCaret = useRef<number | null>(null);
  // Another conversation's menu says nothing about this one.
  const [stateFor, setStateFor] = useState(draftKey);
  if (stateFor !== draftKey) {
    setStateFor(draftKey);
    setPrompts([]);
    setDismissed(false);
    setChosen(null);
    setCut(false);
  }

  const query = menu === undefined || !focused || chosen !== null ? null : promptQuery(value);
  const typing = query !== null;
  // A menu Escape closed opens again at the next `/`.
  const [wasTyping, setWasTyping] = useState(typing);
  if (wasTyping !== typing) {
    setWasTyping(typing);
    if (!typing) setDismissed(false);
  }
  // Each `/` reads them again, in the conversation it is typed in: a server can
  // change what it offers at any time.
  const loadingFor = typing ? draftKey : null;
  const load = useEffectEvent(() => menu?.load() ?? Promise.resolve(null));
  useEffect(() => {
    if (loadingFor === null) return;
    let current = true;
    void load().then((list) => {
      if (current) setPrompts(list ?? []);
    });
    return () => {
      current = false;
    };
  }, [loadingFor]);

  const options = query === null ? [] : promptOptions(query, prompts);
  const open = query !== null && !dismissed && options.length > 0;
  const [activeFor, setActiveFor] = useState(query);
  if (activeFor !== query) {
    setActiveFor(query);
    setActive(0);
  }
  const current = Math.min(active, Math.max(options.length - 1, 0));
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    const at = placeCaret.current;
    const element = field.current;
    if (at === null || element === null || fieldText(element) !== value) return;
    placeCaret.current = null;
    element.focus();
    selectInField(element, at);
  }, [field, value]);

  const write = (prompt: PromptOption, drafts: Readonly<Record<string, string>>) => {
    const given = promptArguments(prompt, drafts);
    if (given === null) {
      setChosen({ prompt, drafts, writing: false, failed: false, tried: true });
      return;
    }
    setChosen({ prompt, drafts, writing: true, failed: false, tried: true });
    void (menu?.render(prompt, given) ?? Promise.resolve(null)).then((written) => {
      if (written === null) {
        setChosen({ prompt, drafts, writing: false, failed: true, tried: true });
        return;
      }
      setChosen(null);
      setCut(written.cut);
      placeCaret.current = written.text.length;
      onValueChange(written.text);
    });
  };

  const pick = (prompt: PromptOption) => {
    const drafts = Object.fromEntries(prompt.arguments.map((argument) => [argument.name, ""]));
    if (prompt.arguments.length === 0) write(prompt, drafts);
    else setChosen({ prompt, drafts, writing: false, failed: false, tried: false });
  };

  return {
    open,
    options,
    active: current,
    listId,
    optionId,
    pick,
    chosen,
    cut,
    /** The operator typed into the argument `name`. */
    fill: (name: string, text: string) =>
      setChosen((was) =>
        was === null ? null : { ...was, drafts: { ...was.drafts, [name]: text }, failed: false },
      ),
    use: () => {
      if (chosen !== null && !chosen.writing) write(chosen.prompt, chosen.drafts);
    },
    /** Leaves the form; the focus goes back to the field, with the draft as it was. */
    cancel: () => {
      setChosen(null);
      field.current?.focus();
    },
    /** The field has the focus. */
    follow: () => setFocused(true),
    /** The operator edited the draft: a written prompt that was cut is theirs now. */
    edited: () => {
      setFocused(true);
      setCut(false);
    },
    leave: () => setFocused(false),
    /** Handles the key when the menu is open; true when it took it. */
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (!open || event.nativeEvent.isComposing) return false;
      const option = options[current];
      const modified = event.altKey || event.ctrlKey || event.metaKey;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !modified) {
        setActive(movedOption(current, event.key === "ArrowDown" ? 1 : -1, options.length));
      } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && option) {
        pick(option);
      } else if (event.key === "Escape") {
        setDismissed(true);
      } else {
        return false;
      }
      event.preventDefault();
      return true;
    },
    fieldProps:
      menu === undefined
        ? {}
        : ({
            role: "combobox",
            "aria-multiline": true,
            "aria-autocomplete": "list",
            "aria-expanded": open,
            "aria-controls": open ? listId : undefined,
            "aria-activedescendant": open ? optionId(current) : undefined,
          } as const),
  };
}

/** The prompts that match what follows `/`, above the composer. */
export function PromptList({
  id,
  options,
  active,
  optionId,
  onPick,
}: {
  id: string;
  options: ReadonlyArray<PromptOption>;
  active: number;
  optionId: (index: number) => string;
  onPick: (prompt: PromptOption) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const activeId = optionId(active);
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    for (const option of list.children) {
      if (option.id === activeId) option.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);
  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={t("prompt.menu")}
      className="absolute start-0 bottom-0 z-10 flex max-h-72 w-full max-w-96 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-overlay"
    >
      {options.map((prompt, index) => (
        <li
          key={`${prompt.connectorId}:${prompt.name}`}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          // The field keeps the focus, so the keyboard stays up on a touch screen.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onPick(prompt)}
          className="flex min-h-10 cursor-default flex-col justify-center rounded-md px-2 py-1 text-sm aria-selected:bg-muted pointer-coarse:min-h-(--layout-touch-target)"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate">{prompt.title ?? prompt.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{prompt.connector}</span>
          </span>
          {prompt.description !== "" && (
            <span className="truncate text-xs text-muted-foreground">{prompt.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The arguments of the prompt the operator picked, above the composer. Use
 * has its server write it into the draft; Cancel or Escape leaves the draft
 * as it was. A server that did not write it says so, and Use tries again.
 */
export function PromptForm({
  chosen,
  onFill,
  onUse,
  onCancel,
}: {
  chosen: ChosenPrompt;
  onFill: (name: string, text: string) => void;
  onUse: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { prompt } = chosen;
  const firstRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => firstRef.current?.focus(), []);
  return (
    // A group, not a form: it sits in the composer's form, which a submit
    // inside it would send. Enter in a field uses the prompt instead, unless it
    // confirms what an input method is composing.
    <div
      role="group"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-raised"
      aria-label={prompt.title ?? prompt.name}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (
          event.key === "Enter" &&
          !event.nativeEvent.isComposing &&
          event.target instanceof HTMLInputElement
        ) {
          event.preventDefault();
          onUse();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <SquareSlashIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">
            {prompt.title ?? prompt.name}{" "}
            <span className="text-xs font-normal text-muted-foreground">{prompt.connector}</span>
          </span>
          {prompt.description !== "" && (
            <span className="text-xs text-muted-foreground">{prompt.description}</span>
          )}
        </div>
      </div>
      {prompt.arguments.map((argument, index) => {
        const name = argument.title ?? argument.name;
        const text = chosen.drafts[argument.name] ?? "";
        const missing = chosen.tried && argument.required && text.trim() === "";
        return (
          <FieldFrame
            key={argument.name}
            label={argument.required ? name : t("prompt.optional", { label: name })}
            hint={argument.description === "" ? null : argument.description}
            problem={missing ? t("connectorInput.required") : null}
          >
            {(control: FieldControl) => (
              <input
                {...control}
                ref={index === 0 ? firstRef : undefined}
                value={text}
                onChange={(event) => onFill(argument.name, event.currentTarget.value)}
                autoComplete="off"
                className={lineField}
              />
            )}
          </FieldFrame>
        );
      })}
      {chosen.failed && (
        <p role="alert" className="text-xs text-blocked">
          {t("prompt.failed", { connector: prompt.connector })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost-muted" onClick={onCancel}>
          {t("prompt.cancel")}
        </Button>
        <Button size="sm" variant="primary" onClick={onUse} aria-disabled={chosen.writing}>
          {t("prompt.use")}
        </Button>
      </div>
    </div>
  );
}
