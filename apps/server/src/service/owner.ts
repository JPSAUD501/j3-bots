// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AdminClient } from "../admin/AdminClient.ts";
import type { AdminStatus } from "../admin/protocol.ts";
import { Host } from "../system/Host.ts";
import { Systemd, type UnitState } from "../system/Systemd.ts";
import * as Unit from "./unit.ts";

/** Who answers on the admin socket, and what systemd says of the unit meanwhile. */
interface SocketOwner {
  /**
   * `service` when the server answering is the unit's main process, `other`
   * when another process holds the home, `nobody` when none answers, and
   * `unknown` when a server answers but which process it is cannot be told.
   */
  readonly owner: "service" | "other" | "nobody" | "unknown";
  /** What the server answered; none from a release that answers differently. */
  readonly status: Option.Option<AdminStatus>;
  readonly unit: UnitState;
}

const ownedBy = (
  owner: SocketOwner["owner"],
  status: Option.Option<AdminStatus>,
  unit: UnitState,
): SocketOwner => ({ owner, status, unit });

/**
 * Who answers on `socket`, the admin socket of the home a command looks at:
 * the service's own server only when it is the unit's main process. What
 * `service install`, `service status` and `doctor` attribute to the service
 * goes through this.
 */
export const socketOwner = Effect.fn("service.socketOwner")(function* (socket: string) {
  const admin = yield* AdminClient;
  const systemd = yield* Systemd;
  const host = yield* Host;
  const answer = yield* admin.status(socket).pipe(Effect.result);
  const unit = yield* systemd.unitState(Unit.UNIT_NAME);
  const mainPid = unit.active === "active" ? unit.mainPid : Option.none<number>();
  if (answer._tag === "Success") {
    if (Option.isNone(answer.success)) return ownedBy("nobody", Option.none(), unit);
    const ours = Option.contains(mainPid, answer.success.value.pid);
    return ownedBy(ours ? "service" : "other", answer.success, unit);
  }
  // A server answers, but not in this release's words (an older release, or
  // one that is stuck), so it cannot say which process it is. The kernel can.
  if (Option.isNone(mainPid)) return ownedBy("other", Option.none(), unit);
  const held = yield* host.holdsSocket(mainPid.value, socket);
  return ownedBy(
    Option.match(held, {
      onNone: () => "unknown",
      onSome: (holds) => (holds ? "service" : "other"),
    }),
    Option.none(),
    unit,
  );
});
