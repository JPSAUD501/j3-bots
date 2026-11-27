// SPDX-License-Identifier: AGPL-3.0-or-later
import { deferred } from "../lib/deferred";

/** The first run, which most sessions never see: not part of the app's first load. */
export const onboarding = deferred(() => import("./Onboarding").then((first) => first.Onboarding));
