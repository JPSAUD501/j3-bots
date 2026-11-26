// SPDX-License-Identifier: AGPL-3.0-or-later
import { sameScope, skillDraft, skillGroups } from "@j3-bots/client-runtime/presentation";
import { useAnswer, useConnection, useJ3Client, useSkills } from "@j3-bots/client-runtime/react";
import {
  lastChangeText,
  skillFailureText,
  skillScopeText,
  skillSourceText,
} from "@j3-bots/client-runtime/wording";
import type { Bot, Skill, SkillScope } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { BookOpen } from "lucide-react-native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DeleteButton,
  Problem,
  Quiet,
  Section,
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
 * The skills on the connectors screen that the operator or a bot added:
 * every bot's, then each bot's own, each with who changed it last and when.
 * With none, one line says to ask a bot for one. Each opens its page.
 */
export function SkillsSection({
  bots,
  onOpen,
}: {
  readonly bots: ReadonlyArray<Bot>;
  readonly onOpen: (skill: Skill) => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const state = useSkills();
  const groups = state._tag === "ready" ? skillGroups(state.value, bots) : null;
  return (
    <Section open title={t("skills.title")}>
      <Quiet>{t("skills.hint")}</Quiet>
      {groups === null ? (
        <SkeletonRows count={2} />
      ) : groups.length === 0 ? (
        <Quiet>{t("skills.none")}</Quiet>
      ) : (
        groups.map((group) => (
          <View key={scopeKey(group.scope)} className="gap-1">
            <Text accessibilityRole="header" className="pt-1 text-xs text-muted-foreground">
              {skillScopeText(group.scope, bots, ctx.i18n)}
            </Text>
            {group.skills.map((skill) => (
              <OpenRow key={skill.name} label={skill.name} onPress={() => onOpen(skill)}>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text numberOfLines={1} className="font-mono text-base text-foreground">
                    {skill.name}
                  </Text>
                  <Text numberOfLines={2} className="text-sm text-muted-foreground">
                    {skill.description}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {lastChangeText(skill.lastChange, bots, ctx)}
                  </Text>
                </View>
              </OpenRow>
            ))}
          </View>
        ))
      )}
    </Section>
  );
}

/**
 * One skill: what it is for, whose it is, where it came from and who changed
 * it last; its `SKILL.md` to edit, and removing it.
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
    if (submitting || !connected) return;
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
              readOnly={submitting}
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
            <View className="flex-row justify-end">
              <Button
                variant="primary"
                label={submitting ? t("skills.saving") : t("skills.save")}
                onPress={save}
                held={submitting}
                disabled={!connected || shown === stored}
              />
            </View>
          </View>
        )}
      </PageSection>
      <RemoveSkill
        skill={skill}
        connected={connected}
        onRemoved={() => leave(() => navigation.goBack())}
      />
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
