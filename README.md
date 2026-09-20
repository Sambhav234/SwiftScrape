## SwiftScrape

Tracks only `https://demo.inelabteamdev.com/`; metadata uses its JSON API and prices use Playwright.

## Deployment

Run `npm ci && npx playwright install chromium`, set `TARGET_ORIGIN`, `CRON_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`, then apply `supabase/migrations/001_initial.sql`. Build and serve with `npm run build && npm run api`; Express serves `dist`.

## API

`GET /api/health`; `GET /api/search?q=term`; `GET|POST /api/tracked`; `DELETE /api/tracked/:id`; `GET /api/history/:id`; `GET /api/logs`.

`POST /api/cron/scrape` requires `x-cron-secret: $CRON_SECRET`, returns `202` immediately, and rejects overlapping runs. In cron-job.org configure the POST URL `https://<render-host>/api/cron/scrape`, header `x-cron-secret: <value>`, and a 2-hour schedule. A GitHub Actions trigger can call the same endpoint.

## Scraping

`npm run scrape` collects metadata. `npm run scrape:headed -- --product 1` performs one headed reveal; add `--chaos` to select a random product. Browser attestation can be rejected or rate-limited by the target.

## Validation

Run `npm test` and `npm run build`.
