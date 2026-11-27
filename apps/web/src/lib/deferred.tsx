// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ComponentType, createElement, lazy, Suspense, useState } from "react";

/**
 * A component whose code is not part of the app's first load: what most
 * sessions never open, or open only once the app is up, such as Settings'
 * pages, a dialog or the first run. Its code is fetched the first time it is
 * wanted, or earlier with `preload`; until it is here the component renders
 * nothing, and it never holds up anything around it. Once loaded, it renders
 * at once, as any other component.
 */
export interface Deferred<P extends object> {
  readonly Component: ComponentType<P>;
  /** Fetches the code ahead, for what the operator is likely to open soon. */
  readonly preload: () => Promise<unknown>;
}

/**
 * `load` fetches the component's code. `wanted` says, from its props, whether
 * it shows anything: a dialog that is always mounted, closed until the
 * operator opens it, renders nothing and fetches nothing until it is first
 * open. After that it stays mounted, so it closes as it opens.
 */
export function deferred<P extends object>(
  load: () => Promise<ComponentType<P>>,
  wanted: (props: P) => boolean = () => true,
): Deferred<P> {
  let loading: Promise<ComponentType<P>> | null = null;
  let loaded: ComponentType<P> | null = null;
  const lazyOne = () => lazy(() => preload().then((component) => ({ default: component })));
  const preload = () =>
    (loading ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        // Fetched again the next time it is wanted: a lazy component keeps
        // its failure, so the next render takes a new one.
        loading = null;
        Lazy = lazyOne();
        throw error;
      },
    ));
  let Lazy = lazyOne();
  function DeferredComponent(props: P) {
    // How it renders, chosen the first time it is wanted and kept: a
    // component that showed while its code was on the way is not mounted
    // again when the code arrives.
    const [shown, setShown] = useState<{ readonly Loaded: ComponentType<P> | null } | null>(null);
    const current = shown ?? (wanted(props) ? { Loaded: loaded } : null);
    if (current === null) return null;
    if (shown === null) setShown(current);
    const { Loaded } = current;
    return Loaded === null ? (
      <Suspense fallback={null}>{createElement(Lazy, props)}</Suspense>
    ) : (
      createElement(Loaded, props)
    );
  }
  return { Component: DeferredComponent, preload };
}

/**
 * Fetches `deferred` components' code once the page has nothing else to do,
 * so what the operator opens first after the app is up opens at once.
 */
export function preloadWhenIdle(...preloads: ReadonlyArray<() => Promise<unknown>>): void {
  const run = () => {
    // One that fails is fetched again when it is opened.
    for (const preload of preloads) preload().catch(() => undefined);
  };
  // Safari has no idle callback.
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}
