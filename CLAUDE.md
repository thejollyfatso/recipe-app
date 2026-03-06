# Mama's Kitchen

A PWA recipe and shopping list app. Hosted on GitHub Pages, works offline, installable on iPhone Safari.

## Stack

- Vanilla JS (ES modules, no build step)
- Firebase Firestore (v11.3.0 via CDN) for all data storage and offline persistence
- No framework, no bundler — plain HTML/CSS/JS pushed straight to GitHub Pages

## File Structure

```
index.html          # App shell (minimal HTML, views rendered by JS)
app.js              # All application logic — single ES module
style.css           # All styles
firebase-config.js  # Firebase project credentials (already configured)
manifest.json       # PWA manifest (theme: #E8623A, bg: #FAF8F5)
sw.js               # Service worker — cache-first for app shell, pass-through for Firebase
icon.svg            # App icon
```

## Architecture

All logic lives in `app.js`. Key areas:

- **State**: `state` object holds `recipes[]`, `shoppingList[]`, `addedRecipeIds` (Set), `currentView`, `viewingRecipeId`, `editingRecipeId`
- **Views**: `recipes` | `detail` | `edit` | `shopping` — rendered imperatively via `navigateTo(view, id)`
- **Firestore collections**: `recipes` (ordered by `createdAt desc`), `shoppingList` (ordered by `order asc`), `meta/shoppingMeta` (tracks which recipe IDs have been added)
- **Ingredient merging**: `mergeIngredients()` normalises names (lowercase, singularize, strip articles), uses Levenshtein distance=1 for fuzzy matching (e.g. chili/chilli), sums compatible units
- **Shopping list writes**: always full rewrite via `writeBatch` — delete all existing docs, write new ones, update meta

## Firestore Data Model

- `recipes/{id}`: `{ title, notes, ingredients: [{qty, unit, name}], createdAt, updatedAt }`
- `shoppingList/{id}`: `{ name, normalizedName, quantities: [{qty, unit}], checked, sourceRecipes[], order }`
- `meta/shoppingMeta`: `{ addedRecipeIds: string[] }`

## Ingredient Entry Modes (Recipe Edit)

The ingredients section has a **Manual / Paste Text** toggle (segmented control, `.ing-mode-toggle`):

- **Manual** (default): existing row-per-ingredient UI with qty/unit/name inputs
- **Paste Text**: a textarea where the user pastes a block of text; parsed on switch back to Manual

Switching Manual → Paste Text serialises existing rows back into the textarea.
Switching Paste Text → Manual calls `parseIngredientBlock()`, populates rows, shows a toast with the count.
Saving while in Paste Text mode also calls `parseIngredientBlock()` directly.

Parser (`parseIngredientLine` / `parseIngredientBlock` in `app.js`):
- Strips bullet points, numbered list markers, trailing parentheticals, "to taste" / "as needed"
- Replaces unicode fractions (½ → 1/2 etc.)
- Extracts qty: mixed numbers (1 1/2), fractions (1/2), decimals, "a/an" → 1
- Extracts unit: matches against `INGREDIENT_UNITS` set (cups, tsp, g, oz, cloves, etc.)
- Strips "of" connector ("2 cups of flour" → name = "flour")

## Key Behaviours

- Firebase config check on init — shows setup screen if unconfigured
- Service worker caches app shell; Firestore handles its own IndexedDB offline cache
- When a recipe is edited and it's already in the shopping list, `rebuildShoppingListContribution()` recalculates its contribution
- `escHtml()` used throughout for XSS safety when injecting into innerHTML
- Toast notifications via `showToast(msg)` — auto-dismiss after 2400ms

## Deployment

Push to GitHub Pages (main branch, root folder). No build step needed.
