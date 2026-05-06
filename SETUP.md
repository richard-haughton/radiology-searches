# Searches — Web App Setup Guide

This document walks you through deploying the Searches web app using **Netlify Hosting** with **Firebase Auth + Firestore** as the backend.

---

## Prerequisites

- A [Firebase](https://console.firebase.google.com/) account (free Spark plan is sufficient)
- [Node.js](https://nodejs.org/) 18+ (for the Netlify CLI, optional)
- Python 3.9+ with pip (for the optional data migration only)

---

## Step 1 — Create a Firebase Project

1. Go to https://console.firebase.google.com/ and click **Add project**.
2. Name it (e.g. `searches-app`) and follow the wizard.

### Enable Google Authentication
1. **Authentication → Get started → Sign-in method → Google → Enable → Save**.

### Create a Firestore Database
1. **Firestore Database → Create database → Start in production mode → choose a region → Enable**.

### Set Firestore Security Rules
In the Firestore Rules editor, replace the default rules with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Each user can only read/write their own subtree
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Click **Publish**.

---

## Step 2 — Get Firebase Web Config

1. **Project Settings (gear icon) → General → Your apps → Web app → Add app** (or select existing).
2. Copy the `firebaseConfig` object.

---

## Step 3 — Configure the App

Edit `website/js/firebase-config.js` and paste your config values:

```js
const firebaseConfig = {
  apiKey:            "AIza…",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123…"
};
```

---

## Step 4 — Deploy with Netlify

### Option A: Netlify UI (easiest)
1. Go to https://app.netlify.com/ and sign in.
2. Click **Add new site** -> **Deploy manually**.
3. Drag the `website/` folder into the upload area.
4. Netlify will publish and provide a URL like `https://your-site.netlify.app`.

### Option B: Netlify CLI
```bash
npm install -g netlify-cli
cd /path/to/Searches_Export
netlify login
netlify deploy --prod --dir=website
```

### Important: Authorise your Netlify domain in Firebase Auth
Because Auth is still handled by Firebase, add your Netlify host:
1. Firebase Console -> Authentication -> Settings -> Authorized domains
2. Add `your-site.netlify.app` (and any custom domain you use)

### Re-deploy after changes
```bash
netlify deploy --prod --dir=website
```

---

## Step 5 — Migrate Existing Data (Optional)

If you have an existing `.h5` pattern file and/or `study_times.csv`:

```bash
# Install dependencies
pip install firebase-admin h5py pandas

# Get a service account key:
# Firebase Console → Project Settings → Service Accounts → Generate new private key

# Find your UID:
# Firebase Console → Authentication → Users → copy your UID

python migrate_h5_to_firestore.py \
    --h5    ~/.radiology_assistant/radiology_search_patterns.h5 \
    --csv   ~/.radiology_assistant/study_times.csv \
    --uid   YOUR_FIREBASE_UID \
    --creds /path/to/serviceAccountKey.json
```

Run with `--dry-run` first to verify without writing:
```bash
python migrate_h5_to_firestore.py --h5 … --uid … --creds … --dry-run
```

---

## File Structure

```
Searches_Export/
├── netlify.toml                   ← Netlify hosting config (SPA rewrite)
├── firebase.json                  ← Firebase config (backend project)
├── .firebaserc                    ← Firebase project alias (optional)
├── migrate_h5_to_firestore.py     ← One-time data migration script
└── website/                       ← Published via Netlify
    ├── index.html                 ← Single-page app shell
    ├── css/
    │   └── app.css
    ├── js/
    │   ├── firebase-config.js     ← ← YOU MUST EDIT THIS
    │   ├── app.js                 ← Auth + routing
    │   ├── db.js                  ← Firestore data layer
    │   ├── patterns.js            ← Search Patterns tab
    │   ├── editor.js              ← Pattern editor modal
    │   ├── study-log.js           ← Study Log tab
    │   └── calculations.js        ← Calculations tab
    └── images/
        └── icon.png               ← App icon (optional)
```

---

## Keyboard Shortcuts (Search Patterns tab)

| Key | Action |
|-----|--------|
| `→` / `↓` | Next step |
| `←` / `↑` | Previous step |
| `Space` | Open "Record Study" dialog |
| `Ctrl/Cmd+B` (in editor) | Bold text |

---

## Data Model (Firestore)

```
users/{uid}/
  patterns/{patternId}
    name, modality, steps[], updatedAt

  studyLog/{logId}
    study, seconds, duration, rvu, date, timestamp
```

All data is private to the authenticated user — enforced by the Firestore security rules above.

---

## AI Features Setup (Firebase Proxy)

AI generate/rewrite now runs through a Firebase Cloud Function proxy. The OpenAI API key is stored as a backend secret and is never entered in the browser.

### 1) Configure Backend Secret

1. Install Firebase CLI and authenticate.
2. Set the OpenAI key secret for Functions:

```bash
firebase functions:secrets:set OPENAI_API_KEY --project searches-app
```

3. Deploy Functions:

```bash
firebase deploy --only functions --project searches-app
```

### 2) Optional GitHub Actions Deployment

Use the included workflow at `.github/workflows/deploy-firebase-functions.yml`.

1. Create a GitHub repository secret named `FIREBASE_SERVICE_ACCOUNT_SEARCHES_APP`.
2. Value should be the full JSON of a Google service account with Firebase Functions deploy permissions.
3. Push to `main`/`master` (or run workflow manually).

### 3) In-App Usage

1. Sign in to the app.
2. Open **Settings** and use **Test Provider** to confirm backend AI availability.
3. Use AI actions in the Pattern Editor:
- New pattern: generate from selected existing patterns.
- Edit step: rewrite or append with optional tone presets.

### 4) Security Notes

- Browser clients do not store API keys.
- AI requests are sent only to the backend proxy function.
- Rotate key with `firebase functions:secrets:set OPENAI_API_KEY --project searches-app` and redeploy functions.
