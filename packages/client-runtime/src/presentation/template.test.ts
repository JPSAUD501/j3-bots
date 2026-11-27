// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotTemplate,
  type EngineStatus,
  fileBytes,
  MAX_TEMPLATE_FILE_SIZE,
  ModelId,
  ProviderId,
  type ProviderStatus,
  TEMPLATE_LIMITS,
  templateFileText,
  templateTooLarge,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  openTemplateChunks,
  openTemplateFile,
  readTemplateFile,
  sharedTemplate,
  templateFileName,
  templateStart,
  templateSubmission,
} from "./template.ts";

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
  models: [{ id: ModelId.make(model), name: model, efforts: [] }],
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

  it("refuses a version 1 file with a field this build does not know, and still tells a newer one", () => {
    const file = JSON.parse(templateFileText(template));
    expect(readTemplateFile(JSON.stringify({ ...file, notes: "Not shown" }))).toEqual({
      _tag: "invalid",
    });
    expect(
      readTemplateFile(
        JSON.stringify({ ...file, profile: { ...file.profile, email: "ana@example.com" } }),
      ),
    ).toEqual({ _tag: "invalid" });
    expect(readTemplateFile(JSON.stringify({ ...file, version: 2, notes: "New" }))).toEqual({
      _tag: "newer",
    });
  });

  it("refuses a file over the limit before decoding it", () => {
    const padded = templateFileText({
      ...template,
      profile: { ...template.profile, job: "" },
    }).replace('"job": ""', `"job": "", "padding": "${"x".repeat(MAX_TEMPLATE_FILE_SIZE)}"`);
    expect(readTemplateFile(padded)).toEqual({ _tag: "too-large" });
  });
});

describe("the size a template file can be", () => {
  // Text that fits the limits, which count characters, can take three bytes a
  // character: sixteen full skills and two full routines in "€", then a third
  // routine and the job to reach the limit to the byte.
  const heavy = (euros: number, padding: number): BotTemplate => ({
    ...template,
    profile: { ...template.profile, job: "a".repeat(padding) },
    skills: Array.from({ length: TEMPLATE_LIMITS.skills }, (_, index) => ({
      name: `skill-${index}`,
      text: "€".repeat(TEMPLATE_LIMITS.skillText),
    })),
    routines: [
      ...["First", "Second"].map((name) => ({
        name,
        instruction: "€".repeat(10_000),
        trigger: { _tag: "webhook" } as const,
      })),
      { name: "Third", instruction: `x${"€".repeat(euros)}`, trigger: { _tag: "webhook" } },
    ],
  });
  const gap = MAX_TEMPLATE_FILE_SIZE - fileBytes(templateFileText(heavy(0, 0)));
  const euros = Math.floor(gap / 3);
  const padding = gap - euros * 3;

  it("is the same when it is shared and when it is read, to the byte", () => {
    const fits = heavy(euros, padding);
    const text = templateFileText(fits);
    expect(fileBytes(text)).toBe(MAX_TEMPLATE_FILE_SIZE);
    expect(templateTooLarge(fits)).toBeNull();
    expect(readTemplateFile(text)).toEqual({ _tag: "template", template: fits });

    const over = heavy(euros, padding + 1);
    expect(templateTooLarge(over)?.largest).toEqual({ _tag: "skill", name: "skill-0" });
    expect(readTemplateFile(templateFileText(over))).toEqual({ _tag: "too-large" });
  });
});

describe("openTemplateChunks", () => {
  /** A file's bytes, read as a file handle reads them: up to the bytes asked for. */
  const handle = (bytes: Uint8Array) => {
    let at = 0;
    return (length: number) => {
      const chunk = bytes.subarray(at, at + length);
      at += chunk.length;
      return Promise.resolve(chunk);
    };
  };

  it("reads a template in chunks", async () => {
    const bytes = new TextEncoder().encode(templateFileText(template));
    expect(await openTemplateChunks(null, handle(bytes))).toEqual({ _tag: "template", template });
  });

  it("stops past the limit when a file holds more than its size said", async () => {
    let asked = 0;
    const endless = (length: number) => {
      asked += length;
      return Promise.resolve(new Uint8Array(length).fill(0x20));
    };
    expect(await openTemplateChunks(10, endless)).toEqual({ _tag: "too-large" });
    expect(asked).toBe(MAX_TEMPLATE_FILE_SIZE + 1);
  });

  it("never reads a file whose size is over the limit, and says a failed read is unreadable", async () => {
    let read = false;
    const reading = () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    };
    expect(await openTemplateChunks(MAX_TEMPLATE_FILE_SIZE + 1, reading)).toEqual({
      _tag: "too-large",
    });
    expect(read).toBe(false);
    expect(await openTemplateChunks(null, () => Promise.reject(new Error("gone")))).toEqual({
      _tag: "unreadable",
    });
  });
});

describe("openTemplateFile", () => {
  it("never reads a file whose size is over the limit", async () => {
    let read = false;
    const text = () => {
      read = true;
      return Promise.resolve(templateFileText(template));
    };
    expect(await openTemplateFile(MAX_TEMPLATE_FILE_SIZE + 1, text)).toEqual({ _tag: "too-large" });
    expect(read).toBe(false);
  });

  it("says a file that could not be read is unreadable", async () => {
    expect(await openTemplateFile(10, () => Promise.reject(new Error("gone")))).toEqual({
      _tag: "unreadable",
    });
  });
});

describe("sharedTemplate", () => {
  const file = (name: string, mediaType = "application/octet-stream") => ({
    name,
    mediaType,
    size: 10,
    uri: `content://files/${name}`,
  });

  it("takes a share of one template file, by its name or its media type", () => {
    const named = file("Scout.J3BOT");
    expect(sharedTemplate({ text: null, url: null, files: [named] })).toBe(named);
    const typed = file("download", "application/vnd.j3bots.bot+json");
    expect(sharedTemplate({ text: null, url: null, files: [typed] })).toBe(typed);
  });

  it("leaves a share that holds anything more for a conversation", () => {
    const template = file("scout.j3bot");
    expect(sharedTemplate({ text: "look", url: null, files: [template] })).toBeNull();
    expect(sharedTemplate({ text: null, url: null, files: [template, template] })).toBeNull();
    expect(sharedTemplate({ text: null, url: null, files: [file("notes.json")] })).toBeNull();
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
      asked: "full-access",
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
      asked: "auto",
    });
  });

  it("asks for nothing more when the template's mode is the one the bot starts with", () => {
    expect(
      templateStart(
        { ...template, permissionMode: "auto" },
        engine(provider("claude", "claude-code", ready, "opus")),
      ).asked,
    ).toBeNull();
  });

  it("leaves the permission mode to the server until the operator picks one", () => {
    const start = templateStart(template, engine(provider("claude", "claude-code", ready, "opus")));
    expect(templateSubmission(template, start, null)).toEqual({ template, model: template.model });
    expect(templateSubmission(template, start, "full-access")).toEqual({
      template,
      model: template.model,
      permissionMode: "full-access",
    });
  });

  it("offers no model, and supervised, before the engine lists one", () => {
    expect(templateStart(template, null)).toEqual({
      model: { _tag: "none" },
      permissionMode: "supervised",
      asked: "full-access",
    });
  });
});
