# 0081: One secret card asks for every value a request needs, at once

**Status:** Accepted.

## Context

A bot that needs credentials only the operator has asks for them with the engine's `request_secret`, and J3 Bots shows the request as a card in the conversation. Until this change the card held one masked value. Signing in somewhere takes two (an email and a password), so a bot had to ask twice, and the operator answered two cards for one sign-in.

T3 Code 0.1.13 lets a request name its values (`fields`): one to eight, each with a name, a label, an optional placeholder, and `secret: false` for a value that is not secret, such as an email. The engine takes such a request's answer only whole, a value for every field under its name and no other, refuses a blank value, and delivers every request with fields as owner-only files, one per field, that the agent's commands read for 24 hours (**Read** at `bc0f04d`, `SecretRequests.ts`, `OrchestratorMcpService.ts`, `orchestratorMcp.ts`). J3 Bots moved to 0.1.13 in [decision 0077](0077-the-engine-moves-to-t3-code-0-1-13-and-no-older-engine-starts-on-its-data.md).

## Decision

**A secret request is one card with an input for each value it asks for, answered all together. The card says where the values go, and only a sign-in's email and password are offered to a password manager.**

- **The entry.** `SecretRequestEntry` gains `fields` (each with an id of J3 Bots' own, `field-1` to `field-8` in the order the bot named them, a label, a placeholder and whether it is masked) and `delivery` (`reference` or `file`, an open list). A request for one value has no fields, as before. Both are additive with defaults, so an entry stored earlier, or sent by an older server, still decodes, and protocol 11 holds.
- **The answer.** `secret.provide` takes `provide-fields`, a value for each field keyed by its id, beside `provide` and `decline`. The engine adapter maps the ids back to the bot's names; the names never leave it. An answer that does not fit the request's fields fails with `Invalid("answer")` before anything reaches the engine, and the card stays open. A request with one field also takes `provide`, which is what a client before 0.12.0 sends; one with several cannot be answered by such a client, which sees one input.
- **The card.** A value is masked unless the bot said it is not secret, with an eye that shows it on that device. Labels are real labels. Enter moves to the first value still empty and sends once every one is filled; Send waits until then; Decline is always there. Once the request closes, the card says only that the values were sent, declined, or that the request expired. The same card shows in a conversation, in quick access, and on Android.
- **Where the values go, said plainly.** A request without file delivery: "the bot can use it without seeing it". A request delivered as files: "kept out of this conversation, in a private file your bot can read for the next 24 hours". A delivery the client does not know: no promise at all. The old wording promised the bot would not see the value even for a file, which its commands can read.
- **Autofill by shape.** A shown value directly followed by a masked one is a sign-in: the first is offered to a password manager as the user name, the second as the password. Every other input is marked not to be filled, so an API key is never offered a saved password. On Android a masked value the operator shows stays a password to the keyboard.
- **The base prompt** no longer tells a bot to ask for one value per call. It names `request_secret` and leaves the how to the tool's own description, which already asks for values that go together, such as an email and a password, in one card.

## Costs

- **A client before 0.12.0 cannot answer a card with several values.** It shows one input, and its answer is refused with a reason it does not word. The operator answers on an updated device, or declines.
- **A client before 0.12.0 still makes the old promise.** It does not know `delivery`, so on a request delivered as a file it says the bot can use the value without seeing it, and its answer is taken. Bots already asked for such cards before this change, so nothing here makes that worse. Only updating the client corrects the wording.
- **The sign-in shape is a guess from structure.** A card that asks for a shown account number and then a masked PIN is offered to a password manager as a sign-in too. It is the shape password managers themselves look for, and nothing is filled without the operator choosing it.
- **Values are trimmed by the engine.** A password that starts or ends with a space loses it there (**Read** at `bc0f04d`, `baseSchemas.ts`, `TrimmedNonEmptyString`). J3 Bots sends what was typed.
- **Timed out and stopped look the same.** The engine records a request nobody answered in time as it records one whose run ended (`cancelled`), so the card says "expired" for both.

## Rejected

- **Several one-value cards for one request.** The engine takes the answer only whole, so a card answered alone could not be sent, and the operator would see one sign-in as two questions.
- **Sending the bot's field names to clients.** They are the bot's text, chosen for its commands. Ids by position keep the clients' contract J3 Bots' own, as questions already do.
- **Offering every masked value to a password manager.** It would offer saved passwords for API keys and codes, and invite saving them under J3 Bots' own address.
- **Taking an answer to a file request only from a client that has shown where it goes** (an acknowledgement in `secret.provide`). An older client would then be unable to answer requests it answers today. That costs more than a wording the operator sees on one device, which an update corrects.
- **Keeping one-value cards and telling bots to ask once per value.** It works, and it is what the operator asked to change.
