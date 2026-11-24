// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { type BotId, DeviceId } from "@j3-bots/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Entries } from "../../entries/Entries.ts";
import * as TestDomain from "../../testing/domain.ts";
import { addOAuthConnector, NOTION, TestOAuth, unresolvable } from "../../testing/oauth.ts";
import { createNewBot } from "../../testing/turns.ts";
import { Vault } from "../../vault/Vault.ts";
import { ConnectorSignIns } from "../auth.ts";
import { ConnectorAuth } from "./ConnectorAuth.ts";

const LAPTOP = DeviceId.make("device-laptop");
const domain = TestDomain.layer.pipe(Layer.provide(unresolvable));
const PASSWORD = Redacted.make("correct horse battery");

/** The statuses of the `connector-auth` cards in the bot's conversation, oldest first. */
const cardsOf = (botId: BotId) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    const latest = yield* entries.latest({ _tag: "conversation", botId }, 50);
    return latest.flatMap((entry) => (entry._tag === "connector-auth" ? [entry.status] : []));
  });

/** Waits until no `connector-auth` card in the bot's conversation is pending, following its changes. */
const cardsClosed = (botId: BotId) =>
  Effect.gen(function* () {
    const entries = yield* Entries;
    const open = new Set<string>();
    yield* entries.subscribe({ _tag: "conversation", botId }, null).pipe(
      Stream.map((frame) => {
        if (frame._tag === "snapshot") open.clear();
        for (const entry of frame._tag === "snapshot" ? frame.entries : frame.upsert) {
          if (entry._tag !== "connector-auth") continue;
          if (entry.status === "pending") open.add(entry.id);
          else open.delete(entry.id);
        }
        return open.size;
      }),
      Stream.filter((pending) => pending === 0),
      Stream.runHead,
      Effect.orDie,
    );
  });

const signIn = Effect.gen(function* () {
  const auth = yield* ConnectorAuth;
  const fake = yield* TestOAuth;
  const { authorizationUrl } = yield* auth.begin({
    connectorId: NOTION,
    deviceId: LAPTOP,
    redirect: { _tag: "paste" },
  });
  yield* auth.complete({
    _tag: "device",
    deviceId: LAPTOP,
    url: Redacted.make(fake.authorize(authorizationUrl)),
  });
});

it.effect(
  "puts one card in each conversation whose call needs a sign-in, until the sign-in is done",
  () =>
    Effect.gen(function* () {
      yield* (yield* Vault).setup(PASSWORD);
      yield* addOAuthConnector;
      const ada = yield* createNewBot("Ada");
      const bea = yield* createNewBot("Bea");
      const signIns = yield* ConnectorSignIns;

      // Calls that fail at once, and again later, raise one card per bot.
      yield* Effect.all(
        [
          signIns.needed({ botId: ada.id, connectorId: NOTION }),
          signIns.needed({ botId: ada.id, connectorId: NOTION }),
          signIns.needed({ botId: bea.id, connectorId: NOTION }),
        ],
        { concurrency: "unbounded" },
      );
      yield* signIns.needed({ botId: ada.id, connectorId: NOTION });
      assert.deepStrictEqual(yield* cardsOf(ada.id), ["pending"]);
      assert.deepStrictEqual(yield* cardsOf(bea.id), ["pending"]);

      yield* signIn;
      yield* cardsClosed(ada.id);
      yield* cardsClosed(bea.id);
      assert.deepStrictEqual(yield* cardsOf(ada.id), ["signed-in"]);
      assert.deepStrictEqual(yield* cardsOf(bea.id), ["signed-in"]);

      // A later end of the sign-in is another card, which removal closes.
      yield* signIns.needed({ botId: ada.id, connectorId: NOTION });
      yield* signIns.disconnect(NOTION);
      assert.deepStrictEqual(yield* cardsOf(ada.id), ["signed-in", "removed"]);
      assert.deepStrictEqual(yield* cardsOf(bea.id), ["signed-in"]);
    }).pipe(Effect.provide(domain)),
);

it.effect("closes a card when the operator signs in, not when a sign-in comes back by itself", () =>
  Effect.gen(function* () {
    const vault = yield* Vault;
    yield* vault.setup(PASSWORD);
    yield* addOAuthConnector;
    const ada = yield* createNewBot("Ada");
    const signIns = yield* ConnectorSignIns;
    yield* signIn;

    // The server needs a scope the token lacks: the connector stays signed
    // in, and the bot's call needs a new sign-in.
    const refused = yield* Effect.exit(
      signIns.rejected(
        NOTION,
        Option.some('Bearer error="insufficient_scope", scope="write"'),
        (yield* TestOAuth).bearer,
      ),
    );
    assert.isTrue(Exit.isFailure(refused));
    yield* signIns.needed({ botId: ada.id, connectorId: NOTION });

    // The card closes once, and that must be after the operator signs in.
    const signingIn = yield* Ref.make(false);
    const closed = yield* cardsClosed(ada.id).pipe(
      Effect.andThen(Ref.get(signingIn)),
      Effect.forkChild({ startImmediately: true }),
    );

    // Unlocking the vault brings the sign-in back, which is not the one the card asks for.
    const back = yield* signIns.states.pipe(
      Stream.map((all) => all.get(NOTION)?._tag),
      Stream.dropWhile((tag) => tag !== "vault-locked"),
      Stream.filter((tag) => tag === "signed-in"),
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* vault.lock;
    yield* vault.unlock(PASSWORD);
    yield* Fiber.join(back);
    assert.deepStrictEqual(yield* cardsOf(ada.id), ["pending"]);

    // Signing in again, with the scope the server named, closes it.
    yield* Ref.set(signingIn, true);
    yield* signIn;
    assert.isTrue(yield* Fiber.join(closed));
    assert.deepStrictEqual(yield* cardsOf(ada.id), ["signed-in"]);
  }).pipe(Effect.provide(domain)),
);

it.effect(
  "leaves a sign-in to end once the vault opens, when its connector goes while it is locked",
  () =>
    Effect.gen(function* () {
      const vault = yield* Vault;
      yield* vault.setup(PASSWORD);
      yield* addOAuthConnector;
      const signIns = yield* ConnectorSignIns;
      const fake = yield* TestOAuth;
      yield* signIn;
      yield* vault.lock;
      const refused = yield* Effect.flip(signIns.disconnect(NOTION));
      assert.strictEqual(refused._tag, "VaultLocked");
      assert.deepStrictEqual(fake.revoked, []);
      // The removal runs again with the vault open, and ends the sign-in then.
      yield* vault.unlock(PASSWORD);
      yield* signIns.disconnect(NOTION);
      assert.lengthOf(fake.revoked, 2);
    }).pipe(Effect.provide(domain)),
);
