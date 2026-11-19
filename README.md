# Harder Contracting work order app

Work orders, timesheets, production shifts, driver logs and approvals for the crew. One large React file plus a Firebase database, hosted on GitHub Pages.

Live site: https://certifiedjoes-art.github.io/Work-orders/

## Files that matter

- `index-source.html` — the app. This is the file you edit.
- `index.html` — the compiled copy the site actually runs. Never edit by hand; generate it with the build.
- `sw.js` — service worker. Raise the number in `CACHE_NAME` on every release so phones fetch the new copy.
- `build.js`, `package.json` — the build.
- `cloud-run-index.js` — the server job (emailed reports, backups, translation, receipt reading, Samsara lookups). Runs on Google Cloud Run; keys are environment variables there, not in this code.

## Making a change

1. Edit `index-source.html`.
2. Raise `CACHE_NAME` in `sw.js`.
3. Build (needs Node 20.19 or newer):
   ```
   npm install     # once
   npm run build
   ```
   The build refuses to finish if the output contains `require(` or `jsx-dev-runtime`. That means the wrong React runtime was used and the app would crash on load. Keep `runtime: 'classic'` in `build.js`.
4. Open `index.html` and try it on a phone.
5. Commit `index-source.html`, `index.html` and `sw.js`, then push to `main`. The site updates in a minute or two; crews may need to close and reopen the app.

## Where things live

- Database and logins: Firebase project `harder-contracting` (Realtime Database).
- Report email: Resend, sending from reports@hardercontracting.ca.
- Machine location and hours: Samsara. Translation: Google Translate. Receipt photo reading: Anthropic API.
- Camp iPads run a cached older copy on purpose; they update from a button in the app.

Release notes and how each feature works are in `SUMMARY-FOR-NEXT-CHAT.md`, included in each release zip.
