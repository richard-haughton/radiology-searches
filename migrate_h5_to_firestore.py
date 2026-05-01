#!/usr/bin/env python3
"""
migrate_h5_to_firestore.py

Reads your existing radiology_search_patterns.h5 file and uploads all
patterns (and optionally study_times.csv) to Firestore for a given user.

Usage:
    pip install firebase-admin h5py pandas
    python migrate_h5_to_firestore.py \
        --h5    /path/to/radiology_search_patterns.h5 \
        --csv   /path/to/study_times.csv \          # optional
        --uid   YOUR_FIREBASE_UID \
        --creds /path/to/serviceAccountKey.json

How to get serviceAccountKey.json:
    Firebase Console → Project Settings → Service Accounts
    → Generate new private key → save the downloaded JSON

How to find your UID:
    Firebase Console → Authentication → Users → copy UID column
"""

import argparse
import base64
import json
import sys
from datetime import datetime, timezone

import h5py
import pandas as pd
import firebase_admin
from firebase_admin import credentials, firestore


# ── Firestore batch helper ────────────────────────────────────
BATCH_SIZE = 400


def commit_in_batches(db, items, collection_ref, make_doc):
    """Write items to Firestore in batches of BATCH_SIZE."""
    total = len(items)
    done = 0
    batch = db.batch()
    count = 0

    for item in items:
        doc_ref = collection_ref.document()
        data = make_doc(item)
        batch.set(doc_ref, data)
        count += 1
        done += 1

        if count >= BATCH_SIZE:
            batch.commit()
            print(f"  Committed {done}/{total}…")
            batch = db.batch()
            count = 0

    if count > 0:
        batch.commit()
        print(f"  Committed {done}/{total}.")


# ── Decode HDF5 pattern key ───────────────────────────────────
def decode_pattern_key(key: str) -> str:
    """
    The Python desktop app stores pattern names as base64url-encoded keys:
    "p_<base64url>".  Fall back to the key itself if decoding fails.
    """
    if key.startswith("p_"):
        try:
            b64 = key[2:].replace("-", "+").replace("_", "/")
            # Add padding
            b64 += "=" * (-len(b64) % 4)
            return base64.b64decode(b64).decode("utf-8")
        except Exception:
            pass
    return key


def infer_modality(name: str) -> str:
    upper = name.upper()
    if "MRI" in upper or "MR " in upper:
        return "MRI"
    if "CT" in upper:
        return "CT"
    if " US " in upper or upper.startswith("US ") or "ULTRASOUND" in upper:
        return "US"
    if "XR" in upper or "RADIOGRAPH" in upper or "X-RAY" in upper:
        return "Plain Radiograph"
    if "PET" in upper or "NUCLEAR" in upper or "NM " in upper or "SPECT" in upper:
        return "Nuclear Medicine"
    return "Other"


# ── Read HDF5 ─────────────────────────────────────────────────
def read_h5_patterns(h5_path: str) -> list:
    patterns = []

    with h5py.File(h5_path, "r") as f:
        patterns_group = f.get("patterns")
        if patterns_group is None:
            print("WARNING: No 'patterns' group found in HDF5 file.")
            return patterns

        for key in patterns_group.keys():
            try:
                group = patterns_group[key]
                # Pattern name from attribute or decoded key
                pattern_name = group.attrs.get("pattern_name", None)
                if pattern_name is None:
                    pattern_name = decode_pattern_key(key)
                else:
                    pattern_name = str(pattern_name)

                # Steps JSON dataset
                steps_dataset = group.get("steps_json")
                if steps_dataset is None:
                    print(f"  Skipping '{pattern_name}': no steps_json dataset.")
                    continue

                raw = steps_dataset[()]
                if isinstance(raw, bytes):
                    json_str = raw.decode("utf-8")
                elif isinstance(raw, str):
                    json_str = raw
                else:
                    # numpy bytes array
                    json_str = bytes(raw).decode("utf-8")

                steps_raw = json.loads(json_str)

                # Normalise step keys (snake_case → camelCase)
                steps = []
                for s in steps_raw:
                    steps.append({
                        "stepTitle":    s.get("step_title") or s.get("stepTitle") or "",
                        "richContent":  s.get("rich_content") or s.get("richContent") or [],
                        "linkedStepId": s.get("linked_step_id") or s.get("linkedStepId") or "",
                    })

                patterns.append({
                    "name":     pattern_name,
                    "modality": infer_modality(pattern_name),
                    "steps":    steps,
                })

            except Exception as e:
                print(f"  WARNING: Could not parse pattern '{key}': {e}")
                continue

    print(f"Found {len(patterns)} pattern(s) in HDF5 file.")
    return patterns


# ── Read CSV ──────────────────────────────────────────────────
def read_csv_log(csv_path: str) -> list:
    try:
        df = pd.read_csv(csv_path)
    except Exception as e:
        print(f"WARNING: Could not read CSV: {e}")
        return []

    rows = []
    for _, row in df.iterrows():
        # Parse timestamp
        ts_raw = row.get("timestamp", "")
        try:
            ts = datetime.fromisoformat(str(ts_raw)).replace(tzinfo=timezone.utc)
        except Exception:
            ts = datetime.now(timezone.utc)

        rvu = row.get("rvu", None)
        if pd.isna(rvu):
            rvu = None
        else:
            try:
                rvu = float(rvu)
            except Exception:
                rvu = None

        rows.append({
            "study":    str(row.get("study", "")),
            "seconds":  int(row.get("seconds", 0)) if not pd.isna(row.get("seconds", 0)) else 0,
            "duration": str(row.get("duration", "")),
            "rvu":      rvu,
            "date":     str(row.get("date", ts.strftime("%Y-%m-%d"))),
            "timestamp": ts,
        })

    print(f"Found {len(rows)} study log row(s) in CSV.")
    return rows


# ── Main ──────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Migrate HDF5 patterns + CSV log to Firestore")
    parser.add_argument("--h5",    help="Path to radiology_search_patterns.h5")
    parser.add_argument("--csv",   help="Path to study_times.csv (optional)")
    parser.add_argument("--uid",   required=True, help="Firebase user UID to store data under")
    parser.add_argument("--creds", required=True, help="Path to Firebase service account key JSON")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, do not write to Firestore")
    args = parser.parse_args()

    # Init Firebase Admin SDK
    cred = credentials.Certificate(args.creds)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    user_ref = db.collection("users").document(args.uid)
    patterns_ref = user_ref.collection("patterns")
    log_ref      = user_ref.collection("studyLog")

    # ── Patterns ──────────────────────────────────────────────
    if args.h5:
        print(f"\nReading HDF5: {args.h5}")
        patterns = read_h5_patterns(args.h5)

        if args.dry_run:
            print("[DRY RUN] Would upload the following patterns:")
            for p in patterns:
                print(f"  - {p['name']}  ({p['modality']}, {len(p['steps'])} steps)")
        else:
            print(f"Uploading {len(patterns)} pattern(s) to Firestore (uid={args.uid})…")

            def make_pattern_doc(p):
                return {
                    "name":      p["name"],
                    "modality":  p["modality"],
                    "steps":     p["steps"],
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                }

            commit_in_batches(db, patterns, patterns_ref, make_pattern_doc)
            print("Patterns uploaded successfully.")
    else:
        print("No --h5 file provided; skipping pattern migration.")

    # ── Study log ─────────────────────────────────────────────
    if args.csv:
        print(f"\nReading CSV: {args.csv}")
        rows = read_csv_log(args.csv)

        if args.dry_run:
            print(f"[DRY RUN] Would upload {len(rows)} study log row(s).")
        else:
            print(f"Uploading {len(rows)} study log row(s)…")

            def make_log_doc(row):
                return {
                    "study":     row["study"],
                    "seconds":   row["seconds"],
                    "duration":  row["duration"],
                    "rvu":       row["rvu"],
                    "date":      row["date"],
                    "timestamp": row["timestamp"],
                }

            commit_in_batches(db, rows, log_ref, make_log_doc)
            print("Study log uploaded successfully.")
    else:
        print("No --csv file provided; skipping study log migration.")

    print("\nMigration complete.")


if __name__ == "__main__":
    main()
