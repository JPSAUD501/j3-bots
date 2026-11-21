// SPDX-License-Identifier: AGPL-3.0-or-later
import { type MemoryEdit, memorySaveKey, type Save } from "@j3-bots/client-runtime";
import { shownSaveProblem } from "@j3-bots/client-runtime/presentation";
import { useConnection, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { memoryFileName } from "@j3-bots/client-runtime/wording";
import {
  MEMORY_TEXT_LIMIT,
  type MemoryDocument,
  type MemoryScope,
  MemoryText,
} from "@j3-bots/contracts";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FormScreen, Problem, useDiscardGuard } from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import type { Screens } from "../navigation.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

type Props = NativeStackScreenProps<Screens, "memoryFile">;

/** A memory file as the screen has it: still reading, read, or not readable. */
type MemoryReading =
  | { readonly _tag: "reading" }
  | { readonly _tag: "read"; readonly document: MemoryDocument }
  | { readonly _tag: "failed" };

const fits = Schema.is(MemoryText);

const problemText = {
  stale: "memory.stale",
  "private-location": "memory.privateLocation",
  gone: "memory.gone",
  model: "memory.saveFailed",
  failed: "memory.saveFailed",
} as const;

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
      // Leaving gives up on a failed write; one under way stays, and says if it fails.
      client.dismissMemorySave(scope, path);
    };
  }, [client, readFile, scope, path]);

  const document = reading._tag === "read" ? reading.document : null;
  const [editing, setEditing] = useState<MemoryEdit | null>(() =>
    save?._tag === "failed" ? save.changes : null,
  );
  // A failure shows until the operator edits again.
  const [failureShown, setFailureShown] = useState(save?._tag === "failed");
  const [lastSave, setLastSave] = useState(save);
  if (lastSave !== save) {
    setLastSave(save);
    if (save?._tag === "failed") {
      setEditing((current) => current ?? save.changes);
      setFailureShown(true);
    }
  }
  // Loading the newer version takes one read at a time, and no edit meanwhile.
  // A read that fails keeps the edit and offers to try again.
  const [reloading, setReloading] = useState(false);
  const [reloadFailed, setReloadFailed] = useState(false);
  const endEdit = () => {
    setEditing(null);
    setFailureShown(false);
    setReloadFailed(false);
  };
  // A new version of the file, saved or read again, ends the edit. The first
  // read does not: an edit kept from a failed save waits for it. A read that
  // fails in between keeps the edit.
  const [lastRead, setLastRead] = useState(document);
  if (document !== null && lastRead !== document) {
    setLastRead(document);
    if (lastRead !== null) endEdit();
  }

  const saving = save?._tag === "saving";
  const text = saving ? save.changes.text : editing?.text;
  const isEditing = text !== undefined;
  const problem = shownSaveProblem(save, !failureShown);
  const tooLong = editing !== null && !fits(editing.text);
  const canSave =
    editing !== null &&
    problem !== "stale" &&
    !tooLong &&
    !saving &&
    connected &&
    (document === null || editing.text !== document.text);
  // An edit is the operator's until they save it or let it go.
  useDiscardGuard(isEditing);

  const loadNewer = () => {
    if (reloading || !connected) return;
    setReloading(true);
    void readFile().then((done) => {
      if (!open.current) return;
      setReloading(false);
      // The operator asked for the newer version: it replaces the edit, even
      // when it is the first version this screen could read.
      if (done) {
        client.dismissMemorySave(scope, path);
        endEdit();
      } else {
        setReloadFailed(true);
      }
    });
  };

  const writeFile = (edit: MemoryEdit) =>
    void client.writeMemory(scope, path, edit).then((result) => {
      if (result._tag === "done") {
        if (open.current) setReading({ _tag: "read", document: result.value });
      } else if (result._tag === "failed" && !open.current) {
        say(t("memory.failedClosed", { file: title }));
      }
    });

  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  if (!isEditing) {
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
            <Button
              label={t("memory.edit")}
              onPress={() =>
                setEditing({ text: reading.document.text, revision: reading.document.revision })
              }
            />
            <Text selectable className="font-mono text-sm text-foreground">
              {reading.document.text}
            </Text>
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <FormScreen
      problem={
        tooLong
          ? t("memory.tooLong", { max: MEMORY_TEXT_LIMIT })
          : reloadFailed
            ? t("memory.reloadFailed")
            : problem === null
              ? null
              : t(problemText[problem])
      }
      offline={!connected}
      actions={
        <>
          {problem === "stale" && (
            <Button
              label={
                reloading
                  ? t("memory.loadNewer.loading")
                  : reloadFailed
                    ? t("memory.loadNewer.retry")
                    : t("memory.loadNewer")
              }
              disabled={reloading || !connected}
              onPress={loadNewer}
            />
          )}
          <Button
            label={t("memory.cancel")}
            disabled={saving}
            onPress={() => {
              endEdit();
              client.dismissMemorySave(scope, path);
            }}
          />
          <Button
            variant="primary"
            label={saving ? t("memory.saving") : t("memory.save")}
            disabled={!canSave}
            onPress={() => {
              if (editing !== null && canSave) writeFile(editing);
            }}
          />
        </>
      }
    >
      <TextInput
        accessibilityLabel={t("memory.text", { file: title })}
        aria-invalid={tooLong}
        value={text}
        autoFocus
        multiline
        editable={!saving && !reloading}
        autoCorrect={false}
        autoCapitalize="none"
        textAlignVertical="top"
        onChangeText={(value) => {
          setEditing((current) => current && { ...current, text: value });
          setFailureShown(false);
        }}
        className={`min-h-64 rounded-md border bg-surface p-3 font-mono text-sm ${tooLong ? "border-blocked" : "border-input"} ${saving || reloading ? "text-muted-foreground" : "text-foreground"}`}
      />
    </FormScreen>
  );
}
