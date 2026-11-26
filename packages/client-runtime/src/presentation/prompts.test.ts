// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConnectorId } from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { FILE_MARK } from "../files/placed.ts";
import { type PromptOption, promptArguments, promptOptions, promptQuery } from "./prompts.ts";

const prompt = (name: string, title: string | null, connector: string): PromptOption => ({
  connectorId: ConnectorId.make("conn_fictional0000000"),
  connector,
  name,
  title,
  description: "",
  arguments: [
    { name: "team", title: null, description: "", required: true },
    { name: "since", title: null, description: "", required: false },
  ],
});

describe("the / menu", () => {
  it("opens only while the whole draft is a slash and one word", () => {
    expect(promptQuery("/")).toBe("");
    expect(promptQuery("/week")).toBe("week");
    expect(promptQuery("/week review")).toBeNull();
    expect(promptQuery("say /week")).toBeNull();
    expect(promptQuery(`/${FILE_MARK}`)).toBeNull();
  });

  it("matches the name, the title or the connector, ignoring case", () => {
    const prompts = [
      prompt("weekly-review", "Weekly review", "Notes"),
      prompt("triage", null, "Issues"),
    ];
    expect(promptOptions("REVIEW", prompts).map((p) => p.name)).toEqual(["weekly-review"]);
    expect(promptOptions("issues", prompts).map((p) => p.name)).toEqual(["triage"]);
    expect(promptOptions("", prompts)).toHaveLength(2);
  });

  it("sends the arguments filled in, and none while a required one is empty", () => {
    const weekly = prompt("weekly-review", null, "Notes");
    expect(promptArguments(weekly, { team: " ", since: "monday" })).toBeNull();
    expect(promptArguments(weekly, { team: " design ", since: "" })).toEqual({ team: "design" });
  });
});
