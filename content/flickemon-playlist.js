/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                          ║
 * ║   YOUR MUSIC                                                             ║
 * ║                                                                          ║
 * ║   Add a song by copying one line and changing the two bits:              ║
 * ║                                                                          ║
 * ║       { name: 'What to call it',  url: 'paste the YouTube link here' },  ║
 * ║                                                                          ║
 * ║   That is the whole format. Name, then link, comma at the end.           ║
 * ║                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Where the link comes from:
 *   On YouTube, press Share and copy — or just copy what is in the address bar.
 *   A single video, a live stream, or a whole playlist link all work.
 *
 * When you are done:
 *   1. Save this file.
 *   2. Go to chrome://extensions and press ↻ on Flickémon.
 *   3. Refresh the lecture page.
 *
 * If you get a line wrong, nothing breaks — the player skips it and tells you
 * which one it could not read.
 *
 * ── Why links and not music files ──
 *
 * Everything plays through YouTube's own player, which is what keeps this
 * legal: YouTube streams the audio, shows its ads, and pays whoever owns the
 * music. Putting an mp3 in this folder would be piracy. A link is not.
 * Prefer official channels and artists' own uploads.
 */

window.FlickemonPlaylist = [

    // ─────────────── Add your music below ───────────────

    { name: 'Lofi hip hop radio',  url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
    { name: 'Synthwave radio',     url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY' },

    // ─────────────── Add your music above ───────────────

];
