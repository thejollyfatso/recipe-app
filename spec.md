Build me a PWA (Progressive Web App) recipe and shopping list app. 
It will be hosted on GitHub Pages and should work well on iPhone Safari 
(add to home screen). Use Firebase Firestore for all data storage.

## Core Features

### Recipes
- Add, edit, and delete recipes
- Each recipe has: a title, optional notes, and a list of ingredients
- Each ingredient has: a quantity (if no quantity, a default symbol should be accounted for such as ~), a unit (optional), and a name
- Example: "2 cups flour", "1 tsp salt", "3 eggs", "rice" becomes "~ rice"

### Shopping List
- Any recipe can be added to the shopping list with one tap
- When building the shopping list, ingredients from multiple recipes must 
  be intelligently merged into single entries where they refer to the same 
  ingredient. This must account for:
    - Case differences (Flour vs flour)
    - Pluralisation (egg vs eggs, tomato vs tomatoes)
    - Minor typos or close variants (e.g. "courgette" vs "zuchinni" should 
      NOT merge, but "chilli" vs "chili" should)
  - Where units are compatible, sum the quantities (e.g. 1 cup + 2 cups = 3 cups)
  - Where units differ or cannot be summed, list them separately but consecutively with a note
- Shopping list items can be checked off as purchased
- The shopping list can be cleared
- The shopping list can be copied to clipboard as line separated list, ignoring any items already checked off when copied

### Firebase
- Use Firebase Firestore for storing all recipes and the shopping list
- Include a placeholder in the code for the Firebase config object 
  (I will paste in my own keys)

## Design
- Clean, modern mobile-first UI optimised for iPhone
- Should feel like a native app when added to the home screen
- PWA manifest and service worker so it works offline (reads cached data)

## Output
- All in a single project folder ready to push to GitHub Pages
- Include a README with setup instructions for Firebase and GitHub Pages
