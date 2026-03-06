# Mama's Kitchen

A PWA recipe and shopping list app — works offline, installable on iPhone via "Add to Home Screen", backed by Firebase Firestore.

## Setup

### 1. Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/) and open your project (or create one).
2. Enable **Firestore Database** (Build > Firestore Database > Create database). Start in **production mode**.
3. Set Firestore rules to allow reads/writes (for personal use, open rules are fine):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```

4. Your Firebase config is already set in `firebase-config.js`. If you need to change projects, update the values there.

### 2. GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings > Pages**.
3. Set **Source** to `Deploy from a branch`, branch `main`, folder `/ (root)`.
4. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

### 3. iOS Home Screen Icon (optional)

For a proper high-res icon on iPhone, generate PNG files from `icon.svg`:

- `icon-192.png` — 192×192 px
- `icon-512.png` — 512×512 px

You can use any SVG-to-PNG converter, e.g. [svgtopng.com](https://svgtopng.com/) or Inkscape. Place the PNGs in the root folder alongside `icon.svg`.

## Features

- **Recipes** — add, edit, delete with title, notes, and a flexible ingredient list (quantity, unit, name)
- **Shopping list** — add any recipe with one tap; ingredients are intelligently merged (same ingredient sums quantities, handles plural/case differences and close variants like "chili"/"chilli")
- **Offline** — service worker caches the app shell; Firestore IndexedDB persistence keeps data available offline
- **PWA** — add to iPhone home screen for a full-screen native-like experience

## File Structure

```
/
├── index.html          # App shell
├── app.js              # All application logic (ES module)
├── style.css           # Styles
├── firebase-config.js  # Firebase project config
├── manifest.json       # PWA manifest
├── sw.js               # Service worker
├── icon.svg            # App icon (SVG)
└── README.md
```
