// SPDX-License-Identifier: AGPL-3.0-or-later
/** `data-*` attributes, which React accepts on any element but its prop types do not list. */
export type DataAttributes = { readonly [name: `data-${string}`]: string | undefined };
