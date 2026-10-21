// Motore TutorAlert: traduzione fedele di TutorTracker.kt e collegati (app Android "a1").
// Funziona sia nel browser sia in Node (per i confronti con la versione Kotlin).

// ---------- Geo (ellissoide WGS84, raggi locali) ----------
const A = 6378137.0, E2 = 0.00669437999014, DEG = Math.PI / 180;
export const Geo = {
  mLat(lat) { const s = Math.sin(lat * DEG), w = 1 - E2 * s * s; return A * (1 - E2) / (w * Math.sqrt(w)) * DEG; },
  mLon(lat) { const s = Math.sin(lat * DEG); return A / Math.sqrt(1 - E2 * s * s) * Math.cos(lat * DEG) * DEG; },
  M_LAT: 111070.0,
  dist(lat1, lon1, lat2, lon2) {
    const lm = (lat1 + lat2) / 2;
    const dy = (lat2 - lat1) * Geo.mLat(lm), dx = (lon2 - lon1) * Geo.mLon(lm);
    return Math.sqrt(dx * dx + dy * dy);
  },
  bearing(lat1, lon1, lat2, lon2) {
    const f1 = lat1 * DEG, f2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
    const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  },
  angleDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; },
};
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const headingOk = (a, b, tol) => Math.abs(Geo.angleDiff(a, b)) <= tol;

// ---------- Polyline (Google, 1e-5) ----------
export function decode(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; result += (b & 0x1f) * 2 ** shift; shift += 5; } while (b >= 0x20 && i < str.length);
      const delta = result % 2 === 1 ? -(result + 1) / 2 : result / 2;
      if (k === 0) lat += delta; else lon += delta;
    }
    out.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return out;
}

// ---------- Tracciato in coordinate piane locali ----------
export class Track {
  constructor(points) {
    this.points = points.length >= 2 ? points : [points[0], points[0]];
    this.lat0 = this.points[0].lat; this.lon0 = this.points[0].lon;
    this.kx = Geo.mLon(this.lat0); this.ky = Geo.mLat(this.lat0);
    const clean = [];
    for (const p of this.points) { const l = clean[clean.length - 1]; if (!l || l.lat !== p.lat || l.lon !== p.lon) clean.push(p); }
    if (clean.length === 1) clean.push(clean[0]);
    this.xs = clean.map(p => (p.lon - this.lon0) * this.kx);
    this.ys = clean.map(p => (p.lat - this.lat0) * this.ky);
    this.cum = [0];
    for (let i = 1; i < clean.length; i++) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
    this.length = this.cum[this.cum.length - 1];
  }
  project(lat, lon, hintS = null, windowM = 3000) {
    const px = (lon - this.lon0) * this.kx, py = (lat - this.lat0) * this.ky;
    const { xs, ys, cum } = this; const n = xs.length - 1;
    let best = null, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (hintS != null && (cum[i + 1] < hintS - windowM || cum[i] > hintS + windowM)) continue;
      const ax = xs[i], ay = ys[i], dx = xs[i + 1] - ax, dy = ys[i + 1] - ay, segLen = cum[i + 1] - cum[i];
      if (segLen <= 0) continue;
      let t = ((px - ax) * dx + (py - ay) * dy) / (segLen * segLen);
      const open = (i === 0 && t < 0) || (i === n - 1 && t > 1);
      if (!open) t = clamp(t, 0, 1);
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) { bestD = d; best = { s: cum[i] + t * segLen, lateral: d, bearing: (Math.atan2(dx, dy) / DEG + 360) % 360 }; }
    }
    return best ?? (hintS != null ? this.project(lat, lon, null) : { s: 0, lateral: Number.MAX_VALUE, bearing: 0 });
  }
}

// ---------- Taglio del tracciato sui portali (Calibrate.kt) ----------
function cumulative(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + Geo.dist(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon); return c; }
function pointAt(pts, cum, s) {
  const n = pts.length;
  let i; if (s <= 0) i = 0; else if (s >= cum[n - 1]) i = n - 2; else { i = 0; while (!(cum[i + 1] >= s)) i++; }
  const a = pts[i], b = pts[i + 1], seg = Math.max(cum[i + 1] - cum[i], 1e-6), f = (s - cum[i]) / seg;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}
export function reslice(pts, start, end) {
  if (pts.length < 2) return pts;
  const tr = new Track(pts);
  const s0 = tr.project(start.lat, start.lon).s, s1 = tr.project(end.lat, end.lon).s;
  if (s1 - s0 < 100) return pts;
  const cum = cumulative(pts);
  const out = [pointAt(pts, cum, s0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > s0 + 1 && cum[i] < s1 - 1) out.push(pts[i]);
  out.push(pointAt(pts, cum, s1));
  return out;
}
// Il Kotlin ricodifica il tracciato (arrotondamento a 1e-5) prima di usarlo: lo stesso qui.
const round5 = p => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 });

// ---------- Nomi brevi ----------
export function shortName(name, road) {
  const roadBase = (road || '').split(' ')[0].trim();
  let n = name.trim();
  const m = n.match(/^All\.\s*(A\d+)-(A\d+)(.*)$/);
  if (m) { const other = m[1] === roadBase ? m[2] : m[1]; return ('Allacc. ' + other + m[3]).trim(); }
  if (roadBase) { if (n.endsWith('-' + roadBase)) n = n.slice(0, -roadBase.length - 1); else if (n.endsWith(' ' + roadBase)) n = n.slice(0, -roadBase.length - 1); }
  return n.replace('All. Diramazione ', 'Dir. ').replace('Diramazione ', 'Dir. ').replace('All. Superstrada ', '').replace('Zona Industriale', 'Z.I.').trim();
}

// ---------- Tratta pronta per il tracciamento (Repo.build + TrackedSection) ----------
export class Section {
  /** s: voce di a1_sections.json; i portali "verificato" usano la formula del Tutor. */
  constructor(s) {
    this.id = s.id; this.json = s;
    const startOk = s.startSource === 'verificato', endOk = s.endSource === 'verificato';
    this.portalsMeasured = startOk && endOk;
    let pts = decode(s.geometry);
    if (startOk || endOk) pts = reslice(pts, s.start, s.end).map(round5);
    this.track = new Track(pts);
    this.hasGeometry = pts.length >= 2;
    this.limitKmh = s.limit ?? null;
    this.reliability = this.portalsMeasured ? 'HIGH' : s.reliability;
    this.officialLength = s.lengthM > 0 ? s.lengthM : this.track.length;
    const r = this.track.length / this.officialLength;
    this.measureOnTrack = !this.portalsMeasured && this.hasGeometry && this.officialLength > 0 && r >= 1.0 && r <= 1.15;
    this.measureLength = this.measureOnTrack ? this.track.length : this.officialLength;
    this.start = s.start; // il portale di inizio del database, come nel Kotlin
    this.label = shortName(s.from, s.road) + ' → ' + shortName(s.to, s.road);
    const lats = this.track.points.map(p => p.lat), lons = this.track.points.map(p => p.lon);
    this.box = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  }
  measured(s) { const c = clamp(s, 0, this.track.length); return this.measureOnTrack ? c : c / Math.max(this.track.length, 1) * this.officialLength; }
  nearBox(lat, lon, m) {
    const dLat = m / Geo.M_LAT, dLon = m / Geo.mLon(lat), [a, b, c, d] = this.box;
    return lat >= a - dLat && lat <= b + dLat && lon >= c - dLon && lon <= d + dLon;
  }
}

// ---------- Regole sulla media (SpeedPolicy, tolleranza di legge) ----------
export const Policy = {
  effectiveLimit: l => l ?? null,
  tolerance: l => (l <= 100 ? 5 : l * 0.05),
  allowed: l => l + Policy.tolerance(l),
  margin(rel, len, v) {
    const [sigma, min] = rel === 'MEDIUM' ? [75, 1] : rel === 'LOW' ? [200, 2] : [25, 0];
    if (len <= 0) return 6;
    return clamp(v * sigma / len, min, 6);
  },
  target(l, rel, len) { const base = Policy.allowed(l); return Math.max(1, base - Policy.margin(rel, len, base)); },
};

// ---------- TutorTracker ----------
export const Config = {
  startCorridorM: 70, startCorridorStraightM: 150, leaveCorridorM: 160, leaveCorridorStraightM: 450,
  leaveAfterMs: 20000, farM: 2000, farCloseAfterMs: 60000, rejoinBackM: 300, headingToleranceDeg: 50,
  candidateRadiusM: 2500, timeoutMinKmh: 15, timeoutMinMs: 30 * 60000, minMetersForAverage: 20,
  minRecoverKmh: 50, maxAccuracyM: 50, confirmAfterM: 200, hysteresisKmh: 1.5, levelDownAfterMs: 20000,
  speedSmoothingS: 5, insideCheckMs: 180000,
};
const LEVELS = { OK: 0, CAUTION: 1, OVER: 2 };

export class Tracker {
  constructor(sections = [], config = Config) { this.config = config; this.reset(); this.setSections(sections); }
  setSections(list) {
    this.sections = list;
    const ids = new Set(list.map(s => s.id));
    for (const k of [...this.probes.keys()]) if (!ids.has(k)) this.probes.delete(k);
    if (this.active && !ids.has(this.active.ts.id)) this.active = null;
  }
  reset() { this.active = null; this.probes = new Map(); this.lastFix = null; this.lastSeenMs = null; this.sessionStartMs = null; this.insideNotified = new Set(); }

  /** fix: {lat, lon, speedMps, bearingDeg, accuracyM, timeMs} */
  update(fix) {
    const C = this.config, events = [];
    if (this.sessionStartMs == null) this.sessionStartMs = fix.timeMs;
    this.lastSeenMs = fix.timeMs;
    const reliable = (fix.accuracyM ?? 0) <= C.maxAccuracyM;
    const prev = this.lastFix;
    if (reliable) this.lastFix = fix;
    let speedKmh = fix.speedMps != null ? fix.speedMps * 3.6 : null;
    if (speedKmh == null && prev && reliable) { const dt = (fix.timeMs - prev.timeMs) / 1000; if (dt > 0) speedKmh = Geo.dist(prev.lat, prev.lon, fix.lat, fix.lon) / dt * 3.6; }
    let course = fix.bearingDeg != null && (speedKmh ?? 0) >= 8 ? fix.bearingDeg : null;
    if (course == null && prev && reliable && Geo.dist(prev.lat, prev.lon, fix.lat, fix.lon) >= 10) course = Geo.bearing(prev.lat, prev.lon, fix.lat, fix.lon);

    if (this.active) this.stepActive(this.active, fix, reliable, speedKmh, events);
    if (reliable) this.detectStart(fix, course, events);
    if (reliable && !this.active && fix.timeMs - (this.sessionStartMs ?? fix.timeMs) <= C.insideCheckMs) this.detectInside(fix, course, events);

    let status = null;
    const a = this.active;
    if (a) {
      if (reliable && speedKmh != null) this.updateSpeed(a, speedKmh, fix.timeMs);
      status = this.statusOf(a, fix.timeMs);
      if (a.confirmed && status.level !== a.level) {
        events.push({ type: 'level', status, previous: a.level });
        a.level = status.level; a.levelSince = fix.timeMs;
      }
    }
    return { status, events };
  }

  /** Stato senza una posizione nuova (GPS perso): distanza stimata con l'ultima velocità, max 60 s. */
  peek(nowMs, maxEstimateS = 60) {
    const a = this.active; if (!a || !a.confirmed || a.suspended) return null;
    if (a.speedEma == null) return this.statusOf(a, nowMs);
    const dt = clamp((nowMs - a.lastT) / 1000, 0, maxEstimateS);
    return { ...this.statusOf(a, nowMs, a.speedEma / 3.6 * dt), estimated: true };
  }

  stop(nowMs = null) {
    const a = this.active; if (!a) return null;
    const now = nowMs ?? this.lastSeenMs ?? a.lastT;
    this.active = null;
    if (!a.confirmed) return null;
    return { type: 'finished', trip: this.buildTrip(a, now, a.lastS, 'STOPPED') };
  }

  updateSpeed(a, v, t) {
    a.maxSpeedKmh = Math.max(a.maxSpeedKmh, v);
    const prevT = a.speedEmaT, ema = a.speedEma;
    if (ema == null || prevT == null || t <= prevT) a.speedEma = ema ?? v;
    else a.speedEma = ema + (v - ema) * (1 - Math.exp(-(t - prevT) / 1000 / this.config.speedSmoothingS));
    a.speedEmaT = t;
  }

  detectStart(fix, course, events) {
    const C = this.config;
    const candidates = this.sections
      .map(ts => [ts, Geo.dist(fix.lat, fix.lon, ts.start.lat, ts.start.lon)])
      .filter(([, d]) => d <= C.candidateRadiusM).sort((x, y) => x[1] - y[1]).map(x => x[0]);
    const seen = new Set();
    let started = null, bestLateral = Number.MAX_VALUE;
    for (const ts of candidates) {
      const id = ts.id; seen.add(id);
      const proj = ts.track.project(fix.lat, fix.lon, 0, 1500);
      const prev = this.probes.get(id);
      this.probes.set(id, { s: proj.s, lateral: proj.lateral, timeMs: fix.timeMs });
      if ((this.active && !this.active.suspended) || !prev) continue;
      if (this.active && this.active.ts.id === id) continue;
      if (!(prev.s < 0 && proj.s >= 0)) continue;
      const dtS = (fix.timeMs - prev.timeMs) / 1000;
      if (dtS <= 0 || dtS > 180 || (proj.s - prev.s) / dtS > 70) continue;
      const corridor = (ts.hasGeometry ? C.startCorridorM : C.startCorridorStraightM) + Math.min(fix.accuracyM ?? 0, C.maxAccuracyM);
      const lateral = Math.min(prev.lateral, proj.lateral);
      if (lateral > corridor) continue;
      if (course != null && !headingOk(course, proj.bearing, C.headingToleranceDeg)) continue;
      if (lateral < bestLateral) {
        bestLateral = lateral;
        const f = (0 - prev.s) / (proj.s - prev.s);
        started = [ts, prev.timeMs + Math.trunc((fix.timeMs - prev.timeMs) * f)];
      }
    }
    for (const k of [...this.probes.keys()]) if (!seen.has(k)) this.probes.delete(k);
    if (started) {
      const [ts, t] = started;
      const old = this.active;
      if (old && old.confirmed) events.push({ type: 'finished', trip: this.buildTrip(old, t, old.lastS, 'LEFT_ROUTE') });
      const a = this.newActive(ts, t);
      a.lastS = Math.max(ts.track.project(fix.lat, fix.lon, 0).s, 0);
      a.lastT = fix.timeMs;
      this.active = a;
      this.insideNotified.add(ts.id);
      if (ts.measured(a.lastS) >= C.confirmAfterM || ts.measureLength < C.confirmAfterM * 2) this.confirm(a, events);
    }
  }

  newActive(ts, t) {
    return { ts, startedAt: t, lastS: 0, lastT: t, offSince: null, farSince: null, suspended: false, confirmed: false,
      maxSpeedKmh: 0, speedEma: null, speedEmaT: null, level: 'OK', levelSince: t, offRoute: false };
  }

  detectInside(fix, course, events) {
    const C = this.config;
    for (const ts of this.sections) {
      if (this.insideNotified.has(ts.id) || !ts.nearBox(fix.lat, fix.lon, 300)) continue;
      const proj = ts.track.project(fix.lat, fix.lon);
      if (proj.lateral > (ts.hasGeometry ? C.startCorridorM : C.startCorridorStraightM)) continue;
      if (proj.s < 200 || proj.s > ts.track.length - 200) continue;
      if (course == null || !headingOk(course, proj.bearing, C.headingToleranceDeg)) continue;
      this.insideNotified.add(ts.id);
      events.push({ type: 'insideUnknown', section: ts });
      return;
    }
  }

  confirm(a, events) { if (a.confirmed) return; a.confirmed = true; events.push({ type: 'started', section: a.ts, limitKmh: a.ts.limitKmh, timeMs: a.startedAt }); }
  timeoutFor(ts) { return Math.max(this.config.timeoutMinMs, Math.trunc(ts.officialLength / (this.config.timeoutMinKmh / 3.6) * 1000)); }

  stepActive(a, fix, reliable, speedKmh, events) {
    const C = this.config, ts = a.ts, now = fix.timeMs;
    if (now - a.startedAt > this.timeoutFor(ts)) {
      this.active = null;
      if (a.confirmed) events.push({ type: 'finished', trip: this.buildTrip(a, now, a.lastS, 'TIMEOUT') });
      return;
    }
    if (!reliable) return;
    const corridor = (ts.hasGeometry ? C.leaveCorridorM : C.leaveCorridorStraightM) + Math.min(fix.accuracyM ?? 0, C.maxAccuracyM);
    let proj = ts.track.project(fix.lat, fix.lon, a.lastS);
    if (proj.lateral > corridor) {
      const g = ts.track.project(fix.lat, fix.lon);
      if (g.lateral <= corridor && g.s >= a.lastS - C.rejoinBackM) proj = g;
    }
    if (proj.lateral > corridor) {
      if (!a.confirmed) { this.active = null; return; }
      if (a.offSince == null) a.offSince = now;
      a.offRoute = true;
      if (!a.suspended && now - a.offSince >= C.leaveAfterMs) { a.suspended = true; events.push({ type: 'suspended', section: ts }); }
      const farLateral = Math.min(proj.lateral, ts.track.project(fix.lat, fix.lon).lateral);
      if (farLateral > C.farM) {
        if (a.farSince == null) a.farSince = now;
        if (now - a.farSince >= C.farCloseAfterMs) { this.active = null; events.push({ type: 'finished', trip: this.buildTrip(a, now, a.lastS, 'LEFT_ROUTE') }); }
      } else a.farSince = null;
      return;
    }
    if (a.suspended) { a.suspended = false; events.push({ type: 'resumed', section: ts }); }
    a.offSince = null; a.farSince = null; a.offRoute = false;
    if (proj.s >= ts.track.length) {
      const ds = proj.s - a.lastS;
      const f = ds > 0 ? clamp((ts.track.length - a.lastS) / ds, 0, 1) : 1;
      const tEnd = a.lastT + Math.trunc((now - a.lastT) * f);
      this.active = null;
      if (speedKmh != null) a.maxSpeedKmh = Math.max(a.maxSpeedKmh, speedKmh);
      this.confirm(a, events);
      events.push({ type: 'finished', trip: this.buildTrip(a, tEnd, ts.track.length, 'COMPLETED') });
      return;
    }
    if (proj.s > a.lastS) { a.lastS = proj.s; a.lastT = now; }
    if (!a.confirmed && ts.measured(a.lastS) >= C.confirmAfterM) this.confirm(a, events);
  }

  statusOf(a, nowMs, extraTrackM = 0) {
    const C = this.config, ts = a.ts, total = ts.measureLength;
    const done = clamp(ts.measured(Math.min(a.lastS + extraTrackM, ts.track.length - 1)), 0, total);
    const elapsedMs = Math.max(nowMs - a.startedAt, 1), elapsedS = elapsedMs / 1000;
    const limit = ts.limitKmh;
    const avg = done >= C.minMetersForAverage && elapsedS >= 1 ? done / elapsedS * 3.6 : null;
    const remaining = total - done;
    let projected = a.speedEma != null && a.speedEma >= 5 && !a.suspended ? total / (elapsedS + remaining / (a.speedEma / 3.6)) * 3.6 : null;
    if (avg == null) projected = null;
    const allowed = limit != null ? Policy.allowed(limit) : null;
    const margin = limit != null ? Policy.margin(ts.reliability, total, Policy.allowed(limit)) : 0;
    const target = limit != null ? Policy.target(limit, ts.reliability, total) : null;
    let recommended = null, minRemainingMs = null, cannotRecover = false;
    if (target != null && limit != null && remaining > 0) {
      const leftS = total / (target / 3.6) - elapsedS;
      minRemainingMs = Math.max(Math.trunc(leftS * 1000), 0);
      if (leftS <= 0) recommended = limit;
      else { const req = remaining / leftS * 3.6; recommended = Math.min(limit, req); cannotRecover = req < C.minRecoverKmh; }
    }
    const level = this.decideLevel(a, projected ?? avg, limit, allowed, target, cannotRecover, nowMs);
    return {
      section: ts, startedAtMs: a.startedAt, elapsedMs, doneMeters: done, totalMeters: total, averageKmh: avg,
      projectedKmh: projected, limitKmh: limit, allowedKmh: allowed, targetKmh: target, recommendedKmh: recommended,
      minRemainingMs, cannotRecover, level, offRoute: a.offRoute, suspended: a.suspended, marginKmh: margin,
      confirmed: a.confirmed, estimated: false, remainingMeters: Math.max(total - done, 0),
      progress: total > 0 ? clamp(done / total, 0, 1) : 0,
    };
  }

  decideLevel(a, ref, limit, allowed, target, cannotRecover, nowMs) {
    if (limit == null || ref == null) return a.level;
    const overAt = target ?? allowed ?? limit, h = this.config.hysteresisKmh;
    const up = cannotRecover || ref > overAt ? 'OVER' : ref > limit ? 'CAUTION' : 'OK';
    if (LEVELS[up] > LEVELS[a.level]) return up;
    const down = cannotRecover || ref > overAt - h ? 'OVER' : ref > limit - h ? 'CAUTION' : 'OK';
    return LEVELS[down] < LEVELS[a.level] && nowMs - a.levelSince >= this.config.levelDownAfterMs ? down : a.level;
  }

  buildTrip(a, endMs, sEnd, reason) {
    const ts = a.ts;
    const measuredDone = reason === 'COMPLETED' ? ts.measureLength : ts.measured(sEnd);
    const durS = Math.max((endMs - a.startedAt) / 1000, 1);
    return {
      sectionId: ts.id, sectionLabel: ts.label, startedAt: a.startedAt, endedAt: endMs, lengthMeters: ts.officialLength,
      averageKmh: measuredDone / durS * 3.6, maxSpeedKmh: a.maxSpeedKmh, limitKmh: ts.limitKmh, endReason: reason,
    };
  }
}

// ---------- Misura con i tocchi PORTALE (Prova.kt) ----------
export const Prova = {
  MAX_ACC: 50, SEARCH_M: 1500, LEN_TOL: 0.025, MAX_GAP_S: 5,
  odometer(fixes) {
    const good = fixes.filter(f => (f.accuracyM ?? 0) <= Prova.MAX_ACC);
    const times = good.map(f => f.timeMs), cum = [0];
    for (let i = 1; i < good.length; i++) cum[i] = cum[i - 1] + Geo.dist(good[i - 1].lat, good[i - 1].lon, good[i].lat, good[i].lon);
    const at = t => {
      if (!good.length || t <= times[0]) return 0;
      if (t >= times[times.length - 1]) return cum[cum.length - 1];
      let lo = 0, hi = times.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
      if (times[lo] === t) return cum[lo];
      const f = (t - times[lo]) / Math.max(times[hi] - times[lo], 1);
      return cum[lo] + (cum[hi] - cum[lo]) * f;
    };
    return { at, between: (t0, t1) => at(t1) - at(t0) };
  },
  positionAt(fixes, t) {
    const good = fixes.filter(f => (f.accuracyM ?? 0) <= Prova.MAX_ACC);
    if (!good.length) return null;
    const i = good.findIndex(f => f.timeMs >= t);
    if (i === -1) return { lat: good[good.length - 1].lat, lon: good[good.length - 1].lon };
    if (i === 0) return { lat: good[0].lat, lon: good[0].lon };
    const a = good[i - 1], b = good[i], f = (t - a.timeMs) / Math.max(b.timeMs - a.timeMs, 1);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  },
  pairTaps(fixes, taps, sections) {
    if (taps.length < 2) return [];
    const odo = Prova.odometer(fixes), pos = taps.map(t => Prova.positionAt(fixes, t)), out = [];
    for (const ts of sections) {
      if (!pos.some(p => p && ts.nearBox(p.lat, p.lon, Prova.SEARCH_M))) continue;
      const proj = pos.map(p => p && ts.track.project(p.lat, p.lon));
      let best = null;
      for (let i = 0; i < taps.length; i++) {
        const a = proj[i]; if (!a || a.lateral > 200 || Math.abs(a.s) > Prova.SEARCH_M) continue;
        for (let j = i + 1; j < taps.length; j++) {
          const b = proj[j]; if (!b || b.lateral > 200 || Math.abs(b.s - ts.track.length) > Prova.SEARCH_M || b.s <= a.s) continue;
          const diff = Math.abs(odo.between(taps[i], taps[j]) - ts.officialLength) / ts.officialLength;
          if (diff <= Prova.LEN_TOL && (!best || diff < best[2])) best = [i, j, diff];
        }
      }
      if (best) out.push([best[0], best[1], ts]);
    }
    return out.sort((x, y) => x[0] - y[0]);
  },
  /** Media dai tocchi: lunghezza ufficiale / tempo tra i due tocchi, e confronto con la media dell'app. */
  compute(fixes, t0, t1, ts, trips) {
    const durS = Math.max((t1 - t0) / 1000, 0.001);
    const gps = Prova.odometer(fixes).between(t0, t1);
    const ov = tr => Math.max(Math.min(tr.endedAt, t1 + 120000) - Math.max(tr.startedAt, t0 - 120000), 0);
    const trip = trips.filter(tr => tr.sectionId === ts.id && ov(tr) > 0).sort((x, y) => ov(y) - ov(x))[0];
    return {
      id: t0 + '-' + t1, startMs: t0, endMs: t1, durationS: durS, sectionId: ts.id, sectionLabel: ts.label,
      officialM: ts.officialLength, gpsDistanceM: gps, refAvgKmh: gps / durS * 3.6,
      tutorAvgKmh: ts.officialLength / durS * 3.6, appAvgKmh: trip ? trip.averageKmh : null,
    };
  },
};
