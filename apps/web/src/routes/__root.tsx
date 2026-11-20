// SPDX-License-Identifier: AGPL-3.0-or-later
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Fragment, Suspense, lazy } from "react";
import { ClockProvider, I18nProvider } from "../app/context";

// Development serves a sample team so every screen can be seen without a server.
// The condition is constant in a build, so the sample is not part of one.
const SourceProvider = import.meta.env.DEV
  ? lazy(() => import("../gallery/sampleSource").then((m) => ({ default: m.SampleSourceProvider })))
  : Fragment;

export const Route = createRootRoute({
  component: () => (
    <I18nProvider>
      <ClockProvider>
        <Suspense>
          <SourceProvider>
            <Outlet />
          </SourceProvider>
        </Suspense>
      </ClockProvider>
    </I18nProvider>
  ),
});
