# TaskForce X

Een installeerbare takenlijst (PWA) in de stijl van TaskForce: taken per dag, en per taak een tijdstip, pushmelding en herhaling.

- **App:** GitHub Pages serveert `index.html`, `app.js` en `sw.js`.
- **Data:** `data/state.json` (taken en afvinkjes) en `data/subscriptions.json` (toestellen die meldingen willen). De app leest en schrijft deze via de GitHub API, met een fine-grained token dat alleen op je toestel staat.
- **Meldingen:** `.github/workflows/remind.yml` draait elke ~10 minuten (`scripts/remind.mjs`) en stuurt een web-push voor taken die aan de beurt zijn. Wat al verstuurd is, houdt hij bij in `data/sent.json`.

## Instellen
1. Repository secret `VAPID_PRIVATE_KEY` (de bijbehorende publieke sleutel staat in `config.json`).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open de app en maak bij Instellingen een fine-grained token aan (alleen deze repo, *Contents: Read and write*).
4. Zet bij Instellingen de meldingen aan. Op een iPhone moet je de app eerst via Safari → Deel → *Zet op beginscherm* installeren.

Testmelding: Actions → TaskForce X herinneringen → *Run workflow* → vink *test* aan.

Let op: GitHub start geplande workflows niet altijd precies op tijd. Een melding kan daardoor een paar minuten (soms langer) later binnenkomen. De repo is publiek, dus je takenlijst is zichtbaar voor wie hem opzoekt.
