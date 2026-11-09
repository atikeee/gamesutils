#!/usr/bin/env python3
"""Scan Outlook for HSD-ES tickets and validation emails; write data/triage_its.json and data/triage_val.json."""

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from routes import routes_triage_its as its  # noqa: E402


def scan_tickets(hours):
    existing = its.read_cache()
    incoming = its.scan_outlook(hours=hours, processed_email_ids=existing.get('processed_email_ids'))
    merged = its.merge_ticket_cache(existing, incoming)
    its.write_cache(merged)
    print(f"Tickets: {len(incoming['tickets'])} from new emails, {len(merged['tickets'])} saved.")
    print(f"Output: {its.DATA_FILE}")


def scan_validation(hours):
    existing = its.read_validation_cache()
    incoming = its.scan_validation_outlook(hours=hours, processed_email_ids=existing.get('processed_email_ids'))
    merged = its.merge_validation_cache(existing, incoming)
    its.write_validation_cache(merged)
    print(f"Validation: {len(incoming['rows'])} rows from new emails, {len(merged['rows'])} saved.")
    print(f"Output: {its.VALIDATION_DATA_FILE}")


def main():
    parser = argparse.ArgumentParser(description="Scan Outlook for HSD-ES tickets and validation rows.")
    parser.add_argument("--hours", type=int, default=48, help="How far back to scan (default: 48)")
    args = parser.parse_args()

    failed = 0
    for name, scan in (("tickets", scan_tickets), ("validation", scan_validation)):
        try:
            scan(args.hours)
        except Exception as error:
            print(f"ERROR scanning {name}: {error}")
            failed += 1
    print("Finished." if not failed else f"Finished with {failed} error(s).")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
