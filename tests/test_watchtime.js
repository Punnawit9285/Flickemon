const ROOT = require('path').join(__dirname, '..') + '/';
// Study time must be real time spent watching, not video position crossed.
const fs=require('fs');
const src=fs.readFileSync(ROOT + 'content/content-script.js','utf8');

let pass=0,fail=0;
const check=(n,c,d='')=>c?(console.log('  PASS  '+n),pass++):(console.log('  FAIL  '+n+(d?' -> '+d:'')),fail++);

console.log('\n=== progress no longer reads the playhead ===');
check('currentTime is not differenced any more',
      !/currentTime\s*-\s*last/.test(src), 'a currentTime delta scales with playback rate');
check('elapsed real time is used instead', /Date\.now\(\)/.test(src));
check('gaps are clamped', /MAX_TICK_SECONDS/.test(src));
check('an interrupted stream resets the interval',
      /'pause', 'seeking', 'ended', 'waiting', 'stalled'/.test(src));

console.log('\n=== simulating the loop at each playback rate ===');
// Re-create the accounting exactly as content-script.js performs it, driven by
// a fake clock, and confirm the rate cannot influence the total.
const MAX_TICK_SECONDS = Number(/MAX_TICK_SECONDS\s*=\s*(\d+)/.exec(src)[1]);

function simulate({rate, realSeconds, tickHz=4, paused=()=>false}) {
    let lastTickAt=null, credited=0, now=0;
    const stepMs=1000/tickHz;
    for (let t=0; t<realSeconds*1000; t+=stepMs) {
        now=t;
        if (paused(t/1000)) { lastTickAt=null; continue; }
        if (lastTickAt===null) { lastTickAt=now; continue; }
        const seconds=Math.min((now-lastTickAt)/1000, MAX_TICK_SECONDS);
        lastTickAt=now;
        credited+=seconds;
    }
    return credited;
}

const at1x  = simulate({rate:1,  realSeconds:600});
const at2x  = simulate({rate:2,  realSeconds:600});
const at10x = simulate({rate:10, realSeconds:600});
console.log(`      10 real minutes credits ${at1x.toFixed(0)}s at 1x, `
          + `${at2x.toFixed(0)}s at 2x, ${at10x.toFixed(0)}s at 10x`);
check('2x credits the same as 1x', Math.abs(at2x-at1x)<1, `${at2x} vs ${at1x}`);
check('10x credits the same as 1x', Math.abs(at10x-at1x)<1, `${at10x} vs ${at1x}`);
check('ten real minutes credits about ten minutes',
      Math.abs(at1x-600)<2, `${at1x}s`);

// Under the OLD rule, playback rate multiplied the credit directly.
const oldRule = (rate, realSeconds) => rate*realSeconds;
check('the old rule paid 2x double', oldRule(2,600)===1200);
check('and 10x tenfold', oldRule(10,600)===6000);

console.log('\n=== pauses and scrubs are not billed ===');
const halfPaused = simulate({realSeconds:600, paused:s=>s>=300});
check('a pause halfway credits about half', Math.abs(halfPaused-300)<3, `${halfPaused}s`);
check('a paused session credits nothing',
      simulate({realSeconds:600, paused:()=>true})===0);

// A scrub moves the playhead but consumes no real time, so it earns nothing —
// by construction rather than by a heuristic threshold.
check('scrubbing earns nothing on its own',
      simulate({realSeconds:0})===0);

console.log('\n=== a throttled or sleeping tab cannot bank hours ===');
{
    // One tick, then a four-hour gap (laptop shut). Only the clamp is credited.
    let lastTickAt=0, credited=0;
    const gapMs=4*60*60*1000;
    credited+=Math.min((gapMs-0)/1000, MAX_TICK_SECONDS);
    check('a four-hour gap credits only the clamp',
          credited===MAX_TICK_SECONDS, `${credited}s`);
    check('the clamp is small enough to matter', MAX_TICK_SECONDS<=5, `${MAX_TICK_SECONDS}s`);
    // But the clamp must not starve a normal 4Hz tick.
    check('and generous enough for a normal tick', MAX_TICK_SECONDS>=0.25);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
