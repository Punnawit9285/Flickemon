# Privacy Policy for Flickémon

*Last updated: September 8, 2026*

Flickémon ("we", "our", or "the extension") is an unofficial, non-profit educational study companion browser extension designed for students using the Flick lecture platform at [flick.docchula.com](https://flick.docchula.com). 

We respect your privacy. This Privacy Policy explains what information is collected, how it is used, and how your data is protected.

---

## 1. Developer & Contact Information

- **Developer:** Punnawit
- **Affiliation:** Student developer, Faculty of Medicine, Chulalongkorn University
- **Contact Email:** [punnawit.wsr@docchula.com](mailto:punnawit.wsr@docchula.com)
- **Source Code & Issue Tracker:** [https://github.com/Punnawit9285/Flickemon](https://github.com/Punnawit9285/Flickemon)

---

## 2. Information We Collect

Flickémon only collects data strictly necessary for providing the educational gamification features of the extension.

### A. Study Activity & Video Progress (On `flick.docchula.com` only)
- **What is collected:** Playback status (play, pause, duration) of the HTML5 `<video>` element on course lecture pages on `flick.docchula.com`.
- **Purpose:** To calculate active study time and award in-game experience points (EXP) and Pokédollars to your companion team.
- **Scope:** We do NOT read lecture contents, exam questions, video transcripts, or keystrokes.

### B. Account & Authentication Information (Optional)
- **What is collected:** If you choose to sign in to sync your progress across devices, we collect your Google User ID (UID) and email address via Google Firebase Authentication.
- **Purpose:** To authenticate your account and associate your saved companion data with your account.
- **Anonymous Usage:** If you do not sign in, gameplay progress is stored purely on your local device.

### C. In-Game State & Gameplay Data
- **What is collected:** Companion team rosters, captured species IDs, levels, EXP points, in-game Pokédollars, battle preferences, and UI theme settings.
- **Purpose:** To persist your game state and enable features such as PvP challenges and trading between students.

---

## 3. Information We DO NOT Collect

- We do **NOT** track your browsing history or collect data from any website outside of `flick.docchula.com`.
- We do **NOT** collect financial, payment, or credit card information. The extension is 100% free with no in-app purchases.
- We do **NOT** collect biometric data, device identifiers (beyond standard browser user agents for network requests), or physical location.
- We do **NOT** use tracking cookies, analytics trackers (such as Google Analytics or Facebook Pixel), or advertising SDKs.

---

## 4. How Data is Stored and Protected

- **Local Storage:** Gameplay state is stored locally on your device using Chrome's secure `chrome.storage.local` API.
- **Cloud Storage:** Synchronized save data and multiplayer match rooms are hosted on Google Cloud Firestore (Firebase) with strict security rules enforcing user ownership of data.
- **Encryption:** All communications with Firebase and Google APIs use standard TLS 1.3 encryption in transit.

---

## 5. Third-Party Services

The extension connects only to the following services:
- **Google Firebase (Authentication & Cloud Firestore):** Used for cloud synchronization of study progress. Governed by the [Google Cloud Privacy Notice](https://cloud.google.com/terms/cloud-privacy-notice).
- **GitHub / PokeAPI:** Visual Pokémon sprites are loaded from static, open-source community repositories. No personal user data is sent to PokeAPI.

---

## 6. Data Sharing & Disclosure

- **No Sale of Data:** We do NOT sell, rent, monetize, or trade your personal or usage data to any third party, broker, or advertiser.
- **No Advertising:** Flickémon contains no advertisements and does not share data with ad networks.
- **No Unrelated Uses:** Data is exclusively used to provide the study companion features described in the extension.

---

## 7. Data Retention and Deletion Requests

- **Local Data:** You can delete all locally stored progress at any time by uninstalling the extension or clearing the extension storage in `chrome://extensions`.
- **Cloud Data Deletion:** To request permanent deletion of your Firebase account, companion party, and cloud study records, send an email from your registered address to [punnawit.wsr@docchula.com](mailto:punnawit.wsr@docchula.com) with the subject *"Flickemon Data Deletion Request"*. Your records will be deleted within 7 business days.

---

## 8. Changes to This Policy

If we make updates to this policy, changes will be posted to this repository with a revised "Last updated" date.

---

## 9. Compliance Certification

In accordance with the Chrome Web Store Developer Program Policies:
1. We limit data collection strictly to what is directly relevant to core functionality.
2. We do not transfer data for personalized advertising or creditworthiness checks.
3. We provide clear, prominent disclosure of data practices.
