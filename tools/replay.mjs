// Rigioca i registri CSV dell'app Android con il motore web e stampa le tratte (confronto con ReplayDump.kt).
import fs from 'node:fs';
import path from 'node:path';
import { Section, Tracker } from '../js/engine.js';

const [dir, sectionsFile] = process.argv.slice(2);
const sections = JSON.parse(fs.readFileSync(sectionsFile, 'utf8')).sections.map(s => new Section(s));
const out = [];
for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
  const fixes = [];
  for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
    const c = line.split(',');
    if (c.length < 8 || c[0] !== 'fix') continue;
    const num = v => (v === '' ? null : Number(v));
    fixes.push({ lat: Number(c[2]), lon: Number(c[3]), accuracyM: num(c[4]), speedMps: c[5] === '' ? null : Number(c[5]) / 3.6, bearingDeg: num(c[6]), timeMs: Number(c[1]) });
  }
  fixes.sort((a, b) => a.timeMs - b.timeMs);
  const tr = new Tracker(sections);
  let sum = 0, n = 0;
  const trip = t => out.push(`${name} trip ${t.sectionId} ${t.startedAt} ${t.endedAt} ${t.averageKmh.toFixed(6)} ${t.endReason}`);
  for (const f of fixes) {
    const u = tr.update(f);
    for (const e of u.events) {
      if (e.type === 'finished') trip(e.trip);
      else if (e.type === 'started') out.push(`${name} start ${e.section.id} ${e.timeMs}`);
    }
    if (u.status?.averageKmh != null) { sum += u.status.averageKmh; n++; }
  }
  const last = tr.stop(); if (last) trip(last.trip);
  out.push(`${name} status ${n} ${sum.toFixed(6)}`);
}
console.log(out.join('\n'));
