// SPDX-License-Identifier: AGPL-3.0-or-later
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { ClockProvider, I18nProvider } from "../app/context";

export const Route = createRootRoute({
  component: () => (
    <I18nProvider>
      <ClockProvider>
        <Suspense>
          <Outlet />
        </Suspense>
      </ClockProvider>
    </I18nProvider>
  ),
});
