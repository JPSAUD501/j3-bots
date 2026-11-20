// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy } from "react";

// The condition is constant in a build, so the gallery and its sample are not part of one.
const GalleryPage = import.meta.env.DEV ? lazy(() => import("../gallery/GalleryPage")) : null;

/**
 * Every component in every state, in both themes, with sample data. Development
 * only: a build answers this path with "not found".
 */
export const Route = createFileRoute("/gallery")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: () => (GalleryPage === null ? null : <GalleryPage />),
});
