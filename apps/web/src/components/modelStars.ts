// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type SettingsChange,
  type SettingsSave,
  type FavoriteChanges,
} from "@j3-bots/client-runtime";
import { shownFavorites, starChange } from "@j3-bots/client-runtime/presentation";
import type { ModelChoice, Settings } from "@j3-bots/contracts";

/** The models the operator starred, and how a star is put on one or taken off. */
export interface ModelStars {
  /** In the order they were starred. */
  readonly favorites: ReadonlyArray<ModelChoice>;
  readonly onStar: (choice: ModelChoice, starred: boolean) => void;
}

/**
 * The stars as the model picker shows them, from the settings and their save
 * under way, so a star shows as soon as it is tapped; null from a server that
 * keeps none, where the picker offers no star.
 */
export function modelStarsOf(
  settings: Settings | null,
  save: SettingsSave<FavoriteChanges>,
  update: (change: SettingsChange) => void,
): ModelStars | null {
  const favorites = shownFavorites(settings?.favoriteModels, save);
  if (favorites === null) return null;
  return {
    favorites,
    onStar: (choice, starred) => update(starChange(favorites, choice, starred)),
  };
}
