// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotTemplate,
  type EngineStatus,
  MAX_TEMPLATE_FILE_SIZE,
  ModelId,
  ProviderId,
  type ProviderStatus,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { readTemplateFile, templateFileName, templateFileText, templateStart } from "./template.ts";

const template: BotTemplate = {
  format: "j3-bots/bot-template",
  version: 1,
  profile: {
    name: "Scout",
    title: "Research",
    avatar: { shape: "bean", color: "honey" },
    job: "Finds sources.",
  },
  model: { providerId: ProviderId.make("claude"), modelId: ModelId.make("opus") },
  permissionMode: "full-access",
  skills: [{ name: "triage", text: "Read each message." }],
  routines: [
    {
      name: "Digest",
      instruction: "Summarize the inbox.",
      trigger: { _tag: "schedule", cron: "0 9 * * *" },
    },
  ],
};

const provider = (
  id: string,
  harness: ProviderStatus["harness"],
  status: ProviderStatus["status"],
  model: string,
): ProviderStatus => ({
  id: ProviderId.make(id),
  name: id,
  harness,
  status,
  models: [{ id: ModelId.make(model), name: model }],
  usage: [],
});

const engine = (...providers: ReadonlyArray<ProviderStatus>): EngineStatus => ({
  state: { _tag: "ready" },
  pinnedVersion: "0.1.11",
  providers,
});

const ready = { _tag: "ready" } as const;

describe("readTemplateFile", () => {
  it("reads back what a template file holds", () => {
    expect(readTemplateFile(templateFileText(template))).toEqual({ _tag: "template", template });
  });

  it("tells a later template from a file that is not one", () => {
    const later = JSON.stringify({ ...JSON.parse(templateFileText(template)), version: 2 });
    expect(readTemplateFile(later)).toEqual({ _tag: "newer" });
    expect(readTemplateFile("{ not json")).toEqual({ _tag: "invalid" });
    expect(
      readTemplateFile(JSON.stringify({ ...template, skills: [{ name: "../x", text: "x" }] })),
    ).toEqual({ _tag: "invalid" });
  });

  it("refuses a file over the limit before decoding it", () => {
    const padded = templateFileText({
      ...template,
      profile: { ...template.profile, job: "" },
    }).replace('"job": ""', `"job": "", "padding": "${"x".repeat(MAX_TEMPLATE_FILE_SIZE)}"`);
    expect(readTemplateFile(padded)).toEqual({ _tag: "too-large" });
  });
});

describe("templateFileName", () => {
  it("names the file after the bot in plain letters", () => {
    expect(templateFileName("João's Inbox")).toBe("joao-s-inbox.j3bot");
    expect(templateFileName("🤖")).toBe("bot.j3bot");
  });
});

describe("templateStart", () => {
  it("keeps the template's model where the engine offers it, its mode capped by the default", () => {
    expect(
      templateStart(template, engine(provider("claude", "claude-code", ready, "opus"))),
    ).toEqual({
      model: {
        _tag: "template",
        choice: template.model,
        name: "claude · opus",
      },
      permissionMode: "auto",
    });
  });

  it("puts the first ready model in place of one the engine does not offer", () => {
    const start = templateStart(
      { ...template, permissionMode: "auto" },
      engine(
        provider("codex", "codex", { _tag: "unavailable", checking: false }, "gpt"),
        provider("local", "other", ready, "llama"),
      ),
    );
    expect(start).toEqual({
      model: {
        _tag: "replaced",
        choice: { providerId: "local", modelId: "llama" },
        name: "local · llama",
        asked: "opus",
      },
      permissionMode: "supervised",
    });
  });

  it("offers no model, and supervised, before the engine lists one", () => {
    expect(templateStart(template, null)).toEqual({
      model: { _tag: "none" },
      permissionMode: "supervised",
    });
  });
});
