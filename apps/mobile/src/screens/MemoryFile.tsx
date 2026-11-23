// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MemoryEdit, memorySaveKey, type Save } from "@j3-bots/client-runtime";
import {
  type MemoryReading,
  useConnection,
  useJ3Client,
  useMemoryEdit,
  useReadable,
} from "@j3-bots/client-runtime/react";
import { memoryEditProblemText, memoryFileName } from "@j3-bots/client-runtime/wording";
import type { MemoryScope } from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FormScreen, Problem, useDiscardGuard } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

type Props = NativeStackScreenProps<Screens, "memoryFile">;

/**
 * One memory file as the bot wrote it, which the operator can correct. Save
 * writes over the revision the edit started from, so a file that changed on
 * the server meanwhile is never overwritten: the screen says so, keeps the
 * edit and offers the newer version. While a save is under way the text takes
 * no edit; a save that fails leaves it in place and says why, or, once the
 * screen has closed, a toast does.
 */
export function MemoryFileScreen({ navigation, route }: Props) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const say = useSay();
  const insets = useSafeAreaInsets();
  const { botId, path } = route.params;
  const scope = useMemo((): MemoryScope => ({ _tag: "bot", botId }), [botId]);
  const title = memoryFileName(path, i18n);
  const connected = useConnection()._tag === "connected";
  const save: Save<MemoryEdit> | undefined = useReadable(client.memorySaves).get(
    memorySaveKey(scope, path),
  );

  const [reading, setReading] = useState<MemoryReading>({ _tag: "reading" });
  // Each read moves this on; an answer is applied only while its read still
  // owns the screen, and the screen is still open.
  const read = useRef(0);
  const open = useRef(true);
  /**
   * Reads the file, and resolves with whether this read put it on the screen.
   * A read that fails after one succeeded keeps the version already read.
   */
  const readFile = useMemo(
    () => () => {
      const mine = ++read.current;
      return client.readMemory(scope, path).then((result) => {
        if (read.current !== mine || !open.current) return false;
        setReading((current) =>
          result._tag === "done"
            ? { _tag: "read", document: result.value }
            : current._tag === "read"
              ? current
              : { _tag: "failed" },
        );
        return result._tag === "done";
      });
    },
    [client, scope, path],
  );
  useEffect(() => {
    open.current = true;
    void readFile();
    return () => {
      open.current = false;
    };
  }, [readFile]);

  const edit = useMemoryEdit({
    reading,
    save,
    connected,
    // The operator asked for the newer version: it replaces the failed write too.
    onLoadNewer: () =>
      readFile().then((read) => {
        if (read) client.dismissMemorySave(scope, path);
        return read;
      }),
  });
  const { text, saving, reloading, problem } = edit;
  // An edit is the operator's until they save it or let it go. Leaving gives up
  // on a failed write; one under way goes on, and says if it fails.
  useDiscardGuard(edit.unsaved && !saving, () => client.dismissMemorySave(scope, path));

  const writeFile = (toSave: MemoryEdit) =>
    void client.writeMemory(scope, path, toSave).then((result) => {
      if (result._tag === "done") {
        if (open.current) setReading({ _tag: "read", document: result.value });
      } else if (result._tag === "failed" && !open.current) {
        say(t("memory.failedClosed", { file: title }));
      }
    });

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (text === undefined) {
    return (
      <ScrollView
        className="flex-1 bg-background"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}
      >
        {reading._tag === "reading" ? (
          <Text className="text-sm text-muted-foreground">{t("details.loading")}</Text>
        ) : reading._tag === "failed" ? (
          <Problem>{t("memory.readFailed")}</Problem>
        ) : (
          <View className="items-start gap-3">
            <Button label={t("memory.edit")} onPress={edit.startEdit} />
            <Text selectable face="mono" className="text-sm text-foreground">
              {reading.document.text}
            </Text>
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <FormScreen
      problem={problem === null ? null : memoryEditProblemText(problem, i18n)}
      offline={!connected}
      actions={
        <>
          {edit.stale && (
            <Button
              label={
                reloading
                  ? t("memory.loadNewer.loading")
                  : edit.reloadFailed
                    ? t("memory.loadNewer.retry")
                    : t("memory.loadNewer")
              }
              disabled={reloading || !connected}
              onPress={edit.loadNewer}
            />
          )}
          <Button
            label={t("memory.cancel")}
            disabled={saving}
            onPress={() => {
              edit.endEdit();
              client.dismissMemorySave(scope, path);
            }}
          />
          <Button
            variant="primary"
            label={saving ? t("memory.saving") : t("memory.save")}
            disabled={edit.toSave === null}
            onPress={() => {
              if (edit.toSave !== null) writeFile(edit.toSave);
            }}
          />
        </>
      }
    >
      <TextInput
        accessibilityLabel={t("memory.text", { file: title })}
        aria-invalid={edit.tooLong}
        face="mono"
        value={text}
        autoFocus
        multiline
        editable={!saving && !reloading}
        autoCorrect={false}
        autoCapitalize="none"
        textAlignVertical="top"
        onChangeText={edit.changeText}
        className={`min-h-64 rounded-md border bg-muted p-3 text-sm ${edit.tooLong ? "border-blocked" : "border-transparent"} ${saving || reloading ? "text-muted-foreground" : "text-foreground"}`}
      />
    </FormScreen>
  );
}
