/**
 * Reading Flick's own progress off the page
 * ─────────────────────────────────────────
 * Study on a phone, or on a machine without the extension, and none of it
 * exists here: the party does not level, the friends screen is wrong, and the
 * global board ranks a student below classmates who did less work but did it
 * in Chrome.
 *
 * Flick already knows. FlickPlayer posts progress to its own backend every 20
 * seconds and on pause, the course page re-polls it every 60 seconds, and a
 * websocket pushes updates from the student's other devices. All of it is then
 * RENDERED -- "2.4 hours left (68.1%)" in the header, "- 34 min left" per
 * lecture. So the cheapest correct way to see a phone session is to read the
 * number Flick already put on the page.
 *
 * This file is deliberately pure: DOM in, numbers out, no game state and no
 * side effects. That is what lets it be tested against a fixture string with no
 * browser, which matters for a parser whose whole risk is the markup changing
 * underneath it.
 *
 * What it does NOT do is decide what any of this is worth. Flick's end_time is
 * a RESUME POSITION, not watch time -- scrub to the end and a lecture reads as
 * finished -- so every number here is a claim, not a measurement. The engine
 * prices and bounds it; see creditFlickProgress.
 */
(function () {
    'use strict';

    /** "- 34 min left" -> 34. Commas stripped; anything unparseable is null. */
    function parseMinutes(text) {
        if (typeof text !== 'string') return null;
        const m = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*min/i);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    /**
     * The course header: "2.4 hours left (68.1%)".
     *
     * Kept as a cross-check rather than the primary signal. It is one number for
     * the whole course, so it cannot say WHICH lecture moved, and Angular rounds
     * it to a tenth of an hour -- six minutes, which is most of a short session.
     */
    function parseHeader(root) {
        const el = (root || document).querySelector('ion-title small');
        if (!el) return null;
        const text = (el.textContent || '').replace(/,/g, '');
        const m = text.match(/(\d+(?:\.\d+)?)\s*hours?\s*left\s*\(\s*(\d+(?:\.\d+)?)\s*%\s*\)/i);
        if (!m) return null;
        const hoursLeft = Number(m[1]);
        const percent = Number(m[2]);
        if (!Number.isFinite(hoursLeft) || !Number.isFinite(percent)) return null;
        if (percent < 0 || percent > 100) return null;
        return { hoursLeft, percent };
    }

    /** The course name, which is the title with its progress <small> removed. */
    function parseCourseName(root) {
        const title = (root || document).querySelector('ion-title');
        if (!title) return '';
        const clone = title.cloneNode(true);
        clone.querySelectorAll('small').forEach(n => n.remove());
        return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /** The lecture's own title, with the date, the byline and the bar stripped. */
    function lectureTitle(label) {
        const clone = label.cloneNode(true);
        clone.querySelectorAll('.date, .date-divider, small, ion-progress-bar, ion-icon')
            .forEach(n => n.remove());
        return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /**
     * One row of the lecture list.
     *
     * Flick renders the remaining time, not the watched time -- "- 34 min left"
     * -- and only while a lecture is under 95% complete. Past that the row loses
     * both the text and the bar and gains a checkmark instead, so "no numbers"
     * means finished in one case and untouched in another. The checkmark is what
     * tells those apart.
     */
    function parseLecture(item) {
        const label = item.querySelector('ion-label');
        if (!label) return null;

        let durationSec = null, leftMin = null, playedMin = null;
        for (const span of label.querySelectorAll('.time-info')) {
            const text = span.textContent || '';
            const mins = parseMinutes(text);
            if (mins === null) continue;
            if (/left/i.test(text)) leftMin = mins;
            else if (/played/i.test(text)) playedMin = mins;
            else if (durationSec === null) durationSec = mins * 60;
        }

        const title = lectureTitle(label);
        if (!title) return null;

        // A lecture whose duration Flick does not know is the only case where it
        // prints minutes PLAYED directly.
        if (playedMin !== null) {
            return { title, durationSec, playedSec: playedMin * 60, from: 'played' };
        }

        if (durationSec === null) return { title, durationSec: null, playedSec: 0, from: 'none' };

        // The bar carries the raw ratio rather than a rounded minute, so it is
        // the better number wherever it exists.
        const bar = item.querySelector('ion-progress-bar');
        const rawValue = bar && (bar.getAttribute('value') ?? bar.value);
        const ratio = rawValue === null || rawValue === undefined ? NaN : Number(rawValue);
        if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
            return { title, durationSec, playedSec: Math.round(ratio * durationSec), from: 'bar' };
        }

        if (leftMin !== null) {
            return { title, durationSec, playedSec: Math.max(0, durationSec - leftMin * 60),
                     from: 'left' };
        }

        // 95% or more. Counting it as complete slightly over-credits the tail,
        // which is the right way to be wrong: the alternative is telling a
        // student who finished a lecture that they did not.
        if (item.querySelector('.check-icon')) {
            return { title, durationSec, playedSec: durationSec, from: 'complete' };
        }

        return { title, durationSec, playedSec: 0, from: 'none' };
    }

    /**
     * Everything readable about the open course.
     *
     * Returns null off a course page rather than an empty reading: "no lectures
     * here" and "a course where nothing has been watched" must not look alike,
     * or navigating away would read as progress being lost.
     */
    function readCourse(root) {
        const doc = root || document;
        const items = doc.querySelectorAll('ion-list ion-item');
        if (!items.length) return null;

        const lectures = [];
        for (const item of items) {
            const parsed = parseLecture(item);
            if (parsed) lectures.push(parsed);
        }
        if (!lectures.length) return null;

        return {
            course: parseCourseName(doc),
            lectures,
            header: parseHeader(doc),
        };
    }

    /**
     * Does the sum of the rows agree with the header?
     *
     * Both are rendered from the same object by different expressions, so they
     * should agree to within their rounding. When they do not, the markup has
     * moved and the parse is guesswork -- and the right response to a misparse
     * is to credit nothing, because the failure that matters is inventing study
     * time, not missing some.
     *
     * The tolerance is asymmetric, and has to be. Past 95% Flick stops printing
     * a number and prints a checkmark, so a finished lecture can only be read as
     * "all of it" while the header still counts the real position -- a course
     * with twenty finished hour-long lectures legitimately reads up to an hour
     * high. A flat tolerance rejected that, which meant rejecting almost every
     * real course: the feature would have looked healthy and silently never paid
     * anything. Rows may therefore run OVER by the slack each checkmark hides,
     * and under only by the rounding.
     */
    function agreesWithHeader(reading) {
        if (!reading || !reading.header) return true;   // nothing to check against
        const known = reading.lectures.filter(l => l.durationSec !== null);
        if (!known.length) return true;

        const total = known.reduce((a, l) => a + l.durationSec, 0);
        const viewed = known.reduce((a, l) => a + l.playedSec, 0);
        const headerViewed = total - reading.header.hoursLeft * 3600;
        const drift = viewed - headerViewed;

        // Every row is rounded to a whole minute, and the header to a tenth of
        // an hour, which is three minutes either way.
        const rounding = known.length * 30 + 4 * 60;
        // A checkmark means "95% or more", so it can hide up to 5% of a lecture.
        const hidden = known
            .filter(l => l.from === 'complete')
            .reduce((a, l) => a + l.durationSec * 0.05, 0);

        return drift <= rounding + hidden && drift >= -rounding;
    }

    window.FlickProgress = {
        readCourse, parseLecture, parseHeader, parseMinutes,
        parseCourseName, lectureTitle, agreesWithHeader,
    };
})();
