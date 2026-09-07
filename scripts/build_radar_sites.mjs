#!/usr/bin/env node
// build_radar_sites.mjs — per-site BoM radar rainfall accumulation, published to R2.
//
// For every verified NSW BoM radar site, the site's product frames
// (IDR<site>3 = 128 km, or IDR<site>2 = 256 km where the site's LGAs fall
// outside 128 km) are fetched from BoM's anonymous FTP, colour-class decoded
// to rain rate exactly as build_radar_bom.mjs does, converted to depth
// (rate x 5/60), resampled onto a 512x512 grid over the product's rectangular
// bounds (~500 m cells at 128 km, ~1 km at 256 km), and accumulated into
// per-true-Sydney-day files. Missing frames stay visible through
// frames_used vs frames_expected — never zero-filled. Unknown opaque colours
// are counted and logged, never guessed.
//
// Output (R2 bucket `radar-data`, public host radar-data.pluviometrics.com.au),
// keyed by site slug:
//   <slug>/daily/<YYYY-MM-DD>.bin.gz   Uint16 little-endian, mm x 10, row-major
//                                      north-to-south, gzip
//   <slug>/daily/<YYYY-MM-DD>.json     sidecar: window/frames accounting, unknown
//                                      colours, bbox, leaflet_bounds, grid, encoding
//   <slug>/today.bin.gz + today.json   same pair for the current Sydney day
//   <slug>/metadata.json               static site/product/grid description
//   index.json                         sites, products, last updated per site
//
// A git-ignored local mirror (radar_sites/) carries accumulation state between
// runs. When the mirror lacks a day that new frames touch, that day's pair is
// pulled from R2 first so the accumulation continues rather than restarts.
//
// Uploads use `wrangler r2 object put` with CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID from the environment. Nothing is uploaded without a
// token; --dry-run prints the exact commands instead of executing them.
//
// Usage: node scripts/build_radar_sites.mjs [--site slug[,slug]] [--hours N]
//        [--dry-run] [--no-upload] [--no-restore] [--mirror dir]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Site table
// ---------------------------------------------------------------------------
// Copied from PLUVIO_STORMGAUGE/src/modules/radar/bomRadar.js (BOM_RADAR_SITES),
// which is the source of truth for coordinates and frames_verified. Keep the
// two in step. `product` is the accumulation product for this site: the 128 km
// product unless the site's LGAs fall outside 128 km, then the 256 km product.
const SITES = [
  { site: '04', slug: 'newcastle',    name: 'Newcastle',          lat: -32.730,  lon: 152.027,  product: 'IDR043', frames_verified: true  },
  { site: '28', slug: 'grafton',      name: 'Grafton',            lat: -29.62,   lon: 152.97,   product: 'IDR283', frames_verified: true  },
  { site: '40', slug: 'canberra',     name: 'Canberra',           lat: -35.66,   lon: 149.51,   product: 'IDR402', frames_verified: true  },
  { site: '53', slug: 'moree',        name: 'Moree',              lat: -29.50,   lon: 149.85,   product: 'IDR533', frames_verified: true  },
  { site: '69', slug: 'namoi',        name: 'Namoi',              lat: -31.0240, lon: 150.1915, product: 'IDR693', frames_verified: true  },
  { site: '71', slug: 'terrey-hills', name: 'Terrey Hills',       lat: -33.701,  lon: 151.210,  product: 'IDR713', frames_verified: true  },
  { site: '93', slug: 'brewarrina',   name: 'Brewarrina',         lat: -29.96,   lon: 146.81,   product: 'IDR933', frames_verified: true  },
  { site: '94', slug: 'hillston',     name: 'Hillston',           lat: -33.55,   lon: 145.52,   product: 'IDR942', frames_verified: true  },
  { site: '96', slug: 'yeoval',       name: 'Yeoval',             lat: -32.74,   lon: 148.70,   product: 'IDR963', frames_verified: true  },
  { site: '55', slug: 'wagga-wagga',  name: 'Wagga Wagga',        lat: -35.17,   lon: 147.47,   product: 'IDR553', frames_verified: false },
  { site: '03', slug: 'wollongong',   name: 'Wollongong (Appin)', lat: -34.264,  lon: 150.874,  product: 'IDR033', frames_verified: false }
];

const RANGE_KM_BY_SUFFIX = { '1': 512, '2': 256, '3': 128, '4': 64 };

const FTP_DIR = 'ftp://ftp.bom.gov.au/anon/gen/radar/';
const PUBLIC_HOST = 'https://radar-data.pluviometrics.com.au';
const BUCKET = 'radar-data';
const IMG_SIZE = 512;
const GRID_SIZE = 512;
const FRAME_MINUTES = 5;
const SCHEMA_VERSION = 'pluviometrics.radar_accumulation.v3_site';
const VALUE_SCALE = 10;                 // stored Uint16 = mm x 10
const KM_PER_DEG_LAT = 111.132;         // decode constants, as build_radar_bom.mjs

// Standard BoM radar intensity legend, light -> extreme (mm/h midpoints).
// Identical to build_radar_bom.mjs.
const BOM_RATE_LUT = new Map([
  ['245,245,255', 0.2], ['180,180,255', 0.5], ['120,120,255', 1.5], ['20,20,255', 2.5],
  ['0,216,195', 4], ['0,150,144', 6], ['0,102,102', 10], ['255,255,0', 15],
  ['255,200,0', 20], ['255,150,0', 35], ['255,100,0', 50], ['255,0,0', 80],
  ['200,0,0', 120], ['120,0,0', 200], ['40,0,0', 360]
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt; };
const DRY_RUN = flag('--dry-run');
const NO_UPLOAD = flag('--no-upload') || DRY_RUN;
const NO_RESTORE = flag('--no-restore');
const ONLY_SITES = opt('--site') ? opt('--site').split(',').map(s => s.trim()).filter(Boolean) : null;
const HOURS = opt('--hours') ? Number(opt('--hours')) : null;
const MIRROR = path.resolve(ROOT, opt('--mirror', 'radar_sites'));

// ---------------------------------------------------------------------------
// Sydney time helpers (as build_radar_bom.mjs)
// ---------------------------------------------------------------------------

function sydneyOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'longOffset' })
    .formatToParts(new Date(utcMs));
  const name = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+10:00';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((Number(m[2]) * 60 + Number(m[3] || 0)) * 60 * 1000);
}

function sydneyDateString(utcMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(utcMs));
}

function sydneyMidnightUtcMs(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d) - 10 * 3600 * 1000;
  return Date.UTC(y, mo - 1, d) - sydneyOffsetMs(guess);
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

function stampToUtcMs(stamp) {
  return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12));
}

// ---------------------------------------------------------------------------
// Site geometry
// ---------------------------------------------------------------------------

export function siteGeometry(site) {
  const rangeKm = RANGE_KM_BY_SUFFIX[site.product.slice(-1)];
  if (!rangeKm) throw new Error(`${site.slug}: unknown product range ${site.product}`);
  // Rectangular bounds as bomRadar.js computeRectangularBoundsKm().
  const latDelta = rangeKm / 111.32;
  const lonDelta = rangeKm / (111.32 * Math.cos((site.lat * Math.PI) / 180));
  const bbox = { minLon: site.lon - lonDelta, minLat: site.lat - latDelta, maxLon: site.lon + lonDelta, maxLat: site.lat + latDelta };
  return { rangeKm, bbox, kmPerDegLon: 111.320 * Math.cos(site.lat * Math.PI / 180) };
}

// ---------------------------------------------------------------------------
// FTP fetch + frame decode
// ---------------------------------------------------------------------------

function curl(url, binary = false) {
  return execFileSync('curl', ['-s', '--max-time', '60', url], { maxBuffer: 32 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' });
}

function listFramesByProduct(products) {
  const listing = curl(FTP_DIR);
  const out = new Map();
  for (const product of products) {
    const re = new RegExp(`${product}\\.T\\.(\\d{12})\\.png`, 'g');
    const stamps = new Set();
    let m;
    while ((m = re.exec(listing))) stamps.add(m[1]);
    out.set(product, [...stamps].sort());
  }
  return out;
}

// Decode one frame onto the site grid as mm of rain in 5 minutes.
// Pixel mapping is build_radar_bom.mjs's frameToAoiGrid, generalised to the
// site's centre and range. Returns { grid, unknown } where unknown counts
// opaque colours not in the legend.
export function frameToSiteGrid(pngBuffer, site, geom) {
  const img = PNG.sync.read(pngBuffer);
  if (img.width !== IMG_SIZE || img.height !== IMG_SIZE) {
    throw new Error(`Unexpected radar image size ${img.width}x${img.height}`);
  }
  const { bbox, rangeKm, kmPerDegLon } = geom;
  const out = new Float64Array(GRID_SIZE * GRID_SIZE);
  const unknown = new Map();
  const lonStep = (bbox.maxLon - bbox.minLon) / GRID_SIZE;
  const latStep = (bbox.maxLat - bbox.minLat) / GRID_SIZE;
  const pxPerKm = IMG_SIZE / (2 * rangeKm);
  for (let r = 0; r < GRID_SIZE; r++) {
    const lat = bbox.maxLat - (r + 0.5) * latStep;
    const dyKm = (lat - site.lat) * KM_PER_DEG_LAT;
    const py = Math.round(IMG_SIZE / 2 - dyKm * pxPerKm);
    if (py < 0 || py >= IMG_SIZE) continue;
    for (let c = 0; c < GRID_SIZE; c++) {
      const lon = bbox.minLon + (c + 0.5) * lonStep;
      const dxKm = (lon - site.lon) * kmPerDegLon;
      const px = Math.round(IMG_SIZE / 2 + dxKm * pxPerKm);
      if (px < 0 || px >= IMG_SIZE) continue;
      const o = (py * IMG_SIZE + px) * 4;
      if (img.data[o + 3] === 0) continue;               // transparent = no echo
      const key = `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
      const rate = BOM_RATE_LUT.get(key);
      if (rate === undefined) {
        unknown.set(key, (unknown.get(key) || 0) + 1);
        continue;
      }
      out[r * GRID_SIZE + c] = rate * FRAME_MINUTES / 60;
    }
  }
  return { grid: out, unknown };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeValues(values) {
  const u16 = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    u16[i] = Math.min(65535, Math.max(0, Math.round(values[i] * VALUE_SCALE)));
  }
  // Uint16Array on every supported platform is little-endian; make it explicit.
  const buf = Buffer.alloc(u16.length * 2);
  for (let i = 0; i < u16.length; i++) buf.writeUInt16LE(u16[i], i * 2);
  return gzipSync(buf);
}

export function decodeValues(gzBuffer, expectedLength = GRID_SIZE * GRID_SIZE) {
  const raw = gunzipSync(gzBuffer);
  if (raw.length !== expectedLength * 2) throw new Error(`decoded length ${raw.length} != ${expectedLength * 2}`);
  const out = new Float64Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) out[i] = raw.readUInt16LE(i * 2) / VALUE_SCALE;
  return out;
}

const ENCODING = { type: 'uint16', byte_order: 'little-endian', scale: VALUE_SCALE, units: 'mm', compression: 'gzip', row_order: 'north_to_south' };

// ---------------------------------------------------------------------------
// Mirror + R2 restore
// ---------------------------------------------------------------------------

function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj));
}

function mirrorPaths(slug, date) {
  const dir = path.join(MIRROR, slug, 'daily');
  return { json: path.join(dir, `${date}.json`), bin: path.join(dir, `${date}.bin.gz`) };
}

async function fetchPublic(key) {
  const resp = await fetch(`${PUBLIC_HOST}/${key}?v=${Date.now()}`, { cache: 'no-store' });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`${key} ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Pull a day's pair from R2 into the mirror when the mirror lacks it.
async function restoreDayFromR2(slug, date) {
  const p = mirrorPaths(slug, date);
  if (existsSync(p.json) && existsSync(p.bin)) return false;
  if (NO_RESTORE) return false;
  try {
    const json = await fetchPublic(`${slug}/daily/${date}.json`);
    const bin = json ? await fetchPublic(`${slug}/daily/${date}.bin.gz`) : null;
    if (!json || !bin) return false;
    mkdirSync(path.dirname(p.json), { recursive: true });
    writeFileSync(p.json, json);
    writeFileSync(p.bin, bin);
    console.log(`${slug} ${date}: restored from R2`);
    return true;
  } catch (e) {
    console.warn(`${slug} ${date}: R2 restore failed (${e.message}); starting fresh`);
    return false;
  }
}

function newDay(site, geom, date) {
  const startMs = sydneyMidnightUtcMs(date);
  const endMs = sydneyMidnightUtcMs(addDays(date, 1));
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      site: site.site, slug: site.slug, name: site.name, product: site.product, range_km: geom.rangeKm,
      date,
      window_start_utc: new Date(startMs).toISOString(),
      window_end_utc: new Date(endMs).toISOString(),
      frames_expected: Math.round((endMs - startMs) / 60000 / FRAME_MINUTES),
      frames_used: 0,
      frames_first_used_utc: null,
      frames_last_used_utc: null,
      frames: [],
      unknown_colours: {},
      bbox: [geom.bbox.minLon, geom.bbox.minLat, geom.bbox.maxLon, geom.bbox.maxLat],
      leaflet_bounds: [[geom.bbox.minLat, geom.bbox.minLon], [geom.bbox.maxLat, geom.bbox.maxLon]],
      grid_rows: GRID_SIZE, grid_cols: GRID_SIZE,
      encoding: ENCODING
    },
    values: new Float64Array(GRID_SIZE * GRID_SIZE)
  };
}

function loadDay(site, geom, date) {
  const p = mirrorPaths(site.slug, date);
  if (existsSync(p.json) && existsSync(p.bin)) {
    try {
      const meta = JSON.parse(readFileSync(p.json, 'utf8'));
      const values = decodeValues(readFileSync(p.bin), meta.grid_rows * meta.grid_cols);
      if (meta.product === site.product && meta.grid_rows === GRID_SIZE) return { meta, values };
      console.warn(`${site.slug} ${date}: mirror is for ${meta.product}/${meta.grid_rows}; rebuilding`);
    } catch (e) {
      console.warn(`${site.slug} ${date}: unreadable mirror (${e.message}); rebuilding`);
    }
  }
  return newDay(site, geom, date);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

const uploads = [];   // { key, file, contentType, gzip }

function queueUpload(key, file, contentType, gzip = false) {
  uploads.push({ key, file, contentType, gzip });
}

function runUploads() {
  if (!uploads.length) { console.log('Nothing to upload.'); return; }
  const hasToken = !!process.env.CLOUDFLARE_API_TOKEN && !!process.env.CLOUDFLARE_ACCOUNT_ID;
  console.log(`${uploads.length} object(s) to upload to ${BUCKET}${DRY_RUN ? ' (dry run)' : ''}`);
  for (const u of uploads) {
    const args = ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${u.key}`, '--file', u.file, '--content-type', u.contentType];
    if (u.gzip) args.push('--content-encoding', 'gzip');
    args.push('--remote');
    if (DRY_RUN || NO_UPLOAD) { console.log('  npx ' + args.join(' ')); continue; }
    if (!hasToken) { console.warn('  CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set; skipping ' + u.key); continue; }
    execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sites = SITES.filter(s => s.frames_verified && (!ONLY_SITES || ONLY_SITES.includes(s.slug)));
  if (!sites.length) throw new Error('No verified sites selected');
  const skipped = SITES.filter(s => !s.frames_verified).map(s => `${s.slug} (${s.product})`);
  if (skipped.length) console.log(`Skipping unverified: ${skipped.join(', ')}`);

  const byProduct = listFramesByProduct(sites.map(s => s.product));
  const cutoffMs = HOURS ? Date.now() - HOURS * 3600 * 1000 : null;
  const indexFile = path.join(MIRROR, 'index.json');
  const index = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, 'utf8'))
    : { schema_version: SCHEMA_VERSION, updated_at: null, sites: {} };
  const today = sydneyDateString(Date.now());

  for (const site of sites) {
    const geom = siteGeometry(site);
    let stamps = byProduct.get(site.product) || [];
    if (cutoffMs) stamps = stamps.filter(s => stampToUtcMs(s) >= cutoffMs);
    if (!stamps.length) { console.warn(`${site.slug}: no ${site.product} frames in FTP listing`); continue; }
    console.log(`${site.slug} ${site.product}: ${stamps.length} frames (${stamps[0]} .. ${stamps[stamps.length - 1]})`);

    const touched = new Map();
    let fetched = 0;
    for (const stamp of stamps) {
      const date = sydneyDateString(stampToUtcMs(stamp));
      if (!touched.has(date)) {
        await restoreDayFromR2(site.slug, date);
        touched.set(date, loadDay(site, geom, date));
      }
      const day = touched.get(date);
      if (day.meta.frames.includes(stamp)) continue;
      let decoded;
      try {
        decoded = frameToSiteGrid(curl(`${FTP_DIR}${site.product}.T.${stamp}.png`, true), site, geom);
      } catch (e) {
        console.error(`${site.slug} frame ${stamp}: ${e.message}`);
        continue;
      }
      for (let i = 0; i < decoded.grid.length; i++) day.values[i] += decoded.grid[i];
      for (const [k, n] of decoded.unknown) day.meta.unknown_colours[k] = (day.meta.unknown_colours[k] || 0) + n;
      day.meta.frames.push(stamp);
      day.meta.frames.sort();
      day.meta.frames_used = day.meta.frames.length;
      day.meta.frames_first_used_utc = new Date(stampToUtcMs(day.meta.frames[0])).toISOString();
      day.meta.frames_last_used_utc = new Date(stampToUtcMs(day.meta.frames[day.meta.frames.length - 1])).toISOString();
      fetched++;
    }

    const siteDir = path.join(MIRROR, site.slug);
    for (const [date, day] of touched) {
      const p = mirrorPaths(site.slug, date);
      day.meta.as_of_utc = new Date().toISOString();
      mkdirSync(path.dirname(p.json), { recursive: true });
      writeFileSync(p.bin, encodeValues(day.values));
      writeJson(p.json, day.meta);
      queueUpload(`${site.slug}/daily/${date}.bin.gz`, p.bin, 'application/octet-stream', true);
      queueUpload(`${site.slug}/daily/${date}.json`, p.json, 'application/json');
      const unk = Object.keys(day.meta.unknown_colours).length;
      console.log(`${site.slug} ${date}: frames_used=${day.meta.frames_used}/${day.meta.frames_expected}` +
        (unk ? ` unknown colours: ${JSON.stringify(Object.entries(day.meta.unknown_colours).slice(0, 5))}` : ''));
      if (date === today) {
        copyFileSync(p.bin, path.join(siteDir, 'today.bin.gz'));
        copyFileSync(p.json, path.join(siteDir, 'today.json'));
        queueUpload(`${site.slug}/today.bin.gz`, path.join(siteDir, 'today.bin.gz'), 'application/octet-stream', true);
        queueUpload(`${site.slug}/today.json`, path.join(siteDir, 'today.json'), 'application/json');
      }
    }

    const metaFile = path.join(siteDir, 'metadata.json');
    const metadata = {
      schema_version: SCHEMA_VERSION,
      site: site.site, slug: site.slug, name: site.name, product: site.product, range_km: geom.rangeKm,
      site_lat: site.lat, site_lon: site.lon,
      source: `BoM ${site.name} ${geom.rangeKm} km radar (${site.product}), colour-class decoded`,
      source_ftp: `${FTP_DIR}${site.product}.T.<YYYYMMDDHHMM>.png`,
      bbox: [geom.bbox.minLon, geom.bbox.minLat, geom.bbox.maxLon, geom.bbox.maxLat],
      leaflet_bounds: [[geom.bbox.minLat, geom.bbox.minLon], [geom.bbox.maxLat, geom.bbox.maxLon]],
      grid_rows: GRID_SIZE, grid_cols: GRID_SIZE,
      cell_size_km_approx: Math.round((2 * geom.rangeKm / GRID_SIZE) * 100) / 100,
      row_order: 'north_to_south',
      frame_interval_minutes: FRAME_MINUTES,
      day_boundary_rule: 'True Sydney midnight',
      encoding: ENCODING,
      units: 'mm accumulated over the window (class-midpoint rates x 5 min)',
      warning: 'Colour-class radar QPE. Absolute depths need gauge calibration; the Stormgauge client applies local gauge anchoring. Gauge records remain authoritative.'
    };
    const metaChanged = !existsSync(metaFile) || JSON.stringify({ ...JSON.parse(readFileSync(metaFile, 'utf8')), generated_at: 0 }) !== JSON.stringify({ ...metadata, generated_at: 0 });
    if (metaChanged) {
      writeJson(metaFile, { ...metadata, generated_at: new Date().toISOString() });
      queueUpload(`${site.slug}/metadata.json`, metaFile, 'application/json');
    }

    const todayDay = touched.get(today);
    index.sites[site.slug] = {
      site: site.site, name: site.name, product: site.product, range_km: geom.rangeKm, frames_verified: true,
      last_updated_utc: fetched ? new Date().toISOString() : (index.sites[site.slug]?.last_updated_utc || null),
      today_date: todayDay ? today : (index.sites[site.slug]?.today_date || null),
      today_frames_used: todayDay ? todayDay.meta.frames_used : (index.sites[site.slug]?.today_frames_used ?? null)
    };
    console.log(`${site.slug}: ${fetched} new frames ingested`);
  }

  for (const s of SITES.filter(s => !s.frames_verified)) {
    index.sites[s.slug] = { ...(index.sites[s.slug] || {}), site: s.site, name: s.name, product: s.product, frames_verified: false };
  }
  index.updated_at = new Date().toISOString();
  writeJson(indexFile, index);
  queueUpload('index.json', indexFile, 'application/json');

  runUploads();
  console.log('Done.');
}

// Run only when executed directly; importing the module (tests, verification) does not ingest.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { SITES, GRID_SIZE, VALUE_SCALE, BOM_RATE_LUT, sydneyDateString, stampToUtcMs };
