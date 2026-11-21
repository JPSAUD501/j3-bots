// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- a test of a shell script, run on plain git in a scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

// scripts/check-signoff.sh, the CI step that refuses a pull request with a
// commit its author did not sign off, run on throwaway repositories.

const SCRIPT = NodePath.join(import.meta.dirname, "check-signoff.sh");

const ADA = "Ada Example <ada@example.com>";
const BOB = "Bob Example <bob@example.com>";

const scratch: Array<string> = [];
afterEach(() => {
  for (const folder of scratch.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

/**
 * A new repository on `main`, whose commits Ada writes. Git reads neither the
 * user's nor the system's configuration, so a signing or hook setting on the
 * machine running the test changes nothing.
 */
const repository = () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j3-signoff-"));
  scratch.push(folder);
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: folder,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Ada Example",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_NAME: "Ada Example",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  };
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: folder, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  return {
    git,
    /** Commits on the current branch, with `signedOffBy` as its trailers, and answers its id. */
    commit: (subject: string, ...signedOffBy: ReadonlyArray<string>) => {
      const trailers = signedOffBy.map((who) => `Signed-off-by: ${who}`);
      const paragraphs = trailers.length === 0 ? [subject] : [subject, trailers.join("\n")];
      git("commit", "--quiet", "--allow-empty", ...paragraphs.flatMap((text) => ["-m", text]));
      return git("rev-parse", "HEAD");
    },
    /** Runs the check on `base..head`, as CI does. */
    check: (base: string, head: string) =>
      NodeChildProcess.spawnSync(SCRIPT, [base, head], { cwd: folder, env, encoding: "utf8" }),
  };
};

describe("check-signoff.sh", () => {
  it("passes a pull request whose commits are signed off by their author, leaving the base's and merges alone", () => {
    const repo = repository();
    repo.commit("Start the project");
    repo.git("switch", "--quiet", "-c", "feature");
    repo.commit("Add the widget", ADA);
    repo.git("switch", "--quiet", "main");
    const base = repo.commit("Rename the gadget");
    repo.git("switch", "--quiet", "feature");
    repo.git("merge", "--quiet", "--no-edit", "main");
    const head = repo.commit("Test the widget", BOB, ADA);

    const result = repo.check(base, head);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("checked 2 commits");
    expect(result.status).toBe(0);
  });

  it("refuses a commit its author did not sign off, and names each one", () => {
    const repo = repository();
    const base = repo.commit("Start the project");
    repo.commit("Add the widget", ADA);
    repo.commit("Draw the widget");
    const head = repo.commit("Test the widget", BOB);

    const result = repo.check(base, head);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Draw the widget");
    expect(result.stderr).toContain("Test the widget");
    expect(result.stderr).not.toContain("Add the widget");
  });

  it("refuses a range it cannot read rather than pass it empty", () => {
    const repo = repository();
    const head = repo.commit("Add the widget", ADA);

    expect(repo.check("0".repeat(40), head).status).toBe(2);
  });
});
