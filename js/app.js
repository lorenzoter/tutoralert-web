// TutorAlert per il browser della Tesla: GPS, motore Tutor (engine.js), voce registrata, modalità prova.
import { Geo, Section, Tracker, Prova, Policy } from './engine.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v == null ? '--' : v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const km = (m, d = 1) => fmt(m / 1000, d) + ' km';
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const store = {
  get(k, def) { try { const v = localStorage.getItem('ta.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('ta.' + k, JSON.stringify(v)); } catch { /* memoria piena o non disponibile */ } },
};
const ROUTE = [35, 36, 37, 38, 45, 46, 47, 48];

// ---------- Impostazioni (per dispositivo) ----------
const DEFAULTS = {
  audio: 'nulla', volume: 1, tapSound: 'bip', approach: 1000, slowRepeat: false, endAverage: true,
  targetExact: true, personalMax: null, rain: false, decimals: 1, speedoPct: 0, testMode: false, layout: 'auto', portalChime: true, segmentCheck: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
if (settings.voice === false && !store.get('settings', {}).audio) settings.audio = 'nulla';
delete settings.voice;
function applySettings() {
  Policy.settings = { targetExact: settings.targetExact, personalMax: settings.personalMax, rain: settings.rain };
  if (gain) gain.gain.value = settings.volume;
  document.body.classList.toggle('test', settings.testMode);
  applyLayout();
  const ab = document.getElementById('audioBtn');
  if (ab) ab.textContent = { voce: '🔊 Voce', bip: '🔔 Bip', nulla: '🔇 Muto' }[settings.audio];
}
/** Una colonna se lo chiede l'utente o se il pannello del browser è stretto. */
function applyLayout() {
  const narrow = settings.layout === 'stretto' || (settings.layout === 'auto' && window.innerWidth < 900);
  document.body.classList.toggle('narrow', narrow);
}
window.addEventListener('resize', applyLayout);
function setSetting(k, v) { settings[k] = v; store.set('settings', settings); applySettings(); renderSettings(); render(); }

// ---------- Stato ----------
let allSections = [], sections = [], tracker = null;
// Tratte disattivate: quelle ufficiali (database su GitHub) più le scelte fatte su questo dispositivo.
let official = new Set(), localOff = new Set(store.get('disabled', [])), localOn = new Set(store.get('enabled', []));
let disabled = new Set(), dataVersion = 0;
let results = store.get('results', []);
// Storico delle tratte fatte (riepilogo viaggio e grafici).
let history = store.get('trips', []), sessionId = 0;
let running = false, simulated = false, watchId = null, simTimer = null;
let fixes = [], taps = [], trips = [], lastFix = null, lastFedAt = 0, lastFixWall = 0;
let status = null, next = null, nextPortal = null, portalToCheck = null, lastResult = null, gpsLostS = null;
const announced = new Set();
let lastOverSpeech = 0;

// ---------- Voce registrata ----------
let ac = null, gain = null, clips = {}, clipNames = [], speakQueue = Promise.resolve();
async function loadVoice() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    gain = ac.createGain(); gain.connect(ac.destination); gain.gain.value = settings.volume;
  }
  await ac.resume();
  if (clipNames.length) return;
  clipNames = await (await fetch('audio/index.json')).json();
  await Promise.all(clipNames.map(async k => {
    try { clips[k] = await ac.decodeAudioData(await (await fetch('audio/' + k + '.mp3')).arrayBuffer()); } catch { /* manca una frase: si salta */ }
  }));
}
const num = n => { n = Math.round(n); return n >= 1 && n <= 200 ? 'n' + n : null; };
/** Pronuncia una frase fatta di pezzi registrati, in coda alle precedenti. */
function say(keys, force = false, urgent = false) {
  if (!ac) return;
  if (!force && settings.audio === 'nulla') return;
  if (!force && settings.audio === 'bip') { for (let i = 0; i < (urgent ? 3 : 2); i++) setTimeout(beep, i * 260); return; }
  const parts = keys.filter(k => k && clips[k]);
  if (!parts.length) return;
  speakQueue = speakQueue.then(() => new Promise(done => {
    ac.resume();
    let at = ac.currentTime + 0.05;
    for (const k of parts) {
      const src = ac.createBufferSource();
      src.buffer = clips[k]; src.connect(gain); src.start(at);
      at += clips[k].duration + 0.03;
    }
    setTimeout(done, (at - ac.currentTime) * 1000 + 150);
  }));
}

/** Segnale sotto il portale: due toni brevi, sempre (anche con gli avvisi su Nessuno). */
function chime() {
  if (!ac) return;
  ac.resume();
  [[880, 0], [1320, 0.16]].forEach(([f, dt]) => {
    const o = ac.createOscillator(), g = ac.createGain(), t0 = ac.currentTime + dt;
    o.frequency.value = f; g.gain.setValueAtTime(0.3, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    o.connect(g); g.connect(gain); o.start(t0); o.stop(t0 + 0.25);
  });
}

/** Bip breve (tocco di PORTALE). */
function beep() {
  if (!ac) return;
  ac.resume();
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = 990; g.gain.setValueAtTime(0.25, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.18);
  o.connect(g); g.connect(gain); o.start(); o.stop(ac.currentTime + 0.2);
}

// ---------- Tratte ----------
async function loadSections() {
  // Sempre la versione più recente del database (niente copie vecchie in memoria del browser).
  const data = await (await fetch('data/a1_sections.json?t=' + Date.now(), { cache: 'no-store' })).json();
  allSections = data.sections.map(s => new Section(s));
  official = new Set(data.disabled || []);
  dataVersion = data.dataVersion || 0;
  applyDisabled();
}
function applyDisabled() {
  disabled = new Set([...official, ...localOff].filter(id => !localOn.has(id)));
  sections = allSections.filter(s => !disabled.has(s.id));
  tracker?.setSections(sections);
}
function setDisabled(id, off) {
  if (off) { localOff.add(id); localOn.delete(id); }
  else { localOff.delete(id); if (official.has(id)) localOn.add(id); }
  store.set('disabled', [...localOff]); store.set('enabled', [...localOn]);
  applyDisabled();
}

// ---------- Avvio e posizione ----------
async function start(sim) {
  $('startErr').textContent = '';
  try { await loadVoice(); } catch { /* senza voce si va avanti */ }
  if (!allSections.length) await loadSections();
  tracker = new Tracker(sections);
  fixes = []; taps = []; trips = []; announced.clear(); portalCheck.reset(); allPortalCheck.reset(); segment.reset(); seg = null;
  status = next = nextPortal = portalToCheck = null; lastFix = null; lastFedAt = 0;
  simulated = !!sim; running = true; sessionId = Date.now();
  document.body.classList.add('running');
  try { await navigator.wakeLock?.request('screen'); } catch { /* non supportato */ }
  say(['avvio']);
  if (simulated) startSim(sim);
  else if (!('geolocation' in navigator)) { stop(); $('startErr').textContent = 'Questo browser non fornisce la posizione.'; }
  else watchId = navigator.geolocation.watchPosition(onPosition, e => { $('gps').textContent = 'GPS: ' + e.message; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  render();
}

function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  clearInterval(simTimer); watchId = null; simTimer = null;
  const fin = tracker?.stop(lastFix?.timeMs); if (fin) onTrip(fin.trip);
  evaluate();
  running = false; status = next = nextPortal = portalToCheck = null;
  renderLastJourney();
  document.body.classList.remove('running');
  render();
}

function onPosition(p) {
  const c = p.coords, now = Date.now();
  // La Tesla manda fino a 10 posizioni al secondo, con orari che saltano: si usa l'orologio della pagina
  // e si tengono al massimo 4 posizioni al secondo, scartando quelle identiche alla precedente.
  if (lastFix && c.latitude === lastFix.lat && c.longitude === lastFix.lon) return;
  if (now - lastFedAt < 250) return;
  lastFedAt = now;
  onFix({
    lat: c.latitude, lon: c.longitude, accuracyM: c.accuracy ?? null,
    speedMps: c.speed != null && !isNaN(c.speed) ? c.speed : null,
    bearingDeg: c.heading != null && !isNaN(c.heading) ? c.heading : null,
    timeMs: now,
  });
}

async function startSim(speed) {
  const { points } = await (await fetch('data/sim_a1_sud.json')).json();
  let i = 0, t = Date.now();
  simTimer = setInterval(() => {
    if (i >= points.length) { stop(); return; }
    const [lat, lon] = points[i], [lat2, lon2] = points[Math.min(i + 1, points.length - 1)];
    const d = Geo.dist(lat, lon, lat2, lon2);
    onFix({ lat, lon, accuracyM: 5, speedMps: d, bearingDeg: d > 0.5 ? Geo.bearing(lat, lon, lat2, lon2) : null, timeMs: t });
    i++; t += 1000;
  }, 1000 / speed);
}

// ---------- Ogni posizione ----------
function onFix(fix) {
  lastFix = fix; lastFixWall = Date.now(); gpsLostS = null;
  fixes.push(fix);
  if (fixes.length > 6 * 3600 * 4) fixes.splice(0, fixes.length - 6 * 3600 * 4);
  const u = tracker.update(fix);
  for (const e of u.events) onEvent(e, fix);
  status = u.status;
  if (settings.slowRepeat && status && status.confirmed && status.level === 'OVER' && !status.suspended && fix.timeMs - lastOverSpeech >= 60000) overSpeech(status, fix.timeMs);
  next = status ? null : nextTutor(fix);
  nextPortal = findNextPortal(fix);
  portalToCheck = portalCheck.update(fix, nextPortal);
  allPortalCheck.update(fix, findNextPortal(fix, allSections));
  const pa = allPortalCheck.justPassed;
  seg = settings.segmentCheck ? segment.update(fix, pa, pa ? Policy.effectiveLimit(allSections.find(x => x.id === pa.sectionId)?.limitKmh) : null) : null;
  if (seg?.justOver) say(['segmento'], false, true);
  if (portalCheck.justPassed && settings.portalChime) chime();
  if (portalToCheck && disabled.has(portalToCheck.sectionId)) portalToCheck = null;
  if (pendingEval && fix.timeMs > (taps[taps.length - 1] ?? 0)) evaluate();
  render();
}

function onEvent(e, fix) {
  switch (e.type) {
    case 'started': lastOverSpeech = 0; say(['inizio', e.limitKmh ? 'limite' : null, num(e.limitKmh)]); break;
    case 'level':
      if (e.status.level === 'OVER') overSpeech(e.status, fix.timeMs);
      else if (e.status.level === 'OK' && e.previous === 'OVER') say(['rientrata']);
      break;
    case 'suspended': say(['fuori']); break;
    case 'resumed': say(['ripresa']); break;
    case 'insideUnknown': say(['dentro']); break;
    case 'finished': onTrip(e.trip); break;
  }
}

function onTrip(t) {
  announced.delete(t.sectionId);
  trips.push(t);
  history.push({ sessionId, sectionId: t.sectionId, label: t.sectionLabel, startedAt: t.startedAt, endedAt: t.endedAt,
    averageKmh: t.averageKmh, maxSpeedKmh: t.maxSpeedKmh, limitKmh: t.limitKmh, endReason: t.endReason, simulated });
  history = history.slice(-3000); store.set('trips', history);
  if (t.endReason === 'COMPLETED') say(settings.endAverage ? ['fine', 'media', num(t.averageKmh)] : ['fine']);
  else if (t.endReason === 'LEFT_ROUTE') say(['chiusa']);
  refreshAppAverages(t.sectionId);
}

function overSpeech(s, now) {
  lastOverSpeech = now;
  const rec = s.recommendedKmh != null ? Math.round(s.recommendedKmh) : null;
  if (s.cannotRecover) say(['oltre'], false, true);
  else if (rec != null && s.limitKmh != null && rec < s.limitKmh) say(['rallenta', num(rec)], false, true);
  else say(['attenzione'], false, true);
}

/** Prossimo portale di inizio davanti, sullo stesso tracciato, entro 2 km. */
function nextTutor(fix) {
  const course = fix.bearingDeg != null && (fix.speedMps ?? 0) * 3.6 > 15 ? fix.bearingDeg : null;
  if (course == null) return null;
  let best = null;
  for (const ts of sections) {
    if (Geo.dist(fix.lat, fix.lon, ts.start.lat, ts.start.lon) > 2500) continue;
    const p = ts.track.project(fix.lat, fix.lon, 0, 1500);
    if (p.s > -20 || p.s < -2000 || p.lateral > 80 || Geo.angleDiff(course, p.bearing) > 45) continue;
    if (!best || -p.s < best.d) best = { ts, d: -p.s };
  }
  if (!best) return null;
  const { ts, d } = best;
  if (settings.approach > 0 && d <= settings.approach && !announced.has(ts.id)) {
    announced.add(ts.id);
    const m = Math.max(100, Math.round(d / 100) * 100), lim = Policy.effectiveLimit(ts.limitKmh);
    say(m >= 1000 ? ['un_km', lim ? 'limite' : null, num(lim)] : ['tutor_tra', 'n' + m, 'metri', lim ? 'limite' : null, num(lim)]);
  }
  return { ts, distanceM: d };
}

/** Prossimo portale (inizio o fine) davanti entro 1,5 km. */
function findNextPortal(fix, list = sections) {
  const course = fix.bearingDeg != null && (fix.speedMps ?? 0) * 3.6 > 15 ? fix.bearingDeg : null;
  if (course == null) return null;
  const found = [];
  for (const ts of list) {
    if (!ts.nearBox(fix.lat, fix.lon, 1600)) continue;
    const p = ts.track.project(fix.lat, fix.lon);
    if (p.lateral > 80 || Geo.angleDiff(course, p.bearing) > 45) continue;
    for (const [d, isStart] of [[-p.s, true], [ts.track.length - p.s, false]]) {
      if (d >= 15 && d <= 1500) found.push({ distanceM: d, isStart, sectionId: ts.id, label: ts.label, verified: ts.portalsMeasured });
    }
  }
  if (!found.length) return null;
  const best = found.reduce((a, b) => (b.distanceM < a.distanceM ? b : a));
  // Portale condiviso: la fine di una tratta coincide (entro 100 m) con l'inizio della successiva.
  best.endAndStart = found.some(o => o !== best && o.isStart !== best.isStart && Math.abs(o.distanceM - best.distanceM) < 100);
  best.kind = best.endAndStart ? 'di fine e inizio tratta' : best.isStart ? 'di inizio tratta' : 'di fine tratta';
  return best;
}

/** "Il portale non c'è" è attivo solo nel primo km dopo il punto previsto. */
function makePortalCheck() { return {
  portal: null, remaining: 0, prev: null, justPassed: null,
  reset() { this.portal = null; this.prev = null; this.justPassed = null; },
  update(fix, ahead) {
    this.justPassed = null;
    const before = this.remaining;
    if ((fix.accuracyM ?? 0) <= 50) { if (this.prev) this.remaining -= Geo.dist(this.prev.lat, this.prev.lon, fix.lat, fix.lon); this.prev = fix; }
    if (this.portal && before > 0 && this.remaining <= 0) this.justPassed = this.portal;
    const passed = this.portal && this.remaining <= 0 && this.remaining > -1000;
    if (ahead && !passed) { this.portal = ahead; this.remaining = ahead.distanceM; }
    if (this.portal && this.remaining <= -1000) this.portal = null;
    return this.portal && this.remaining <= 0 ? this.portal : null;
  },
}; }
const portalCheck = makePortalCheck();
/** Tutti i portali, anche delle tratte spente: per il controllo della media tra ogni portale. */
const allPortalCheck = makePortalCheck();

/**
 * Massima sicurezza: ogni portale conta come fine del pezzo precedente e inizio del successivo.
 * Se la media resta sotto il limite tra ogni coppia di portali consecutivi, resta sotto anche tra qualsiasi
 * coppia di portali. Distanza GPS +1,5% (le lunghezze ufficiali sono fino all'1% più lunghe).
 */
const segment = {
  startT: null, startOdo: 0, odo: 0, prev: null, limit: null, alerted: false,
  reset() { this.startT = null; this.prev = null; this.odo = 0; this.alerted = false; },
  update(fix, passed, limit) {
    if ((fix.accuracyM ?? 0) <= 50) { if (this.prev) this.odo += Geo.dist(this.prev.lat, this.prev.lon, fix.lat, fix.lon); this.prev = fix; }
    if (passed) { this.startT = fix.timeMs; this.startOdo = this.odo; this.limit = limit; this.alerted = false; }
    if (this.startT == null) return null;
    const dist = this.odo - this.startOdo, el = fix.timeMs - this.startT;
    if (dist > 45000 || el > 3600000) { this.startT = null; return null; }
    const avg = el >= 3000 && dist >= 200 ? dist * 1.015 / (el / 1000) * 3.6 : null;
    const over = avg != null && this.limit != null && avg > this.limit;
    let justOver = false;
    if (over && !this.alerted) { this.alerted = true; justOver = true; }
    if (this.alerted && avg != null && this.limit != null && avg < this.limit - 1) this.alerted = false;
    return { avgKmh: avg, limitKmh: this.limit, distanceM: dist, over, justOver };
  },
};
let seg = null;

// GPS perso (galleria): ogni secondo la media continua con una stima.
setInterval(() => {
  if (!running || simulated || !lastFix) return;
  const lost = Math.floor((Date.now() - lastFixWall) / 1000);
  if (lost >= 3) {
    if (gpsLostS == null) say(['gps_perso']);
    gpsLostS = lost;
    status = tracker.peek(Date.now()) ?? status;
    render();
  }
}, 1000);

// ---------- Modalità prova: tocchi PORTALE ----------
let pendingEval = false;
function tapTime() { return simulated && lastFix ? lastFix.timeMs : Date.now(); }
function tap() {
  if (!running) return;
  taps.push(tapTime()); pendingEval = true;
  if (settings.tapSound === 'bip') beep(); else say(['portale'], true);
  render();
}
function undoTap() { if (taps.length) { taps.pop(); say(['annullato']); render(); } }

function evaluate() {
  pendingEval = false;
  if (taps.length < 2 || !fixes.length) return;
  for (const [i, j, ts] of Prova.pairTaps(fixes, taps, sections)) {
    const r = Prova.compute(fixes, taps[i], taps[j], ts, trips);
    if (results.some(x => x.id === r.id)) continue;
    results.unshift(r); results = results.slice(0, 300); store.set('results', results);
    lastResult = r;
    say(['misurata', 'media', num(r.tutorAvgKmh)]);
  }
}
function refreshAppAverages(sectionId) {
  let changed = false;
  for (const r of results) {
    if (r.sectionId !== sectionId || r.appAvgKmh != null) continue;
    const ts = sections.find(s => s.id === sectionId); if (!ts) continue;
    const fresh = Prova.compute(fixes, r.startMs, r.endMs, ts, trips);
    if (fresh.appAvgKmh != null) { r.appAvgKmh = fresh.appAvgKmh; changed = true; if (lastResult?.id === r.id) lastResult = r; }
  }
  if (changed) store.set('results', results);
}

// ---------- Schermo ----------
function render() {
  $('gps').textContent = !running ? '' : simulated ? 'SIMULAZIONE' : lastFix ? `GPS ±${Math.round(lastFix.accuracyM ?? 0)} m` : 'GPS: in attesa…';
  const s = status;
  $('tutor').hidden = !s; $('free').hidden = !!s;
  if (s) {
    const avg = s.averageKmh, lim = s.limitKmh;
    const col = avg == null || lim == null ? '' : avg <= lim ? 'ok' : avg <= (s.allowedKmh ?? lim) ? 'warn' : 'bad';
    $('tLabel').textContent = 'TUTOR · ' + s.section.label;
    $('avg').textContent = fmt(avg, settings.decimals); $('avg').className = 'avg ' + col;
    $('limit').textContent = lim ?? '?';
    const spd = shownSpeed();
    $('tLine').textContent = `ora ${spd} km/h · in tratta da ${dur(s.elapsedMs)}`;
    const pct = (s.progress * 100).toFixed(1) + '%';
    $('bar').style.width = pct; $('bar').className = 'fill ' + col;
    $('car').style.left = pct; $('car').className = 'car ' + col;
    $('kmDone').innerHTML = `fatti <b>${km(s.doneMeters)}</b>`;
    $('kmLeft').innerHTML = `mancano <b>${km(s.remainingMeters)}</b>`;
    const rec = s.recommendedKmh != null ? Math.round(s.recommendedKmh) : null;
    const banner = gpsLostS != null ? [`GPS perso da ${gpsLostS} s · media stimata`, 'warn']
      : s.suspended ? ['Fuori percorso', 'warn']
      : s.cannotRecover ? ['Media oltre il limite', 'bad']
      : s.level === 'OVER' && rec != null && lim != null && rec < lim ? [`Rallenta a ${rec}`, 'warn'] : null;
    $('banner').hidden = !banner;
    if (banner) { $('banner').textContent = banner[0]; $('banner').className = 'banner ' + banner[1]; }
    $('tState').textContent = (s.section.portalsMeasured ? '🟢 Portali verificati in auto · formula del Tutor' : '⚪ Portali da verificare: media prudente') + ` · ${km(s.totalMeters, 2)}`;
  } else {
    $('speed').textContent = shownSpeed();
    $('nextCard').className = 'card next' + (next ? ' on' : '');
    $('nextTitle').textContent = next ? `Tutor tra ${Math.round(next.distanceM / 10) * 10} m` : running ? 'Nessun Tutor davanti entro 2 km' : '';
    $('nextSub').textContent = next ? `${next.ts.label} · ${km(next.ts.officialLength)} · limite ${next.ts.limitKmh ?? '?'}` : '';
  }
  // Controllo tra ogni portale
  $('segBanner').hidden = !(seg && seg.over);
  $('segLine').textContent = seg ? `Dall'ultimo portale: ${seg.avgKmh != null ? fmt(seg.avgKmh, settings.decimals) + ' km/h' : 'calcolo…'} · ${km(seg.distanceM)}${seg.limitKmh ? ' · limite ' + seg.limitKmh : ''}` : '';
  $('segLine').className = 'segLine ' + (!seg || seg.avgKmh == null ? '' : seg.over ? 'bad' : 'ok');
  // Prova
  const np = nextPortal;
  $('hint').textContent = np ? `Portale ${np.kind} tra circa ${Math.round(np.distanceM / 50) * 50} m` + (np.verified ? '' : ' (posizione approssimativa)')
    : portalToCheck ? 'Superato il punto del portale previsto. Se non c\'era, premi «Il portale non c\'è».'
    : 'Tocca PORTALE ogni volta che passi sotto un portale con telecamere.';
  $('hint').className = 'hint' + (np || portalToCheck ? ' warn' : '');
  $('missing').disabled = !portalToCheck;
  $('missing').textContent = 'Il portale non c\'è';
  $('undo').hidden = !taps.length;
  const lt = taps[taps.length - 1];
  if (lt != null && fixes.length) {
    const odo = Prova.odometer(fixes.filter(f => f.timeMs >= lt - 2000));
    const now = lastFix.timeMs, el = now - lt, d = odo.between(lt, now);
    $('since').textContent = `Dall'ultimo portale: ${dur(el)} · ${km(d, 2)}` + (el > 3000 ? ` · media ${fmt(d / (el / 1000) * 3.6)} km/h` : '');
  } else $('since').textContent = '';
  $('tapCount').textContent = `${taps.length} portali segnati`;
  renderResult();
}

/** Velocità mostrata: GPS con la correzione del tachimetro scelta (solo per lo schermo, mai nei calcoli). */
function shownSpeed() { return lastFix?.speedMps != null ? Math.round(lastFix.speedMps * 3.6 * (1 + settings.speedoPct / 100)) : '--'; }

function resultHtml(r) {
  const diff = r.appAvgKmh != null ? r.appAvgKmh - r.tutorAvgKmh : null;
  const ok = diff != null && Math.abs(diff) <= 1;
  return `<div class="res">
    <div class="rTitle">${r.sectionLabel}</div>
    <div class="rSub">${new Date(r.startMs).toLocaleString('it-IT')} · ${dur(r.durationS * 1000)} · ${km(r.gpsDistanceM, 2)} percorsi · ufficiale ${km(r.officialM, 2)}</div>
    <div class="rRow"><span>Media Tutor (dai tocchi)</span><b class="acc">${fmt(r.tutorAvgKmh)}</b></div>
    <div class="rRow"><span>Media app</span><b>${r.appAvgKmh != null ? fmt(r.appAvgKmh) : '--'}</b></div>
    ${diff != null ? `<div class="rDiff ${ok ? 'ok' : 'warn'}">Differenza: ${diff > 0 ? '+' : ''}${fmt(diff)} km/h${ok ? ' ✓ entro 1 km/h' : ''}</div>` : ''}
  </div>`;
}
function renderResult() { $('result').innerHTML = lastResult ? resultHtml(lastResult) : ''; }

function renderTratte() {
  const list = allSections.filter(s => ROUTE.includes(s.id)).sort((a, b) => (a.json.direction || '').localeCompare(b.json.direction || '') || a.json.kmStart - b.json.kmStart);
  $('tratteList').innerHTML = `<p class="dim">Database tratte: versione ${dataVersion} (si aggiorna da solo a ogni avvio)</p>` + list.map(s => `<div class="item">
      <div><b>${s.label}</b><div class="dim">${s.json.direction ?? ''} · ${km(s.officialLength, 2)} · limite ${s.limitKmh ?? '?'}</div>
      <div class="dim">${disabled.has(s.id) ? '⛔ Disattivata' : s.portalsMeasured ? '🟢 Portali verificati in auto' : '⚪ Portali da verificare'}</div></div>
      <label class="switch"><input type="checkbox" data-id="${s.id}" ${disabled.has(s.id) ? '' : 'checked'}><span></span></label></div>`).join('');
  $('tratteList').querySelectorAll('input[data-id]').forEach(b => b.onchange = () => {
    const id = Number(b.dataset.id);
    b.checked = !disabled.has(id); // lo stato vero lo decide la conferma
    if (disabled.has(id)) { setDisabled(id, false); renderTratte(); }
    else confirmBox('Disattivare questa tratta?', 'Usalo se nella realtà i portali non ci sono. Puoi riattivarla quando vuoi.', () => { setDisabled(id, true); renderTratte(); });
  });
}
function renderMisure() {
  $('misureList').innerHTML = results.length ? results.map(resultHtml).join('') : '<p class="dim">Nessuna misura: in viaggio tocca PORTALE sotto ogni portale.</p>';
}

function confirmBox(title, text, onOk) {
  $('dlgTitle').textContent = title; $('dlgText').textContent = text;
  $('dlg').hidden = false;
  $('dlgOk').onclick = () => { $('dlg').hidden = true; onOk(); };
  $('dlgNo').onclick = () => { $('dlg').hidden = true; };
}
const SCHEMA = [
  ['Voce e audio', [
    ['audio', 'Avvisi', [['voce', 'Voce'], ['bip', 'Bip'], ['nulla', 'Nessuno']]],
    ['volume', 'Volume della voce', [[0.5, 'Basso'], [1, 'Normale'], [1.6, 'Alto'], [2.4, 'Massimo']]],
    ['portalChime', 'Segnale sotto ogni portale', [[true, 'Sempre'], [false, 'No']]],
    ['tapSound', 'Al tocco di PORTALE', [['voce', 'Voce'], ['bip', 'Bip']]],
  ]],
  ['Avvisi', [
    ['approach', 'Preavviso Tutor', [[1000, '1 km'], [500, '500 m'], [0, 'Spento']]],
    ['slowRepeat', '«Rallenta»', [[true, 'Ogni minuto'], [false, 'Una volta']]],
    ['endAverage', 'Media a fine tratta', [[true, 'Sì'], [false, 'No']]],
  ]],
  ['Calcolo della media', [
    ['segmentCheck', 'Media tra ogni portale', [[true, 'Sì'], [false, 'No']]],
    ['targetExact', 'Obiettivo', [[false, 'Tolleranza di legge'], [true, 'Limite esatto']]],
    ['personalMax', 'Limite personale', [[null, 'Nessuno'], [110, '110'], [100, '100'], [90, '90'], [80, '80']]],
    ['rain', 'Pioggia (limite 110)', [[false, 'No'], [true, 'Sì']]],
  ]],
  ['Schermo', [
    ['decimals', 'Decimali della media', [[1, '1'], [0, '0']]],
    ['speedoPct', 'Correzione tachimetro', [[0, '0%'], [1, '+1%'], [2, '+2%'], [3, '+3%'], [4, '+4%']]],
    ['layout', 'Disposizione', [['auto', 'Automatica'], ['stretto', 'Una colonna'], ['ampio', 'Due colonne']]],
    ['testMode', 'Modalità prova (PORTALE)', [[false, 'No'], [true, 'Sì']]],
  ]],
];
const HELP = {
  portalChime: 'Due toni brevi quando passi sotto un portale Tutor (inizio o fine), anche con gli avvisi su Nessuno.',
  audio: 'Si cambia anche durante la guida con il pulsante in alto.',
  segmentCheck: 'Massima sicurezza: ogni portale conta come fine e inizio. Se la media resta sotto il limite tra ogni coppia di portali, resta sotto anche su qualunque tratta. Si va un po\' più piano.',
  targetExact: 'Tolleranza di legge: la media può arrivare al limite + 5%. Limite esatto: più prudente.',
  speedoPct: 'Solo la velocità mostrata, per farla coincidere col cruscotto. La media non cambia.',
  layout: 'Una colonna è comoda con il browser affiancato alla mappa. Automatica sceglie in base alla larghezza.',
  testMode: 'Mostra PORTALE e le misure con i tocchi, per verificare la media.',
};
function renderSettings() {
  const el = $('settingsList'); if (!el) return;
  el.innerHTML = SCHEMA.map(([group, rows]) => `<h3>${group}</h3>` + rows.map(([k, label, opts]) => `
    <div class="set"><div class="setLabel">${label}${HELP[k] ? `<div class="dim">${HELP[k]}</div>` : ''}</div>
    <div class="seg">${opts.map(([v, t], i) => `<button data-k="${k}" data-i="${i}" class="${settings[k] === v ? 'on' : ''}">${t}</button>`).join('')}</div></div>`).join('')).join('')
    + `<h3>Database tratte</h3><div class="set"><div class="setLabel">Versione ${dataVersion}<div class="dim">Si aggiorna da solo a ogni avvio dal database su GitHub. ${allSections.filter(s => s.portalsMeasured).length} tratte con portali verificati in auto.</div></div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px"><button id="voiceTest">Prova la voce</button><button id="simBtn">Simulazione Roma → Ferentino</button></div>
    <p class="dim" style="margin-top:20px">TutorAlert · Controlli in anticipo. Media sotto controllo.</p>`;
  el.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
    const [, , opts] = SCHEMA.flatMap(g => g[1]).find(r => r[0] === b.dataset.k);
    setSetting(b.dataset.k, opts[Number(b.dataset.i)][0]);
  });
  $('voiceTest').onclick = async () => { await loadVoice(); say(['tutor_tra', 'n500', 'metri', 'limite', 'n130'], true); };
  $('simBtn').onclick = () => { openPanel(null); start(10); };
}

// ---------- Viaggi: riepilogo e storico ----------
function journeys() {
  const by = new Map();
  for (const t of history) if (!t.simulated) { if (!by.has(t.sessionId)) by.set(t.sessionId, []); by.get(t.sessionId).push(t); }
  return [...by.entries()].map(([id, l]) => ({ id, trips: l.sort((a, b) => a.startedAt - b.startedAt) })).sort((a, b) => b.id - a.id);
}
const avgCls = (v, lim) => lim == null || v <= lim ? 'ok' : v <= lim * 1.05 ? 'warn' : 'bad';
const hm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
function journeyHtml(j, title) {
  const f = j.trips[0], l = j.trips[j.trips.length - 1], done = j.trips.filter(t => t.endReason === 'COMPLETED');
  const over = done.filter(t => t.limitKmh != null && t.averageKmh > t.limitKmh).length;
  const d = new Date(f.startedAt).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  return `<div class="res">${title ? `<div class="label">${title}</div>` : ''}
    <div class="rTitle" style="font-size:22px">${d.charAt(0).toUpperCase() + d.slice(1)} · ${hm(f.startedAt)}–${hm(l.endedAt)}</div>
    ${j.trips.map(t => `<div class="rRow"><span>${t.label}<div class="dim">${t.endReason === 'COMPLETED' ? `max ${Math.round(t.maxSpeedKmh)} km/h · ${dur(t.endedAt - t.startedAt)}` : 'non completata'}</div></span>
      ${t.endReason === 'COMPLETED' ? `<b class="${avgCls(t.averageKmh, t.limitKmh)}">${fmt(t.averageKmh)}</b>` : ''}</div>`).join('')}
    ${done.length ? `<div class="rDiff ${over ? 'warn' : 'ok'}">${done.length} ${done.length === 1 ? 'tratta' : 'tratte'} · ${over ? over + ' sopra il limite' : 'tutte entro il limite ✓'}</div>` : ''}</div>`;
}
const dayIdx = ms => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60000) / 86400000);
/** Grafico a punti: x giorni (dal primo dato a oggi, 7–30), y valori, linee di riferimento e fascia facoltativa. */
function chartSvg(points, lo, hi, refs, band) {
  const W = 600, H = 200, today = dayIdx(Date.now());
  const span = Math.min(30, Math.max(7, today - Math.min(...points.map(p => dayIdx(p.t))) + 1));
  const x = t => W * (1 - (today - dayIdx(t) + 0.5) / span), y = v => H * (1 - (v - lo) / (hi - lo));
  const col = { ok: '#3fb950', warn: '#ffb300', bad: '#ef4444' };
  return `<svg viewBox="-40 -10 ${W + 50} ${H + 40}" style="width:100%;height:auto">
    ${band != null ? `<rect x="0" y="${y(band)}" width="${W}" height="${y(-band) - y(band)}" fill="rgba(67,160,71,.15)"/>` : ''}
    <line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="#333" stroke-width="2"/>
    ${refs.map(r => `<line x1="0" y1="${y(r)}" x2="${W}" y2="${y(r)}" stroke="#bdbdbd" stroke-width="2" stroke-dasharray="10 8"/>`).join('')}
    <text x="-8" y="10" fill="#9b9b9b" font-size="16" text-anchor="end">${Math.round(hi)}</text>
    <text x="-8" y="${H}" fill="#9b9b9b" font-size="16" text-anchor="end">${Math.round(lo)}</text>
    <text x="0" y="${H + 26}" fill="#9b9b9b" font-size="15">${span} giorni fa</text><text x="${W}" y="${H + 26}" fill="#9b9b9b" font-size="15" text-anchor="end">oggi</text>
    ${points.filter(p => today - dayIdx(p.t) < span).map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(Math.min(Math.max(p.v, lo), hi)).toFixed(1)}" r="7" fill="${col[p.c]}"/>`).join('')}
  </svg>`;
}
function renderViaggi() {
  const js = journeys();
  if (!js.length) { $('viaggiList').innerHTML = '<p class="dim">Nessun viaggio ancora: dopo il primo Tutor qui trovi il riepilogo e lo storico.</p>'; return; }
  const done = history.filter(t => !t.simulated && t.endReason === 'COMPLETED');
  const lim = Math.max(...done.map(t => t.limitKmh ?? 130), 130);
  let html = journeyHtml(js[0], 'Ultimo viaggio');
  if (done.length) {
    const lo = Math.floor(Math.min(...done.map(t => t.averageKmh), lim - 20) / 10) * 10, hi = Math.ceil(Math.max(...done.map(t => t.averageKmh), lim + 10) / 10) * 10;
    html += `<div class="res"><div class="rTitle">Medie per tratta</div><div class="rSub">un punto per tratta · linea tratteggiata: limite</div>
      ${chartSvg(done.map(t => ({ t: t.startedAt, v: t.averageKmh, c: avgCls(t.averageKmh, t.limitKmh) })), lo, hi, [lim])}</div>`;
  }
  const errs = results.filter(r => r.appAvgKmh != null && r.tutorAvgKmh != null).map(r => ({ t: r.startMs, v: r.appAvgKmh - r.tutorAvgKmh }));
  if (errs.length) {
    const m = Math.max(2, ...errs.map(e => Math.abs(e.v) + 0.5));
    html += `<div class="res"><div class="rTitle">Precisione dell'app</div><div class="rSub">differenza app − Tutor sulle misure con i tocchi · fascia ±1 km/h</div>
      ${chartSvg(errs.map(e => ({ ...e, c: Math.abs(e.v) <= 1 ? 'ok' : 'warn' })), -m, m, [0], 1)}</div>`;
  }
  if (js.length > 1) html += '<h3>Viaggi precedenti</h3>' + js.slice(1, 31).map(j => journeyHtml(j)).join('');
  $('viaggiList').innerHTML = html;
}
function renderLastJourney() {
  const j = journeys()[0];
  $('lastJourney').innerHTML = j ? journeyHtml(j, 'Ultimo viaggio') + '<button data-open="viaggi" class="lj">Tutti i viaggi e lo storico</button>' : '';
  $('lastJourney').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPanel('viaggi'));
}

function openPanel(id) { if (id === 'impostazioni') renderSettings(); if (id === 'viaggi') renderViaggi(); ['tratte', 'misure', 'impostazioni', 'viaggi'].forEach(p => $(p).hidden = p !== id); if (id === 'tratte') renderTratte(); if (id === 'misure') renderMisure(); }

// ---------- Pulsanti ----------
$('go').onclick = () => start(0);
$('stop').onclick = () => confirmBox('Fermare il rilevamento?', 'La tratta in corso viene chiusa.', stop);
$('tap').onclick = tap;
$('audioBtn').onclick = () => { const order = ['voce', 'bip', 'nulla']; setSetting('audio', order[(order.indexOf(settings.audio) + 1) % 3]); };
$('undo').onclick = undoTap;
$('missing').onclick = () => {
  const p = portalToCheck; if (!p) return;
  confirmBox('Il portale non c\'è?', `Tratta ${p.label}. Premi Disattiva solo se sei passato oltre e non c'era nessun portale con telecamere. Se il portale c'è ma in un punto diverso, tocca PORTALE quando ci passi sotto.`, () => {
    setDisabled(p.sectionId, true); portalToCheck = null; portalCheck.reset(); say(['disattivata']); render();
  });
};
document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openPanel(b.dataset.open));
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openPanel(null));
$('dlgNo').onclick = () => { $('dlg').hidden = true; };
applySettings();
renderLastJourney();
loadSections().then(() => { render(); $('dbInfo').textContent = `Database tratte v${dataVersion} · ${allSections.filter(s => s.portalsMeasured).length} tratte verificate in auto`; }).catch(e => { $('startErr').textContent = 'Errore nel caricare le tratte: ' + e.message; });
