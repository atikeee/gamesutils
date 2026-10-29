#!/usr/bin/env python3
"""
process_ticket_csv.py
=====================
Workflow script to process 'triage_its_op.json' and generate a structured CSV.

Features:
- Preserves all original JSON fields.
- Replaces 'description' and 'comments' with altered/cleaned versions.
- Adds the new 'issue' column with values: ['yes', 'dup', 'tcs', 'false'].
  * 'tcs'   : Netbatch, environment, server, socket, or infrastructure issues.
  * 'false' : Concluded not an issue, rejected, expected behavior, or user error.
  * 'dup'   : Duplicate ticket / clone.
  * 'yes'   : Confirmed valid issue / code fix.
- Fully modular so classification and alteration rules can be updated anytime.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("process_ticket_csv")

DEFAULT_INPUT_JSON: str = "triage_its_op.json"
DEFAULT_OUTPUT_CSV: str = "triage_its_processed.csv"


# ==============================================================================
# 1. ISSUE CLASSIFICATION LOGIC (yes / dup / tcs / false)
# ==============================================================================
def classify_issue(record: Dict[str, Any]) -> str:
    """Evaluates root_cause, solution_details, comments, status, and description
    to determine if the issue is 'tcs', 'false', 'dup', or 'yes'.
    """
    root_cause = str(record.get("root_cause") or "").lower()
    solution = str(record.get("solution_details") or "").lower()
    comments = str(record.get("comments") or "").lower()
    desc = str(record.get("description") or "").lower()
    status = str(record.get("status") or "").lower()

    combined_text = f"{root_cause} {solution} {comments} {desc} {status}"

    # 1. Check for Duplicate (dup)
    dup_patterns = [
        r"\bduplicate\b",
        r"\bdup\b",
        r"\bdup of\b",
        r"\balready tracked\b",
        r"\bcloned from\b",
        r"\bredundant\b",
    ]
    for pattern in dup_patterns:
        if re.search(pattern, root_cause) or re.search(pattern, comments[:500]):
            return "dup"

    # 2. Check for Not an Issue / Rejected (false)
    false_patterns = [
        r"\bnot an issue\b",
        r"\bno issue\b",
        r"\brejected\b",
        r"\bexpected behavior\b",
        r"\bby design\b",
        r"\bas designed\b",
        r"\buser error\b",
        r"\bwithdrawn\b",
        r"\bcancelled\b",
        r"\bfalse alarm\b",
        r"\bworks as expected\b",
    ]
    for pattern in false_patterns:
        if re.search(pattern, root_cause) or re.search(pattern, solution) or re.search(pattern, comments):
            return "false"

    # 3. Check for Netbatch / Server / Environment / Infrastructure (tcs)
    tcs_patterns = [
        r"\bnetbatch\b",
        r"\bnb\b",
        r"\bnbpool\b",
        r"\bserver\b",
        r"\benvironment\b",
        r"\binfrastructure\b",
        r"\bsocket processing\b",
        r"\bemergency rampdown\b",
        r"\brampdown\b",
        r"\bnode down\b",
        r"\bmachine down\b",
        r"\bdisk full\b",
        r"\bout of memory\b",
        r"\boom\b",
        r"\bquota exceeded\b",
        r"\bnfs\b",
        r"\bnetwork timeout\b",
        r"\bit issue\b",
        r"\bhost unavailable\b",
        r"\bconnection reset\b",
    ]
    for pattern in tcs_patterns:
        if re.search(pattern, root_cause) or re.search(pattern, solution) or re.search(pattern, comments) or re.search(pattern, desc):
            return "tcs"

    # 4. Default to confirmed issue
    return "yes"


# ==============================================================================
# 2. MODULAR DESCRIPTION ALTERATION
# ==============================================================================
def alter_description(raw_description: Optional[str], record: Dict[str, Any]) -> str:
    """Customizes / cleans up the description for the CSV output.
    You can easily update or add new extraction / formatting rules here.
    """
    if not raw_description or not isinstance(raw_description, str):
        return ""

    text = raw_description.strip()

    # Normalize multiple newlines and spaces
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)

    # Example: If AlertRouter alert, strip repeated header noise
    if "AlertRouter CRITICAL" in text:
        # Keep summary line if present
        summary_match = re.search(r"Summary:\s*([^\n]+)", text, re.IGNORECASE)
        error_match = re.search(r"emergency_rampdown_string:\s*([^\n]+)", text, re.IGNORECASE)
        summary = summary_match.group(1).strip() if summary_match else ""
        err = error_match.group(1).strip() if error_match else ""
        if summary and err:
            return f"Alert: {summary} | {err}"

    return text


# ==============================================================================
# 3. MODULAR COMMENT ALTERATION
# ==============================================================================
def alter_comments(raw_comments: Optional[str], record: Dict[str, Any]) -> str:
    """Customizes / extracts relevant summary from comments for the CSV output.
    You can easily update or add new extraction / formatting rules here.
    """
    if not raw_comments or not isinstance(raw_comments, str):
        return ""

    text = raw_comments.strip()

    # Normalize whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)

    # If comments contain long automated config dumps, extract the opening note
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if lines:
        # Filter out lines that look like raw CSV tool config headers
        meaningful_lines = [l for l in lines if not l.startswith('"PORTLCFG') and not l.startswith('++++')]
        if meaningful_lines:
            return " ".join(meaningful_lines[:5])
        return lines[0]

    return text


# ==============================================================================
# 4. JSON -> CSV PIPELINE
# ==============================================================================
def process_ticket_json_to_csv(
    json_path: Union[str, Path] = DEFAULT_INPUT_JSON,
    csv_path: Union[str, Path] = DEFAULT_OUTPUT_CSV,
) -> Path:
    """Reads input JSON, replaces description and comment, adds 'issue' column,
    and writes out all records to CSV.
    """
    in_file = Path(json_path).resolve()
    if not in_file.is_file():
        # Fallback to script directory
        script_dir = Path(__file__).resolve().parent
        in_file = (script_dir / json_path).resolve()

    if not in_file.is_file():
        raise FileNotFoundError(f"Input JSON file not found: '{json_path}'")

    logger.info("Reading input JSON: %s", in_file)
    with open(in_file, "r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)

    if not records:
        logger.warning("No records found in %s.", in_file.name)
        return Path(csv_path)

    processed_rows: List[Dict[str, Any]] = []

    # Determine headers preserving original JSON keys + adding 'issue'
    original_keys = list(records[0].keys())
    fieldnames = list(original_keys)

    # Insert 'issue' column after status (or at the end if status is not present)
    if "issue" not in fieldnames:
        if "status" in fieldnames:
            status_idx = fieldnames.index("status")
            fieldnames.insert(status_idx + 1, "issue")
        else:
            fieldnames.append("issue")

    for record in records:
        row = dict(record)

        # 1. Alter description
        row["description"] = alter_description(record.get("description"), record)

        # 2. Alter comment / comments
        row["comments"] = alter_comments(record.get("comments") or record.get("comment"), record)

        # 3. Classify issue
        row["issue"] = classify_issue(record)

        processed_rows.append(row)

    out_file = Path(csv_path).resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)

    with open(out_file, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(processed_rows)

    logger.info("Successfully processed %d tickets -> CSV: %s", len(processed_rows), out_file)
    return out_file


# ==============================================================================
# CLI INTERFACE
# ==============================================================================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Process triage_its_op.json into CSV with altered fields and 'issue' classification."
    )
    parser.add_argument(
        "json_file",
        nargs="?",
        default=DEFAULT_INPUT_JSON,
        help=f"Input JSON path (default: {DEFAULT_INPUT_JSON})",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=DEFAULT_OUTPUT_CSV,
        help=f"Output CSV path (default: {DEFAULT_OUTPUT_CSV})",
    )

    args = parser.parse_args()

    print(f"=== Process Ticket JSON -> CSV ===")
    print(f"Input JSON: {args.json_file}")
    print(f"Output CSV: {args.output}")

    try:
        process_ticket_json_to_csv(json_path=args.json_file, csv_path=args.output)
    except Exception as exc:
        logger.critical("Fatal error: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
