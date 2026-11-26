// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SkillsClient } from "@j3-bots/client-runtime";
import {
  type InstallProblem,
  newSkillText,
  sameScope,
  skillDraft,
  skillGroups,
  skillInstall,
} from "@j3-bots/client-runtime/presentation";
import {
  lastChangeText,
  skillFailureText,
  skillScopeText,
  skillSourceText,
} from "@j3-bots/client-runtime/wording";
import type { Bot, BotId, Skill, SkillScope } from "@j3-bots/contracts";
import { BookOpenIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useAnswer } from "@j3-bots/client-runtime/react";
import { type ReactNode, useId, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Confirm } from "../ui/confirm";
import { lineField, textField } from "../ui/field";
import { Segmented } from "../ui/segmented";
import { SkeletonRows } from "../ui/skeleton";
import { FieldFrame, LineField, PageSection } from "./parts";
import { Failed } from "./screen";

/** What the skills pages ask of the client runtime. */
export type SkillsIntents = Omit<SkillsClient, "state">;

/** A scope as a key: every bot's, or one bot's. */
const scopeKey = (scope: SkillScope) => (scope._tag === "all-bots" ? "all-bots" : scope.botId);

/** A skills page of the connectors screen: one skill, or adding one. */
export type SkillPlace =
  | { readonly _tag: "skill"; readonly scope: SkillScope; readonly name: Skill["name"] }
  | { readonly _tag: "new-skill" };

/**
 * The skills on the screen's first page: every bot's, then each bot's own,
 * each with who changed it last and when; last, adding one.
 */
export function SkillsGroup({
  skills,
  bots,
  onOpen,
  onAdd,
}: {
  skills: ReadonlyArray<Skill> | null;
  bots: ReadonlyArray<Bot>;
  onOpen: (skill: Skill) => void;
  onAdd: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{t("skills.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("skills.hint")}</p>
      {skills === null ? (
        <SkeletonRows count={2} />
      ) : (
        skillGroups(skills, bots).map((group) => (
          <div key={scopeKey(group.scope)}>
            <h4 className="pt-1 text-xs text-muted-foreground">
              {skillScopeText(group.scope, bots, ctx.i18n)}
            </h4>
            {group.skills.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">{t("skills.none")}</p>
            ) : (
              <ul className="-mx-2 flex flex-col">
                {group.skills.map((skill) => (
                  <li key={skill.name}>
                    <Row onClick={() => onOpen(skill)}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-sm">{skill.name}</span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">
                          {skill.description}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {skill.shipped
                          ? t("skills.shipped")
                          : lastChangeText(skill.lastChange, bots, ctx)}
                      </span>
                    </Row>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
      <Row onClick={onAdd}>
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
        >
          <PlusIcon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{t("skills.add")}</span>
          <span className="text-sm text-muted-foreground">{t("skills.add.hint")}</span>
        </span>
      </Row>
    </section>
  );
}

/** A row that opens a page, as the connectors' rows do. */
function Row({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable pressable-row flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-2 text-start hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="mt-1 size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
      />
    </button>
  );
}

/** Who a skill is for: every bot, or one bot. */
function ScopeField({
  bots,
  scope,
  onChange,
  readOnly,
}: {
  bots: ReadonlyArray<Bot>;
  scope: SkillScope;
  onChange: (scope: SkillScope) => void;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  return (
    <FieldFrame label={t("skills.scope")}>
      {(control) => (
        <select
          {...control}
          value={scope._tag === "all-bots" ? "" : scope.botId}
          aria-readonly={readOnly}
          onChange={(event) => {
            if (readOnly) return;
            const picked = bots.find((bot) => bot.id === event.currentTarget.value);
            onChange(
              picked === undefined ? { _tag: "all-bots" } : { _tag: "bot", botId: picked.id },
            );
          }}
          className={lineField}
        >
          <option value="">{t("skills.scope.all")}</option>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.profile.name}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

/** A skill's `SKILL.md`, as a text area. */
function SkillTextField({
  value,
  onChange,
  problem,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  return (
    <FieldFrame label={t("skills.text")} hint={t("skills.text.hint")} problem={problem}>
      {(control) => (
        <textarea
          {...control}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          readOnly={readOnly}
          rows={14}
          spellCheck={false}
          className={cn(textField, "min-h-48 py-2 font-mono text-xs leading-relaxed")}
        />
      )}
    </FieldFrame>
  );
}

type Way = "write" | "install";

const installProblemKey = {
  repository: "skills.repository.invalid",
  path: "skills.path.invalid",
  ref: "skills.ref.invalid",
  name: "skills.name.invalid",
} as const satisfies Record<InstallProblem, string>;

/**
 * Adding a skill: written here, or installed from the folder of a public git
 * repository, at a commit the server records. For every bot at first, or for
 * the bot whose details opened the screen.
 */
export function NewSkill({
  bots,
  forBot,
  connected,
  intents,
  onSaved,
}: {
  bots: ReadonlyArray<Bot>;
  forBot: BotId | null;
  connected: boolean;
  intents: SkillsIntents;
  onSaved: (skill: Skill) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const wayId = useId();
  const [way, setWay] = useState<Way>("write");
  const [scope, setScope] = useState<SkillScope>(() =>
    forBot !== null && bots.some((bot) => bot.id === forBot)
      ? { _tag: "bot", botId: forBot }
      : { _tag: "all-bots" },
  );
  const [name, setName] = useState("");
  const [text, setText] = useState(() => newSkillText(""));
  const [repository, setRepository] = useState("");
  const [path, setPath] = useState("");
  const [ref, setRef] = useState("main");
  const [problems, setProblems] = useState<ReadonlyArray<InstallProblem | "text">>([]);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The frontmatter's name follows the name typed, until the text is changed by hand.
  const typedName = (next: string) => {
    if (text === newSkillText(name)) setText(newSkillText(next));
    setName(next);
  };

  const finish = (result: Awaited<ReturnType<SkillsIntents["save"]>>) => {
    setSubmitting(false);
    if (result._tag === "done") onSaved(result.value);
    else setFailure(skillFailureText(result.failure, i18n));
  };

  const submit = () => {
    setFailure(null);
    if (way === "write") {
      const draft = skillDraft(name, text);
      if (draft === null) {
        setProblems([
          ...(skillDraft(name, "x") === null ? (["name"] as const) : []),
          ...(text.trim() === "" ? (["text"] as const) : []),
        ]);
        return;
      }
      setProblems([]);
      setSubmitting(true);
      void intents.save(scope, draft.name, draft.text).then(finish);
      return;
    }
    const checked = skillInstall({ scope, repository, path, ref, name });
    if (checked._tag === "invalid") {
      setProblems(checked.problems);
      return;
    }
    setProblems([]);
    setSubmitting(true);
    void intents.install(checked.install).then(finish);
  };

  const problem = (field: InstallProblem) =>
    problems.includes(field) ? t(installProblemKey[field]) : null;

  return (
    <form
      className="flex flex-col gap-5 px-4 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting && connected) submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span id={wayId} className="sr-only">
          {t("skills.way")}
        </span>
        <Segmented
          value={way}
          labelledBy={wayId}
          onChange={(next) => {
            setWay(next);
            setProblems([]);
            setFailure(null);
          }}
          options={[
            { value: "write", label: t("skills.way.write") },
            { value: "install", label: t("skills.way.install") },
          ]}
        />
      </div>
      <ScopeField bots={bots} scope={scope} onChange={setScope} readOnly={submitting} />
      {way === "write" ? (
        <>
          <LineField
            label={t("skills.name")}
            hint={t("skills.name.hint")}
            problem={problem("name")}
            value={name}
            onChange={typedName}
            readOnly={submitting}
            autoFocus
            mono
          />
          <SkillTextField
            value={text}
            onChange={setText}
            problem={problems.includes("text") ? t("skills.text.invalid") : null}
            readOnly={submitting}
          />
        </>
      ) : (
        <>
          <LineField
            label={t("skills.repository")}
            hint={t("skills.repository.hint")}
            problem={problem("repository")}
            type="url"
            placeholder="https://"
            value={repository}
            onChange={setRepository}
            readOnly={submitting}
            autoFocus
            mono
          />
          <LineField
            label={t("skills.path")}
            hint={t("skills.path.hint")}
            problem={problem("path")}
            value={path}
            onChange={setPath}
            readOnly={submitting}
            mono
          />
          <LineField
            label={t("skills.ref")}
            hint={t("skills.ref.hint")}
            problem={problem("ref")}
            value={ref}
            onChange={setRef}
            readOnly={submitting}
            mono
          />
          <LineField
            label={`${t("skills.name")} (${t("connect.optional")})`}
            hint={t("skills.name.hint")}
            problem={problem("name")}
            value={name}
            onChange={setName}
            readOnly={submitting}
            mono
          />
        </>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-blocked">
          {failure}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="self-end"
        aria-disabled={submitting || !connected}
      >
        {way === "write"
          ? submitting
            ? t("skills.saving")
            : t("skills.save")
          : submitting
            ? t("skills.installing")
            : t("skills.install")}
      </Button>
    </form>
  );
}

/**
 * One skill: what it is for, whose it is, where it came from and who changed
 * it last; its `SKILL.md` to edit, and removing it. J3 Bots' own are shown,
 * and not changed.
 */
export function SkillPage({
  skill,
  loading,
  bots,
  connected,
  intents,
  onRemoved,
}: {
  /** Null once it is gone, or while the skills load. */
  skill: Skill | null;
  loading: boolean;
  bots: ReadonlyArray<Bot>;
  connected: boolean;
  intents: SkillsIntents;
  onRemoved: () => void;
}) {
  const ctx = usePresentation();
  const { i18n } = ctx;
  const { t } = i18n;
  const [typed, setTyped] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | null>(
    null,
  );
  const read = useAnswer(skill === null ? null : `${scopeKey(skill.scope)}/${skill.name}`, () =>
    skill === null
      ? Promise.resolve({ _tag: "failed", failure: { _tag: "unexpected" } })
      : intents.read(skill.scope, skill.name),
  );

  if (skill === null) {
    return loading ? (
      <div className="px-4 py-5">
        <SkeletonRows />
      </div>
    ) : (
      <p className="px-4 py-5 text-sm text-muted-foreground">{t("skills.loadFailed")}</p>
    );
  }

  const source = skillSourceText(skill.source, i18n);
  const changed = lastChangeText(skill.lastChange, bots, ctx);
  const stored = saved ?? (read.answer._tag === "ready" ? read.answer.value : "");
  const shown = typed ?? stored;
  const save = () => {
    const draft = skillDraft(skill.name, shown);
    if (draft === null) {
      setOutcome({ ok: false, text: t("skills.text.invalid") });
      return;
    }
    setSubmitting(true);
    setOutcome(null);
    void intents.save(skill.scope, draft.name, draft.text).then((result) => {
      setSubmitting(false);
      if (result._tag === "done") {
        setSaved(draft.text);
        setTyped(null);
        setOutcome({ ok: true, text: t("skills.saved") });
      } else {
        setOutcome({ ok: false, text: skillFailureText(result.failure, i18n) });
      }
    });
  };

  return (
    <div className="flex flex-col gap-5 px-4 py-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <BookOpenIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-base">{skill.name}</span>
          <span className="text-sm text-muted-foreground">{skill.description}</span>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("skills.scope")}</dt>
        <dd>{skillScopeText(skill.scope, bots, i18n)}</dd>
        {changed !== null && (
          <>
            <dt className="text-muted-foreground">{t("skills.lastChange")}</dt>
            <dd>{changed}</dd>
          </>
        )}
        {source !== null && (
          <>
            <dt className="sr-only">{t("skills.repository")}</dt>
            <dd className="col-span-2 font-mono text-xs break-all text-muted-foreground">
              {source}
            </dd>
          </>
        )}
        {skill.files > 0 && (
          <dd className="col-span-2 text-xs text-muted-foreground">
            {i18n.plural("skills.files", skill.files)}
          </dd>
        )}
      </dl>
      {skill.shipped && <p className="text-sm text-muted-foreground">{t("skills.shippedNote")}</p>}
      <PageSection title={t("skills.text")}>
        {read.answer._tag === "loading" && saved === null ? (
          <SkeletonRows count={3} />
        ) : read.answer._tag === "failed" && saved === null ? (
          <Failed text={t("skills.loadFailed")} onRetry={read.retry} />
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!submitting && connected && !skill.shipped) save();
            }}
          >
            <SkillTextField
              value={shown}
              onChange={setTyped}
              problem={null}
              readOnly={skill.shipped || submitting}
            />
            {outcome !== null && (
              <p
                role={outcome.ok ? "status" : "alert"}
                className={cn("text-sm", outcome.ok ? "text-muted-foreground" : "text-blocked")}
              >
                {outcome.text}
              </p>
            )}
            {!skill.shipped && (
              <Button
                type="submit"
                variant="primary"
                className="self-end"
                aria-disabled={submitting || !connected || shown === stored}
              >
                {submitting ? t("skills.saving") : t("skills.save")}
              </Button>
            )}
          </form>
        )}
      </PageSection>
      {!skill.shipped && (
        <RemoveSkill skill={skill} connected={connected} intents={intents} onRemoved={onRemoved} />
      )}
    </div>
  );
}

/** Removes the skill and its folder once the operator confirms. */
function RemoveSkill({
  skill,
  connected,
  intents,
  onRemoved,
}: {
  skill: Skill;
  connected: boolean;
  intents: SkillsIntents;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section className="flex flex-col items-start gap-2 border-t border-border pt-5">
      <Confirm
        trigger={<Button variant="destructive-outline" aria-disabled={pending || !connected} />}
        title={t("skills.remove.title", { name: skill.name })}
        body={t("skills.remove.body")}
        cancel={t("skills.remove.cancel")}
        confirm={t("skills.remove")}
        busy={pending || !connected}
        onConfirm={() => {
          setPending(true);
          setFailed(false);
          void intents.remove(skill.scope, skill.name).then((result) => {
            setPending(false);
            if (result._tag === "done") onRemoved();
            else setFailed(true);
          });
        }}
      >
        {pending ? t("skills.remove.pending") : t("skills.remove")}
      </Confirm>
      {failed && (
        <p role="alert" className="text-sm text-blocked">
          {t("skills.remove.failed")}
        </p>
      )}
    </section>
  );
}

/** The skill `place` names among `skills`, if it is there. */
export const skillAt = (
  skills: ReadonlyArray<Skill> | null,
  place: Extract<SkillPlace, { readonly _tag: "skill" }>,
): Skill | null =>
  skills?.find((skill) => skill.name === place.name && sameScope(skill.scope, place.scope)) ?? null;
