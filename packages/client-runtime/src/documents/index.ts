// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Documents a conversation carries, read on the device that shows them:
 * which files show in the app's own viewer, and what each holds as a model
 * the app draws with its own components (`DocumentContent`).
 */
export { documentKind, type DocumentKind } from "./kinds.ts";
export { CARD_PREVIEW_MAX_SIZE, DOCUMENT_LIMITS } from "./limits.ts";
export {
  Block,
  DocumentContent,
  DocumentImage,
  DocumentImageType,
  DocumentRead,
  Run,
  Sheet,
  Slide,
} from "./model.ts";
export { type DocumentFacts, factsOf, readDocument, type ReadKind } from "./read.ts";
