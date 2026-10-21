# TutorAlert web

Versione web di TutorAlert per il browser della Tesla (autostrada A1).

- `index.html`, `js/app.js` — l'app: avvisi Tutor, media in tratta, voce registrata, modalità prova (PORTALE).
- `js/engine.js` — motore Tutor, traduzione fedele di quello dell'app Android; `tools/replay.mjs` rigioca i
  registri di guida e dà risultati identici alla versione Kotlin.
- `data/a1_sections.json` — tratte A1 (portali SICVe; quelli verificati in auto sono marcati "verificato").
- `audio/` — frasi registrate (sintesi Piper, voce "paola").
- `prova/` — pagina di prova del browser (GPS, audio, blocchi).

Il browser va tenuto aperto sullo schermo: con la mappa a schermo intero la Tesla sospende la pagina.

Pubblicata con GitHub Pages: https://lorenzoter.github.io/tutoralert-web/
