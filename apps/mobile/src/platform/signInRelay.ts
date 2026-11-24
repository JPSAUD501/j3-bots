// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  LOOPBACK_HEADERS,
  landingPage,
  type LoopbackAnswer,
  type SignInCatch,
  signInCatch,
} from "@j3-bots/client-runtime/presentation";
import type { SignInRoute } from "@j3-bots/client-runtime/react";
import type { Language } from "@j3-bots/contracts";
import { createI18n } from "@j3-bots/i18n";
import { type NativeModule, requireOptionalNativeModule } from "expo";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Linking } from "react-native";

// A connector's sign-in from this phone: its page in a Custom Tab, and the
// browser's return. A server reached over https takes it at its own callback,
// so nothing of the sign-in passes through the phone. A computer at home on
// plain HTTP is no address a browser may come back to: then the return is
// caught on the phone's loopback (`modules/sign-in-relay`) and relayed to the
// server, as the desktop app does; the code that comes back is worth nothing
// without the verifier only the server holds. The native listener reads each
// request and asks here what to answer, so the phone takes a return by the
// same rules as the desktop app (`signInCatch`): only the sign-in's own, with
// the state the server put in it, once.

/** A request the native listener read, as it reports it. */
const Request = Schema.Struct({
  id: Schema.Int,
  port: Schema.Int,
  method: Schema.String,
  target: Schema.String,
  host: Schema.NullOr(Schema.String),
});
type Request = typeof Request.Type;

const decodeRequest = Schema.decodeUnknownOption(Request);

declare class SignInRelayModule extends NativeModule<{ onRequest: (request: unknown) => void }> {
  /**
   * Listens in place of any listener before, keeping the app awake behind the
   * browser under a notification titled `title`, in the channel `channelName`;
   * the port, or null when it could not.
   */
  listen(title: string, channelName: string): Promise<number | null>;
  stop(port: number): void;
  answer(id: number, status: number, headers: Record<string, string>, body: string): void;
  /** Shows an https: page in a Custom Tab; false when nothing could show it. */
  open(url: string): Promise<boolean>;
  bringForward(): Promise<void>;
}

/** The app's own module, on Android only. */
const relay = requireOptionalNativeModule<SignInRelayModule>("SignInRelay");

/** What turns a request away. */
const refused = (status: number) => ({ status, headers: LOOPBACK_HEADERS, body: "" });

/**
 * The listener's catch, by port: the one it listens on now, which a new
 * sign-in replaces. A request to any other port, still in the native
 * listener's hands as it closes, is turned away.
 */
const catches = new Map<number, { readonly caught: SignInCatch; readonly page: string }>();
const returned = new Set<(url: string) => void>();

const answerOf = (request: Request) => {
  const held = catches.get(request.port);
  const answer: LoopbackAnswer = held?.caught.answer({
    method: request.method,
    url: request.target,
    host: request.host ?? undefined,
  }) ?? { _tag: "refused", status: 400 };
  return answer._tag === "refused"
    ? refused(answer.status)
    : {
        status: 200,
        headers: { ...LOOPBACK_HEADERS, "content-type": "text/html; charset=utf-8" },
        body: held?.page ?? "",
      };
};

relay?.addListener("onRequest", (event) => {
  Option.match(decodeRequest(event), {
    onNone: () => undefined,
    onSome: (request) => {
      const { status, headers, body } = answerOf(request);
      relay.answer(request.id, status, headers, body);
    },
  });
});

/**
 * How a sign-in started on this phone comes back: to the server's own
 * address when the phone reaches it over https (`viaHttps`), else to the
 * phone's loopback, where the app listens, with its words in `language`.
 * Without the app's listener (a build for another system), to the server's
 * own address too.
 */
export const phoneSignInRoute = (language: Language, viaHttps: boolean): SignInRoute => {
  if (viaHttps || relay === null) return { _tag: "server" };
  return {
    _tag: "relay",
    listen: async () => {
      const { t } = createI18n(language);
      const port = await relay
        .listen(t("signIn.waitingNotice"), t("notification.channel.signIn"))
        .catch(() => null);
      catches.clear();
      if (port === null) return null;
      catches.set(port, {
        caught: signInCatch(port, {
          relay: (url) => {
            for (const listener of returned) listener(url);
          },
          focus: () => {
            void relay.bringForward();
          },
        }),
        page: landingPage({
          language,
          title: t("signInReturn.title"),
          body: t("signInReturn.body"),
        }),
      });
      return port;
    },
    expect: (port, state) => {
      const held = catches.get(port);
      held?.caught.expect(Redacted.value(state));
      return Promise.resolve(held !== undefined);
    },
    onReturn: (listener) => {
      returned.add(listener);
      return () => {
        returned.delete(listener);
      };
    },
    stop: (port) => {
      catches.delete(port);
      relay.stop(port);
    },
  };
};

/**
 * Opens a sign-in's page: in a Custom Tab over the app where the app has
 * one, else in the system's browser.
 */
export const openSignInPage = (url: string): void => {
  void (relay?.open(url) ?? Promise.resolve(false))
    .catch(() => false)
    .then((opened) => (opened ? undefined : Linking.openURL(url)))
    .catch(() => undefined);
};
