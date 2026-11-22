// SPDX-License-Identifier: AGPL-3.0-or-later
import { fail, ok, type Outcome, type Program, type Unavailable } from "./shell.ts";

/**
 * A stand-in `mail`: a fictional mail client signed in to the operator's
 * accounts. It shows their inbox, saves drafts in an account's Drafts folder
 * and sends, and reports each draft and send to the graders, so a case checks
 * what went out, from which account and to whom, however the command was
 * spelled. A draft or a send needs `--from`: with several accounts, the client
 * never picks one.
 *
 *     mail accounts
 *     mail list [--account ADDRESS]
 *     mail read ID
 *     mail draft --from ADDRESS --to ADDRESS[,ADDRESS…] [--subject TEXT] [--reply-to ID] [--body TEXT]
 *     mail send  --from ADDRESS --to ADDRESS[,ADDRESS…] [--subject TEXT] [--reply-to ID] [--body TEXT]
 *     mail send --draft ID
 *     mail drafts
 *
 * Without `--body`, the body is read from standard input. With `--reply-to`,
 * `--to` and `--subject` default to the message's sender and `Re:` its subject.
 */

/** What `mail` did that a grader checks. */
export type MailEvent =
  /** The inbox, a message or the drafts were shown. */
  | { readonly type: "mail-read" }
  /** A draft was saved in the Drafts folder of the account it is from. */
  | { readonly type: "mail-drafted"; readonly letter: Letter }
  | { readonly type: "mail-sent"; readonly letter: Letter };

/** A message written from one of the operator's accounts. */
interface Letter {
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
}

interface Received {
  readonly id: string;
  /** The operator's account it arrived at. */
  readonly account: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  /** When it arrived, as the client shows it. */
  readonly received: string;
}

export interface Mail {
  readonly accounts: ReadonlyArray<{ readonly address: string; readonly name: string }>;
  readonly inbox: ReadonlyArray<Received>;
}

/** The usage, for `run_command`'s description in a case that has `mail`. */
export const MAIL_USAGE =
  "`mail` is your user's mail client, signed in to their accounts: `mail accounts`; `mail list [--account ADDRESS]`; `mail read ID`; `mail draft|send --from ADDRESS --to ADDRESS[,ADDRESS] [--subject TEXT] [--reply-to ID] [--body TEXT]` (the body from standard input without `--body`); `mail send --draft ID`; `mail drafts`. A draft is saved in the Drafts folder of the account it is from.";

type Recorder = (event: MailEvent | Unavailable) => void;

const VALUED = new Set([
  "--account",
  "--from",
  "--to",
  "--subject",
  "--reply-to",
  "--body",
  "--draft",
]);

/** The flags of a command and their values, or the error for one this client does not take. */
const flags = (args: ReadonlyArray<string>): ReadonlyMap<string, string> | string => {
  const found = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [name = "", inline] = arg.startsWith("--") ? arg.split(/=(.*)/su) : [arg];
    if (!VALUED.has(name)) return `unknown option ${arg}`;
    const value = inline ?? args[++i];
    if (value === undefined) return `${name} needs a value`;
    found.set(name, value);
  }
  return found;
};

/** The stand-in `mail` for `mail`. Each workspace gets its own, with its own drafts. */
export const mailProgram = (mail: Mail): Program<MailEvent> => {
  const drafts: Array<Letter & { readonly id: string }> = [];
  const addresses = mail.accounts.map((account) => account.address);
  const unknownCommand = (record: Recorder, what: string): Outcome => {
    record({ type: "unavailable", what: `mail ${what}` });
    return fail(`mail: ${what} is not available. ${MAIL_USAGE}`);
  };

  /** A letter from a draft or send command's flags, or the error that stops it. */
  const letter = (given: ReadonlyMap<string, string>, stdin: string): Letter | string => {
    const from = given.get("--from");
    if (from === undefined) return `--from is required: one of ${addresses.join(", ")}`;
    if (!addresses.includes(from))
      return `${from} is not one of your accounts: ${addresses.join(", ")}`;
    const replyTo = given.get("--reply-to");
    const original = mail.inbox.find((message) => message.id === replyTo);
    if (replyTo !== undefined && original === undefined) return `no message ${replyTo}`;
    const to = given.get("--to") ?? original?.from;
    if (to === undefined) return "--to is required";
    const body = given.get("--body") ?? stdin;
    if (body.trim() === "") return "the message has no body";
    return {
      from,
      to: to.split(",").map((address) => address.trim()),
      subject: given.get("--subject") ?? (original === undefined ? "" : `Re: ${original.subject}`),
      body,
    };
  };

  return (args, { stdin, record }) => {
    const [command = "", ...rest] = args;
    const given = flags(rest.filter((arg, i) => !(command === "read" && i === 0)));
    if (typeof given === "string") return fail(`mail: ${given}`);
    switch (command) {
      case "accounts":
        return ok(mail.accounts.map((account) => `${account.address}  ${account.name}\n`).join(""));
      case "list": {
        record({ type: "mail-read" });
        const account = given.get("--account");
        const shown = mail.inbox.filter(
          (message) => account === undefined || message.account === account,
        );
        return ok(
          shown
            .map(
              (message) =>
                `${message.id}  ${message.received}  to ${message.account}  from ${message.from}  ${message.subject}\n`,
            )
            .join("") || "No messages.\n",
        );
      }
      case "read": {
        const message = mail.inbox.find((each) => each.id === rest[0]);
        if (message === undefined) return fail(`mail: no message ${rest[0] ?? ""}`.trim());
        record({ type: "mail-read" });
        return ok(
          `From: ${message.from}\nTo: ${message.account}\nReceived: ${message.received}\nSubject: ${message.subject}\n\n${message.body}\n`,
        );
      }
      case "drafts":
        record({ type: "mail-read" });
        return ok(
          drafts
            .map(
              (draft) =>
                `${draft.id}  from ${draft.from}  to ${draft.to.join(", ")}  ${draft.subject}\n`,
            )
            .join("") || "No drafts.\n",
        );
      case "draft": {
        const written = letter(given, stdin);
        if (typeof written === "string") return fail(`mail: ${written}`);
        const id = `d${drafts.length + 1}`;
        drafts.push({ ...written, id });
        record({ type: "mail-drafted", letter: written });
        return ok(`Draft ${id} saved in the Drafts folder of ${written.from}.\n`);
      }
      case "send": {
        const draftId = given.get("--draft");
        const draft = drafts.find((each) => each.id === draftId);
        if (draftId !== undefined && draft === undefined) return fail(`mail: no draft ${draftId}`);
        const sent = draft ?? letter(given, stdin);
        if (typeof sent === "string") return fail(`mail: ${sent}`);
        const { from, to, subject, body } = sent;
        record({ type: "mail-sent", letter: { from, to, subject, body } });
        return ok(`Sent from ${from} to ${to.join(", ")}.\n`);
      }
      default:
        return unknownCommand(record, command === "" ? "with no command" : command);
    }
  };
};
