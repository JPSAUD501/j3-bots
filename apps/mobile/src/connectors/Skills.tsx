// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type InstallProblem,
  newSkillText,
  sameScope,
  skillDraft,
  skillGroups,
  skillInstall,
} from "@j3-bots/client-runtime/presentation";
import { useAnswer, useConnection, useJ3Client, useSkills } from "@j3-bots/client-runtime/react";
import {
  lastChangeText,
  skillFailureText,
  skillScopeText,
  skillSourceText,
} from "@j3-bots/client-runtime/wording";
import type { Bot, BotId, Skill, SkillScope } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { BookOpen, Plus } from "lucide-react-native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChoiceRow,
  DeleteButton,
  FormScreen,
  Problem,
  Quiet,
  Section,
  Segmented,
  SkeletonRows,
  TextField,
  useDiscardGuard,
} from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useBotList, usePresentation } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { OpenRow, PageSection } from "./parts.tsx";

/** A scope as a key: every bot's, or one bot's. */
const scopeKey = (scope: SkillScope) => (scope._tag === "all-bots" ? "all-bots" : scope.botId);

/**
 * The skills on the connectors screen: every bot's, then each bot's own, each
 * with who changed it last and when; last, adding one. Each opens its page.
 */
export function SkillsSection({
  bots,
  onOpen,
  onAdd,
}: {
  readonly bots: ReadonlyArray<Bot>;
  readonly onOpen: (skill: Skill) => void;
  readonly onAdd: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const state = useSkills();
  return (
    <Section open title={t("skills.title")}>
      <Quiet>{t("skills.hint")}</Quiet>
      {state._tag !== "ready" ? (
        <SkeletonRows count={2} />
      ) : (
        skillGroups(state.value, bots).map((group) => (
          <View key={scopeKey(group.scope)} className="gap-1">
            <Text accessibilityRole="header" className="pt-1 text-xs text-muted-foreground">
              {skillScopeText(group.scope, bots, ctx.i18n)}
            </Text>
            {group.skills.length === 0 ? (
              <Quiet>{t("skills.none")}</Quiet>
            ) : (
              group.skills.map((skill) => (
                <OpenRow key={skill.name} label={skill.name} onPress={() => onOpen(skill)}>
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text numberOfLines={1} className="font-mono text-base text-foreground">
                      {skill.name}
                    </Text>
                    <Text numberOfLines={2} className="text-sm text-muted-foreground">
                      {skill.description}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {skill.shipped
                        ? t("skills.shipped")
                        : lastChangeText(skill.lastChange, bots, ctx)}
                    </Text>
                  </View>
                </OpenRow>
              ))
            )}
          </View>
        ))
      )}
      <OpenRow label={t("skills.add")} hint={t("skills.add.hint")} onPress={onAdd}>
        <View className="size-9 items-center justify-center rounded-md border border-dashed border-border">
          <Icon icon={Plus} color="accent-muted-foreground" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-medium text-foreground">{t("skills.add")}</Text>
          <Text className="text-sm text-muted-foreground">{t("skills.add.hint")}</Text>
        </View>
      </OpenRow>
    </Section>
  );
}

/** Who a skill is for: every bot, or one bot. */
function ScopePicker({
  bots,
  scope,
  onChange,
  readOnly,
}: {
  readonly bots: ReadonlyArray<Bot>;
  readonly scope: SkillScope;
  readonly onChange: (scope: SkillScope) => void;
  readonly readOnly: boolean;
}) {
  const { t } = useI18n();
  return (
    <PageSection title={t("skills.scope")}>
      <ChoiceRow
        kind="one"
        label={t("skills.scope.all")}
        selected={scope._tag === "all-bots"}
        unavailable={readOnly}
        onPress={() => onChange({ _tag: "all-bots" })}
      />
      {bots.map((bot) => (
        <ChoiceRow
          key={bot.id}
          kind="one"
          label={bot.profile.name}
          selected={scope._tag === "bot" && scope.botId === bot.id}
          unavailable={readOnly}
          onPress={() => onChange({ _tag: "bot", botId: bot.id })}
        />
      ))}
    </PageSection>
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
 * the bot whose details opened the connectors. Once saved, its page takes
 * this one's place.
 */
export function NewSkillScreen({ navigation, route }: NativeStackScreenProps<Screens, "newSkill">) {
  const i18n = useI18n();
  const { t } = i18n;
  const intents = useJ3Client().skills;
  const bots = useBotList();
  const connected = useConnection()._tag === "connected";
  const forBot: BotId | null = route.params.forBot;
  const title = t("skills.new.title");
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

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

  const typedSomething =
    way === "write" ? name !== "" || text !== newSkillText(name) : repository !== "" || path !== "";
  const leave = useDiscardGuard(typedSomething && !submitting);

  // The frontmatter's name follows the name typed, until the text is changed by hand.
  const typedName = (next: string) => {
    if (text === newSkillText(name)) setText(newSkillText(next));
    setName(next);
  };

  const finish = (result: Awaited<ReturnType<typeof intents.save>>) => {
    setSubmitting(false);
    if (result._tag === "done") {
      const saved = result.value;
      leave(() => navigation.replace("skill", { scope: saved.scope, name: saved.name }));
    } else {
      setFailure(skillFailureText(result.failure, i18n));
    }
  };

  const submit = () => {
    if (submitting || !connected) return;
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
  const label =
    way === "write"
      ? submitting
        ? t("skills.saving")
        : t("skills.save")
      : submitting
        ? t("skills.installing")
        : t("skills.install");

  return (
    <FormScreen
      problem={failure}
      offline={!connected}
      actions={
        <Button
          variant="primary"
          label={label}
          onPress={submit}
          held={submitting}
          disabled={!connected}
        />
      }
    >
      <Segmented
        label={t("skills.way")}
        value={way}
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
      {way === "write" ? (
        <>
          <TextField
            label={t("skills.name")}
            hint={t("skills.name.hint")}
            error={problem("name")}
            value={name}
            onChange={typedName}
            readOnly={submitting}
            autoCapitalize="none"
          />
          <TextField
            label={t("skills.text")}
            hint={t("skills.text.hint")}
            error={problems.includes("text") ? t("skills.text.invalid") : null}
            value={text}
            onChange={setText}
            readOnly={submitting}
            multiline
            autoCapitalize="none"
          />
        </>
      ) : (
        <>
          <TextField
            label={t("skills.repository")}
            hint={t("skills.repository.hint")}
            error={problem("repository")}
            placeholder="https://"
            value={repository}
            onChange={setRepository}
            readOnly={submitting}
            autoCapitalize="none"
          />
          <TextField
            label={t("skills.path")}
            hint={t("skills.path.hint")}
            error={problem("path")}
            value={path}
            onChange={setPath}
            readOnly={submitting}
            autoCapitalize="none"
          />
          <TextField
            label={t("skills.ref")}
            hint={t("skills.ref.hint")}
            error={problem("ref")}
            value={ref}
            onChange={setRef}
            readOnly={submitting}
            autoCapitalize="none"
          />
          <TextField
            label={`${t("skills.name")} (${t("connect.optional")})`}
            hint={t("skills.name.hint")}
            error={problem("name")}
            value={name}
            onChange={setName}
            readOnly={submitting}
            autoCapitalize="none"
          />
        </>
      )}
      <ScopePicker bots={bots} scope={scope} onChange={setScope} readOnly={submitting} />
    </FormScreen>
  );
}

/**
 * One skill: what it is for, whose it is, where it came from and who changed
 * it last; its `SKILL.md` to edit, and removing it. J3 Bots' own are shown,
 * and not changed.
 */
export function SkillScreen({ navigation, route }: NativeStackScreenProps<Screens, "skill">) {
  const ctx = usePresentation();
  const { i18n } = ctx;
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const intents = useJ3Client().skills;
  const bots = useBotList();
  const connected = useConnection()._tag === "connected";
  const state = useSkills();
  const { scope, name } = route.params;
  const skill =
    state._tag === "ready"
      ? (state.value.find((held) => held.name === name && sameScope(held.scope, scope)) ?? null)
      : null;
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [navigation, name]);

  const [typed, setTyped] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | null>(
    null,
  );
  const read = useAnswer(`${scopeKey(scope)}/${name}`, () => intents.read(scope, name));
  const stored = saved ?? (read.answer._tag === "ready" ? read.answer.value : "");
  const shown = typed ?? stored;
  const leave = useDiscardGuard(typed !== null && typed !== stored && !submitting);

  if (skill === null) {
    return (
      <View className="flex-1 bg-background px-4 pt-4">
        {state._tag === "ready" ? <Quiet>{t("skills.loadFailed")}</Quiet> : <SkeletonRows />}
      </View>
    );
  }

  const source = skillSourceText(skill.source, i18n);
  const changed = lastChangeText(skill.lastChange, bots, ctx);
  const save = () => {
    if (submitting || !connected || skill.shipped) return;
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
    <ScrollView
      className="flex-1 bg-background"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: 20, padding: 16, paddingBottom: insets.bottom + 24 }}
    >
      <View className="flex-row items-start gap-3">
        <View className="size-9 items-center justify-center rounded-md bg-muted">
          <Icon icon={BookOpen} color="accent-muted-foreground" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-mono text-base text-foreground">{skill.name}</Text>
          <Text className="text-sm text-muted-foreground">{skill.description}</Text>
        </View>
      </View>
      <View className="gap-1">
        <Text className="text-sm text-foreground">
          {t("skills.scope")}: {skillScopeText(skill.scope, bots, i18n)}
        </Text>
        {changed !== null && (
          <Text className="text-sm text-foreground">
            {t("skills.lastChange")}: {changed}
          </Text>
        )}
        {source !== null && (
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {source}
          </Text>
        )}
        {skill.files > 0 && (
          <Text className="text-xs text-muted-foreground">
            {i18n.plural("skills.files", skill.files)}
          </Text>
        )}
      </View>
      {skill.shipped && <Quiet>{t("skills.shippedNote")}</Quiet>}
      <PageSection title={t("skills.text")}>
        {saved === null && read.answer._tag === "loading" ? (
          <SkeletonRows count={3} />
        ) : saved === null && read.answer._tag === "failed" ? (
          <View className="items-start gap-2">
            <Quiet>{t("skills.loadFailed")}</Quiet>
            <Button variant="secondary" label={t("connectors.retry")} onPress={read.retry} />
          </View>
        ) : (
          <View className="gap-3">
            <TextField
              label={t("skills.text")}
              value={shown}
              onChange={setTyped}
              readOnly={skill.shipped || submitting}
              multiline
              autoCapitalize="none"
            />
            {outcome !== null &&
              (outcome.ok ? (
                <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
                  {outcome.text}
                </Text>
              ) : (
                <Problem>{outcome.text}</Problem>
              ))}
            {!skill.shipped && (
              <View className="flex-row justify-end">
                <Button
                  variant="primary"
                  label={submitting ? t("skills.saving") : t("skills.save")}
                  onPress={save}
                  held={submitting}
                  disabled={!connected || shown === stored}
                />
              </View>
            )}
          </View>
        )}
      </PageSection>
      {!skill.shipped && (
        <RemoveSkill
          skill={skill}
          connected={connected}
          onRemoved={() => leave(() => navigation.goBack())}
        />
      )}
    </ScrollView>
  );
}

/** Removes the skill and its folder once the operator confirms. */
function RemoveSkill({
  skill,
  connected,
  onRemoved,
}: {
  readonly skill: Skill;
  readonly connected: boolean;
  readonly onRemoved: () => void;
}) {
  const { t } = useI18n();
  const intents = useJ3Client().skills;
  const [failed, setFailed] = useState(false);
  return (
    <View className="items-start gap-2 border-t border-border pt-5">
      {connected && (
        <DeleteButton
          label={t("skills.remove")}
          title={t("skills.remove.title", { name: skill.name })}
          body={t("skills.remove.body")}
          cancel={t("skills.remove.cancel")}
          onDelete={async () => {
            setFailed(false);
            const result = await intents.remove(skill.scope, skill.name);
            if (result._tag === "done") onRemoved();
            else setFailed(true);
          }}
        />
      )}
      <Problem>{failed ? t("skills.remove.failed") : null}</Problem>
    </View>
  );
}
