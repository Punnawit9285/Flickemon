# Cross-Device Sync — Setup

Sync is fully implemented but **inert until you complete these steps**. Until then the
game works exactly as before, saving locally only, and Settings shows
*"Not configured"*.

Do them in order — step 2 must happen before step 3.

---

## 1. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**
3. **Build → Firestore Database → Create database** (start in production mode)

## 2. Pin the extension ID ⚠️ do this before step 3

`chrome.identity` requires a **fixed** extension ID, but unpacked extensions get a
new one on every load. Pin it:

1. Package the extension once: `chrome://extensions` → **Pack extension** → select
   this folder. That produces a `.pem` private key file — **keep it, never commit it**.
2. Get the public key:
   ```sh
   openssl rsa -in your-key.pem -pubout -outform DER | openssl base64 -A
   ```
3. Paste it into `manifest.json` as a top-level `"key"` field:
   ```json
   "key": "MIIBIjANBgkqh...",
   ```
4. Reload the extension and copy its now-permanent ID from `chrome://extensions`.

> Alternative: publish to the Chrome Web Store first and use the ID it assigns.

## 3. Set up the OAuth client

Auth uses `chrome.identity.launchWebAuthFlow`, which needs a **Web application**
OAuth client — *not* a Chrome Extension one. (`getAuthToken` was replaced because
it can only offer accounts already signed into the Chrome profile, so a student
whose Chrome holds a personal Gmail could never reach their faculty account.)

Firebase already created a web client for this project, so the quickest path is
to reuse it:

1. <https://console.cloud.google.com/apis/credentials> → open the **Web client**
   (auto created by Google Service)
2. Under **Authorized redirect URIs** → **+ Add URI**. ⚠️ **Add both** — see
   below for why one is not enough:
   ```
   https://joaglgcgbblaoiioeebpjlbjlahiagcm.chromiumapp.org/   ← loaded unpacked
   https://oammomcicbchkaepkkbenadpflojjahh.chromiumapp.org/   ← Chrome Web Store
   ```
3. **Save**, then wait — Google warns changes take *5 minutes to a few hours*
   to take effect
4. Its client ID must match `WEB_OAUTH_CLIENT_ID` in
   `background/firebase-config.js`

### ⚠️ The published extension has a different redirect URI

`chrome.identity.getRedirectURL()` builds the redirect from the extension ID,
and the extension ID comes from the manifest's public key. `build.sh --zip`
strips the local `key` (it has to — the Web Store signs the item with its own),
so **the published extension has a different ID from the one you develop
against, and therefore a different redirect URI.**

This does not show up in testing. Sign-in works perfectly on the unpacked build
while every student on the store version gets:

> Access blocked: This app's request is invalid — **Error 400:
> `redirect_uri_mismatch`**

Both URIs are registered on the client now, so both builds work. If the item is
ever republished under a new ID, register that one too. To read the ID of the
build actually in front of you: `chrome://extensions` → the card's ID, or the
`.../detail/<id>` in the store URL — and the sign-in failure screen in the game
now prints the extension ID and redirect URI it is really using.

> Prefer a dedicated client? Create another **Web application** client with the
> same redirect URI and put its ID in `WEB_OAUTH_CLIENT_ID`. Leave the Firebase
> one alone either way — Firebase Auth uses it internally.

> The manifest no longer has an `oauth2` block, and the Chrome Extension–type
> client is now unused. You can delete it, or leave it; nothing reads it.

## 4. Fill in the Firebase config

In `background/firebase-config.js`:

```js
export const FIREBASE_CONFIG = {
    apiKey:    'AIza...',        // Project settings → General → Web API Key
    projectId: 'your-project-id' // Project settings → General → Project ID
};
```

These are **not secrets** — Firebase web API keys are public by design. Access is
controlled entirely by the security rules in the next step.

## 4b. Restrict who may sign in ⚠️ confirm the domain

`ALLOWED_EMAIL_DOMAINS` in `background/firebase-config.js` defaults to
`docchula.com`. **Confirm this is the domain your students' Google accounts
actually use** — if they sign in with a university address such as
`@student.chula.ac.th`, add it to the list, or nobody will be able to sign in.

The same domain appears in `firestore.rules`. Keep the two in sync: the
extension's copy only produces a friendly error message and can be edited out by
anyone running it unpacked, so **the rules file is the actual restriction**.

## 4b-ii. Shared computers ⚠️ confirm the Flick session reader before shipping

On a faculty library PC one Chrome profile is signed in to many Google accounts,
**all of them `@docchula.com`** — so the domain check waves every one of them
through, and `firestore.rules` cannot help either, because a Firebase token says
nothing about a Flick session.

So Flickémon binds to Flick: **the Google account signing in must be the account
already signed in to Flick on that machine.** Enforced in two places —

| When | What happens |
|---|---|
| At sign-in | `content/flickemon-flick-identity.js` reads Flick's session, passes it as `login_hint` so Google pre-selects it, and `background/auth.js` rejects the sign-in if the address Google returns is a different account. Nothing is persisted before that check passes. |
| While playing | Every 60s and on tab focus, `enforceFlickAccount()` re-reads Flick. If it now reports a *different* account — the student left, someone else logged in — the previous student's progress is flushed to **their own** save, they are signed out, and their party is cleared from the screen. |

**This fails closed.** If Flick's session cannot be read at all, sign-in is
refused. Local-only play still works via "Continue without signing in", so a
Flick redesign costs cloud sync, never the game — but it *does* cost cloud sync
for everyone until the reader is updated.

⚠️ **Because of that, confirm the reader works on the live site before you
publish.** Open a Flick page while logged in and run:

```js
window.FlickemonFlickIdentity.currentFlickIdentity()
```

- `{ email: 'you@docchula.com', source: 'localStorage:…' }` → working. Pin that
  key into `KNOWN_KEYS` at the top of `flickemon-flick-identity.js` so the read
  is exact instead of heuristic.
- `null` → **do not ship**. Nobody would be able to sign in. Use the snippet in
  that file's header comment to find where Flick keeps the session, add the key
  to `KNOWN_KEYS`, and re-check.

Like `ALLOWED_EMAIL_DOMAINS`, this is not a security boundary — anyone running
the extension unpacked can edit it out. It stops the accident and the casual
opportunist on a shared machine, which is the threat that actually exists in a
library. A student determined to credit their own account can just watch the
lecture.

## 4c. Grant admin access

There is no admin passcode. A passcode shipped inside an extension is readable
by anyone who opens its source, so admin is a property of the signed-in account,
checked against Firestore.

To grant it, in the Firebase console → **Firestore → Data**:

1. Start a collection named `admins`
2. Add a document whose **Document ID is the person's Firebase uid**
   (Authentication → Users, copy the User UID)
3. Any fields are optional — presence of the document is what counts

Security rules let a user read only their own `admins/{uid}` document and deny
**all** client writes, so admin can only be granted from the console.

**Scope of this control:** it authoritatively protects anything the server does.
It cannot stop a determined student editing the extension on their own machine
to reveal the panel — but those tools only alter that person's own save, which
they could already do by editing `chrome.storage` directly.

## 4d. PVP

PVP needs no extra setup beyond the rules in step 5, which now include a
`battles` collection.

Each student's 6-digit code is derived from their Firebase uid, so it never
changes and needs no allocation or collision bookkeeping. A battle is one
document at `battles/{code}`, keyed by the **host's** code.

Neither client trusts the other's arithmetic: each submits only its chosen
action, and both replay the turn locally through the same seeded RNG, so
identical rolls occur on both sides without a server refereeing.

Rules allow any signed-in student to *read* a battle (you must read a lobby to
find it) but restrict *writes* to the two participants — once the guest slot is
claimed, a third student cannot interfere.

## 5. Deploy the security rules **and the index**

```sh
npm install -g firebase-tools     # once
firebase login                    # once, as the project's Google account
firebase deploy --only firestore:rules,firestore:indexes
```

`firebase.json` and `.firebaserc` in the repo root point the CLI at
`firestore.rules`, `firestore.indexes.json` and the project — without them the
deploy fails with *"Not in a Firebase project directory"*.

**Two things go up, not one.**

| File | Protects / enables | If it is missing |
|---|---|---|
| `firestore.rules` | every privacy guarantee: audience-gated feeds, owner-only leaderboard rows, friendship membership | sync, PVP, trading and friends fail with permission errors |
| `firestore.indexes.json` | the one ordered query in the game — today's leaderboard | the global board returns an **error**, not an empty list, while everything else looks healthy |

The index takes a few minutes to build after deploying. Until it reports
**Enabled** in the console the board still errors, so check
**Firestore → Indexes** before concluding something is broken.

**Do not skip this.** The default production ruleset denies everything (sync will
silently fail), and a permissive ruleset would expose every student's save to every
other student.

### Without the CLI

Both can be done by hand in the console:

- **Rules** — paste `firestore.rules` into **Firestore → Rules** → *Publish*.
- **Index** — **Firestore → Indexes → Composite → Add index**: collection
  `leaderboard`, field `dayKey` Ascending, field `todayExp` Descending, scope
  Collection.

---

## Verifying it works

You need **two Chrome profiles** (or two machines) — not two tabs.

1. Load the extension in both, sign in as the **same Google account** in both.
2. Profile A: play until you catch something. A catch flushes to the cloud immediately.
3. Profile B: open Settings → **Sync Now**, or just wait ~90s with the tab focused.
4. Profile B should show A's progress.

Useful checks in the extension's DevTools console:

```js
// Local save
chrome.storage.local.get('flickemon_ext_save_v2', console.log)
// Auth session
chrome.storage.local.get('flickemon_auth_v1', console.log)
// A push parked while offline
chrome.storage.local.get('flickemon_pending_push_v1', console.log)
```

For service-worker errors, use the **"service worker"** link on the extension's card
in `chrome://extensions` — those logs do **not** appear in the page console.

---

## How it behaves

| | |
|---|---|
| **Local writes** | Coalesced to ~1/sec |
| **Cloud writes** | Coalesced to ~45s, plus immediate on catch / evolve / starter / reset, and on tab hide/close |
| **Cloud reads** | On startup, on tab focus, every ~90s while visible, and on **Sync Now** |
| **Offline** | The pending push is parked in `chrome.storage.local` and retried on the next successful cloud contact |
| **Merge rule** | Monotonic — study time takes the max, Pokédex unions, party keeps the higher EXP per species. A stale device can never erase a newer one. |
| **Battle state** | Deliberately **not** synced. Resuming another device's half-finished battle would be confusing; each device fights its own. |
| **Starting a game** | "Start Game" requires sign-in first, so a returning student resumes their existing partner instead of being offered a second starter that would merge into their account. If sync is unconfigured, it falls back to local-only play rather than locking the game. |
| **When sign-in fails** | Signing in is the only option offered up front. If an attempt actually fails (misconfigured OAuth, offline, background worker asleep), a "Continue without signing in" bypass appears so a broken dependency never makes the game unplayable. A save made that way is unowned, and is discarded on a later sign-in if the account already has one — so the bypass can never create a second starter. |
| **Shared devices** | Each save records the Firebase uid that owns it. A different student signing in on the same machine gets a clean slate, so one student's party can never merge into another's account. A save predating sign-in has no owner and is adopted into the first account that signs in. |
| **Library / public PCs** | The Google account must match the account Flick is signed in as — see 4b-ii. A handover mid-session (student leaves, next one logs in to Flick) flushes the first student's progress to their own save, signs them out, and clears their party from the screen. |
| **Who can sign in** | Only addresses on `ALLOWED_EMAIL_DOMAINS`. Enforced twice: in the extension for a clear error message, and in `firestore.rules` (server-side) as the real boundary. A rejected account is also dropped from Chrome's token cache so the student can immediately try a different one. |
| **Switch account** | Settings → **Switch account** re-opens Google's chooser with `prompt=select_account`, so any account is reachable — not just ones signed into Chrome. Local progress is discarded on switch, so the next student never inherits the previous one's party. It also appears after a *failed* sign-in, which is when reaching a different account matters most and was previously impossible without succeeding first. |
| **Wrong account on the sign-in gate** | Google's error page names whichever account it silently reused, so any failure reads as "wrong account" to a student. The gate therefore offers **Use a different Google account** alongside the retry once an attempt fails; it passes `prompt=select_account consent`, because `select_account` alone can still be skipped for an account that already granted this client. |

## Cost / free-tier headroom

Firestore's free (Spark) tier allows **20k writes + 50k reads per day**. Writes are
the binding constraint, not reads.

At the shipped cadence (`CLOUD_PUSH_DEBOUNCE_MS = 120s`, i.e. 30 writes/hr of active
watching) with **100 students**:

| Day type | Active watching / student | Writes/day | % of free tier |
|---|---|---|---|
| Typical | 1.5h | 4,500 | 23% |
| Heavy | 3h | 9,000 | 45% |
| Exam cram | 5h | 15,000 | 75% |
| Extreme | 8h | 24,000 | **120% — over** |

**Break-even is ~6.7h of active watching per student per day at 100 users.** Normal
and exam-period usage fit comfortably; only a sustained all-day-every-student
scenario exceeds it.

Scaling levers, in order of preference:

1. Raise `CLOUD_PUSH_DEBOUNCE_MS` in `content/flickemon-engine.js` — it scales
   linearly. 180s → 10h/student/day break-even at 100 users. The only cost is how
   much progress a crash could lose (immediate flushes on catch/evolve/starter/reset
   and on tab-close are unaffected).
2. Raise `CLOUD_POLL_INTERVAL_MS` if reads ever become the constraint (they aren't
   at these ratios).
3. Blaze pay-as-you-go: beyond the free quota, writes are ~$0.18 per 100k. Even
   3× over budget is single-digit dollars/month at this scale.

Rough scaling rule: **users × active-hours ≤ 670/day** stays free at 120s debounce.
So 200 students at 3.3h/day, or 300 at 2.2h/day, also fit.

## Privacy note

Each save stores the student's **email address**, total study time, and game progress.
For a faculty-distributed tool, confirm that's acceptable to Chulalongkorn before
rolling it out — especially given the admin monitoring portal reads
`email` / `totalMinutesWatched` / `caughtCount`.
