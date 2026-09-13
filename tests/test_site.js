/**
 * The generated public site.
 *
 * privacy.html is a legal document rendered by a hand-rolled markdown converter,
 * which is exactly the combination that deserves a test: the first version
 * double-escaped code spans, so `<video>` reached the page as the literal text
 * &lt;video&gt;. Google also refuses to publish the OAuth app without these two
 * pages, so a broken build here blocks the release.
 */
const ROOT = require('path').join(__dirname, '..') + '/';
const fs = require('fs');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c
    ? (console.log('  PASS  ' + n), pass++)
    : (console.log('  FAIL  ' + n + (d ? ' -> ' + d : '')), fail++);

const { markdownToHtml } = require(ROOT + 'tools/build-site.js');

console.log('=== markdown rendering ===');
{
    const html = (md) => markdownToHtml(md);

    check('a code span is escaped exactly once',
        html('Reads the `<video>` element.').includes('<code>&lt;video&gt;</code>'),
        html('Reads the `<video>` element.'));

    check('and never double-escaped',
        !html('`<video>`').includes('&amp;lt;'));

    check('bold wins over italic, so **x** is not two emphases',
        html('**Local Storage:** text') === '<p><strong>Local Storage:</strong> text</p>',
        html('**Local Storage:** text'));

    check('a bare number surrounded by spaces is left alone',
        html('deleted within 7 business days') === '<p>deleted within 7 business days</p>',
        html('deleted within 7 business days'));

    check('links get noopener when they leave the site',
        html('[x](https://e.com)').includes('rel="noopener noreferrer"'));

    check('a mailto link is not treated as external',
        !html('[m](mailto:a@b.com)').includes('noopener'));

    check('list items group into one <ul>',
        html('- a\n- b') === '<ul><li>a</li><li>b</li></ul>', html('- a\n- b'));

    check('a horizontal rule closes the list before it',
        html('- a\n\n---').startsWith('<ul><li>a</li></ul>'), html('- a\n\n---'));

    check('headings carry their level', html('## Two') === '<h2>Two</h2>');

    check('raw HTML in the source is escaped, not passed through',
        html('<script>x</script>').includes('&lt;script&gt;'));
}

console.log('\n=== the two pages Google requires exist and are complete ===');
{
    const home = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
    const priv = fs.readFileSync(ROOT + 'public/privacy.html', 'utf8');
    const md = fs.readFileSync(ROOT + 'PRIVACY.md', 'utf8');

    check('the home page names the app', /Flickémon/.test(home));
    check('the home page links the privacy policy', home.includes('href="/privacy"'));
    check('the home page carries the non-affiliation notice',
        /not affiliated/i.test(home));
    check('the privacy page has a contact address',
        priv.includes('punnawit.wsr@docchula.com'));
    check('the privacy page has a deletion route, which the policy promises',
        /Deletion Request/i.test(priv));

    // Drift guard: every section heading in the source must reach the page.
    const headings = [...md.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
    const missing = headings.filter(h => !priv.includes(h.replace(/&/g, '&amp;')));
    check(`all ${headings.length} policy sections are rendered`,
        missing.length === 0, missing.join(' | '));

    check('no unconverted markdown is left on the page',
        !/\*\*|\]\(/.test(priv.replace(/<[^>]+>/g, '')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
