'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
const { buildIndex, parseRobots, robotsBlocked } = require('./lib');

const MAX_PAGES = +process.env.MAX_PAGES || 150;
const MAX_TERMS = +process.env.MAX_TERMS || 12000;
const DELAY = +process.env.DELAY_MS || 1000;
const REPO = process.env.GITHUB_REPOSITORY || 'stride-search';
const UA = `StrideBot/1.0 (+https://github.com/${REPO})`;
const BAD_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|gz|mp3|mp4|avi|mov|exe|apk|dmg|css|js|json|xml)$/i;
const TRK = /^(utm_|fbclid|gclid|msclkid|igshid|yclid)/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashId = u => crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);

const seeds = fs.readFileSync(path.join(__dirname, '..', 'seeds.txt'), 'utf8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
if (!seeds.length) { console.error('seeds.txt está vacío'); process.exit(1); }

const robots = new Map();
async function allowed(u) {
  if (!robots.has(u.origin)) {
    let rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok) rules = parseRobots(await r.text());
    } catch {}
    robots.set(u.origin, rules);
  }
  return !robotsBlocked(robots.get(u.origin), u.pathname + u.search);
}

async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  if (!r.ok || !(r.headers.get('content-type') || '').includes('text/html')) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 1.5e6) return null;
  return { html: new TextDecoder('utf-8').decode(buf), url: r.url };
}

function parse(html) {
  const $ = cheerio.load(html);
  const noindex = /noindex/i.test($('meta[name="robots"]').attr('content') || '');
  const links = $('a[href]').map((_, a) => $(a).attr('href')).get();
  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim();
  $('script,style,noscript,svg,nav,footer,header,form,iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { noindex, links, title, desc, text };
}

(async () => {
  const perSeed = Math.ceil(MAX_PAGES / seeds.length);
  const pages = new Map();
  for (const seed of seeds) {
    let base;
    try { base = new URL(seed); } catch { console.warn('Semilla inválida:', seed); continue; }
    const hostName = base.hostname.replace(/^www\./, '');
    const queue = [base.href], seen = new Set(queue);
    let n = 0;
    console.log('Rastreando', base.href);
    while (queue.length && n < perSeed) {
      const u = new URL(queue.shift());
      if (!(await allowed(u))) continue;
      await sleep(DELAY);
      let res;
      try { res = await get(u.href); } catch { continue; }
      if (!res) continue;
      n++;
      const p = parse(res.html);
      const id = hashId(res.url);
      if (!p.noindex && p.title && !pages.has(id)) {
        pages.set(id, { id, url: res.url, title: p.title, desc: p.desc, text: p.text });
      }
      for (const l of p.links) {
        try {
          const x = new URL(l, res.url);
          x.hash = '';
          if (!/^https?:$/.test(x.protocol) || x.hostname.replace(/^www\./, '') !== hostName || BAD_EXT.test(x.pathname)) continue;
          for (const k of [...x.searchParams.keys()]) if (TRK.test(k)) x.searchParams.delete(k);
          if (!seen.has(x.href)) { seen.add(x.href); queue.push(x.href); }
        } catch {}
      }
    }
    console.log(`  ${n} páginas`);
  }

  const list = [...pages.values()];
  if (!list.length) { console.error('No se indexó ninguna página.'); process.exit(1); }
  const terms = buildIndex(list, MAX_TERMS);
  console.log(`Documentos: ${list.length} · Términos: ${terms.size}`);

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  const bw = db.bulkWriter();
  for (const p of list) {
    bw.set(db.collection('docs').doc(p.id), { url: p.url, title: p.title.slice(0, 150), desc: (p.desc || p.text).slice(0, 220) });
  }
  for (const [t, posts] of terms) bw.set(db.collection('terms').doc(t), { p: posts });
  bw.set(db.collection('meta').doc('stats'), { docs: list.length, terms: terms.size, updated: new Date().toISOString() });
  await bw.close();
  console.log('Índice guardado en Firestore.');
})().catch(e => { console.error(e); process.exit(1); });
