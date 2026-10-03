

import os
import json,re
from bs4 import BeautifulSoup
from datetime import datetime
debug = True
INPUT_JSON = r"c:\temp\email.txt"
HTML_DIR = r"C:\Users\rahmanma\OneDrive - Intel Corporation\Documents\1_docs\gamesutils\templates\triagemails"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_JSON = os.path.join(SCRIPT_DIR, "triage_email_data.json")
#OUTPUT_HTML = os.path.join(SCRIPT_DIR, "triage_email_dashboard.html")
def pd(dbg_string):
    if debug:
        print(dbg_string)
def convert_datetime(date_string):
    if not date_string:
        return ""
    try:
        dt = datetime.strptime(date_string, "%m/%d/%Y %I:%M:%S %p")
        # Windows-compatible formatting (no %-) 
        month = dt.month
        day = dt.day
        time_24 = dt.strftime("%H:%M")
        return f"{month}/{day} {time_24}"
    except ValueError as e:
        pd(f"Error parsing date '{date_string}': {e}")
        return date_string 
    
def cleanupsubject(subject):
    """
    If subject contains ' - ' and the last part starts with
    'tsc' or 'tor', treat that last part as the server name.
    """
    if not subject:
        return subject, ""
    if (subject.startswith("Swapping Compute")):
        parts = subject.split("-")
        if len(parts) > 1:
            last_part = parts[-1].strip()
            if last_part.lower().startswith(("tsc", "tor")):
                cleaned_subject = "-".join(parts[:-1]).strip()
                return cleaned_subject, last_part
    elif (subject.startswith("Alertrouter: CRITICAL")):
        subject = "Alertrouter: CRITICAL"
    return subject, ""
def gettabledatas(soup, cols, headertext, red=True):
    """
    Parse table rows from HTML and return a list of columns.
    Args:
        soup (html soup) 
        cols (list[int]): zero-based column indexes to extract
        headertext (str): text that must be present in the first row of the table
        red (bool): if True, include only rows with red text
    Returns:
        list[list[str]]: list of columns, each column containing values from matching rows
    """
    
    result = [[] for _ in cols]
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        # First row is the header row
        header_cells = rows[0].find_all(["td", "th"])
        header_texts = [cell.get_text(" ", strip=True) for cell in header_cells]
        # Skip table if required header text is not found in first row
        if not any(headertext.lower() in h.lower() for h in header_texts):
            continue
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue
            if red:
                has_red = False
                for cell in cells:
                    spans = cell.find_all("span")
                    for span in spans:
                        style = span.get("style", "").replace(" ", "").lower()
                        if "color:red" in style:
                            has_red = True
                            break
                    if has_red:
                        break
                if not has_red:
                    continue
            for idx, col in enumerate(cols):
                if col < len(cells):
                    result[idx].append(cells[col].get_text(" ", strip=True))
                else:
                    result[idx].append("")
    return result
    
def parsepath(path, segments):
    if not isinstance(path, str) or not path.strip():
        return [""] * len(segments)
    if "/" not in path and "\\" not in path:
        return [""] * len(segments)
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    return [parts[i] if isinstance(i, int) and 0 <= i < len(parts) else "" for i in segments]
# ----------------------------
# File helpers
# ----------------------------
def load_input_json(path):
    with open(path, "r", encoding="utf-16") as f:
        return json.load(f)
def load_html_file(html_path):
    if not os.path.exists(html_path):
        pd(f"[WARN] Missing HTML file: {html_path}")
        return None
    encodings_to_try = ["utf-8", "utf-8-sig", "utf-16", "cp1252", "latin-1"]
    for enc in encodings_to_try:
        try:
            with open(html_path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    pd(f"[WARN] Could not decode HTML file: {html_path}")
    return None
# ----------------------------
# Save / render
# ----------------------------
def save_json(data, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
# ----------------------------
# Parser functions (subject -> parse function registry)
# ----------------------------
def build_parse_context(html):
    soup = BeautifulSoup(html, "html.parser")
    text_space = soup.get_text(" ", strip=True)
    text_lines = soup.get_text("\n", strip=True)
    return {
        "soup": soup,
        "text_space": text_space,
        "text_lines": text_lines,
    }


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


def get_common_links(ctx):
    out = {"rfc": "", "dashboard": ""}
    text_lines = ctx["text_lines"]
    soup = ctx["soup"]

    match = re.search(r"RFC:\s*(https?://\S+)", text_lines, re.IGNORECASE)
    if match:
        out["rfc"] = match.group(1).strip()
    else:
        el = soup.select_one(".rfc")
        out["rfc"] = el.get_text(" ", strip=True) if el else ""

    match = re.search(r"Dashboard:\s*(https?://\S+)", text_lines, re.IGNORECASE)
    if match:
        out["dashboard"] = match.group(1).strip()
    else:
        el = soup.select_one(".dashboard")
        out["dashboard"] = el.get_text(" ", strip=True) if el else ""

    return out


def parse_base(ctx):
    return {}


def parse_ttd_ref_vol_fill(ctx):
    text = ctx["text_space"]
    match = re.search(r"Summary: (\S+)\s+volume\s+on\s+(\S+)\s+is\s+(\S+)\s+full", text, re.IGNORECASE)
    if match:
        return {
            "info2": "<b>" + match.group(2) + "</b> Vol: " + match.group(1),
            "info1": match.group(3),
        }
    pd("TTDrefVolFill parser: no match")
    return {}


def parse_critical_its(ctx):
    text = ctx["text_space"]
    out = {"path": "--"}

    raw_subject = ctx.get("raw_subject", "")
    pd(f"Parsing Critical its... {raw_subject}")
    match = re.search(
        r"Summary:\s*ITS\s*ticket\s*(\d+)\s*needs\s*your\s*attention:\s*(.+?)(?=\s+rfc:|\s+dashboard:|$)",
        text,
        re.IGNORECASE,
    )
    if match:
        out.update({
            "info1": match.group(1),
            "info2": match.group(2).strip(),
        })
    else:
        pd("CriticalITS parser: no match")

    matches = re.findall(r"rfc:\s*(\S+)", text, re.IGNORECASE | re.MULTILINE)
    if matches:
        out["path"] = "<br> ".join(f"<a href={its}>{its}</a>" for its in matches)
    return out

def parse_critical(ctx):
    text = ctx["text_space"]
    raw_subject = ctx.get("raw_subject", "")
    out = {"path": "--"}
    pd(f"Parsing Critical... {raw_subject}")

    # Shared: build Info1 label from raw subject, linked to RFC
    rfc_match = re.search(r"rfc:\s*(https?://\S+)", text, re.IGNORECASE)
    rfc_link = rfc_match.group(1).strip() if rfc_match else ""
    subj_match = re.search(r"AlertRouter: CRITICAL (.*) is firing", raw_subject, re.IGNORECASE)
    label = subj_match.group(1).strip() if subj_match else raw_subject
    if label:
        out["info1"] = f'<a href="{rfc_link}">{label}</a>' if rfc_link else label

    # Per-type: fill server (Info2) and path based on what the subject contains
    if "Emergency rampdown" in raw_subject:
        match = re.search(r"description:\s*(\S+)", text, re.IGNORECASE)
        if match:
            desc_path = match.group(1).strip()
            parts = [p for p in desc_path.replace("\\", "/").split("/") if p]
            out["info2"] = parsepath(desc_path, [1])[0]
            out["path"] = "/" + "/".join(parts[:-1]) if len(parts) > 1 else desc_path
    elif "MultipleClientsDownNetbatchClass" in raw_subject:
        # description: More than 50% of SLES12_short in pool orto_e are not available.
        matches = re.findall(r"description: More than \S+ of (\S+)\s+in pool\s+(\S+)\s+are not available", text, re.IGNORECASE)
        if matches:
            out["path"] = "<br>".join(f"{cls} - {pool}" for cls, pool in matches)
    elif "MLCWorkerNodeSwapping" in raw_subject:
        match = re.search(r"description:\s*(\S+):\s*Swap usage is above (.+)", text, re.IGNORECASE)
        if match:
            out["info2"] = match.group(1).strip()
            out["path"] = match.group(2).strip()
        else:
            match = re.search(r"description:\s*Machine\s+(\S+)\s+is\s+swapping", text, re.IGNORECASE)
            if match:
                out["info2"] = match.group(1).strip()
    #one condition for subject containing NetbatchQOS is firing
    elif "NetbatchQOS is firing" in raw_subject:
        matches = re.findall(r"Time\s+to\s+do\s+nbstatus\s+jobs\s+--target\s+(\S+)\s+is\s+high,\s+with\s+a\s+value\s+of\s+(\d+)\s+secs", text, re.IGNORECASE)
        if matches:
            out["info2"] = ", ".join(f"{target} - {value} secs" for target, value in matches)
        else:
            pd("NBStatus parser: no match")

    return out

def parse_ito_vol_fill(ctx):
    text = ctx["text_space"]
    out = {}

    matches = re.findall(
        r"description:\s*(\S+)\s+from\s+(\S+)\s*will\s*fill\s*in\s*less\s*than\s*(\S)\s*days.",
        text,
        re.IGNORECASE | re.MULTILINE,
    )
    if matches:
        out["info2"] = ",<br> ".join(f"{aggr}({volume} {d} days)" for volume, aggr, d in matches)
    else:
        pd("ITOVolFill parser: no match server")

    matches = re.findall(r"Sname:\s*(\S+)", text, re.IGNORECASE | re.MULTILINE)
    if matches:
        out["notes"] = ",<br> ".join(f"{n}" for n in matches)
    else:
        pd("ITOVolFill parser: no match notes")

    return out


def parse_emergency_rampdown(ctx):
    text = ctx["text_space"]
    out = {"info1": "", "info2": "none"}
    match = re.search(r"job_path:\s*(\S+)", text, re.IGNORECASE)
    if match:
        out["path"] = match.group(1)
    return out


def parse_ttd_netapp_aggr(ctx):
    text = ctx["text_space"]
    match = re.search(r"Summary:\s+Aggregate\s+(\S+)\s+is\s+at\s+(\S+)%", text, re.IGNORECASE)
    if match:
        return {
            "info2": match.group(1),
            "info1": match.group(2) + "%",
        }
    pd("TTDNetAppAggr parser: no match")
    return {}


def parse_aggr_will_fill(ctx):
    text = ctx["text_space"]
    match = re.search(r"Summary:\s+(\S+)\s+will\s+fill\s+in\s+less\s+than\s+(\d+)\s+days", text, re.IGNORECASE)
    if match:
        return {
            "info2": match.group(1),
            "info1": match.group(2) + " day",
        }
    pd("AggrWillFill parser: no match")
    return {}


def parse_high_nb_job_wait(ctx):
    text = ctx["text_lines"]
    out = {}

    descriptions = re.findall(
        r"description:\s*(.*?)(?=\n\s*(?:description:|rfc:|dashboard:|-{5,}|$))",
        text,
        re.IGNORECASE | re.DOTALL,
    )

    classes = []
    pool_paths = []

    for raw_desc in descriptions:
        desc = " ".join(raw_desc.split())
        if not desc:
            continue

        class_match = re.search(r"\bclass\s+(.+?)\s+for\s+last\b", desc, re.IGNORECASE)
        pool_match = re.search(r"\bin\s+(\S+)\s+in\s+qslot\b", desc, re.IGNORECASE)
        qslot_match = re.search(r"\bin\s+qslot\s+(\S+)", desc, re.IGNORECASE)

        if class_match:
            classes.append(class_match.group(1).strip())

        pool = pool_match.group(1).strip() if pool_match else ""
        qslot = qslot_match.group(1).strip() if qslot_match else ""
        if pool or qslot:
            pool_paths.append(f"{pool} {qslot}".strip())

    if classes:
        out["info1"] = "<br>".join(dict.fromkeys(classes))
    if pool_paths:
        out["info2"] = "<br>".join(dict.fromkeys(pool_paths))

    if not out:
        pd("HighNBJobWait parser: no description match")

    return out

def parse_computehighload(ctx):
    text = ctx["text_space"]
    out = {}
    
    matches = re.findall(r"description:\s*(\S+)\s+has\s+high\s+load\s+for\s+more\s+than\s+(\d+\s+\w+)", text, re.IGNORECASE)
    if matches:
        out["info2"] = ", ".join(f"{server}-{days}" for server, days in matches)
    else:
        pd("ComputeHighLoad parser: no match")
    
    return out
def parse_netbatchqos(ctx):
    text = ctx["text_space"]
    out = {}
    matches = re.findall(r"Time to do nbstatus jobs --target (\S+) is high, with a value of (\d+) ", text, re.IGNORECASE)
    if matches:
        out["info2"] = ", ".join(f"{target} - {value}" for target, value in matches)
    else:
        pd("NetBatchQos parser: no match")

    return out

def parse_swapping_compute(ctx):
    text = ctx["text_space"]
    soup = ctx["soup"]
    out = {}

    match = re.search(r"machine\s+(\s+)\s+is\s+swapping\s+at\s*(\s+)\s*%", text, re.ignorecase)
    if match:
        out["info2"] = match.group(1)
        out["info1"] = match.group(2) + "%"

    table1 = gettabledatas(soup, [0, 7, 9, 12], "min slots needed", red=True)
    if len(table1) > 3 and table1[3]:
        out["path"] = table1[3][0]
    if table1 and table1[0]:
        out["users"] = ", ".join(set(table1[0]))

    return out

def parse_license_low_availability(ctx):
    text = ctx["text_space"]
    out = {}
    match = re.search(r"license\s+low\s+availability\s+on\s+(\s+)", text, re.ignorecase)
    if match:
        out["info2"] = match.group(1)

    return out

def subject_startswith(prefix):
    return lambda subject: subject.startswith(prefix)


def subject_contains(fragment):
    return lambda subject: fragment in subject


PARSER_RULES = [
    (subject_startswith("alertrouter: warning emergency rampdown is firing"), parse_emergency_rampdown),
    (subject_startswith("swapping compute"), parse_swapping_compute),
    (subject_startswith("alertrouter: warning ttd_netapp_aggr_full is firing"), parse_ttd_netapp_aggr),
    (subject_startswith("alertrouter: warning ito_aggr_will_fill_in_x_days is firing"), parse_aggr_will_fill),
    (subject_startswith("alertrouter: warning ttd_ref_volume_full is firing"), parse_ttd_ref_vol_fill),
    (subject_startswith("alertrouter: warning ito_vol_will_fill_in_x_days is firing"), parse_ito_vol_fill),
    (subject_startswith("alertrouter: critical its alert"), parse_critical_its),
    (subject_startswith("alertrouter: critical"), parse_critical),
    (subject_contains("highnbjobwaitcountbyclass"), parse_high_nb_job_wait),
    (subject_startswith("alertrouter: warning licenselowavailability is firing"), parse_license_low_availability),
    (subject_startswith("alertrouter: warning computehighload is firing"), parse_computehighload),
    (subject_startswith("alertrouter: warning netbatchqos is firing"), parse_netbatchqos),
    
    

]


def parse_email_by_subject(subject, html, raw_subject=None):
    ctx = build_parse_context(html)
    ctx["subject"] = subject
    ctx["raw_subject"] = raw_subject or subject
    # Use original subject for rule dispatch so cleanup/normalization
    # does not hide more-specific parser rules.
    match_subject = raw_subject or subject
    parsed = default_parse_result()
    parsed.update(get_common_links(ctx))

    for matcher, parser_func in PARSER_RULES:
        if matcher(match_subject):
            parsed.update(parser_func(ctx))
            return parsed

    parsed.update(parse_base(ctx))
    return parsed
def load_existing_json(path):
    """Loads existing data to preserve manual status/notes."""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {}
    return {}
def build_combined_data(input_items):
    # 1. Load existing data
    combined_data = load_existing_json(OUTPUT_JSON)
    
    for item in input_items:
        subject, server = cleanupsubject(item.get("subject", ""))
        item_id = item.get("id", "")
        pd(f"Processing ID: {item_id}")
        
        datetime = item.get("date","")
        # Ensure subject key exists
        if subject not in combined_data:
            combined_data[subject] = {
                "ind_dats": {},
                "rfc": "", "dashboard": "", "notes": "", "info": ""
                
            }
        
        html_path = os.path.join(HTML_DIR, f"{item_id}.html")
        
        html = load_html_file(html_path)
        
        # Prepare new data from parser
        new_ind_dat = {
            "info1": "", "info2": "", "path": "", 
            "status": "", "link":  f"http://localhost:5000/triagemails/{item_id}.html",
            "notes":"","users":"",
            "datetime":convert_datetime(datetime)
        }
        
        if html:
            parsed = parse_email_by_subject(subject, html, raw_subject=item.get("subject", ""))
            new_ind_dat.update({
                "info1": parsed["info1"],
                "info2": server or parsed["info2"],
                "path": parsed["path"],
                "notes": parsed["notes"],
                "users": parsed["users"],
            })
            
            # Preserve/Update RFC/Dashboard if empty
            if not combined_data[subject]["rfc"]:
                combined_data[subject]["rfc"] = parsed["rfc"]
            if not combined_data[subject]["dashboard"]:
                combined_data[subject]["dashboard"] = parsed["dashboard"]
        
            
        # 2. MERGE LOGIC:
        if item_id in combined_data[subject]["ind_dats"]:
            # Update existing: Keep status, update all other fields including new ones
            existing_entry = combined_data[subject]["ind_dats"][item_id]
            # Preserve existing status if it exists
            existing_status = existing_entry.get("status", "")
            
            # Update with all new data
            existing_entry.update({
                "info1": new_ind_dat["info1"],
                "info2": new_ind_dat["info2"],
                "path": new_ind_dat["path"],
                "link": new_ind_dat["link"],
                "notes": new_ind_dat["notes"],
                "users": new_ind_dat["users"],
                "datetime": new_ind_dat["datetime"]
            })
            
            # Restore status if it was previously set
            if existing_status:
                existing_entry["status"] = existing_status
        else:
            # Add new entry
            combined_data[subject]["ind_dats"][item_id] = new_ind_dat
            
            
            
        # Keep subject notes if they weren't already there
        if not combined_data[subject]["notes"]:
            combined_data[subject]["notes"] = item.get("notes", "")
    return combined_data
def main():
    input_items = load_input_json(INPUT_JSON)
    combined_data = build_combined_data(input_items)
    
    save_json(combined_data, OUTPUT_JSON)
    
    pd(f"[OK] Merged data saved to: {OUTPUT_JSON}")

if __name__=="__main__":
    main()
