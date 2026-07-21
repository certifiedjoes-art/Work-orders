# Harder Contracting Work Order Board — Setup Guide

You'll do two things: (1) connect a free real-time database so every phone
stays in sync, and (2) put the files online so you have one link to share.
Takes about 10 minutes total, no coding required.

## Part 1 — Connect Firebase (free, ~5 min)

1. Go to **console.firebase.google.com** and sign in with any Google account.
2. Click **Add project**. Name it anything (e.g. "harder-work-orders"). You
   can skip Google Analytics.
3. Once the project loads, in the left sidebar click **Build → Realtime Database**.
4. Click **Create Database**. Pick any location. Start in **test mode**
   (you can lock it down later — see the note at the bottom).
5. Now click the gear icon (top left, next to "Project Overview") →
   **Project settings**.
6. Scroll to **Your apps** → click the **</> (Web)** icon to register a new
   web app. Give it any nickname. You do NOT need Firebase Hosting.
7. It'll show you a `firebaseConfig` object like this:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "harder-work-orders.firebaseapp.com",
     databaseURL: "https://harder-work-orders-default-rtdb.firebaseio.com",
     projectId: "harder-work-orders",
     storageBucket: "harder-work-orders.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```
8. Copy that whole block.
9. Open **index.html** in any text editor (Notepad, TextEdit, VS Code —
   anything). Find the `firebaseConfig` section near the top (search for
   "YOUR_API_KEY") and replace the placeholder object with the one you copied.
10. Save the file.

## Part 2 — Put it online (free, ~5 min)

You need somewhere to host these 5 files so they have one public link:
`index.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`.

**Easiest option — Netlify Drop:**
1. Go to **app.netlify.com/drop**
2. Sign up free (or log in) if prompted.
3. Drag the whole folder of 5 files onto the page.
4. Netlify gives you a link instantly, like `https://random-name-123.netlify.app`
5. That's your shareable link. Text or email it to your mechanics.

**Alternative — GitHub Pages**, if you already use GitHub:
1. Create a new repository, upload the 5 files.
2. Go to Settings → Pages → set source to your main branch.
3. GitHub gives you a link like `https://yourname.github.io/reponame/`

## Part 3 — Add to home screen

Once mechanics open your link:

- **iPhone (Safari):** tap the Share icon → "Add to Home Screen"
- **Android (Chrome):** tap the ⋮ menu → "Add to Home screen" or "Install app"
- **Windows/Mac/Linux (Chrome or Edge):** click the install icon (⊕ or
  computer icon) in the address bar, or the ⋮ menu → "Install Work Orders"

It'll show up with the orange "H" icon and open full-screen like a native app.

## A note on security

Test mode leaves your database open to anyone with the link for 30 days,
then it locks automatically. For an internal tool this is usually fine
short-term, but if you want it locked down sooner: in Firebase, go to
Realtime Database → Rules, and set:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```
This keeps it open to anyone who has your app's link (no login needed,
matching how the app works today) but stops search engines and randoms
from finding it without the link. For anything more locked-down (e.g.
requiring mechanics to log in), let me know and I can help set that up.
