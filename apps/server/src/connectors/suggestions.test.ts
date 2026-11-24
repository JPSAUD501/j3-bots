// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import { ConnectorId, CuratedKey } from "@j3-bots/contracts";
import { offers } from "./suggestions.ts";

const work = ConnectorId.make("conn_0123456789abcdef");
const otherWork = ConnectorId.make("conn_fedcba9876543210");
const linear = { _tag: "curated", key: CuratedKey.make("linear") } as const;
const linearKey = { _tag: "curated", key: CuratedKey.make("linear-key") } as const;

it("tells two of the operator's connectors apart by id, whatever their names", () => {
  const card = { name: "Work", subject: { _tag: "connector", connectorId: work } } as const;
  const same = {
    name: "Work",
    subject: { _tag: "connector", connectorId: work },
    listings: [],
  } as const;
  const other = {
    name: "Work",
    subject: { _tag: "connector", connectorId: otherWork },
    listings: [],
  } as const;
  assert.isTrue(offers(card, same));
  assert.isFalse(offers(card, other));
});

it("takes another gallery entry for the same address as the same service", () => {
  const card = { name: "Linear", subject: { _tag: "listing", ref: linear } } as const;
  const byKey = {
    name: "Linear (API key)",
    subject: { _tag: "listing", ref: linearKey },
    listings: [linearKey, linear],
  } as const;
  const elsewhere = {
    name: "Linear (API key)",
    subject: { _tag: "listing", ref: linearKey },
    listings: [linearKey],
  } as const;
  assert.isTrue(offers(card, byKey));
  assert.isFalse(offers(card, elsewhere));
});
