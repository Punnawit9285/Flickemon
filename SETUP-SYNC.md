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

## 3. Create the OAuth client

1. <https://console.cloud.google.com/apis/credentials> (same project as Firebase)
2. **Create Credentials → OAuth client ID → Application type: Chrome Extension**
3. Paste the extension ID from step 2
4. Copy the generated client ID into `manifest.json`, replacing
   `REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com`

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

## 5. Deploy the security rules

```sh
firebase deploy --only firestore:rules
```

Or paste `firestore.rules` into **Firestore → Rules** in the console.

**Do not skip this.** The default production ruleset denies everything (sync will
silently fail), and a permissive ruleset would expose every student's save to every
other student.

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
| **Signed out** | Game is fully playable; it just stays local-only. Auth gates sync, never play. |

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
