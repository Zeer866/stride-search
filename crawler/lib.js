'use strict';

const STOP = new Set(('a al algo ante con como de del el en es esta este la las lo los me mi muy no o para pero por que se si sin su sus un una y ' +
  'the and or of to in is it for on with as at by an be this that from are was were').split(' '));

function tokenize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 2 && w.length <= 40 && !STOP.has(w));
}

// pages: [{id,title,desc,text}] -> Map(term -> ["id:score", ...])
function buildIndex(pages, maxTerms = 12000) {
  const N = pages.length, tfs = new Map();
  for (const p of pages) {
    const counts = new Map();
    const add = (arr, w) => { for (const t of arr) counts.set(t, (counts.get(t) || 0) + w); };
    add(tokenize(p.title), 5);
    add(tokenize(p.desc), 2);
    add(tokenize(p.text).slice(0, 3000), 1);
    for (const [t, c] of counts) {
      if (!tfs.has(t)) tfs.set(t, new Map());
      tfs.get(t).set(p.id, c);
    }
  }
  const out = [];
  for (const [t, m] of tfs) {
    const idf = Math.log(1 + N / m.size);
    const posts = [...m]
      .map(([id, c]) => [id, Math.round((1 + Math.log(c)) * idf * 100)])
      .sort((a, b) => b[1] - a[1]).slice(0, 200);
    out.push([t, posts[0][1], posts.map(([id, s]) => id + ':' + s)]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return new Map(out.slice(0, maxTerms).map(([t, , p]) => [t, p]));
}

function parseRobots(text) {
  const rules = [];
  let apply = false, prevUA = false;
  for (const raw of String(text).split('\n')) {
    const l = raw.split('#')[0].trim();
    const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      const hit = v === '*' || /stridebot/i.test(v);
      apply = prevUA ? (apply || hit) : hit;
      prevUA = true;
    } else {
      prevUA = false;
      if (k === 'disallow' && apply && v) rules.push(v);
    }
  }
  return rules;
}

function robotsBlocked(rules, pathAndQuery) {
  return rules.some(r => {
    const end = r.endsWith('$');
    const body = end ? r.slice(0, -1) : r;
    const re = new RegExp('^' + body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (end ? '$' : ''));
    return re.test(pathAndQuery);
  });
}

module.exports = { tokenize, buildIndex, parseRobots, robotsBlocked };
