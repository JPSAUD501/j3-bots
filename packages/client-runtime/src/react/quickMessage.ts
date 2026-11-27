// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, EntryId, EntryTarget } from "@j3-bots/contracts";
import { useState } from "react";
import type { MessageProblem } from "../files/limits.ts";
import type { IntentResult } from "../intents/Actions.ts";

/** What sending a message answers (`J3Client.send`). */
export type QuickSendResult =
  | IntentResult<EntryId>
  | { readonly _tag: "invalid"; readonly problem: MessageProblem };

export type QuickSend = (input: {
  readonly target: EntryTarget;
  readonly text: string;
}) => Promise<QuickSendResult>;

/**
 * Where the latest quick message stands. `failed` leaves it in the bot's
 * conversation, not sent, where Retry is; `invalid` sent nothing, and its
 * text is back in the field; `gone` is a bot deleted meanwhile.
 */
export type QuickMessageState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "sending" }
  | { readonly _tag: "sent" }
  | { readonly _tag: "invalid"; readonly problem: MessageProblem }
  | { readonly _tag: "gone" }
  | { readonly _tag: "failed" };

const idle: QuickMessageState = { _tag: "idle" };

const outcome = (result: QuickSendResult): QuickMessageState => {
  switch (result._tag) {
    case "done":
      return { _tag: "sent" };
    case "invalid":
      return { _tag: "invalid", problem: result.problem };
    case "failed":
      return result.failure._tag === "refused" && result.failure.error._tag === "NotFound"
        ? { _tag: "gone" }
        : { _tag: "failed" };
  }
};

/**
 * A message to `botId` typed on its card, sent straight to its conversation
 * without opening it (decision 0102), through the outbox as the composer's
 * is: it is shown there at once and sent through any disconnection. The field
 * empties as it goes and gets its text back only when it broke a limit, so
 * nothing was sent. Another bot starts from an empty field; the latest send's
 * answer is the one shown.
 */
export function useQuickMessage(botId: BotId, send: QuickSend) {
  const [held, setHeld] = useState<{
    readonly botId: BotId;
    readonly text: string;
    readonly attempt: number;
    readonly state: QuickMessageState;
  }>({ botId, text: "", attempt: 0, state: idle });
  const current = held.botId === botId ? held : { botId, text: "", attempt: 0, state: idle };
  const setText = (text: string) =>
    setHeld({ ...current, text, state: current.state._tag === "sending" ? current.state : idle });
  const submit = () => {
    const text = current.text.trim();
    if (text === "") return;
    const attempt = current.attempt + 1;
    setHeld({ botId, text: "", attempt, state: { _tag: "sending" } });
    void send({ target: { _tag: "conversation", botId }, text }).then((result) =>
      setHeld((now) =>
        now.botId !== botId || now.attempt !== attempt
          ? now
          : {
              ...now,
              text: result._tag === "invalid" && now.text === "" ? text : now.text,
              state: outcome(result),
            },
      ),
    );
  };
  return { text: current.text, setText, state: current.state, submit };
}
