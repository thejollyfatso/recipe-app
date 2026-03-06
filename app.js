import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-app.js';
import {
  getFirestore,
  enableIndexedDbPersistence,
  collection, doc,
  addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// ============================================================
// Firebase init
// ============================================================
const isConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR_');
let db;

if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  enableIndexedDbPersistence(db).catch(() => {});
}

// ============================================================
// State
// ============================================================
const state = {
  recipes: [],
  shoppingList: [],
  addedRecipeIds: new Set(),
  currentView: 'recipes', // 'recipes' | 'detail' | 'edit' | 'shopping'
  viewingRecipeId: null,
  editingRecipeId: null,   // null = new recipe
};

// Firestore unsubscribe handles
let unsubRecipes = null;
let unsubShopping = null;
let unsubMeta = null;

// ============================================================
// Ingredient merging utilities
// ============================================================
function singularize(word) {
  const irregulars = {
    leaves: 'leaf', halves: 'half', knives: 'knife', loaves: 'loaf',
    wolves: 'wolf', tomatoes: 'tomato', potatoes: 'potato',
    berries: 'berry', cherries: 'cherry', raspberries: 'raspberry',
    strawberries: 'strawberry', blueberries: 'blueberry',
  };
  if (irregulars[word]) return irregulars[word];
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ves') && word.length > 3) return word.slice(0, -3) + 'f';
  if (word.endsWith('es') && word.length > 4) {
    const stem = word.slice(0, -2);
    if (/[sxz]$/.test(stem) || /[cs]h$/.test(stem)) return stem;
    return word.slice(0, -1);
  }
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function normalizeIngredientName(name) {
  let n = name.toLowerCase().trim();
  n = n.replace(/^(a |an |the )/, '');
  n = singularize(n);
  return n;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let j = 1; j <= m; j++) {
    let prev = j;
    for (let i = 1; i <= n; i++) {
      const val = b[i - 1] === a[j - 1]
        ? dp[i - 1]
        : Math.min(dp[i - 1], dp[i], prev) + 1;
      dp[i - 1] = prev;
      prev = val;
    }
    dp[n] = prev;
  }
  return dp[n];
}

function ingredientsMatch(a, b) {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  // Allow 1 edit for words of 4+ chars (catches "chilli" vs "chili")
  // but require same length ±1 to avoid false positives
  if (maxLen < 4) return false;
  return levenshtein(a, b) === 1;
}

function parseQty(qtyStr) {
  if (!qtyStr || qtyStr.trim() === '' || qtyStr.trim() === '~') return null;
  const s = qtyStr.trim();
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  return parseFloat(s) || null;
}

function formatQty(num) {
  if (num === null || num === undefined) return '';
  const FRACS = { 0.25: '\u00BC', 0.5: '\u00BD', 0.75: '\u00BE', 0.333: '\u2153', 0.667: '\u2154', 0.125: '\u215B' };
  const rounded = Math.round(num * 1000) / 1000;
  const whole = Math.floor(rounded);
  const decimal = Math.round((rounded - whole) * 1000) / 1000;
  const fracChar = FRACS[Math.round(decimal * 1000) / 1000];
  if (fracChar) return whole > 0 ? `${whole}\u202F${fracChar}` : fracChar;
  // Nice decimals
  if (rounded === Math.floor(rounded)) return String(Math.floor(rounded));
  return String(Math.round(rounded * 100) / 100);
}

function formatIngredientDisplay(qty, unit, name) {
  const qtyNum = parseQty(qty);
  const qtyStr = qtyNum !== null ? formatQty(qtyNum) : '~';
  const unitStr = unit ? ` ${unit}` : '';
  return { qty: `${qtyStr}${unitStr}`, name };
}

function mergeIngredients(existingItems, newIngredients, recipeId) {
  const result = existingItems.map(item => ({
    ...item,
    quantities: item.quantities.map(q => ({ ...q })),
    sourceRecipes: [...(item.sourceRecipes || [])],
  }));

  for (const ing of newIngredients) {
    const normalized = normalizeIngredientName(ing.name);
    const qty = parseQty(ing.qty);
    const unit = (ing.unit || '').toLowerCase().trim();

    const matchIdx = result.findIndex(item =>
      ingredientsMatch(item.normalizedName, normalized)
    );

    if (matchIdx === -1) {
      result.push({
        name: ing.name,
        normalizedName: normalized,
        quantities: [{ qty, unit }],
        checked: false,
        sourceRecipes: [recipeId],
      });
    } else {
      const item = result[matchIdx];
      if (!item.sourceRecipes.includes(recipeId)) item.sourceRecipes.push(recipeId);
      const existingQtyIdx = item.quantities.findIndex(q => q.unit === unit);
      if (existingQtyIdx !== -1 && qty !== null && item.quantities[existingQtyIdx].qty !== null) {
        item.quantities[existingQtyIdx].qty += qty;
      } else {
        item.quantities.push({ qty, unit });
      }
    }
  }

  return result;
}

function formatShoppingItem(item) {
  const parts = item.quantities.map(({ qty, unit }) => {
    const qStr = qty !== null ? formatQty(qty) : '~';
    return unit ? `${qStr} ${unit}` : qStr;
  });
  return parts.join(' + ');
}

// ============================================================
// Ingredient text parser (auto-entry mode)
// ============================================================
const INGREDIENT_UNITS = new Set([
  'cup','cups','tablespoon','tablespoons','tbsp','tbs',
  'teaspoon','teaspoons','tsp','ounce','ounces','oz',
  'pound','pounds','lb','lbs','gram','grams','g',
  'kilogram','kilograms','kg','milliliter','milliliters','ml',
  'liter','liters','l','pint','pints','pt','quart','quarts','qt',
  'gallon','gallons','gal','piece','pieces','pc','pcs',
  'slice','slices','clove','cloves','sprig','sprigs',
  'bunch','bunches','head','heads','stalk','stalks',
  'can','cans','package','packages','pkg','pinch','pinches',
  'dash','dashes','handful','handfuls','sheet','sheets',
]);

function parseIngredientLine(line) {
  let s = line.trim();
  // Strip bullet points and numbered list markers
  s = s.replace(/^[-•*·]\s*/, '').replace(/^\d+\.\s+/, '');
  if (!s) return null;

  // Replace unicode fractions with ASCII equivalents
  s = s.replace(/½/g,'1/2').replace(/⅓/g,'1/3').replace(/⅔/g,'2/3')
       .replace(/¼/g,'1/4').replace(/¾/g,'3/4').replace(/⅛/g,'1/8');

  // Remove trailing parenthetical notes and common trailing phrases
  s = s.replace(/\s*\(.*?\)\s*$/, '').trim();
  s = s.replace(/,?\s*(to taste|or to taste|as needed|as required)$/i, '').trim();

  let qty = '';
  let rest = s;

  // Match leading quantity: mixed number (1 1/2), fraction (1/2), or decimal/integer
  const qtyMatch = rest.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)\s*/);
  if (qtyMatch) {
    qty = qtyMatch[1].trim();
    rest = rest.slice(qtyMatch[0].length);
  } else if (/^an?\s+/i.test(rest)) {
    qty = '1';
    rest = rest.replace(/^an?\s+/i, '');
  }

  // Match unit (first word if it's a known unit)
  let unit = '';
  const firstWord = (rest.split(/\s+/)[0] || '').toLowerCase().replace(/[.,;]$/, '');
  if (INGREDIENT_UNITS.has(firstWord)) {
    unit = firstWord;
    rest = rest.slice(firstWord.length).trim();
  }

  // Strip "of" connector (e.g. "2 cups of flour" → name = "flour")
  rest = rest.replace(/^of\s+/i, '');

  const name = rest.trim();
  if (!name) return null;
  return { qty, unit, name };
}

function parseIngredientBlock(text) {
  return text.split('\n').map(parseIngredientLine).filter(Boolean);
}

// ============================================================
// DOM helpers
// ============================================================
const $ = id => document.getElementById(id);

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function setHeader({ title, showBack = false, actions = [] }) {
  $('header-title').textContent = title;
  const backBtn = $('back-btn');
  backBtn.classList.toggle('hidden', !showBack);
  const actionsEl = $('header-actions');
  actionsEl.innerHTML = '';
  for (const { label, handler, cls } of actions) {
    const btn = document.createElement('button');
    btn.className = `header-btn${cls ? ' ' + cls : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    actionsEl.appendChild(btn);
  }
}

// ============================================================
// Navigation
// ============================================================
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(`view-${viewId}`).classList.remove('hidden');

  const fab = $('fab-add');
  fab.classList.toggle('hidden', viewId !== 'recipes');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === (viewId === 'recipes' || viewId === 'detail' || viewId === 'edit' ? 'recipes' : 'shopping'));
  });
}

function goBack() {
  if (state.currentView === 'detail' || state.currentView === 'edit') {
    navigateTo('recipes');
  }
}

function navigateTo(view, id = null) {
  state.currentView = view;
  if (view === 'recipes') {
    state.viewingRecipeId = null;
    state.editingRecipeId = null;
    renderRecipesList();
    setHeader({ title: "Mama's Kitchen" });
    showView('recipes');
  } else if (view === 'detail') {
    state.viewingRecipeId = id;
    renderRecipeDetail(id);
    showView('recipe-detail');
  } else if (view === 'edit') {
    state.editingRecipeId = id; // null = new
    renderRecipeEdit(id);
    showView('recipe-edit');
  } else if (view === 'shopping') {
    renderShoppingList();
    showView('shopping');
  }
}

// ============================================================
// Render: Recipes List
// ============================================================
function renderRecipesList() {
  setHeader({ title: "Mama's Kitchen" });
  const container = $('recipes-list');
  if (!state.recipes.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#127859;</div>
        <p>No recipes yet.<br>Tap <strong>+</strong> to add your first one.</p>
      </div>`;
    return;
  }
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'recipes-grid';
  for (const recipe of state.recipes) {
    const card = document.createElement('div');
    card.className = 'recipe-card';
    const ingCount = recipe.ingredients?.length || 0;
    card.innerHTML = `
      <div class="recipe-card-body">
        <div class="recipe-card-title">${escHtml(recipe.title)}</div>
        <div class="recipe-card-meta">${ingCount} ingredient${ingCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="recipe-card-arrow">&#8250;</div>`;
    card.addEventListener('click', () => navigateTo('detail', recipe.id));
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

// ============================================================
// Render: Recipe Detail
// ============================================================
function renderRecipeDetail(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) { navigateTo('recipes'); return; }

  const isAdded = state.addedRecipeIds.has(id);

  setHeader({
    title: recipe.title,
    showBack: true,
    actions: [{ label: 'Edit', handler: () => navigateTo('edit', id) }],
  });

  const view = $('view-recipe-detail');
  const ingHtml = (recipe.ingredients || []).map(ing => {
    const { qty, name } = formatIngredientDisplay(ing.qty, ing.unit, ing.name);
    return `<div class="ingredient-item">
      <span class="ingredient-qty">${escHtml(qty)}</span>
      <span class="ingredient-name">${escHtml(name)}</span>
    </div>`;
  }).join('');

  view.innerHTML = `
    <div class="detail-hero">
      <div class="detail-title">${escHtml(recipe.title)}</div>
      ${recipe.notes ? `<div class="detail-notes">${escHtml(recipe.notes)}</div>` : ''}
    </div>
    <div class="detail-section">
      <div class="section-title">Ingredients</div>
      <div class="ingredient-list">
        ${ingHtml || '<p style="color:var(--color-text-secondary);font-size:14px">No ingredients added.</p>'}
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn-primary ${isAdded ? 'added' : ''}" id="add-to-shopping-btn">
        ${isAdded ? '&#10003; In Shopping List' : '&#43; Add to Shopping List'}
      </button>
    </div>`;

  $('add-to-shopping-btn').addEventListener('click', () => addRecipeToShoppingList(id));
}

// ============================================================
// Render: Recipe Edit
// ============================================================
function renderRecipeEdit(id) {
  const recipe = id ? state.recipes.find(r => r.id === id) : null;
  const isNew = !recipe;

  setHeader({
    title: isNew ? 'New Recipe' : 'Edit Recipe',
    showBack: true,
  });

  const view = $('view-recipe-edit');
  view.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="input-title">Recipe Name</label>
      <input class="form-input" id="input-title" type="text" placeholder="e.g. Spaghetti Bolognese"
        value="${escHtml(recipe?.title || '')}" autocomplete="off" />
    </div>
    <div class="form-group">
      <label class="form-label" for="input-notes">Notes <span style="font-weight:400;text-transform:none">(optional)</span></label>
      <textarea class="form-input" id="input-notes" placeholder="Cooking time, tips, serving suggestions...">${escHtml(recipe?.notes || '')}</textarea>
    </div>
    <div class="form-group">
      <div class="ing-mode-header">
        <label class="form-label">Ingredients</label>
        <div class="ing-mode-toggle">
          <button type="button" class="ing-mode-btn active" data-mode="manual">Manual</button>
          <button type="button" class="ing-mode-btn" data-mode="auto">Paste Text</button>
        </div>
      </div>
      <div id="ing-manual-section">
        <div class="ingredients-editor" id="ingredients-editor"></div>
        <button type="button" class="btn-add-ingredient" id="btn-add-ingredient">
          <span>&#43;</span> Add Ingredient
        </button>
      </div>
      <div id="ing-auto-section" class="hidden">
        <textarea class="form-input ing-auto-textarea" id="ing-auto-text"
          placeholder="Paste your ingredient list here, one per line.&#10;&#10;e.g.&#10;2 cups flour&#10;1 tsp salt&#10;3 eggs&#10;500g chicken breast"></textarea>
        <p class="ing-auto-hint">Switch to Manual to review and edit parsed ingredients.</p>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" id="btn-save-recipe">Save Recipe</button>
      ${!isNew ? `<button class="btn-danger" id="btn-delete-recipe">Delete Recipe</button>` : ''}
    </div>`;

  const editor = $('ingredients-editor');

  function addIngredientRow(qty = '', unit = '', name = '') {
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <input class="ing-qty" type="text" inputmode="decimal" placeholder="qty" value="${escHtml(qty)}" />
      <span class="ing-sep">&middot;</span>
      <input class="ing-unit" type="text" placeholder="unit" value="${escHtml(unit)}" />
      <span class="ing-sep">&middot;</span>
      <input class="ing-name" type="text" placeholder="ingredient name" value="${escHtml(name)}" />
      <button type="button" class="ing-remove-btn" aria-label="Remove">&#215;</button>`;
    row.querySelector('.ing-remove-btn').addEventListener('click', () => row.remove());
    editor.appendChild(row);
  }

  const ingredients = recipe?.ingredients || [];
  if (ingredients.length) {
    ingredients.forEach(ing => addIngredientRow(ing.qty, ing.unit, ing.name));
  } else {
    addIngredientRow();
  }

  $('btn-add-ingredient').addEventListener('click', () => {
    addIngredientRow();
    const rows = editor.querySelectorAll('.ingredient-row');
    rows[rows.length - 1].querySelector('.ing-name').focus();
  });

  // Ingredient entry mode toggle
  let currentMode = 'manual';
  document.querySelectorAll('.ing-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode;
      if (newMode === currentMode) return;

      if (newMode === 'auto') {
        // Serialize current manual rows into the textarea
        const rows = editor.querySelectorAll('.ingredient-row');
        const lines = [];
        for (const row of rows) {
          const q = row.querySelector('.ing-qty').value.trim();
          const u = row.querySelector('.ing-unit').value.trim();
          const n = row.querySelector('.ing-name').value.trim();
          if (n) lines.push([q, u, n].filter(Boolean).join(' '));
        }
        $('ing-auto-text').value = lines.join('\n');
        $('ing-manual-section').classList.add('hidden');
        $('ing-auto-section').classList.remove('hidden');
        $('ing-auto-text').focus();
      } else {
        // Parse textarea content into manual rows
        const parsed = parseIngredientBlock($('ing-auto-text').value);
        editor.innerHTML = '';
        if (parsed.length) {
          parsed.forEach(ing => addIngredientRow(ing.qty, ing.unit, ing.name));
          showToast(`${parsed.length} ingredient${parsed.length !== 1 ? 's' : ''} parsed`);
        } else {
          addIngredientRow();
        }
        $('ing-auto-section').classList.add('hidden');
        $('ing-manual-section').classList.remove('hidden');
      }

      currentMode = newMode;
      document.querySelectorAll('.ing-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === newMode);
      });
    });
  });

  $('btn-save-recipe').addEventListener('click', () => saveRecipe(id));

  if (!isNew) {
    $('btn-delete-recipe').addEventListener('click', () => deleteRecipe(id));
  }
}

// ============================================================
// Render: Shopping List
// ============================================================
function renderShoppingList() {
  const unchecked = state.shoppingList.filter(i => !i.checked);
  const checked = state.shoppingList.filter(i => i.checked);

  setHeader({
    title: 'Shopping List',
    actions: [
      ...(state.shoppingList.length > 0 ? [{ label: 'Copy', handler: copyShoppingList }] : []),
      ...(state.shoppingList.length > 0 ? [{ label: 'Clear', handler: clearShoppingList, cls: 'danger' }] : []),
    ],
  });

  const view = $('view-shopping');

  if (!state.shoppingList.length) {
    view.innerHTML = `
      <div class="shopping-empty">
        <div class="empty-icon">&#128722;</div>
        <p>Your shopping list is empty.<br>Add a recipe to get started.</p>
      </div>`;
    return;
  }

  view.innerHTML = '<div class="shopping-items" id="shopping-items"></div>';
  const container = $('shopping-items');

  const renderItem = (item) => {
    const el = document.createElement('div');
    el.className = `shopping-item${item.checked ? ' checked' : ''}`;
    const qtyDisplay = formatShoppingItem(item);
    const hasMultipleUnits = item.quantities.length > 1;
    el.innerHTML = `
      <div class="check-box">
        <span class="check-mark">&#10003;</span>
      </div>
      <div class="shopping-item-text">
        <div class="shopping-item-qty">${escHtml(qtyDisplay)}</div>
        <div class="shopping-item-name">${escHtml(item.name)}</div>
        ${hasMultipleUnits ? `<div class="shopping-item-note">combined from multiple recipes</div>` : ''}
      </div>`;
    el.addEventListener('click', () => toggleShoppingItem(item.id, !item.checked));
    container.appendChild(el);
  };

  unchecked.forEach(renderItem);
  if (checked.length && unchecked.length) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    divider.style.margin = '8px 0';
    container.appendChild(divider);
  }
  checked.forEach(renderItem);
}

// ============================================================
// Firebase: Recipes CRUD
// ============================================================
function startListeners() {
  // Recipes listener
  unsubRecipes = onSnapshot(
    query(collection(db, 'recipes'), orderBy('createdAt', 'desc')),
    (snap) => {
      state.recipes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (state.currentView === 'recipes') renderRecipesList();
      if (state.currentView === 'detail') renderRecipeDetail(state.viewingRecipeId);
    },
    (err) => console.error('Recipes listener error:', err)
  );

  // Shopping list listener
  unsubShopping = onSnapshot(
    query(collection(db, 'shoppingList'), orderBy('order', 'asc')),
    (snap) => {
      state.shoppingList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (state.currentView === 'shopping') renderShoppingList();
    },
    (err) => console.error('Shopping listener error:', err)
  );

  // Meta (added recipe IDs)
  unsubMeta = onSnapshot(doc(db, 'meta', 'shoppingMeta'), (snap) => {
    if (snap.exists()) {
      state.addedRecipeIds = new Set(snap.data().addedRecipeIds || []);
    } else {
      state.addedRecipeIds = new Set();
    }
    if (state.currentView === 'detail') renderRecipeDetail(state.viewingRecipeId);
  });
}

async function saveRecipe(id) {
  const title = $('input-title').value.trim();
  if (!title) { showToast('Please enter a recipe name'); return; }

  let ingredients = [];
  const autoSection = $('ing-auto-section');
  if (autoSection && !autoSection.classList.contains('hidden')) {
    ingredients = parseIngredientBlock($('ing-auto-text').value);
  } else {
    const rows = $('ingredients-editor').querySelectorAll('.ingredient-row');
    for (const row of rows) {
      const name = row.querySelector('.ing-name').value.trim();
      if (!name) continue;
      ingredients.push({
        qty: row.querySelector('.ing-qty').value.trim(),
        unit: row.querySelector('.ing-unit').value.trim(),
        name,
      });
    }
  }

  const btn = $('btn-save-recipe');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const data = {
      title,
      notes: $('input-notes').value.trim(),
      ingredients,
      updatedAt: serverTimestamp(),
    };

    if (id) {
      await updateDoc(doc(db, 'recipes', id), data);
      // If this recipe is in the shopping list, recalculate its contribution
      if (state.addedRecipeIds.has(id)) {
        await rebuildShoppingListContribution(id, ingredients);
      }
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, 'recipes'), data);
    }

    navigateTo('recipes');
  } catch (err) {
    console.error(err);
    showToast('Error saving recipe');
    btn.disabled = false;
    btn.textContent = 'Save Recipe';
  }
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe?')) return;
  try {
    await deleteDoc(doc(db, 'recipes', id));
    // Remove from shopping list if present
    if (state.addedRecipeIds.has(id)) {
      await removeRecipeFromShoppingList(id);
    }
    navigateTo('recipes');
  } catch (err) {
    console.error(err);
    showToast('Error deleting recipe');
  }
}

// ============================================================
// Firebase: Shopping List
// ============================================================
async function addRecipeToShoppingList(recipeId) {
  const recipe = state.recipes.find(r => r.id === recipeId);
  if (!recipe) return;

  if (state.addedRecipeIds.has(recipeId)) {
    showToast('Already in shopping list');
    return;
  }

  const btn = $('add-to-shopping-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

  try {
    const merged = mergeIngredients(state.shoppingList, recipe.ingredients || [], recipeId);
    await writeShoppingList(merged, [...state.addedRecipeIds, recipeId]);
    showToast(`"${recipe.title}" added to list`);
    renderRecipeDetail(recipeId);
  } catch (err) {
    console.error(err);
    showToast('Error updating shopping list');
    if (btn) { btn.disabled = false; btn.textContent = '+ Add to Shopping List'; }
  }
}

async function removeRecipeFromShoppingList(recipeId) {
  const newAddedIds = [...state.addedRecipeIds].filter(id => id !== recipeId);
  // Rebuild shopping list from scratch using remaining added recipes
  let items = [];
  for (const rId of newAddedIds) {
    const recipe = state.recipes.find(r => r.id === rId);
    if (recipe) items = mergeIngredients(items, recipe.ingredients || [], rId);
  }
  // Preserve checked state
  items = items.map(item => {
    const existing = state.shoppingList.find(e => e.normalizedName === item.normalizedName);
    return { ...item, checked: existing?.checked || false };
  });
  await writeShoppingList(items, newAddedIds);
}

async function rebuildShoppingListContribution(recipeId, newIngredients) {
  const addedIds = [...state.addedRecipeIds];
  let items = [];
  for (const rId of addedIds) {
    const ings = rId === recipeId ? newIngredients : state.recipes.find(r => r.id === rId)?.ingredients || [];
    items = mergeIngredients(items, ings, rId);
  }
  items = items.map(item => {
    const existing = state.shoppingList.find(e => e.normalizedName === item.normalizedName);
    return { ...item, checked: existing?.checked || false };
  });
  await writeShoppingList(items, addedIds);
}

async function writeShoppingList(items, addedRecipeIds) {
  const batch = writeBatch(db);

  // Delete existing shopping list docs
  for (const item of state.shoppingList) {
    batch.delete(doc(db, 'shoppingList', item.id));
  }

  // Write new items
  items.forEach((item, i) => {
    const ref = doc(collection(db, 'shoppingList'));
    const { id: _id, ...data } = item;
    batch.set(ref, { ...data, order: i });
  });

  // Update meta
  batch.set(doc(db, 'meta', 'shoppingMeta'), { addedRecipeIds });

  await batch.commit();
}

async function toggleShoppingItem(itemId, checked) {
  try {
    await updateDoc(doc(db, 'shoppingList', itemId), { checked });
  } catch (err) {
    console.error(err);
  }
}

async function clearShoppingList() {
  if (!confirm('Clear the entire shopping list?')) return;
  try {
    const batch = writeBatch(db);
    for (const item of state.shoppingList) {
      batch.delete(doc(db, 'shoppingList', item.id));
    }
    batch.set(doc(db, 'meta', 'shoppingMeta'), { addedRecipeIds: [] });
    await batch.commit();
  } catch (err) {
    console.error(err);
    showToast('Error clearing list');
  }
}

function copyShoppingList() {
  const unchecked = state.shoppingList.filter(i => !i.checked);
  if (!unchecked.length) { showToast('Nothing to copy (all checked off)'); return; }
  const text = unchecked.map(item => {
    const qty = formatShoppingItem(item);
    return `${qty} ${item.name}`;
  }).join('\n');
  navigator.clipboard.writeText(text).then(
    () => showToast('Copied to clipboard'),
    () => showToast('Could not copy')
  );
}

// ============================================================
// Utility
// ============================================================
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Init
// ============================================================
function initApp() {
  if (!isConfigured) {
    document.body.innerHTML = `
      <div id="setup-screen">
        <h1>Setup Required</h1>
        <p>Open <strong>firebase-config.js</strong> and replace the placeholder values with your Firebase project config.</p>
        <code>apiKey: "YOUR_API_KEY",<br>projectId: "YOUR_PROJECT_ID",<br>...</code>
        <p>See README.md for step-by-step instructions.</p>
      </div>`;
    return;
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Wire up navigation buttons
  $('back-btn').addEventListener('click', goBack);
  $('fab-add').addEventListener('click', () => navigateTo('edit', null));

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      state.currentView = v;
      navigateTo(v);
    });
  });

  // Start Firestore listeners and show initial view
  startListeners();
  navigateTo('recipes');
}

document.addEventListener('DOMContentLoaded', initApp);
