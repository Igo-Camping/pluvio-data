#!/usr/bin/env python3
"""
build_stations_catalogue.py -- station catalogue + embedded IFD table from the gauge registry CSV.

Inputs (read only):
  nsw_rainfall_stations.csv                                 gauge registry export (this repo)
  ..\\PLUVIO_STORMGAUGE_NSW\\data\\nsw_rainfall_stations_ifd.json  fresh BoM IFD per gauge_uid
                                                             (29 durations x 7 AEP columns + rare)

Outputs (overwritten):
  pluviometrics_rainfall_stations.json                      station catalogue (this repo)
  ..\\PLUVIO_STORMGAUGE\\data\\pluviometrics_ifd_table.json  IFD table keyed by gauge_uid

Selection: live == true AND cls in {A,B,C} AND at least one of mhl_ts_id / wdo_ts_id /
waternsw_site non-empty. The run aborts unless exactly EXPECTED_COUNT gauges are selected,
every selected gauge has an IFD record with an accepted status, and every IFD table is
monotonic (non-decreasing across AEP columns from common to rare, and non-decreasing with
duration in every column).

Nothing is written until every check has passed.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]                       # PLUVIO_DATA
CSV_PATH = ROOT / "nsw_rainfall_stations.csv"
IFD_INPUT = ROOT.parent / "PLUVIO_STORMGAUGE_NSW" / "data" / "nsw_rainfall_stations_ifd.json"
CATALOGUE_OUT = ROOT / "pluviometrics_rainfall_stations.json"
IFD_TABLE_OUT = ROOT.parent / "PLUVIO_STORMGAUGE" / "data" / "pluviometrics_ifd_table.json"

# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

EXPECTED_COUNT = 545
ACCEPTED_CLASSES = ("A", "B", "C")
ACCEPTED_IFD_STATUS = ("ok",)

# AEP columns in order from common to rare. Rare columns are merged from the
# record's `rare` block; "1 in 100" and "1 in 2000" are deliberately not carried.
AEP_COLUMNS = ["63.2%", "50%", "20%", "10%", "5%", "2%", "1%"]
RARE_COLUMNS = ["1 in 200", "1 in 500", "1 in 1000"]
ALL_COLUMNS = AEP_COLUMNS + RARE_COLUMNS

# Column-monotonicity exemption. BoM's rare design-rainfall grids are derived separately
# from the standard IFD and are not smoothed across the daily boundary, so the rare columns
# can dip slightly between 1440 and 1800 minutes. A decrease in a rare column at that one
# step is tolerated up to max(TOLERANCE_MM, TOLERANCE_PCT % of the 1440 value). Every other
# column, every other step, and the row check stay strict. Every exempted cell is recorded.
TOLERANCE_MM = 5.0
TOLERANCE_PCT = 3.0
TOLERANCE_STEP = ("1440", "1800")
IFD_VALIDATION_RULE = (
    "Each row non-decreasing across AEP columns from common to rare; each column "
    "non-decreasing with duration. Exemption: rare columns may decrease at the "
    f"{TOLERANCE_STEP[0]}-{TOLERANCE_STEP[1]} minute step only, by at most "
    f"{TOLERANCE_MM:g} mm or {TOLERANCE_PCT:g} percent of the {TOLERANCE_STEP[0]} value, "
    "whichever is larger. Exempted cells are listed."
)

COASTAL_SUFFIX = " (coastal)"


def fail(msg: str) -> None:
    print(f"ABORT: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

def is_selected(row: dict) -> bool:
    if row.get("live", "").strip().lower() != "true":
        return False
    if row.get("cls", "").strip() not in ACCEPTED_CLASSES:
        return False
    return any(row.get(k, "").strip() for k in ("mhl_ts_id", "wdo_ts_id", "waternsw_site"))


def load_selected_rows() -> list[dict]:
    with CSV_PATH.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    selected = [r for r in rows if is_selected(r)]
    uids = [r["gauge_uid"] for r in selected]
    if len(set(uids)) != len(uids):
        dupes = [u for u, n in Counter(uids).items() if n > 1]
        fail(f"duplicate gauge_uid in selection: {dupes}")
    return selected


# ---------------------------------------------------------------------------
# Record shaping
# ---------------------------------------------------------------------------

def _int_or_none(s: str):
    s = (s or "").strip()
    return int(float(s)) if s else None


def _float_or_none(s: str):
    s = (s or "").strip()
    return float(s) if s else None


def _str_or_none(s: str):
    s = (s or "").strip()
    return s or None


def strip_coastal(lga: str) -> str:
    lga = (lga or "").strip()
    if lga.endswith(COASTAL_SUFFIX):
        lga = lga[: -len(COASTAL_SUFFIX)]
    return lga


def source_of(row: dict) -> tuple[str, str]:
    mhl = row.get("mhl_ts_id", "").strip()
    if mhl:
        return "mhl", mhl
    return "wdo", row.get("wdo_ts_id", "").strip()


def catalogue_record(row: dict) -> dict:
    source, ts_id = source_of(row)
    return {
        "station_type": "rainfall",
        "station_id": row["gauge_uid"].strip(),
        "gauge_uid": row["gauge_uid"].strip(),
        "station_name": row["name"].strip(),
        "lat": float(row["lat"]),
        "lon": float(row["lon"]),
        "lga": strip_coastal(row.get("lga", "")),
        "cls": row["cls"].strip(),
        "interval_s": _int_or_none(row.get("interval_s")),
        "mode": _str_or_none(row.get("mode")),
        "networks": _str_or_none(row.get("networks")),
        "last_data": _str_or_none(row.get("last_data")),
        "record_start": _str_or_none(row.get("record_start")),
        "checksum_agree_pct": _float_or_none(row.get("checksum_agree_pct")),
        "source": source,
        "ts_id": ts_id,
        "data_identifier": f"{source}:{ts_id}",
        "mhl_ts_id": _str_or_none(row.get("mhl_ts_id")),
        "wdo_ts_id": _str_or_none(row.get("wdo_ts_id")),
        "waternsw_site": _str_or_none(row.get("waternsw_site")),
    }


# ---------------------------------------------------------------------------
# IFD
# ---------------------------------------------------------------------------

def build_ifd(rec: dict) -> dict:
    """Return {duration: {column: depth}} with the three rare columns merged in."""
    ifds = rec.get("ifds") or {}
    rare = rec.get("rare") or {}
    out: dict[str, dict[str, float]] = {}
    for dur in sorted(ifds, key=float):
        row = {col: ifds[dur][col] for col in AEP_COLUMNS if col in ifds[dur]}
        rare_row = rare.get(dur) or {}
        for col in RARE_COLUMNS:
            if col in rare_row and rare_row[col] is not None:
                row[col] = rare_row[col]
        out[str(int(float(dur)))] = row
    return out


def validate_ifd(uid: str, ifd: dict, exempted: list) -> None:
    """Abort on any monotonicity failure except the scoped rare-column tolerance.

    Tolerated cells are appended to `exempted` as {uid, column, v1440, v1800}.
    """
    durations = sorted(ifd, key=float)
    # Rows: non-decreasing across columns, common -> rare.
    for dur in durations:
        row = ifd[dur]
        prev_key, prev_val = None, None
        for col in ALL_COLUMNS:
            if col not in row:
                continue
            val = row[col]
            if not isinstance(val, (int, float)):
                fail(f"non-numeric depth uid={uid} duration={dur} key={col!r} value={val!r}")
            if prev_val is not None and val < prev_val:
                fail(f"row not non-decreasing uid={uid} duration={dur} key={col!r} "
                     f"({prev_key}={prev_val} > {col}={val})")
            prev_key, prev_val = col, val
    # Columns: non-decreasing with duration.
    for col in ALL_COLUMNS:
        prev_dur, prev_val = None, None
        for dur in durations:
            if col not in ifd[dur]:
                continue
            val = ifd[dur][col]
            if prev_val is not None and val < prev_val:
                decrease = prev_val - val
                allowed = max(TOLERANCE_MM, prev_val * TOLERANCE_PCT / 100.0)
                if (col in RARE_COLUMNS and (prev_dur, dur) == TOLERANCE_STEP
                        and decrease <= allowed):
                    exempted.append({"uid": uid, "column": col,
                                     f"v{TOLERANCE_STEP[0]}": prev_val,
                                     f"v{TOLERANCE_STEP[1]}": val})
                else:
                    fail(f"column not non-decreasing uid={uid} duration={dur} key={col!r} "
                         f"({prev_dur} min={prev_val} > {dur} min={val})")
            prev_dur, prev_val = dur, val


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    for p in (CSV_PATH, IFD_INPUT, CATALOGUE_OUT, IFD_TABLE_OUT):
        if not p.exists():
            fail(f"missing input/target: {p}")

    selected = load_selected_rows()

    by_cls = Counter(r["cls"].strip() for r in selected)
    by_source = Counter(source_of(r)[0] for r in selected)
    print(f"selected: {len(selected)}")
    print(f"by cls:    {dict(sorted(by_cls.items()))}")
    print(f"by source: {dict(sorted(by_source.items()))}")
    if len(selected) != EXPECTED_COUNT:
        fail(f"expected {EXPECTED_COUNT} selected gauges, got {len(selected)}")

    catalogue = [catalogue_record(r) for r in selected]
    catalogue.sort(key=lambda s: s["gauge_uid"])

    # ---- IFD ----
    ifd_src = json.loads(IFD_INPUT.read_text(encoding="utf-8"))
    missing, rejected = [], []
    for s in catalogue:
        rec = ifd_src.get(s["gauge_uid"])
        if rec is None:
            missing.append(s["gauge_uid"])
        elif rec.get("status") not in ACCEPTED_IFD_STATUS:
            rejected.append(f"{s['gauge_uid']} (status={rec.get('status')!r})")
    if missing or rejected:
        if missing:
            print(f"no IFD record ({len(missing)}): {' '.join(missing)}", file=sys.stderr)
        if rejected:
            print(f"IFD status not accepted ({len(rejected)}): {' '.join(rejected)}", file=sys.stderr)
        fail("catalogue stations without accepted IFD")

    ifd_stations: dict[str, dict] = {}
    exempted: list[dict] = []
    for s in catalogue:
        rec = ifd_src[s["gauge_uid"]]
        ifd = build_ifd(rec)
        if not ifd:
            fail(f"empty IFD table uid={s['gauge_uid']}")
        validate_ifd(s["gauge_uid"], ifd, exempted)
        ifd_stations[s["gauge_uid"]] = {
            "station_id": s["station_id"],
            "station_name": s["station_name"],
            "source": s["source"],
            "lat": s["lat"],
            "lon": s["lon"],
            "data_identifier": s["data_identifier"],
            "activity_status": "live",
            "ifd": ifd,
        }
    n_dur = Counter(len(v["ifd"]) for v in ifd_stations.values())
    n_rare = sum(1 for v in ifd_stations.values()
                 if all(all(c in row for c in RARE_COLUMNS) for row in v["ifd"].values()))
    print(f"IFD validated: {len(ifd_stations)} stations; durations per station {dict(n_dur)}; "
          f"stations with all three rare columns in every row: {n_rare}")
    print(f"exempted cells ({TOLERANCE_STEP[0]}-{TOLERANCE_STEP[1]} rare-column tolerance): "
          f"{len(exempted)}")
    for e in exempted:
        print(f"  {e}")

    ifd_validation = {
        "rule": IFD_VALIDATION_RULE,
        "tolerance_mm": TOLERANCE_MM,
        "tolerance_pct": TOLERANCE_PCT,
        "step": f"{TOLERANCE_STEP[0]}-{TOLERANCE_STEP[1]}",
        "columns": list(RARE_COLUMNS),
        "exempted": exempted,
    }

    # ---- Write (only after every check passed) ----
    now = datetime.now(timezone.utc).isoformat()

    catalogue_doc = {
        "dataset": "pluviometrics_rainfall_stations",
        "generated_at": now,
        "deduplication": {
            "method": "registry_gauge_uid",
            "note": "One record per gauge_uid. Cross-network duplicate resolution is performed "
                    "upstream in nsw_rainfall_stations.csv, not in this build.",
        },
        "selection": {
            "rule": "live == true AND cls in {A,B,C} AND at least one of mhl_ts_id / wdo_ts_id / "
                    "waternsw_site non-empty",
            "expected_count": EXPECTED_COUNT,
            "selected_count": len(catalogue),
            "by_cls": dict(sorted(by_cls.items())),
            "by_source": dict(sorted(by_source.items())),
            "source_rule": "source = mhl if mhl_ts_id else wdo; ts_id = that id",
            "inputs": {
                "stations": CSV_PATH.name,
                "ifd": IFD_INPUT.name,
            },
            "script": Path(__file__).name,
            "ifd_validation": ifd_validation,
        },
        "stations": catalogue,
    }

    ifd_doc = {
        "generated_at": now,
        "source_input": f"{CSV_PATH.name} + {IFD_INPUT.name}",
        "station_count_input": len(catalogue),
        "enriched_count": len(ifd_stations),
        "error_count": 0,
        "ifd_validation": ifd_validation,
        "stations": ifd_stations,
        "errors": {},
    }

    CATALOGUE_OUT.write_text(json.dumps(catalogue_doc, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")
    IFD_TABLE_OUT.write_text(json.dumps(ifd_doc, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")

    print(f"wrote {CATALOGUE_OUT}  ({CATALOGUE_OUT.stat().st_size:,} bytes, {len(catalogue)} stations)")
    print(f"wrote {IFD_TABLE_OUT}  ({IFD_TABLE_OUT.stat().st_size:,} bytes, {len(ifd_stations)} stations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
