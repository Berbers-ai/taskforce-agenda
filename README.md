# TaskForce X

Een gedeelde takenlijst per dag (PWA). Per taak: tijdstip, pushmelding (op tijd of vooraf), herhalen en voor wie hij is.
Iemand laten meedoen gaat met een uitnodigingslink: openen, naam invullen, klaar. Geen account nodig.

- **App:** GitHub Pages serveert `index.html`, `app.js`, `sw.js` en `vendor/` (supabase-js 2.119.1, MIT).
- **Data:** Supabase. Tabellen, beveiliging (Row Level Security) en functies staan in `supabase/schema.sql`.
  Elk toestel logt anoniem in; alleen leden van een agenda kunnen die lezen of wijzigen.
- **Meldingen:** `.github/workflows/remind.yml` draait elke ~5 minuten (`scripts/remind.mjs`), leest de taken met de
  geheime Supabase-sleutel en stuurt web-push naar de toestellen van de juiste persoon.

## Instellen
1. Supabase-project → Authentication → Sign In / Providers → **Allow anonymous sign-ins** aan.
2. SQL Editor → plak `supabase/schema.sql` → Run.
3. Vul in `config.json` de `supabaseUrl` en `supabaseKey` (publishable key) in.
4. Repository secrets: `SUPABASE_SECRET_KEY` (secret key) en `VAPID_PRIVATE_KEY` (publieke sleutel staat in `config.json`).
5. Settings → Pages → Deploy from branch → `main` / root.

Testmelding: Actions → TaskForce X herinneringen → *Run workflow* → vink *test* aan.

GitHub start geplande workflows niet altijd precies op tijd; een melding kan daardoor een paar minuten later komen.
