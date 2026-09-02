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

//live stream links aren't supported !!

window.FlickemonPlaylist = [

    // ─────────────── Add your music below ───────────────

    { name: 'Lofi hip hop radio',  url: 'https://www.youtube.com/watch?v=lTRiuFIWV54&list=RDlTRiuFIWV54&start_radio=1' },
    { name: 'Synthwave radio',     url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY' },
    { name: 'Relaxing Anime Piano Music ft. RADWIMPS',     url: 'https://youtu.be/0kfdim-wLds?si=BwgBbxwYCdugMRdK' },
    { name: 'Relaxing Anime Piano Music ft. Ghibli',     url: 'https://youtu.be/ASCMw-UCafA?si=j2S48qHirtCnRQBB' },
    { name: 'Pokemon Theme Song',     url: 'https://youtu.be/_tWM-S8CJrE?si=Q0IDcYZzl-4aOLXu' },
    { name: 'Pokemon Battle Music',     url: 'https://www.youtube.com/watch?v=jjM5mUXc3Lk&list=PLsWUM3Sz8ORyKKz2gvoFRLV8w0a2Lf7BT' },
    { name: 'Pokemon Center Theme',     url: 'https://www.youtube.com/watch?v=WjigZM-ONEQ&list=RDWjigZM-ONEQ&start_radio=1' },
    { name: 'สุดฟ้า : Pokemon XY Opening',     url: 'https://youtu.be/nFOXxlLE22A?si=ej4_CMEvyq5XttkG' },
    { name: 'ไปไหนไปกัน : Pokemon XY Ending',     url: 'https://youtu.be/em4x-IswZjY?si=p4bDWOFFt1nLaxP-' },
    { name: 'Around The World : Pokemon BW Opening',     url: 'https://youtu.be/WHgKKaBQ7yc?si=fkSxdSUvGFbCxxUv' },
    { name: 'เเบมือ : Pokemon BW Ending',     url: 'https://youtu.be/16EgnjwHEfg?si=DMJz5BULe3VhijjV' },
    { name: 'นาน นาน : Pokemon XY The Movie OP',     url: 'https://youtu.be/g1xdxUtH_R0?si=O4d9fLqzOq32Kyqe' },


    // ─────────────── Add your music above ───────────────

];

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                          ║
 * ║   BATTLE THEME                                                           ║
 * ║                                                                          ║
 * ║   The one track that is not part of the list above: what plays during a  ║
 * ║   PVP battle, and only during a PVP battle. Same two bits to change.     ║
 * ║                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * It loops until the battle is over, then whatever you were listening to
 * before comes back — or the player closes again, if you had music off.
 *
 * Delete the line (or set it to null) and battles are silent. Nothing else
 * changes.
 */

window.FlickemonBattleMusic =
    { name: 'Pokemon Battle Music', url: 'https://www.youtube.com/watch?v=jjM5mUXc3Lk&list=PLsWUM3Sz8ORyKKz2gvoFRLV8w0a2Lf7BT' };
