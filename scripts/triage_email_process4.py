#!/usr/bin/env python3
"""Download unread Outlook messages as HTML and add them to triage data."""

import argparse
import copy
import json
import os
import re
import tempfile
from pathlib import Path

from bs4 import BeautifulSoup

from outlook_manager import OutlookManager
from triage_email_rewrite import dprint, rewrite_email


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_JSON = PROJECT_ROOT / "data" / "triage_email_data.json"
HTML_DIR = PROJECT_ROOT / "templates" / "triagemails"
DEFAULT_FOLDER = "My Folders/_compute"

soup = None  # Set per email by parse_email_by_subject
origsubject = None


def cleanupsubject(subject):
    """Normalize the subject; strip a trailing tsc/tor server name from 'swapping compute'."""
    if not subject:
        return subject, ""
    subject = subject.strip().lower()
    if subject.startswith("swapping compute"):
        parts = subject.split("-")
        if len(parts) > 1:
            last_part = parts[-1].strip()
            if last_part.lower().startswith(("tsc", "tor")):
                return "-".join(parts[:-1]).strip(), last_part
    elif subject.startswith("alertrouter: critical"):
        subject = "alertrouter: critical"
    return subject, ""


def getdata_p(rgxstr, all=True, getp=False):
    if not soup:
        return ""

    results = []
    for p_tag in soup.find_all('p'):
        text = p_tag.get_text(" ", strip=True)
        match = re.search(rgxstr, text, re.IGNORECASE)
        if match:
            if getp:
                return p_tag
            if match.groups():
                item = " ".join(str(g) for g in match.groups() if g)
            else:
                item = match.group(0)
            results.append(item)
            if not all:
                return item

    if results:
        results = list(dict.fromkeys(results))
        return "<br>".join(results) if all else results[0]
    return ""


def getdata_tbl(rgxstr, red=True, id='table1'):
    """Per row, return [match for each (col_idx, regex)] from table `id`; red limits to class colorred rows."""
    if not soup or not isinstance(rgxstr, list):
        return []

    table = soup.find('table', {'id': id})
    if not table:
        return []

    results = []
    for row in table.find_all('tr'):
        if red:
            row_class = row.get('class', [])
            if isinstance(row_class, str):
                row_class = [row_class]
            if 'colorred' not in row_class:
                continue

        cells = row.find_all('td')
        if not cells:
            continue
        row_results = []
        for col_idx, regex_pattern in rgxstr:
            if col_idx >= len(cells):
                row_results.append("")
                continue
            col_text = cells[col_idx].get_text(strip=True)
            match = re.search(regex_pattern, col_text, re.IGNORECASE)
            if match:
                if match.groups():
                    row_results.append(" ".join(str(g) for g in match.groups() if g))
                else:
                    row_results.append(match.group(0))
            else:
                row_results.append("")
        results.append(row_results)
    return results


def parsepath(path, segments):
    if not isinstance(path, str) or not path.strip():
        return [""] * len(segments)
    if "/" not in path and "\\" not in path:
        return [""] * len(segments)
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    return [parts[i] if isinstance(i, int) and 0 <= i < len(parts) else "" for i in segments]


def load_html_file(html_path):
    if not os.path.exists(html_path):
        dprint(f"[WARN] Missing HTML file: {html_path}")
        return None
    for enc in ["utf-8", "utf-8-sig", "utf-16", "cp1252", "latin-1"]:
        try:
            with open(html_path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    dprint(f"[WARN] Could not decode HTML file: {html_path}")
    return None


def default_parse_result():
    return {
        "info1": "",
        "info2": "-",
        "path": "-",
        "users": "-",
        "notes": "",
        "rfc": "",
        "dashboard": "",
    }


def get_common_links():
    out = {"rfc": "", "dashboard": ""}
    if not soup:
        return out
    text_lines = soup.get_text("\n", strip=True)
    match = re.search(r"RFC:\s*(https?://\S+)", text_lines, re.IGNORECASE)
    if match:
        out["rfc"] = match.group(1).strip()
    match = re.search(r"Dashboard:\s*(https?://\S+)", text_lines, re.IGNORECASE)
    if match:
        out["dashboard"] = match.group(1).strip()
    return out


def parse_critical():
    dprint("[PARSER] parse_critical")
    text = soup.get_text(" ", strip=True)
    out = {"path": "--"}

    rfc_match = re.search(r"rfc:\s*(https?://\S+)", text, re.IGNORECASE)
    rfc_link = rfc_match.group(1).strip() if rfc_match else ""
    subj_match = re.search(r"AlertRouter: CRITICAL (.*) is firing", origsubject, re.IGNORECASE)
    label = subj_match.group(1).strip() if subj_match else origsubject
    if label:
        out["info1"] = f'<a href="{rfc_link}">{label}</a>' if rfc_link else label

    if "Emergency rampdown" in origsubject:
        match = re.search(r"description:\s*(\S+)", text, re.IGNORECASE)
        if match:
            desc_path = match.group(1).strip()
            parts = [p for p in desc_path.replace("\\", "/").split("/") if p]
            out["info2"] = parsepath(desc_path, [1])[0]
            out["path"] = "/" + "/".join(parts[:-1]) if len(parts) > 1 else desc_path
    elif "MultipleClientsDownNetbatchClass" in origsubject:
        matches = re.findall(r"description: More than \S+ of (\S+)\s+in pool\s+(\S+)\s+are not available", text, re.IGNORECASE)
        if matches:
            out["path"] = "<br>".join(f"{cls} - {pool}" for cls, pool in matches)
    elif "MLCWorkerNodeSwapping" in origsubject:
        match = re.search(r"description:\s*(\S+):\s*Swap usage is above (.+)", text, re.IGNORECASE)
        if match:
            out["info2"] = match.group(1).strip()
            out["path"] = match.group(2).strip()
        else:
            match = re.search(r"description:\s*Machine\s+(\S+)\s+is\s+swapping", text, re.IGNORECASE)
            if match:
                out["info2"] = match.group(1).strip()
    elif "NetbatchQOS is firing" in origsubject:
        matches = re.findall(r"Time\s+to\s+do\s+nbstatus\s+jobs\s+--target\s+(\S+)\s+is\s+high,\s+with\s+a\s+value\s+of\s+(\d+)\s+secs", text, re.IGNORECASE)
        if matches:
            out["info2"] = ", ".join(f"{target} - {value} secs" for target, value in matches)
        else:
            dprint("NBStatus parser: no match")

    return out


def parse_swapping_compute():
    dprint("[PARSER] parse_swapping_compute")
    out = {}
    processed_rows = []
    table_results = []
    if origsubject.startswith("Swapping Compute General Batch is firing"):
        rgxstr = [[0, r'(\S+)'], [4, r"\/hnfs\/(t[^\/]+)\/vol\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(?:(?:[^\/]+\/){3}([^\/]+))?"]]
        table_results = getdata_tbl(rgxstr=rgxstr, red=False)
    elif origsubject.startswith("Swapping Compute Special is firing"):
        rgxstr = [[0, r'(\S+)'], [7, r'(\d+)'], [9, r'slots=(\d+),slots_per_host='], [11, r"\/hnfs\/(t[^\/]+)\/vol\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(?:(?:[^\/]+\/){3}([^\/]+))?"]]
        table_results = getdata_tbl(rgxstr=rgxstr, red=True)
    for row in table_results:
        if row and row[0] != "itotools":
            row_str = " ".join(filter(None, [str(item) if item else "" for item in row]))
            if row_str:
                processed_rows.append(row_str)
    if processed_rows:
        out["info2"] = "<br>".join(dict.fromkeys(processed_rows))

    rgxstr1 = r"machine\s+(\S+)\s+is\s+swapping\s+at\s*(\S+)\s*"
    out["info1"] = getdata_p(rgxstr1, all=False)
    return out


def parse_tcs_storage():
    """TCS Storage alerts: rfc/dashboard from <p> links, path/info2 from table1 columns 0/1."""
    dprint("[PARSER] parse_tcs_storage")
    out = {}

    rfc_p = getdata_p(r"To continue troubleshooting follow:", all=False, getp=True)
    if rfc_p:
        rfc_link = rfc_p.find("a")
        if rfc_link:
            out["rfc"] = rfc_link.get("href", rfc_link.get_text(strip=True))

    dashboard_p = getdata_p(r"Useful Links:", all=False, getp=True)
    if dashboard_p:
        dashboard_links = dashboard_p.find_all("a")
        if dashboard_links:
            out["dashboard"] = dashboard_links[0].get("href", dashboard_links[0].get_text(strip=True))

    table_data = getdata_tbl(rgxstr=[[0, r'(\S+)'], [1, r'(\S+)']], red=False, id='table1')
    col0_items = [row[0] for row in table_data if len(row) > 0 and row[0]]
    col1_items = [row[1] for row in table_data if len(row) > 1 and row[1]]
    if col0_items:
        out["path"] = "<br>".join(col0_items)
    if col1_items:
        out["info2"] = "<br>".join(col1_items)
    return out


def subject_startswith(prefix):
    return lambda subject: subject.startswith(prefix)


def subject_contains(fragment):
    return lambda subject: fragment in subject


def parse_with_regex_lists():
    """Default parser: first matching regex in each list wins, searching <p> elements only."""
    dprint("[PARSER] parse_with_regex_lists - default")
    info1_regexes = [
        r'description: Time to do nbstatus --hist (\S+) is high, with a value of \d+\.?\d* secs',
        r'client_number:\s*(\S+)',
        r'description: More than (\S+) of \S+\s+in pool \S+ are not available',
        r'description: (\d+) netbatch jobs waiting in queue \S+ for last ',
        r'description: \S+: (\S+) will fill in less than \d+ \S+.',
        r'description: (\d+) waiting netbatch jobs in (\S+) in qslot \S+ and class \S+ for last \d+ \S+',
        r'Aggregate (\S+) is at \S+ full',
        r'\S+ volume on (\S+) is \S+ full',
        r'average response time of (\S+ \S+)',
        r'summary:\s*(\S+) from (\S+) will fill in',
        r'value of (\S+ \S+)'
    ]
    info2_regexes = [
        r'description: Time to do nbjob run --target (\S+)',
        r'description: Time to do nbstatus --hist \S+ is high, with a value of (\d+)\.?\d* secs',
        r'pool_name:\s*(\S+)',
        r'description: More than \S+ of \S+\s+in pool (\S+) are not available',
        r'description: \d+ netbatch jobs waiting in queue (\S+) for last ',
        r'description: \S+: \S+ will fill in less than (\d+ \S+).',
        r'description: \d+ waiting netbatch jobs in \S+ in qslot \S+ and class \S+ for last (\d+ \S+)',
        r'(\S+) will fill in less than (\d+ days)',
        r'Aggregate \S+ is at (\S+) full',
        r'(\S+) volume on \S+ is (\S+) full',
        r'Slow average AD response of (\d+)[\.\d]* seconds in to',
        r'nbstatus jobs --target (\S+) is high',
        r'sname\s*: (\S+)',
        r'Feature: (\S+)'
    ]
    path_regexes = [
        r'description: \d+ waiting netbatch jobs in \S+ in qslot (\S+) and class \S+ for last \d+ \S+',
        r'job_path:\s*(\S+)'
    ]

    def first_match(regexes):
        for rgx in regexes:
            result = getdata_p(rgx, all=True)
            if result:
                return result
        return ""

    return {
        "info1": first_match(info1_regexes),
        "info2": first_match(info2_regexes),
        "path": first_match(path_regexes),
    }


PARSER_RULES = [
    (subject_startswith("alertrouter: critical"), parse_critical),
    (subject_startswith("swapping compute"), parse_swapping_compute),
    (subject_contains("nap015: troubleshoot filer slowness"), parse_tcs_storage),
    (lambda subject: True, parse_with_regex_lists),
]


def parse_email_by_subject(subject, html, raw_subject=None):
    global soup, origsubject
    soup = BeautifulSoup(html, "html.parser")
    origsubject = raw_subject or subject
    match_subject = origsubject.lower()
    parsed = default_parse_result()
    parsed.update(get_common_links())

    for matcher, parser_func in PARSER_RULES:
        if matcher(match_subject):
            parsed.update(parser_func())
            return parsed
    return parsed


def load_existing_json(path):
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def save_json_atomic(data, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            json.dump(data, temp_file, indent=2, ensure_ascii=False)
        os.replace(temp_path, path)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()


def get_message_timestamp(message):
    for property_name in ("SentOn", "ReceivedTime"):
        try:
            value = getattr(message, property_name)
            if value:
                return value
        except Exception:
            continue
    raise ValueError("Message has no usable SentOn or ReceivedTime value")


def make_item_id(timestamp, raw_subject, data):
    """Return yyyymmdd_subject (non-alphanumerics become '_'), made unique if needed."""
    safe_subject = re.sub(r"[^A-Za-z0-9]+", "_", raw_subject).strip("_")[:100]
    base = f"{timestamp.strftime('%Y%m%d')}_{safe_subject}"
    used = {key for section in data.values() for key in section.get("ind_dats", {})}

    def taken(name):
        return name in used or (HTML_DIR / f"{name}.html").exists()

    candidate = base
    if taken(candidate):
        candidate = f"{base}_{timestamp.strftime('%H%M%S')}"
    counter = 2
    while taken(candidate):
        candidate = f"{base}_{timestamp.strftime('%H%M%S')}_{counter}"
        counter += 1
    return candidate


def find_duplicate_item_id(data, subject, timestamp_key, display_timestamp):
    section = data.get(subject, {})
    for item_id, entry in section.get("ind_dats", {}).items():
        if entry.get("timestamp_key") == timestamp_key:
            return str(item_id)
        # Older process3 records do not contain the full timestamp.
        if not entry.get("timestamp_key") and entry.get("datetime") == display_timestamp:
            return str(item_id)
    return None


def report_unread_row(section, item_id):
    print('[triage-row] ' + json.dumps({'section': section, 'item_id': str(item_id)}), flush=True)


def mark_as_read_result(outlook_manager, message):
    try:
        outlook_manager.mark_email_read(message)
        return "marked read"
    except Exception as error:
        return f"could not mark read: {error}"


def download_and_process(message, combined_data, outlook_manager):
    if getattr(message, "Class", None) != 43:
        return combined_data, "skipped non-mail Outlook item"
    if not getattr(message, "UnRead", False):
        return combined_data, "skipped because it is no longer unread"

    raw_subject = str(getattr(message, "Subject", "") or "").strip()
    if not raw_subject:
        return combined_data, "skipped message without a subject"

    timestamp = get_message_timestamp(message)
    timestamp_key = timestamp.isoformat(timespec="seconds")
    display_timestamp = timestamp.strftime("%d%b %H:%M:%S").upper()
    subject, _server = cleanupsubject(raw_subject)

    # Checked before saving so a duplicate never writes or overwrites a file.
    duplicate_id = find_duplicate_item_id(combined_data, subject, timestamp_key, display_timestamp)
    if duplicate_id is not None:
        report_unread_row(subject, duplicate_id)
        read_result = mark_as_read_result(outlook_manager, message)
        return combined_data, f"duplicate; {read_result} without adding JSON entry"

    item_id = make_item_id(timestamp, raw_subject, combined_data)

    html_path = HTML_DIR / f"{item_id}.html"
    outlook_manager.save_email_as_html(message, html_path)
    # Same beautify step as process3: rewrites HTML in place and removes the _files dir.
    rewrite_email(str(html_path))

    html = load_html_file(str(html_path))
    if not html:
        raise IOError(f"Could not read the downloaded HTML file: {html_path}")

    parsed = parse_email_by_subject(subject, html, raw_subject=raw_subject)
    updated_data = copy.deepcopy(combined_data)
    section = updated_data.setdefault(
        subject,
        {"ind_dats": {}, "rfc": "", "dashboard": "", "notes": "", "info": ""},
    )
    entries = section.setdefault("ind_dats", {})
    section.setdefault("rfc", "")
    section.setdefault("dashboard", "")
    section.setdefault("notes", "")
    section.setdefault("info", "")

    new_entry = {
        "info1": parsed["info1"],
        "info2": parsed["info2"],
        "path": parsed["path"],
        "status": "",
        "link": f"http://localhost:5000/triagemails/{item_id}.html",
        "notes": parsed["notes"],
        "users": parsed["users"],
        "datetime": display_timestamp,
        "timestamp_key": timestamp_key,
    }
    entries[item_id] = new_entry

    if not section["rfc"]:
        section["rfc"] = parsed["rfc"]
    if not section["dashboard"]:
        section["dashboard"] = parsed["dashboard"]

    save_json_atomic(updated_data, OUTPUT_JSON)
    report_unread_row(subject, item_id)
    read_result = mark_as_read_result(outlook_manager, message)
    return updated_data, f"downloaded, added to triage JSON, {read_result}"


def main():
    parser = argparse.ArgumentParser(
        description="Download and process unread Outlook emails for triage."
    )
    parser.add_argument(
        "--folder",
        default=DEFAULT_FOLDER,
        help=f"Outlook folder path (default: {DEFAULT_FOLDER})",
    )
    args = parser.parse_args()

    manager = OutlookManager()
    messages = manager.get_unread_emails(args.folder)
    print(f"Found {len(messages)} unread Outlook item(s) in '{args.folder}'.")

    combined_data = load_existing_json(OUTPUT_JSON)
    processed = 0
    failed = 0

    for index, message in enumerate(messages, start=1):
        subject = str(getattr(message, "Subject", "(no subject)") or "(no subject)")
        try:
            combined_data, result = download_and_process(message, combined_data, manager)
            print(f"[{index}/{len(messages)}] {subject}: {result}")
            processed += 1
        except Exception as error:
            print(f"[{index}/{len(messages)}] {subject}: ERROR: {error}")
            failed += 1

    print(f"Finished. Processed: {processed}; failed: {failed}.")
    print(f"HTML files: {HTML_DIR}")
    print(f"Triage JSON: {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
