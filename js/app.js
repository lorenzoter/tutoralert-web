// TutorAlert per il browser della Tesla: GPS, motore Tutor (engine.js), voce registrata, modalità prova.
import { Geo, Section, Tracker, Prova } from './engine.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v == null ? '--' : v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const km = (m, d = 1) => fmt(m / 1000, d) + ' km';
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const store = {
  get(k, def) { try { const v = localStorage.getItem('ta.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('ta.' + k, JSON.stringify(v)); } catch { /* memoria piena o non disponibile */ } },
};
const ROUTE = [35, 36, 37, 38, 45, 46, 47, 48];

// ---------- Stato ----------
let allSections = [], sections = [], tracker = null;
let disabled = new Set(store.get('disabled', []));
let results = store.get('results', []);
let running = false, simulated = false, watchId = null, simTimer = null;
let fixes = [], taps = [], trips = [], lastFix = null, lastFedAt = 0, lastFixWall = 0;
let status = null, next = null, nextPortal = null, portalToCheck = null, lastResult = null, gpsLostS = null;
const announced = new Set();
let lastOverSpeech = 0;

// ---------- Voce registrata ----------
let ac = null, clips = {}, clipNames = [], speakQueue = Promise.resolve();
async function loadVoice() {
  ac = ac || new (window.AudioContext || window.webkitAudioContext)();
  await ac.resume();
  if (clipNames.length) return;
  clipNames = await (await fetch('audio/index.json')).json();
  await Promise.all(clipNames.map(async k => {
    try { clips[k] = await ac.decodeAudioData(await (await fetch('audio/' + k + '.mp3')).arrayBuffer()); } catch { /* manca una frase: si salta */ }
  }));
}
const num = n => { n = Math.round(n); return n >= 1 && n <= 200 ? 'n' + n : null; };
/** Pronuncia una frase fatta di pezzi registrati, in coda alle precedenti. */
function say(keys) {
  if (!ac) return;
  const parts = keys.filter(k => k && clips[k]);
  if (!parts.length) return;
  speakQueue = speakQueue.then(() => new Promise(done => {
    ac.resume();
    let at = ac.currentTime + 0.05;
    for (const k of parts) {
      const src = ac.createBufferSource();
      src.buffer = clips[k]; src.connect(ac.destination); src.start(at);
      at += clips[k].duration + 0.03;
    }
    setTimeout(done, (at - ac.currentTime) * 1000 + 150);
  }));
}

// ---------- Tratte ----------
async function loadSections() {
  const data = await (await fetch('data/a1_sections.json')).json();
  allSections = data.sections.map(s => new Section(s));
  applyDisabled();
}
function applyDisabled() {
  sections = allSections.filter(s => !disabled.has(s.id));
  tracker?.setSections(sections);
}
function setDisabled(id, off) {
  if (off) disabled.add(id); else disabled.delete(id);
  store.set('disabled', [...disabled]);
  applyDisabled();
}

// ---------- Avvio e posizione ----------
async function start(sim) {
  $('startErr').textContent = '';
  try { await loadVoice(); } catch { /* senza voce si va avanti */ }
  if (!allSections.length) await loadSections();
  tracker = new Tracker(sections);
  fixes = []; taps = []; trips = []; announced.clear(); portalCheck.reset();
  status = next = nextPortal = portalToCheck = null; lastFix = null; lastFedAt = 0;
  simulated = !!sim; running = true;
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
  if (status && status.confirmed && status.level === 'OVER' && !status.suspended && fix.timeMs - lastOverSpeech >= 60000) overSpeech(status, fix.timeMs);
  next = status ? null : nextTutor(fix);
  nextPortal = findNextPortal(fix);
  portalToCheck = portalCheck.update(fix, nextPortal);
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
  if (t.endReason === 'COMPLETED') say(['fine', 'media', num(t.averageKmh)]);
  else if (t.endReason === 'LEFT_ROUTE') say(['chiusa']);
  refreshAppAverages(t.sectionId);
}

function overSpeech(s, now) {
  lastOverSpeech = now;
  const rec = s.recommendedKmh != null ? Math.round(s.recommendedKmh) : null;
  if (s.cannotRecover) say(['oltre']);
  else if (rec != null && s.limitKmh != null && rec < s.limitKmh) say(['rallenta', num(rec)]);
  else say(['attenzione']);
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
  if (d <= 1000 && !announced.has(ts.id)) {
    announced.add(ts.id);
    const m = Math.round(d / 100) * 100;
    say(m >= 1000 ? ['un_km', ts.limitKmh ? 'limite' : null, num(ts.limitKmh)] : ['tutor_tra', 'n' + m, 'metri', ts.limitKmh ? 'limite' : null, num(ts.limitKmh)]);
  }
  return { ts, distanceM: d };
}

/** Prossimo portale (inizio o fine) davanti entro 1,5 km. */
function findNextPortal(fix) {
  const course = fix.bearingDeg != null && (fix.speedMps ?? 0) * 3.6 > 15 ? fix.bearingDeg : null;
  if (course == null) return null;
  let best = null;
  for (const ts of sections) {
    if (!ts.nearBox(fix.lat, fix.lon, 1600)) continue;
    const p = ts.track.project(fix.lat, fix.lon);
    if (p.lateral > 80 || Geo.angleDiff(course, p.bearing) > 45) continue;
    for (const [d, isStart] of [[-p.s, true], [ts.track.length - p.s, false]]) {
      if (d >= 15 && d <= 1500 && (!best || d < best.distanceM)) best = { distanceM: d, isStart, sectionId: ts.id, label: ts.label, verified: ts.portalsMeasured };
    }
  }
  return best;
}

/** "Il portale non c'è" è attivo solo nel primo km dopo il punto previsto. */
const portalCheck = {
  portal: null, remaining: 0, prev: null,
  reset() { this.portal = null; this.prev = null; },
  update(fix, ahead) {
    if ((fix.accuracyM ?? 0) <= 50) { if (this.prev) this.remaining -= Geo.dist(this.prev.lat, this.prev.lon, fix.lat, fix.lon); this.prev = fix; }
    const passed = this.portal && this.remaining <= 0 && this.remaining > -1000;
    if (ahead && !passed) { this.portal = ahead; this.remaining = ahead.distanceM; }
    if (this.portal && this.remaining <= -1000) this.portal = null;
    return this.portal && this.remaining <= 0 ? this.portal : null;
  },
};

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
  say(['portale']); render();
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
    $('avg').textContent = fmt(avg); $('avg').className = 'avg ' + col;
    $('limit').textContent = lim ?? '?';
    const spd = lastFix?.speedMps != null ? Math.round(lastFix.speedMps * 3.6) : '--';
    $('tLine').textContent = `ora ${spd} km/h · ${km(s.remainingMeters)} alla fine · ${dur(s.elapsedMs)}`;
    $('bar').style.width = (s.progress * 100).toFixed(1) + '%'; $('bar').className = 'fill ' + col;
    const rec = s.recommendedKmh != null ? Math.round(s.recommendedKmh) : null;
    const banner = gpsLostS != null ? [`GPS perso da ${gpsLostS} s · media stimata`, 'warn']
      : s.suspended ? ['Fuori percorso', 'warn']
      : s.cannotRecover ? ['Media oltre il limite', 'bad']
      : s.level === 'OVER' && rec != null && lim != null && rec < lim ? [`Rallenta a ${rec}`, 'warn'] : null;
    $('banner').hidden = !banner;
    if (banner) { $('banner').textContent = banner[0]; $('banner').className = 'banner ' + banner[1]; }
    $('tState').textContent = (s.section.portalsMeasured ? '🟢 Portali verificati in auto · formula del Tutor' : '⚪ Portali da verificare: media prudente') + ` · ${km(s.totalMeters, 2)}`;
  } else {
    $('speed').textContent = lastFix?.speedMps != null ? Math.round(lastFix.speedMps * 3.6) : '--';
    $('nextCard').className = 'card next' + (next ? ' on' : '');
    $('nextTitle').textContent = next ? `Tutor tra ${Math.round(next.distanceM / 10) * 10} m` : running ? 'Nessun Tutor davanti entro 2 km' : '';
    $('nextSub').textContent = next ? `${next.ts.label} · ${km(next.ts.officialLength)} · limite ${next.ts.limitKmh ?? '?'}` : '';
  }
  // Prova
  const np = nextPortal;
  $('hint').textContent = np ? `Portale previsto tra circa ${Math.round(np.distanceM / 50) * 50} m` + (np.verified ? '' : ' (posizione approssimativa)')
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
  $('tratteList').innerHTML = list.map(s => `<div class="item">
      <div><b>${s.label}</b><div class="dim">${s.json.direction ?? ''} · ${km(s.officialLength, 2)} · limite ${s.limitKmh ?? '?'}</div>
      <div class="dim">${disabled.has(s.id) ? '⛔ Disattivata' : s.portalsMeasured ? '🟢 Portali verificati in auto' : '⚪ Portali da verificare'}</div></div>
      <button class="small ${disabled.has(s.id) ? '' : 'danger'}" data-id="${s.id}">${disabled.has(s.id) ? 'Riattiva' : 'Non esiste'}</button></div>`).join('');
  $('tratteList').querySelectorAll('button').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.id);
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
function openPanel(id) { ['tratte', 'misure'].forEach(p => $(p).hidden = p !== id); if (id === 'tratte') renderTratte(); if (id === 'misure') renderMisure(); }

// ---------- Pulsanti ----------
$('go').onclick = () => start(0);
$('sim').onclick = () => start(10);
$('stop').onclick = () => confirmBox('Fermare il rilevamento?', 'La tratta in corso viene chiusa.', stop);
$('tap').onclick = tap;
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
loadSections().then(render).catch(e => { $('startErr').textContent = 'Errore nel caricare le tratte: ' + e.message; });
