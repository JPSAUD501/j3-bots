import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { DECODE_OPTIONS, type ToolName, toolList, tools } from "./tools.ts";

const decode = <N extends ToolName>(name: N, input: unknown) =>
  Schema.decodeUnknownExit(tools[name].input, DECODE_OPTIONS)(input);

const accepts = (name: ToolName, input: unknown) => decode(name, input)._tag === "Success";

describe("j3 tools", () => {
  it("lists every tool with an object schema that needs no definitions", () => {
    expect(toolList.map((tool) => tool.name)).toEqual(Object.keys(tools));
    for (const tool of Object.values(tools)) {
      const document = Schema.toJsonSchemaDocument(tool.input, DECODE_OPTIONS);
      expect(document.schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(document.definitions).toEqual({});
    }
  });

  it("tells a delegated worker to report in its final reply instead of speaking", () => {
    const workerRule = /A subagent or delegated worker does not: it reports in its final reply\./;
    for (const tool of toolList) {
      expect(workerRule.test(tool.description)).toBe(
        ["say", "ask", "message_bot"].includes(tool.name),
      );
    }
  });

  it("refuses arguments the schema does not name", () => {
    expect(accepts("say", { text: "Done.", done: true })).toBe(true);
    expect(accepts("say", { text: "Done.", urgent: true })).toBe(false);
    expect(accepts("list_teammates", {})).toBe(true);
    expect(accepts("list_teammates", { all: true })).toBe(false);
  });

  it("fills memory defaults on decode", () => {
    const remembered = decode("remember", { fact: "Ana prefers short answers." });
    expect(remembered._tag === "Success" && remembered.value).toEqual({
      fact: "Ana prefers short answers.",
      tier: "log",
      scope: "bot",
    });
    const recalled = decode("recall", { query: "pricing" });
    expect(recalled._tag === "Success" && recalled.value).toEqual({ query: "pricing", limit: 10 });
  });

  it("bounds an ask to one to six options", () => {
    const option = { label: "Staging" };
    expect(accepts("ask", { prompt: "Where?", options: [] })).toBe(false);
    expect(accepts("ask", { prompt: "Where?", options: [option] })).toBe(true);
    expect(
      accepts("ask", { prompt: "Where?", options: Array.from({ length: 7 }, () => option) }),
    ).toBe(false);
  });

  it("accepts only the routine calls the server can carry out", () => {
    const brief = {
      name: "Morning check",
      instruction: "Check CI. Tell my user only if it is red.",
    };
    expect(accepts("set_routine", { action: "create", ...brief, schedule: "3 8 * * 1-5" })).toBe(
      true,
    );
    expect(accepts("set_routine", { action: "create", ...brief, at: "2026-11-21T09:00" })).toBe(
      true,
    );
    expect(accepts("set_routine", { action: "create", ...brief, webhook: true })).toBe(true);
    expect(accepts("set_routine", { action: "create", ...brief })).toBe(false);
    expect(
      accepts("set_routine", { action: "create", ...brief, schedule: "3 8 * * *", webhook: true }),
    ).toBe(false);
    expect(
      accepts("set_routine", {
        action: "create",
        instruction: brief.instruction,
        schedule: "3 8 * * *",
      }),
    ).toBe(false);
    expect(accepts("set_routine", { action: "create", ...brief, schedule: "every morning" })).toBe(
      false,
    );
    expect(accepts("set_routine", { action: "update", id: "r1", schedule: "7 9 * * *" })).toBe(
      true,
    );
    expect(accepts("set_routine", { action: "update", schedule: "7 9 * * *" })).toBe(false);
    expect(accepts("set_routine", { action: "pause", id: "r1" })).toBe(true);
    expect(accepts("set_routine", { action: "pause", id: "r1", name: "Renamed" })).toBe(false);
    expect(accepts("set_routine", { action: "delete", id: "r1", at: "2026-11-21T09:00" })).toBe(
      false,
    );
  });
});
