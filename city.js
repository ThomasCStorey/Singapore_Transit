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
const lines = D.lines.map((l, i) => ({ i, name: l.name, rgb: l.colour, group: groups[l.group], length: l.length, sections: l.sections }));
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
    for (const start of r.t) { const k = r.p + '@' + start; if (seen.has(k)) continue; seen.add(k); out.push({ p, start, end: start + p.dur }); }
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
  link(out);
  tripCache.set(dk, out);
  return out;
}
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
  const day = Math.floor(sim / DAY), secs = (sim - day * DAY) / 1000, out = [], count = lines.map(() => 0);
  for (const [dk, t] of [[day - 1, secs + 86400], [day, secs]]) {
    for (const tr of tripsFor(dk)) {
      if (tr.start - TURN - 120 > t) break;
      const from = tr.prev ? Math.min(tr.prev.end, tr.start) : tr.start - 60, to = tr.next ? tr.end : tr.end + 45;
      if (t < from || t >= to) continue;
      const line = tr.p.line; if (!line.group.on) continue;
      const pr = progress(tr.p, t - tr.start), pt = pointAt(tr.p.g, pr.s);
      const alpha = t < tr.start && !tr.prev ? 1 + (t - tr.start) / 60 : t > tr.end && !tr.next ? 1 - (t - tr.end) / 45 : 1;
      if (t >= tr.start && t < tr.end) count[line.i]++;
      out.push({ tr, t, s: pr.s, h: pr.h, moving: pr.moving, x: pt.x, y: pt.y, alpha: Math.min(Math.max(alpha, 0), 1), state: t < tr.start ? 'waiting' : t >= tr.end ? 'done' : 'running' });
    }
  }
  out.count = count;
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
const linePaths = lines.map(l => {
  if (l.group.kind === 'rail' || l.group.kind === 'bus') return null;
  const p = new Path2D(), done = new Set();
  for (const pt of pats) { if (pt.line !== l || done.has(pt.g)) continue; done.add(pt.g); const g = pt.g; p.moveTo(g.x[0], g.y[0]); for (let i = 1; i < g.n; i++) p.lineTo(g.x[i], g.y[i]); }
  return p;
});
const places = B.places.map(p => ({ name: p[0], x: px(p[1] / Q), y: py(p[2] / Q), rank: p[3] })).sort((a, b) => (a.name === D.meta.name ? -1 : 0) - (b.name === D.meta.name ? -1 : 0) || a.rank - b.rank);
const usedStations = new Set(); for (const p of pats) for (const s of p.s) usedStations.add(s);
const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
for (const s of stations) { bounds.x0 = Math.min(bounds.x0, s.x); bounds.x1 = Math.max(bounds.x1, s.x); bounds.y0 = Math.min(bounds.y0, s.y); bounds.y1 = Math.max(bounds.y1, s.y); }

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
  if (k > 0.2) { c.strokeStyle = '#d6cfbf'; c.lineWidth = Math.max(11, 3 / k); c.stroke(minorPath); c.stroke(majorPath); c.strokeStyle = '#ffffff'; c.lineWidth = Math.max(8, 1.5 / k); c.stroke(minorPath); c.strokeStyle = '#fbefc9'; c.stroke(majorPath); }
  else { c.strokeStyle = '#dbd4c4'; c.lineWidth = 0.9 / k; c.stroke(minorPath); c.strokeStyle = '#cbbf9f'; c.lineWidth = 1.4 / k; c.stroke(majorPath); }
  const rail = groups.find(g => g.kind === 'rail');
  if (!rail || rail.on) { c.strokeStyle = '#8b8f96'; c.lineWidth = Math.min(Math.max(3 * k, 1.1), 3) / k; c.stroke(railPath); }
  const lw = Math.min(Math.max(5 * k, 2.2), 6);
  lines.forEach((l, i) => { if (!linePaths[i] || !l.group.on) return; c.strokeStyle = '#ffffff'; c.lineWidth = (lw + 2) / k; c.stroke(linePaths[i]); });
  lines.forEach((l, i) => { if (!linePaths[i] || !l.group.on) return; c.strokeStyle = 'rgb(' + l.rgb + ')'; c.lineWidth = lw / k; c.stroke(linePaths[i]); });
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
  if (k > 0.06) stations.forEach((s, i) => { if (usedStations.has(i) && groups[s.group].on && groups[s.group].kind !== 'rail' && groups[s.group].kind !== 'bus') label(s.name, sx(s.x), sy(s.y), '600 11px system-ui, Segoe UI, Arial, sans-serif', '#1b1d21', '#ffffff', 7); });
  if (k > 0.1) stations.forEach((s, i) => { if (usedStations.has(i) && groups[s.group].on && groups[s.group].kind === 'rail') label(s.name, sx(s.x), sy(s.y), '11px system-ui, Segoe UI, Arial, sans-serif', '#3d424a', '#ffffff', 7); });
  const minRank = k < 0.005 ? 1 : k < 0.03 ? 2 : k < 0.12 ? 3 : 4;
  for (const p of places) if (p.rank < minRank) label(p.rank < 2 ? p.name.toUpperCase() : p.name, sx(p.x), sy(p.y), (p.rank === 0 ? '700 13px' : p.rank === 1 ? '600 11px' : '10px') + ' system-ui, Segoe UI, Arial, sans-serif', '#8a8373', '#f3f1ea', 0);
}

let vehicles = [];
function drawVehicles() {
  const k = view.k;
  ctx.lineJoin = 'round';
  const dot = Math.min(Math.max(k * 60, 2.4), 4);
  if (k < 0.15) for (const v of vehicles) {
    if (v.tr.p.line.group.kind !== 'bus') continue;
    const X = sx(v.x), Y = sy(v.y); if (X < -4 || X > W + 4 || Y < -4 || Y > H + 4) continue;
    ctx.globalAlpha = v.alpha; ctx.fillStyle = 'rgb(' + v.tr.p.line.rgb + ')'; ctx.fillRect(X - dot / 2, Y - dot / 2, dot, dot);
    ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(27,29,33,0.55)'; ctx.strokeRect(X - dot / 2, Y - dot / 2, dot, dot);
  }
  ctx.globalAlpha = 1;
  const order = vehicles.filter(v => v.tr.p.line.group.kind === 'bus').concat(vehicles.filter(v => v.tr.p.line.group.kind !== 'bus'));
  for (const v of order) {
    if (k < 0.15 && v.tr.p.line.group.kind === 'bus') continue;
    const l = v.tr.p.line, N = l.sections, low = k < 0.05;
    const U = Math.max(l.length * k, low ? 4 : 7), Wd = low ? 3 : Math.min(Math.max(3.2 * k, 3.5), 9);
    const X0 = sx(v.x), Y0 = sy(v.y); if (X0 < -U || X0 > W + U || Y0 < -U || Y0 > H + U) continue;
    const pts = []; for (let i = 0; i <= N; i++) { const q = pointAt(v.tr.p.g, v.s + (U / 2 - U * i / N) / k); pts.push([sx(q.x), sy(q.y)]); }
    ctx.globalAlpha = v.alpha; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i <= N; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineCap = 'round';
    if (low) { ctx.lineWidth = Wd + 1.6; ctx.strokeStyle = '#ffffff'; ctx.stroke(); ctx.lineWidth = Wd; ctx.strokeStyle = 'rgb(' + l.rgb + ')'; ctx.stroke(); ctx.globalAlpha = 1; continue; }
    ctx.lineWidth = Wd + 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.lineWidth = Wd; ctx.strokeStyle = '#1b1d21'; ctx.stroke();
    ctx.lineWidth = Wd - 2; ctx.strokeStyle = 'rgb(' + l.rgb + ')'; ctx.stroke();
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
  const rows = lines.filter(l => l.group === g).map(l => '<tr><td><span class="sw" style="background:rgb(' + l.rgb + ')"></span>' + l.name + '</td><td class="n" id="ln-' + l.i + '">0</td></tr>').join('');
  return '<div class="sect"><label class="check"><input type="checkbox" data-group="' + g.i + '" checked><span>' + g.name + '</span></label><table>' + rows + '</table></div>';
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
  const head = '<b>' + (p.n ? (/^\w{1,5}$/.test(p.n) ? 'Bus ' + p.n : p.n) : p.line.name) + '</b>' + (p.s[0] === p.s[last] ? '' : ' to ' + name(last)) + (p.n ? '<br>' + p.line.name : '');
  if (v.state === 'waiting') return head + '<br>At ' + name(0) + ', departs ' + at(0);
  if (v.state === 'done') return head + '<br>Arrived at ' + name(last) + ' ' + at(last);
  if (v.moving) return head + '<br>Next stop ' + name(v.h + 1) + ' ' + at(v.h + 1);
  return head + '<br>At ' + name(v.h + 1) + (v.h + 1 < last ? ', departs ' + at(v.h + 1) : '');
}
function showTip(mx, my) {
  let html = '', bd = 12 * 12;
  for (const v of vehicles) { const dx = sx(v.x) - mx, dy = sy(v.y) - my, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; html = describe(v); } }
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
