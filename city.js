(function () {
'use strict';
const D = window.CITY, Q = D.meta.q, DAY = 86400000, DWELL = 20, TURN = 1500;
const el = id => document.getElementById(id);
const KX = 111320 * Math.cos(D.meta.lat0 * Math.PI / 180), KY = 110574;
const px = lon => (lon - D.meta.lon0) * KX, py = lat => -(lat - D.meta.lat0) * KY;

function decode(a) {
  const n = a.length / 2, x = new Float64Array(n), y = new Float64Array(n), cum = new Float64Array(n);
  let lo = 0, la = 0;
  for (let i = 0; i < n; i++) {
    lo += a[2 * i]; la += a[2 * i + 1];
    x[i] = px(lo / Q); y[i] = py(la / Q);
    if (i) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  return { x, y, cum, n };
}
function pointAt(g, s) {
  const c = g.cum, last = g.n - 1;
  if (last < 1) return { x: g.x[0], y: g.y[0], a: 0 };
  if (s <= 0 || s >= c[last]) {
    const i = s <= 0 ? 0 : last - 1, a = Math.atan2(g.y[i + 1] - g.y[i], g.x[i + 1] - g.x[i]), b = s <= 0 ? 0 : last, over = s <= 0 ? s : s - c[last];
    return { x: g.x[b] + Math.cos(a) * over, y: g.y[b] + Math.sin(a) * over, a };
  }
  let lo = 0, hi = last;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const span = c[hi] - c[lo], f = span > 0 ? (s - c[lo]) / span : 0;
  return { x: g.x[lo] + f * (g.x[hi] - g.x[lo]), y: g.y[lo] + f * (g.y[hi] - g.y[lo]), a: Math.atan2(g.y[hi] - g.y[lo], g.x[hi] - g.x[lo]) };
}

const geoms = D.geoms.map(decode);
const joined = new Map();
function hopGeom(h) {
  const key = h.join(','); if (joined.has(key)) return joined.get(key);
  const xs = [], ys = [], d = [0];
  h.forEach((hi, k) => {
    const g = geoms[hi < 0 ? -hi - 1 : hi], n = g.n;
    for (let j = 0; j < n; j++) { const i = hi < 0 ? n - 1 - j : j; if (j === 0 && k > 0) continue; xs.push(g.x[i]); ys.push(g.y[i]); }
    d.push(d[k] + g.cum[n - 1]);
  });
  const n = xs.length, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const out = { g: { x: Float64Array.from(xs), y: Float64Array.from(ys), cum, n }, d };
  joined.set(key, out); return out;
}

const groups = D.groups.map((g, i) => ({ i, name: g.name, kind: g.kind, on: true }));
const lines = D.lines.map((l, i) => ({ i, name: l.name, rgb: l.colour, vrgb: l.vc || l.colour, group: groups[l.group], length: l.length, sections: l.sections }));
const stations = D.stations.map(s => ({ name: s[0], x: px(s[1] / Q), y: py(s[2] / Q), group: s[3] }));
const sums = a => { let c = 0; return a.map(v => c += v); };
const paths = (D.paths || []).map(q => ({ g: geoms[q.g], s: sums(q.ds), d: sums(q.dd), n: q.n }));
const pats = D.patterns.map(p => {
  if (p.p != null) { const q = paths[p.p], t = sums(p.dt); return { line: lines[p.l], g: q.g, d: q.d, s: q.s, t, n: q.n, dur: t[t.length - 1], o: p.o !== 0, e: p.e !== 0 }; }
  const j = p.h ? hopGeom(p.h) : { g: geoms[p.g], d: p.d };
  return { line: lines[p.l], g: j.g, d: j.d, s: p.s, t: p.t, dur: p.t[p.t.length - 1], o: p.o !== 0, e: p.e !== 0 };
});
const services = D.services.map(s => ({ days: s.days, start: s.start, end: s.end, add: new Set(s.add), rem: new Set(s.rem) }));

function rawTrips(dk) {
  const dt = new Date(dk * DAY), ymd = dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(), dow = (dt.getUTCDay() + 6) % 7;
  const on = services.map(s => s.add.has(ymd) || (!s.rem.has(ymd) && ymd >= s.start && ymd <= s.end && s.days[dow] === '1'));
  const seen = new Set(), out = [];
  for (const r of D.runs) {
    if (!on[r.v]) continue;
    const p = pats[r.p];
    r.t.forEach((start, i) => { const k = r.p + '@' + start; if (seen.has(k)) return; seen.add(k); out.push({ p, start, end: start + p.dur, b: r.b ? r.b[i] : -1 }); });
  }
  return out;
}
const tripCache = new Map(), borrowed = new Map();
function tripsFor(dk) {
  if (tripCache.has(dk)) return tripCache.get(dk);
  const out = rawTrips(dk), have = new Set(out.map(t => t.p.line.group.i)), from = [];
  let missing = groups.filter(g => !have.has(g.i));
  for (let w = 1; w <= 52 && missing.length; w++) {
    const ts = rawTrips(dk - 7 * w), date = new Date((dk - 7 * w) * DAY).toISOString().slice(0, 10);
    missing = missing.filter(g => {
      const mine = ts.filter(t => t.p.line.group === g); if (!mine.length) return true;
      out.push(...mine); from.push(g.name + ' (' + date + ')'); return false;
    });
  }
  borrowed.set(dk, from);
  out.sort((a, b) => a.start - b.start);
  const bus = out.filter(isBus);
  link(out.filter(t => !isBus(t)));
  const blocks = new Map();
  for (const t of bus) if (t.b >= 0) { if (!blocks.has(t.b)) blocks.set(t.b, []); blocks.get(t.b).push(t); }
  for (const list of blocks.values()) for (let i = 1; i < list.length; i++) { const a = list[i - 1], c = list[i]; if (a.p.e && c.p.o && c.start >= a.end - 120) { a.next = c; c.prev = a; } }
  link(bus.filter(t => t.b < 0));
  out.work = workings(out);
  tripCache.set(dk, out);
  return out;
}
const isBus = tr => tr.p.line.group.kind === 'bus';
const PREP = 300, WAIT_MAX = 2400, DAY0 = 3 * 3600, OUT = 0, WAIT = 1, RUN = 2, IN = 3, MOVE = 4;
const SPEED = { bus: 25 / 3.6, rail: 40 / 3.6, subway: 20 / 3.6, tram: 20 / 3.6 }, REACH = { bus: 15000, rail: 40000, subway: 5000, tram: 10000 };
const grow = (b, x, y) => b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
const depots = (D.depots || []).map((d, i) => {
  const x = px(d.lon), y = py(d.lat), slots = [], site = d.site != null ? geoms[d.site] : null, tracks = (d.tracks || []).map(g => geoms[g]);
  for (let j = 0; d.slots && j < d.slots.length; j += 3) slots.push([x + d.slots[j], y - d.slots[j + 1], -d.slots[j + 2] * Math.PI / 180]);
  let bb = null; for (const s of slots.slice(0, d.inside || slots.length)) bb = grow(bb, s[0], s[1]); for (const g of tracks.concat(site ? [site] : [])) for (let j = 0; j < g.n; j++) bb = grow(bb, g.x[j], g.y[j]);
  return { i, name: d.name, ls: d.ls || [], k: d.k || 'bus', x, y, slots, site, tracks, bb, cap: 0, rgb: '96,108,124', len: 12, grp: null };
});
const depotRun = new Map((D.depotRuns || []).map(r => [r[0] + '|' + r[1], geoms[r[2]]]));
const nearDepot = new Map();
function depotFor(st, line) {
  const key = st + '|' + line.i, kind = line.group.kind;
  if (!nearDepot.has(key)) { const s = stations[st]; let best = null, bd = (REACH[kind] || 15000) ** 2; for (const d of depots) { if (d.k !== kind || (d.ls.length && !d.ls.includes(line.i))) continue; const v = (d.x - s.x) ** 2 + (d.y - s.y) ** 2; if (v < bd) { bd = v; best = d; } } nearDepot.set(key, best); }
  return nearDepot.get(key);
}
const straight = (a, b) => { const len = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: [a.x, b.x], y: [a.y, b.y], cum: [0, len], n: 2 }; };
function runTo(dep, st, back) {
  const v = SPEED[dep.k] || SPEED.bus, g = depotRun.get(dep.i + '|' + st); if (g) return { g, rev: back, secs: g.cum[g.n - 1] / v + 60 };
  const gl = back ? straight(stations[st], dep) : straight(dep, stations[st]); return { g: gl, rev: false, secs: gl.cum[1] * 1.3 / v + 120 };
}
function workings(trips) {
  const out = [];
  for (const head of trips) {
    if (head.prev) continue;
    let tail = head; while (tail.next) tail = tail.next;
    const segs = [], dep = head.p.o ? depotFor(head.p.s[0], head.p.line) : tail.p.e ? depotFor(tail.p.s[tail.p.s.length - 1], tail.p.line) : null;
    const add = s => { if (s.t1 > s.t0) segs.push(s); };
    const goOut = tr => { const R = runTo(dep, tr.p.s[0], false); add({ k: OUT, t0: tr.start - PREP - R.secs, t1: tr.start - PREP, run: R, tr }); add({ k: WAIT, t0: tr.start - PREP, t1: tr.start, tr }); };
    const goIn = tr => { const R = runTo(dep, tr.p.s[tr.p.s.length - 1], true); add({ k: IN, t0: tr.end, t1: tr.end + R.secs, run: R, tr }); };
    if (dep && head.p.o) goOut(head); else add({ k: WAIT, t0: head.start - 60, t1: head.start, tr: head, fade: 1 });
    for (let tr = head; tr; tr = tr.next) {
      add({ k: RUN, t0: tr.start, t1: tr.end, tr });
      const nx = tr.next;
      if (!nx) { if (dep && tr.p.e) goIn(tr); else add({ k: WAIT, t0: tr.end, t1: tr.end + 45, tr, fade: -1, done: 1 }); break; }
      const gap = nx.start - tr.end;
      if (dep && tr.p.e && nx.p.o && gap > Math.max(WAIT_MAX, runTo(dep, tr.p.s[tr.p.s.length - 1], true).secs + runTo(dep, nx.p.s[0], false).secs + PREP + 1800)) { goIn(tr); goOut(nx); continue; }
      const a = pointAt(tr.p.g, tr.p.d[tr.p.d.length - 1]), b = pointAt(nx.p.g, nx.p.d[0]), far = Math.hypot(b.x - a.x, b.y - a.y);
      const secs = far > (isBus(tr) ? 40 : 300) ? Math.min(far * 1.3 / SPEED.bus + 60, Math.max(gap, 0)) : 0;
      if (secs) add({ k: MOVE, t0: tr.end, t1: tr.end + secs, run: { g: straight(a, b), rev: false, secs }, tr: nx });
      add({ k: WAIT, t0: tr.end + secs, t1: nx.start, tr: nx });
    }
    if (segs.length) out.push({ segs, dep, line: head.p.line, t0: segs[0].t0, t1: segs[segs.length - 1].t1, slot: out.length % 4, a0: dep && head.p.o ? segs[0].t0 : DAY0, a1: dep && tail.p.e ? segs[segs.length - 1].t1 : DAY0 + 86400 });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
let capsFor = null;
function depotCaps(day) {
  if (capsFor !== null || !depots.length) return; capsFor = day;
  const mix = depots.map(() => new Map()), ev = [], n = depots.map(() => 0);
  for (let d = day - 1; d <= day + 1; d++) for (const w of tripsFor(d).work) {
    if (!w.dep) continue;
    mix[w.dep.i].set(w.line, (mix[w.dep.i].get(w.line) || 0) + 1);
    let a = Math.min(w.a0, w.segs[0].t0), b = 0;
    for (const sg of w.segs) { if (sg.t0 > b + 1 && b) { ev.push([d * 86400 + a, 1, w.dep.i], [d * 86400 + b, -1, w.dep.i]); a = sg.t0; } b = sg.t1; }
    ev.push([d * 86400 + a, 1, w.dep.i], [d * 86400 + Math.max(b, w.a1), -1, w.dep.i]);
  }
  ev.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [, s, i] of ev) { n[i] += s; if (n[i] > depots[i].cap) depots[i].cap = n[i]; }
  depots.forEach((dp, i) => { let best = null; for (const [l, c] of mix[i]) { if (!best || c > mix[i].get(best)) best = l; dp.len = Math.max(dp.len, l.length); } if (best) { dp.rgb = best.vrgb; dp.grp = best.group; } });
  baseDirty = true;
}
function yard(d) {
  if (d.k === 'bus') { const cols = Math.max(12, Math.round(Math.sqrt(6 * d.cap))), rows = Math.max(1, Math.ceil(d.cap / cols)); return { cols, rows, w: cols * 4, h: rows * 15, sw: 4, sh: 15, bw: 2.55, bl: 12, across: true }; }
  const rows = Math.min(Math.max(d.cap, 1), 8), cols = Math.max(1, Math.ceil(d.cap / 8)); return { cols, rows, w: cols * (d.len + 10), h: rows * 6, sw: d.len + 10, sh: 6, bw: d.len, bl: 3.2, across: false };
}
const depotOn = d => d.cap && d.grp && d.grp.on;
const slotBox = d => { if (d.sbCap !== d.cap) { let b = null; const h = (d.k === 'bus' ? 12 : d.len) / 2; for (let i = 0; i < Math.min(d.cap, d.slots.length); i++) { const s = d.slots[i]; b = grow(grow(b, s[0] - h, s[1] - h), s[0] + h, s[1] + h); } d.sb = b || depotBox(d); d.sbCap = d.cap; } return d.sb; };
const both = d => { const a = depotBox(d), b = slotBox(d); return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; };
const depotBox = d => { if (d.bb) return d.bb; const y = yard(d); return { x0: d.x - y.w / 2 - 6, y0: d.y - y.h / 2 - 6, x1: d.x + y.w / 2 + 6, y1: d.y + y.h / 2 + 6 }; };
function link(trips) {
  const waiting = new Map(), key = (st, l) => st + '|' + l;
  for (const tr of trips.slice().sort((a, b) => a.end - b.end)) {
    if (!tr.p.e) continue;
    const k = key(tr.p.s[tr.p.s.length - 1], tr.p.line.i);
    if (!waiting.has(k)) waiting.set(k, []);
    waiting.get(k).push(tr);
  }
  for (const dep of trips) {
    if (!dep.p.o) continue;
    const q = waiting.get(key(dep.p.s[0], dep.p.line.i)), i = q ? q.findIndex(a => a.end === dep.start && !a.next) : -1;
    if (i >= 0) { q[i].next = dep; dep.prev = q[i]; }
  }
  for (const dep of trips) {
    if (!dep.p.o || dep.prev) continue;
    const q = waiting.get(key(dep.p.s[0], dep.p.line.i)); if (!q) continue;
    while (q.length && (q[0].next || q[0].end < dep.start - TURN)) q.shift();
    const i = q.findIndex(a => !a.next); if (i < 0 || q[i].end > dep.start) continue;
    q[i].next = dep; dep.prev = q[i];
  }
}
function progress(p, tau) {
  const T = p.t, n = T.length;
  if (tau <= 0) return { s: p.d[0], h: 0, moving: false };
  if (tau >= T[n - 1]) return { s: p.d[n - 1], h: n - 2, moving: false };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= tau) lo = m; else hi = m; }
  const run = T[lo + 1] - T[lo], move = Math.max(run - Math.min(DWELL, run * 0.4), 1);
  let f = Math.min((tau - T[lo]) / move, 1); const moving = f < 1;
  f = f * f * (3 - 2 * f);
  return { s: p.d[lo] + f * (p.d[lo + 1] - p.d[lo]), h: lo, moving };
}
function vehiclesAt(sim) {
  const day = Math.floor(sim / DAY), secs = (sim - day * DAY) / 1000, out = [], count = lines.map(() => 0), bus = { run: 0, wait: 0, dead: 0 }, away = depots.map(() => 0);
  depotCaps(day);
  const segAt = (w, t) => { const S = w.segs; let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].t0 <= t) lo = m; else hi = m - 1; } return t < S[lo].t1 ? S[lo] : null; };
  for (const [dk, t] of [[day - 1, secs + 86400], [day, secs]]) {
    const work = tripsFor(dk).work;
    for (const w of work) if (w.dep && t >= w.a0 && t < w.a1 && !(t >= w.t0 && t < w.t1 && !segAt(w, t))) away[w.dep.i]++;
    for (const w of work) {
      if (w.t0 > t) break;
      if (t >= w.t1) continue;
      const sg = segAt(w, t); if (!sg) continue;
      if (!w.line.group.on) continue;
      const tr = sg.tr, v = { tr, w, sg, t, dir: 1, alpha: 1 }, b = isBus(tr);
      if (sg.k === RUN) { const pr = progress(tr.p, t - tr.start); Object.assign(v, { g: tr.p.g, s: pr.s, h: pr.h, moving: pr.moving, state: 'running' }); count[w.line.i]++; if (b) bus.run++; }
      else if (sg.k === WAIT) {
        Object.assign(v, { g: tr.p.g, s: sg.done ? tr.p.d[tr.p.d.length - 1] : tr.p.d[0] - (b ? 14 + w.slot * 15 : 0), state: sg.done ? 'done' : 'waiting' });
        if (sg.fade) v.alpha = Math.min(Math.max(sg.fade > 0 ? (t - sg.t0) / (sg.t1 - sg.t0) : 1 - (t - sg.t0) / (sg.t1 - sg.t0), 0), 1);
        if (b) bus.wait++;
      } else {
        let f = (t - sg.t0) / (sg.t1 - sg.t0); f = f * f * (3 - 2 * f); const L = sg.run.g.cum[sg.run.g.n - 1];
        Object.assign(v, { g: sg.run.g, s: sg.run.rev ? L * (1 - f) : L * f, dir: sg.run.rev ? -1 : 1, state: 'dead' }); if (b) bus.dead++;
      }
      const pt = pointAt(v.g, v.s); v.x = pt.x; v.y = pt.y; out.push(v);
    }
  }
  bus.park = depots.reduce((n, d) => n + (d.k === 'bus' ? Math.max(d.cap - away[d.i], 0) : 0), 0);
  out.count = count; out.bus = bus; out.away = away;
  return out;
}

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const localNow = () => { const p = {}, d = new Date(); for (const part of fmt.formatToParts(d)) p[part.type] = +part.value; return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + d.getTime() % 1000; };
let live = true, speed = 1, sim = localNow();
const hhmm = s => { s = ((Math.round(s) % 86400) + 86400) % 86400; return String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0'); };

const canvas = el('map'), ctx = canvas.getContext('2d'), base = document.createElement('canvas'), bctx = base.getContext('2d'), panel = el('panel');
let W = 0, H = 0, dpr = 1, baseDirty = true, fitK = 0.02;
const view = { cx: 0, cy: 0, k: 0.02 };
const sx = x => (x - view.cx) * view.k + W / 2, sy = y => (y - view.cy) * view.k + H / 2;
const path = (list, close) => { const p = new Path2D(); for (const a of list) { const g = decode(a); p.moveTo(g.x[0], g.y[0]); for (let i = 1; i < g.n; i++) p.lineTo(g.x[i], g.y[i]); if (close) p.closePath(); } return p; };
const B = D.base, waterPath = path(B.water, true), islandPath = path(B.islands, true), riverPath = path(B.rivers), minorPath = path(B.roadsMinor), majorPath = path(B.roadsMajor), railPath = path(B.rail);
let streetPath = null;
setTimeout(() => { const s = document.createElement('script'); s.src = 'streets.js?v=' + encodeURIComponent(D.meta.built); s.onload = () => { if (window.CITY_STREETS) { streetPath = path(window.CITY_STREETS); baseDirty = true; } }; document.head.appendChild(s); }, 300);
const lineGeoms = lines.map(l => {
  if (l.group.kind === 'rail' || l.group.kind === 'bus') return null;
  const done = new Set(), out = [];
  for (const pt of pats) { if (pt.line !== l || done.has(pt.g)) continue; done.add(pt.g); out.push(pt.g); }
  return out;
});
const trackW = k => Math.min(Math.max(2.6 * k, 1.3), 3.4);
function keepLeft(kind, k) {
  if (kind === 'bus') return Math.max(1.8, 1.2 / k);
  if (kind === 'rail') return (k < 0.3 ? 1.6 : Math.max(0, 1.6 * (0.6 - k) / 0.3)) / k;
  const o = trackW(k) * 0.9 / k;
  return kind === 'tram' ? Math.max(1.75, o) : o;
}
function offsetPath(p, g, o) {
  for (let i = 0; i < g.n; i++) {
    let nx = 0, ny = 0, c = 0;
    if (i > 0) { const dx = g.x[i] - g.x[i - 1], dy = g.y[i] - g.y[i - 1], L = Math.hypot(dx, dy) || 1; nx += dy / L; ny -= dx / L; c++; }
    if (i < g.n - 1) { const dx = g.x[i + 1] - g.x[i], dy = g.y[i + 1] - g.y[i], L = Math.hypot(dx, dy) || 1; nx += dy / L; ny -= dx / L; c++; }
    const L = Math.hypot(nx, ny) || 1, m = c === 2 ? Math.min(2 / L, 2) : 1, x = g.x[i] + nx / L * o * m, y = g.y[i] + ny / L * o * m;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
}
let trackCache = { k: -1, paths: [] };
function trackPaths(k) {
  if (Math.abs(trackCache.k - k) < k * 0.04) return trackCache.paths;
  const paths = lines.map((l, i) => { if (!lineGeoms[i]) return null; const p = new Path2D(), o = keepLeft(l.group.kind, k); for (const g of lineGeoms[i]) offsetPath(p, g, o); return p; });
  trackCache = { k, paths }; return paths;
}
const places = B.places.map(p => ({ name: p[0], x: px(p[1] / Q), y: py(p[2] / Q), rank: p[3] })).sort((a, b) => (a.name === D.meta.name ? -1 : 0) - (b.name === D.meta.name ? -1 : 0) || a.rank - b.rank);
const usedStations = new Set(); for (const p of pats) for (const s of p.s) usedStations.add(s);
const bb = D.meta.bbox, bounds = { x0: px(bb[1]), x1: px(bb[3]), y0: py(bb[2]), y1: py(bb[0]) };

function fit() {
  const r = panel.getBoundingClientRect(), sheet = r.width >= W - 2, left = sheet ? 0 : r.right + 12, bottom = sheet ? H - r.top : 0, m = 30;
  fitK = Math.min((W - left - 2 * m) / (bounds.x1 - bounds.x0), (H - bottom - 2 * m) / (bounds.y1 - bounds.y0));
  view.k = fitK; view.cx = (bounds.x0 + bounds.x1) / 2 - left / (2 * view.k); view.cy = (bounds.y0 + bounds.y1) / 2 + bottom / (2 * view.k);
  baseDirty = true;
}
function resize() {
  dpr = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight;
  for (const c of [canvas, base]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  baseDirty = true;
}
function zoomAt(mx, my, f) {
  const k = Math.min(Math.max(view.k * f, fitK * 0.6), 8), wx = (mx - W / 2) / view.k + view.cx, wy = (my - H / 2) / view.k + view.cy;
  view.k = k; view.cx = wx - (mx - W / 2) / k; view.cy = wy - (my - H / 2) / k; baseDirty = true;
}

function drawBase() {
  const c = bctx, k = view.k;
  baseDirty = false;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = '#f3f1ea'; c.fillRect(0, 0, W, H);
  c.setTransform(k * dpr, 0, 0, k * dpr, (W / 2 - view.cx * k) * dpr, (H / 2 - view.cy * k) * dpr);
  c.lineJoin = c.lineCap = 'round';
  c.fillStyle = '#c9dde8'; c.fill(waterPath); c.fillStyle = '#f3f1ea'; c.fill(islandPath);
  c.strokeStyle = '#c9dde8'; c.lineWidth = Math.max(1.4 / k, 8); c.stroke(riverPath);
  if (k > 0.2) {
    c.strokeStyle = '#d6cfbf';
    if (streetPath) { c.lineWidth = Math.max(8, 2.4 / k); c.stroke(streetPath); }
    c.lineWidth = Math.max(11, 3 / k); c.stroke(minorPath); c.stroke(majorPath);
    c.strokeStyle = '#ffffff';
    if (streetPath) { c.lineWidth = Math.max(5.5, 1.2 / k); c.stroke(streetPath); }
    c.lineWidth = Math.max(8, 1.5 / k); c.stroke(minorPath); c.strokeStyle = '#fbefc9'; c.stroke(majorPath);
  } else {
    if (streetPath && k > 0.06) { c.strokeStyle = '#e4ded1'; c.lineWidth = 0.7 / k; c.stroke(streetPath); }
    c.strokeStyle = '#dbd4c4'; c.lineWidth = 0.9 / k; c.stroke(minorPath); c.strokeStyle = '#cbbf9f'; c.lineWidth = 1.4 / k; c.stroke(majorPath);
  }
  const rail = groups.find(g => g.kind === 'rail');
  if (!rail || rail.on) {
    c.strokeStyle = '#8b8f96';
    if (k < 0.3) { c.lineWidth = 4.2 / k; c.stroke(railPath); c.strokeStyle = '#f3f1ea'; c.lineWidth = 1.6 / k; c.stroke(railPath); }
    else { c.lineWidth = Math.min(Math.max(3 * k, 1.1), 3) / k; c.stroke(railPath); }
  }
  const tw = trackW(k), tp = trackPaths(k);
  lines.forEach((l, i) => { if (!tp[i] || !l.group.on) return; c.strokeStyle = '#ffffff'; c.lineWidth = (tw + 1.6) / k; c.stroke(tp[i]); });
  lines.forEach((l, i) => { if (!tp[i] || !l.group.on) return; c.strokeStyle = 'rgb(' + l.rgb + ')'; c.lineWidth = tw / k; c.stroke(tp[i]); });
  c.lineWidth = 1 / k;
  for (const d of depots) if (depotOn(d)) {
    c.fillStyle = d.k === 'bus' ? '#e2ddd0' : '#dde2e8'; c.strokeStyle = d.k === 'bus' ? '#a8a08e' : '#97a1ab';
    if (d.site) { c.beginPath(); c.moveTo(d.site.x[0], d.site.y[0]); for (let j = 1; j < d.site.n; j++) c.lineTo(d.site.x[j], d.site.y[j]); c.closePath(); c.fill(); c.stroke(); }
    else if (d.tracks.length) { c.lineWidth = Math.max(1.5 / k, 2); for (const g of d.tracks) { c.beginPath(); c.moveTo(g.x[0], g.y[0]); for (let j = 1; j < g.n; j++) c.lineTo(g.x[j], g.y[j]); c.stroke(); } c.lineWidth = 1 / k; }
    else { const b = depotBox(d); c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); }
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const r = Math.min(Math.max(k * 40, 1.6), 5);
  stations.forEach((s, i) => {
    if (!usedStations.has(i) || !groups[s.group].on) return;
    const X = sx(s.x), Y = sy(s.y); if (X < -10 || X > W + 10 || Y < -10 || Y > H + 10) return;
    if (groups[s.group].kind === 'bus') { if (k > 0.6) { c.fillStyle = '#8f8a7e'; c.fillRect(X - 1.5, Y - 1.5, 3, 3); } return; }
    c.beginPath(); c.arc(X, Y, groups[s.group].kind === 'rail' ? r * 0.9 : r, 0, 7); c.fillStyle = '#ffffff'; c.fill(); c.lineWidth = r > 3 ? 1.5 : 1; c.strokeStyle = groups[s.group].kind === 'rail' ? '#5b616b' : '#1b1d21'; c.stroke();
  });
  const pr = panel.getBoundingClientRect(), placed = [{ x0: pr.left, y0: pr.top, x1: pr.right + 4, y1: pr.bottom + 4 }];
  const label = (text, X, Y, font, fill, halo, dx) => {
    c.font = font; const w = c.measureText(text).width;
    for (const x of dx === 0 ? [X - w / 2] : [X + dx, X - dx - w]) {
      const b = { x0: x - 2, y0: Y - 8, x1: x + w + 2, y1: Y + 8 };
      if (b.x0 < 2 || b.x1 > W - 2 || b.y0 < 2 || b.y1 > H - 2 || placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
      placed.push(b); c.lineWidth = 3; c.strokeStyle = halo; c.strokeText(text, x, Y); c.fillStyle = fill; c.fillText(text, x, Y); return;
    }
  };
  c.textBaseline = 'middle'; c.lineJoin = 'round';
  if (k > 0.011) for (const d of depots) if (depotOn(d)) { const b = !d.slots.length ? depotBox(d) : d.site ? both(d) : slotBox(d); label(d.name + ' depot', sx((b.x0 + b.x1) / 2), Math.max(sy(b.y1), sy(d.y) + 4) + 10, '600 11px system-ui, Segoe UI, Arial, sans-serif', d.k === 'bus' ? '#5a4a2a' : '#3a4652', '#f3f1ea', 0); }
  if (k > 0.06) stations.forEach((s, i) => { if (usedStations.has(i) && groups[s.group].on && groups[s.group].kind !== 'rail' && groups[s.group].kind !== 'bus') label(s.name, sx(s.x), sy(s.y), '600 11px system-ui, Segoe UI, Arial, sans-serif', '#1b1d21', '#ffffff', 7); });
  if (k > 0.1) stations.forEach((s, i) => { if (usedStations.has(i) && groups[s.group].on && groups[s.group].kind === 'rail') label(s.name, sx(s.x), sy(s.y), '11px system-ui, Segoe UI, Arial, sans-serif', '#3d424a', '#ffffff', 7); });
  const minRank = k < 0.005 ? 1 : k < 0.03 ? 2 : k < 0.12 ? 3 : 4;
  for (const p of places) if (p.rank < minRank) label(p.rank < 2 ? p.name.toUpperCase() : p.name, sx(p.x), sy(p.y), (p.rank === 0 ? '700 13px' : p.rank === 1 ? '600 11px' : '10px') + ' system-ui, Segoe UI, Arial, sans-serif', '#8a8373', '#f3f1ea', 0);
}

let vehicles = [];
function drawVehicles() {
  const k = view.k;
  ctx.lineJoin = 'round';
  for (const d of depots) {
    if (!depotOn(d)) continue;
    const parked = Math.max(d.cap - (vehicles.away ? vehicles.away[d.i] : 0), 0);
    if (d.slots.length) {
      const b = both(d); if (!parked || sx(b.x0) > W || sy(b.y0) > H || sx(b.x1) < 0 || sy(b.y1) < 0) continue;
      const n = Math.min(parked, d.slots.length), L = d.k === 'bus' ? 12 : d.len, Wd = d.k === 'bus' ? 2.55 : 3.2;
      ctx.fillStyle = 'rgba(' + d.rgb + ',0.9)';
      if (L * k < 3) { for (let i = 0; i < n; i++) ctx.fillRect(sx(d.slots[i][0]) - 1, sy(d.slots[i][1]) - 1, 2, 2); continue; }
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const [x, y, a] = d.slots[i], ca = Math.cos(a), sa = Math.sin(a), hx = ca * L / 2, hy = sa * L / 2, wx = -sa * Wd / 2, wy = ca * Wd / 2;
        ctx.moveTo(sx(x - hx - wx), sy(y - hy - wy)); ctx.lineTo(sx(x + hx - wx), sy(y + hy - wy)); ctx.lineTo(sx(x + hx + wx), sy(y + hy + wy)); ctx.lineTo(sx(x - hx + wx), sy(y - hy + wy)); ctx.closePath();
      }
      ctx.fill(); continue;
    }
    const y = yard(d), n = Math.min(parked, y.cols * y.rows), x0 = d.x - y.w / 2, y0 = d.y - y.h / 2;
    if (!n || sx(x0) > W || sy(y0) > H || sx(x0 + y.w) < 0 || sy(y0 + y.h) < 0) continue;
    ctx.fillStyle = 'rgba(' + d.rgb + ',0.85)';
    if (Math.min(y.sw, y.sh) * k < 1.2) { const f = n / (y.cols * y.rows); ctx.fillRect(sx(x0), sy(y0 + y.h * (1 - f)), Math.max(y.w * k, 2), Math.max(y.h * f * k, 1.5)); continue; }
    for (let i = 0; i < n; i++) {
      const cl = y.across ? i % y.cols : Math.floor(i / y.rows), r = y.across ? y.rows - 1 - Math.floor(i / y.cols) : i % y.rows;
      ctx.fillRect(sx(x0 + cl * y.sw + (y.across ? 0.7 : 5)), sy(y0 + r * y.sh + 1.4), y.bw * k, y.bl * k);
    }
  }
  const dot = Math.min(Math.max(k * 60, 2.4), 4), off = {};
  for (const g of groups) off[g.kind] = keepLeft(g.kind, k);
  const at = (v, s) => { const q = pointAt(v.g, s), o = off[v.w ? v.w.line.group.kind : v.tr.p.line.group.kind] * v.dir; return { x: q.x + Math.sin(q.a) * o, y: q.y - Math.cos(q.a) * o }; };
  if (k < 0.15) for (const v of vehicles) {
    if (!v.w) continue;
    const q = at(v, v.s), X = sx(q.x), Y = sy(q.y); if (X < -4 || X > W + 4 || Y < -4 || Y > H + 4) continue;
    const rgb = 'rgb(' + v.w.line.vrgb + ')';
    ctx.globalAlpha = v.alpha * (v.state === 'waiting' ? 0.55 : 1); ctx.fillStyle = v.state === 'dead' ? '#ffffff' : rgb; ctx.fillRect(X - dot / 2, Y - dot / 2, dot, dot);
    ctx.lineWidth = v.state === 'dead' ? 1 : 0.6; ctx.strokeStyle = v.state === 'dead' ? rgb : 'rgba(27,29,33,0.55)'; ctx.strokeRect(X - dot / 2, Y - dot / 2, dot, dot);
  }
  ctx.globalAlpha = 1;
  const order = vehicles.filter(v => v.w).concat(vehicles.filter(v => !v.w));
  for (const v of order) {
    if (k < 0.15 && v.w) continue;
    const l = v.w ? v.w.line : v.tr.p.line, N = l.sections, low = k < 0.05, dead = v.state === 'dead';
    const U = Math.max(l.length * k, low ? 4 : 7), Wd = low ? 3 : Math.min(Math.max(3.2 * k, 3.5), 9);
    const X0 = sx(v.x), Y0 = sy(v.y); if (X0 < -U || X0 > W + U || Y0 < -U || Y0 > H + U) continue;
    const pts = []; for (let i = 0; i <= N; i++) { const q = at(v, v.s + v.dir * (U / 2 - U * i / N) / k); pts.push([sx(q.x), sy(q.y)]); }
    ctx.globalAlpha = v.alpha * (v.w && v.state === 'waiting' ? 0.6 : 1); ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i <= N; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineCap = 'round';
    if (low) { ctx.lineWidth = Wd + 1.6; ctx.strokeStyle = '#ffffff'; ctx.stroke(); ctx.lineWidth = Wd; ctx.strokeStyle = 'rgb(' + l.vrgb + ')'; ctx.stroke(); ctx.globalAlpha = 1; continue; }
    ctx.lineWidth = Wd + 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.lineWidth = Wd; ctx.strokeStyle = dead ? 'rgb(' + l.vrgb + ')' : '#1b1d21'; ctx.stroke();
    ctx.lineWidth = Wd - 2; ctx.strokeStyle = dead ? '#ffffff' : 'rgb(' + l.vrgb + ')'; ctx.stroke();
    if (U / N >= 11) for (let i = 1; i < N; i++) {
      const dx = pts[i + 1][0] - pts[i - 1][0], dy = pts[i + 1][1] - pts[i - 1][1], L = Math.hypot(dx, dy) || 1, w = Wd / 2 - 1;
      ctx.beginPath(); ctx.moveTo(pts[i][0] + dy / L * w, pts[i][1] - dx / L * w); ctx.lineTo(pts[i][0] - dy / L * w, pts[i][1] + dx / L * w); ctx.lineCap = 'butt'; ctx.lineWidth = 1.2; ctx.strokeStyle = '#1b1d21'; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], Math.max(Wd * 0.2, 1), 0, 7); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.globalAlpha = 1;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
document.title = D.meta.title;
el('title').textContent = D.meta.title;
el('notes').innerHTML = (D.meta.notes || []).map(n => '<li>' + n + '</li>').join('');
el('credit').textContent = D.meta.credit;
el('legend').innerHTML = groups.map(g => {
  const rows = lines.filter(l => l.group === g).map(l => '<tr><td><span class="sw" style="background:rgb(' + l.rgb + ')">' + (l.vrgb !== l.rgb ? '<i style="background:rgb(' + l.vrgb + ')"></i>' : '') + '</span>' + l.name + '</td><td class="n" id="ln-' + l.i + '">0</td></tr>').join('');
  const status = g.kind === 'bus' ? '<table class="status">' + [['run', 'In service'], ['wait', 'Waiting at a stop'], ['dead', 'Running empty'], ['park', 'In a depot']].map(r => '<tr><td>' + r[1] + '</td><td class="n" id="bs-' + r[0] + '">0</td></tr>').join('') + '</table>' : '';
  return '<div class="sect"><label class="check"><input type="checkbox" data-group="' + g.i + '" checked><span>' + g.name + '</span></label><table>' + rows + '</table>' + status + '</div>';
}).join('');
el('legend').addEventListener('change', e => { const g = groups[+e.target.dataset.group]; if (!g) return; g.on = e.target.checked; baseDirty = true; });

let scrubbing = false;
function updatePanel() {
  const d = new Date(sim), secs = Math.floor((sim % DAY) / 1000);
  el('clock').textContent = DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + hhmm(secs) + ':' + String(secs % 60).padStart(2, '0');
  el('clockmode').textContent = live ? 'UK time now' : speed === 0 ? 'Paused' : 'Simulated, ' + speed + '× speed';
  if (!scrubbing) el('time').value = secs;
  if (document.activeElement !== el('date')) el('date').value = d.toISOString().slice(0, 10);
  el('now').setAttribute('aria-pressed', live);
  for (const b of el('speeds').children) b.setAttribute('aria-pressed', !live && +b.dataset.speed === speed);
  lines.forEach(l => { el('ln-' + l.i).textContent = vehicles.count ? vehicles.count[l.i] : 0; });
  if (vehicles.bus && el('bs-run')) for (const k of ['run', 'wait', 'dead', 'park']) el('bs-' + k).textContent = vehicles.bus[k].toLocaleString('en-GB');
  const b = borrowed.get(Math.floor(sim / DAY)) || [];
  el('borrowed').textContent = b.length ? 'No timetable for this date in the data for ' + b.join(', ') + ': that day’s is shown.' : '';
}
const setSim = ms => { live = false; sim = ms; };
el('now').addEventListener('click', () => { live = true; speed = 1; });
el('speeds').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; live = false; speed = +b.dataset.speed; });
el('day').addEventListener('click', () => { setSim(Math.floor(sim / DAY) * DAY + 3 * 3600000); speed = 1200; });
el('date').addEventListener('change', e => { const v = e.target.value.split('-').map(Number); if (v.length === 3 && v[0]) setSim(Date.UTC(v[0], v[1] - 1, v[2]) + sim % DAY); });
el('time').addEventListener('input', e => { scrubbing = true; setSim(Math.floor(sim / DAY) * DAY + e.target.value * 1000); });
el('time').addEventListener('change', () => { scrubbing = false; });

el('more').addEventListener('click', e => { const c = panel.classList.toggle('collapsed'); e.target.textContent = c ? 'More' : 'Less'; e.target.setAttribute('aria-expanded', !c); baseDirty = true; });

const tip = el('tip'), touches = new Map();
let tap = null;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId); touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tap = touches.size === 1 ? { x: e.clientX, y: e.clientY } : null; canvas.classList.add('drag'); tip.style.display = 'none';
});
canvas.addEventListener('pointermove', e => {
  const p = touches.get(e.pointerId);
  if (!p) { showTip(e.clientX, e.clientY); return; }
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
  const [a, b] = touches.values(), two = touches.size > 1;
  const m0 = two ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : [p.x, p.y], d0 = two ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  p.x = e.clientX; p.y = e.clientY;
  const m1 = two ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : [p.x, p.y], d1 = two ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  view.cx -= (m1[0] - m0[0]) / view.k; view.cy -= (m1[1] - m0[1]) / view.k; baseDirty = true;
  if (two && d0 > 0) zoomAt(m1[0], m1[1], d1 / d0);
});
const lift = e => { touches.delete(e.pointerId); if (!touches.size) canvas.classList.remove('drag'); };
canvas.addEventListener('pointerup', e => { lift(e); if (tap && !touches.size) showTip(e.clientX, e.clientY); tap = null; });
canvas.addEventListener('pointercancel', e => { lift(e); tap = null; });
canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') tip.style.display = 'none'; });
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
canvas.addEventListener('dblclick', e => zoomAt(e.clientX, e.clientY, 2));
el('zin').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.5));
el('zout').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.5));
el('zfit').addEventListener('click', fit);
window.addEventListener('resize', () => { const had = W && H; resize(); if (!had) fit(); });

function describe(v) {
  const p = v.tr.p, name = i => stations[p.s[i]].name, at = i => hhmm(v.tr.start + p.t[i]), last = p.s.length - 1;
  const num = p.n ? (/^\w{1,5}$/.test(p.n) ? 'Bus ' + p.n : p.n) : p.line.name;
  if (v.state === 'dead') return '<b>' + p.line.name + '</b>, not in service<br>' + (v.sg.k === OUT ? 'Out of ' + v.w.dep.name + ' depot for the ' + at(0) + ' ' + num + ' from ' + name(0) : v.sg.k === IN ? 'Back to ' + v.w.dep.name + ' depot after the ' + hhmm(v.tr.start) + ' ' + num : 'To ' + name(0) + ' for the ' + at(0) + ' ' + num);
  const head = '<b>' + num + '</b>' + (p.s[0] === p.s[last] ? '' : ' to ' + name(last)) + (p.n ? '<br>' + p.line.name : '');
  if (v.state === 'waiting') return head + '<br>At ' + name(0) + ', departs ' + at(0);
  if (v.state === 'done') return head + '<br>Arrived at ' + name(last) + ' ' + at(last);
  if (v.moving) return head + '<br>Next stop ' + name(v.h + 1) + ' ' + at(v.h + 1);
  return head + '<br>At ' + name(v.h + 1) + (v.h + 1 < last ? ', departs ' + at(v.h + 1) : '');
}
function showTip(mx, my) {
  let html = '', bd = 12 * 12;
  for (const v of vehicles) { const dx = sx(v.x) - mx, dy = sy(v.y) - my, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; html = describe(v); } }
  if (!html) for (const d of depots) {
    if (!depotOn(d)) continue; const b = depotBox(d);
    if (mx >= Math.min(sx(b.x0), sx(d.x) - 6) - 4 && mx <= Math.max(sx(b.x1), sx(d.x) + 6) + 4 && my >= Math.min(sy(b.y0), sy(d.y) - 6) - 4 && my <= Math.max(sy(b.y1), sy(d.y) + 6) + 4) html = '<b>' + d.name + ' depot</b><br>' + Math.max(d.cap - (vehicles.away ? vehicles.away[d.i] : 0), 0) + ' of ' + d.cap + (d.k === 'bus' ? ' buses in' : ' trains in');
  }
  if (!html) { let sd = 8 * 8; stations.forEach((s, i) => { if (!usedStations.has(i) || !groups[s.group].on || (groups[s.group].kind === 'bus' && view.k <= 0.6)) return; const dx = sx(s.x) - mx, dy = sy(s.y) - my, d2 = dx * dx + dy * dy; if (d2 < sd) { sd = d2; html = '<b>' + s.name + '</b>'; } }); }
  if (!html) { tip.style.display = 'none'; return; }
  tip.innerHTML = html; tip.style.display = 'block';
  tip.style.left = Math.min(mx + 14, W - tip.offsetWidth - 8) + 'px'; tip.style.top = Math.max(my - tip.offsetHeight - 10, 8) + 'px';
}

let lastFrame = 0, lastUi = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!base.width || !base.height) return;
  const dt = Math.min(lastFrame ? now - lastFrame : 0, 250); lastFrame = now;
  if (live) sim = localNow(); else sim += dt * speed;
  if (baseDirty) drawBase();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vehicles = vehiclesAt(sim); drawVehicles();
  if (now - lastUi > 250) { updatePanel(); lastUi = now; }
}
resize(); fit(); requestAnimationFrame(frame);
})();
