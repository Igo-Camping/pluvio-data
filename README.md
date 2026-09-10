# pluvio-data

Published rainfall and radar datasets for the Pluviometrics products. The
deliverable of this repository is **data, not code** — the scripts here are the
means of producing it. `.project` declares `kind: analysis` for that reason.

## What is published, and where

Served by GitHub Pages from the `main` branch root, at the domain in `CNAME`:

    https://data.pluviometrics.com.au

Anything committed to the root of `main` is publicly readable at that host.
That includes directories added by accident — see *Working data* below.

| Path | Contents | Schema |
|---|---|---|
| `radar/nb/` | Northern Beaches rainfall accumulation from the Lizard "Precipitation Australia" raster | `pluviometrics.radar_accumulation.v1` |
| `radar/nb2/` | Northern Beaches accumulation from BoM Terrey Hills 64 km radar (IDR714), colour-class decoded, ~250 m native | `pluviometrics.radar_accumulation.v2_bom` |
| `pluviometrics_rainfall_stations.json` | Rainfall station catalogue consumed by Stormgauge and Atmos | — |
| `index` | Landing page for the data host | — |

Both radar directories publish the same four files: `today.json`,
`index.json`, `metadata.json`, and `daily/<YYYY-MM-DD>.json`. Each
`metadata.json` records its upstream source and AOI bbox.

Per-site radar accumulation is **not** published here. It goes to the
Cloudflare R2 bucket `radar-data`, public host `radar-data.pluviometrics.com.au`.

## Which workflow produces what

| Workflow | Script | Produces | Cadence (UTC) |
|---|---|---|---|
| `radar_accumulation.yml` | `scripts/build_radar_accumulation.mjs` | `radar/nb/` | `25 0,3,6,9,12,15,18,21` — ~25 min after each 3-hourly Lizard frame |
| `radar_bom.yml` | `scripts/build_radar_bom.mjs` | `radar/nb2/` | `7,37 * * * *` — BoM FTP retains only ~2 h of 5-minute frames |
| `radar_sites.yml` | `scripts/build_radar_sites.mjs` | R2 bucket `radar-data` | `7,37 * * * *` |

`radar_sites.yml` needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
secrets and holds `contents: read` — it never commits. Its local mirror
directory `radar_sites/` is gitignored.

The station catalogue is built out-of-band, not by any workflow:
`scripts/build_stations_catalogue.py`, `scripts/build_stations_wdo.py`, and
`scripts/validate_bom_high_resolution_inventory.py`.

## Constraints on the committing workflows — do not reintroduce this bug

`radar_accumulation.yml` and `radar_bom.yml` both commit and push from inside
the job:

    git add <output dir>
    git commit -m "..."
    git pull --rebase --autostash origin main
    git push origin main

Two rules keep that working. Both are load-bearing.

**1. `npm ci`, never `npm install`.** The runner resolves node 22.23.2, which
ships npm 10. npm 10 strips the `"libc": ["glibc"|"musl"]` fields that npm 11
writes into `package-lock.json`, so `npm install` rewrites the lockfile on
every run. `git add <output dir>` never stages that change, so the rebase
aborts — and it aborts *after* the commit succeeds, meaning the job exits 128
having committed locally and pushed nothing. `npm ci` never writes the
lockfile.

**2. `git pull --rebase --autostash`, not bare `git pull --rebase`.** Second
line of defence: autostash means any unstaged file, from any future cause,
cannot abort the rebase the way the lockfile did.

**Why this matters more than a normal CI failure:** the only symptom is that
the published data silently stops advancing. The workflow keeps running on
schedule, keeps ingesting, keeps committing locally, and keeps throwing the
commit away. `radar/nb2` was stale from 2026-09-07 to 2026-09-10 this way,
and consumers fell back to the coarse Lizard surface without any signal.
If a dataset looks stale, check whether the push step is failing before
suspecting the upstream feed.

Note that `radar_accumulation.yml` carries the same commit-and-push pattern
but has no install step, so it was never dirtied. That is luck, not design —
do not add an install step to it without `npm ci`.

## Working data

`source/` (upstream inventories and audits) and `outputs/` (derived
intermediates) hold the inputs and outputs of the station-catalogue work.
Neither is currently in `.gitignore`, so a careless `git add -A` would commit
them — and publish them at `data.pluviometrics.com.au`. Stage explicit paths.
