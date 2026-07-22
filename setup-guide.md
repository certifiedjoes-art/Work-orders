# Harder Contracting Work Order Board — Setup Guide

## Your live app

**https://certifiedjoes-art.github.io/Work-orders/**

This is the link to share with all your mechanics. It's fully set up —
Firebase is connected, so everyone who opens this link sees the same
shared board in real time.

## Add it to your home screen (do this on each phone)

**iPhone (Safari):**
1. Open the link above in Safari
2. Tap the **Share icon** (square with an arrow pointing up)
3. Scroll down, tap **"Add to Home Screen"**
4. Tap **Add**

**Android (Chrome):**
1. Open the link in Chrome
2. Tap the **⋮ menu** (top right)
3. Tap **"Add to Home screen"** or **"Install app"**

**Windows/Mac/Linux (Chrome or Edge):**
1. Open the link
2. Click the install icon in the address bar, or the **⋮** menu → **"Install"**

Once added, it opens full-screen with the orange "H" icon like a normal app.

## Sharing with your employees

Just text, email, or AirDrop them this link:
**https://certifiedjoes-art.github.io/Work-orders/**

They open it and do the same "Add to Home Screen" step above. Everyone
sees the same board update live.

## Making changes to the app later

You do **not** need to redo the Firebase setup again — that's done for
good. Your data lives in Firebase, separate from the app files.

When you want a change (new feature, different colors, new field, etc.):

1. Ask me (Claude) to make the change
2. I'll hand you an updated `index.html` file (and occasionally an updated
   `manifest.json` or `sw.js`, if needed — I'll tell you which changed)
3. Go to **github.com**, log in, open your **Work-orders** repository
4. Tap **"Add file" → "Upload files"** (same as before)
5. Select the new file(s) — GitHub will ask if you want to replace the
   existing one, confirm yes
6. Scroll down, tap **"Commit changes"**
7. Wait about a minute — your link stays exactly the same, nothing to
   re-share with your team

## Your accounts

- **GitHub repository:** certifiedjoes-art / Work-orders
- **Firebase project:** harder-contracting (Realtime Database, free tier)

You generally won't need to touch Firebase again unless you want to add
things like a login/password step later — just ask if you ever want that.

### A note on security

Your database currently allows anyone with your app's link to read and
write data (no login required) — this matches how the app works today,
where mechanics just pick their name from a list. Fine for an internal
tool, but be mindful about who you share the link with. If you ever want
it locked down further, let me know and we can add that.

## PIN codes & Face ID / Touch ID

Each mechanic sets a 4-digit PIN the first time they tap their name (existing
mechanics will be asked to set one the next time they sign in too). This
keeps people from accidentally tapping into a coworker's name on the shared
tablet.

On a mechanic's own phone, after entering their PIN once, they'll be offered
the option to use Face ID / Touch ID instead next time — this is a
per-device shortcut only, not shared across phones. It can be turned on or
off anytime from "Enable/Turn off Face ID" on the board.

**Forgot a PIN?** Tap their name, then "Forgot PIN? Reset it" — this clears
their PIN and lets them set a new one immediately. There's no email/password
recovery since the app doesn't use accounts.

**Honest security note:** this is a convenience/deterrence feature, not
full-strength security — the database itself doesn't require login to reach
directly. It's meant to prevent mix-ups on a shared device, not to defend
against someone determined to get in another way.

## Team management (admin only)

Joe is set up as the first admin. Admins see a "⚙️ Team" button on the
dashboard where they can:
- Promote/demote other admins
- Remove someone from the team (e.g. when employment ends) — this removes
  their name and PIN so they can no longer sign in, but keeps all their
  past work orders on record for history

You can't remove or demote yourself from the Team screen (to avoid
accidentally locking yourself out) — ask another admin if you ever need
that changed.

## Editable checklists

All checklists — including the built-in machine ones (Buncher, Excavator,
Crawler, Processor, Skidder) — can now be edited from the Checklists page.
Tap "Edit" on any checklist to change its name or steps.

## Offline support

The app now works with no signal at all:
- The app itself (not just your data) loads even with zero connection,
  once it's been opened at least once with a connection first
- Your existing work orders, machines, and checklists are still visible
  offline (from the last time the app synced)
- Changes you make offline are queued by Firebase and sync automatically
  once you're back in range — **as long as you don't fully close the app
  before reconnecting**. If you do force-close it while offline, that one
  unsaved change may need to be re-entered once you're back online.

**Important for future updates**: this update added a file called `sw.js`
that helps the app work offline. From now on, whenever I hand you an
updated `index.html`, I'll also bump a version number inside `sw.js` —
**always upload both files together** when I mention `sw.js` changed, or
phones can get stuck on an old cached version again.

## Timesheets

Every mechanic gets a "⏱️ Time Clock" button on the dashboard to:
- Clock in / clock out for the day
- Start/end a lunch break
- Log which units or jobs they worked on with hours (free text — works for
  unit numbers, "Labour," "Shop cleanup," anything)
- Edit their own past shifts if they made a mistake

**Mechanics can only see their own timesheet** — there's no way for them
to view anyone else's hours.

**Admins** (just Joe right now) get a separate "📊 Timesheets" screen to:
- View everyone's shifts, filterable by person and date range
- See total hours per person
- Tap "Export & Share" to generate a CSV and open the share sheet
  (choose Mail, and it'll come through as an attachment ready to send)

There's also an email address field and an "automatic weekly email"
toggle in that screen — the toggle is there and ready, but actually
sending automatically needs one more setup step (a small backend + email
service) whenever you're ready to take that on.

**One rule mechanics need to know**: the app won't let them clock out for
the day without either logging a lunch break or confirming they worked
through it — a popup handles this automatically.
