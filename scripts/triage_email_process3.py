

import json
from datetime import datetime
from triage_email_rewrite import *


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_JSON = os.path.join(SCRIPT_DIR, "..", "data", "triage_email_data.json")
#OUTPUT_HTML = os.path.join(SCRIPT_DIR, "triage_email_dashboard.html")
soup = None  # Global HTML element, updated per file
origsubject = None  # Cache original subject for parsers

def convert_datetime(date_string):
    if not date_string:
        return ""
    try:
        # Try multiple formats
        formats = [
            "%A, %B %d, %Y %I:%M %p",  # Friday, September 18, 2026 7:38 PM
            "%m/%d/%Y %I:%M:%S %p",    # 06/17/2024 02:00:00 PM
            "%m/%d/%Y %H:%M:%S",       # 06/17/2024 14:00:00
            "%Y-%m-%d %H:%M:%S",       # 2024-06-17 14:00:00
        ]
        
        dt = None
        for fmt in formats:
            try:
                dt = datetime.strptime(date_string.strip(), fmt)
                break
            except ValueError:
                continue
        
        if not dt:
            dprint(f"[WARNING] Could not parse datetime: {date_string}")
            return date_string
        
        # Format: 18SEP 19:38:00
        day_str = dt.strftime("%d")
        month_str = dt.strftime("%b").upper()
        time_str = dt.strftime("%H:%M:%S")
        formatted = f"{day_str}{month_str} {time_str}"
        return formatted
    except Exception as e:
        dprint(f"[ERROR] Error parsing date '{date_string}': {e}")
        return date_string 
    
def cleanupsubject(subject):
    """
    If subject contains ' - ' and the last part starts with
    'tsc' or 'tor', treat that last part as the server name.
    """
    if not subject:
        return subject, ""
    subject = subject.strip().lower()
    if (subject.startswith("swapping compute")):
        parts = subject.split("-")
        if len(parts) > 1:
            last_part = parts[-1].strip()
            if last_part.lower().startswith(("tsc", "tor")):
                cleaned_subject = "-".join(parts[:-1]).strip()
                return cleaned_subject, last_part
    elif (subject.startswith("alertrouter: critical")):
        subject = "alertrouter: critical"
    return subject, ""
def getdata_p(rgxstr, all=True,getp=False):
    global soup
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
                # If there are groups, join them with space
                item = " ".join(str(g) for g in match.groups() if g)
            else:
                # If no groups, use the whole match
                item = match.group(0)
            results.append(item)
            if not all:
                return item
    
    # Remove duplicates while preserving order
    if results:
        seen = set()
        unique_results = []
        for item in results:
            if item not in seen:
                seen.add(item)
                unique_results.append(item)
        results = unique_results
        return "<br>".join(results) if all else results[0]
    return ""
def getdata_tbl(rgxstr, red=True, id='table1'):
    """
    Extract data from table rows based on column regex matching.
    
    Args:
        rgxstr: list of tuples [(col_idx, regex_pattern), ...] where:
                - col_idx: zero-based column index to search
                - regex_pattern: regex pattern to match
        red: if True, only process rows with class="colorred"
        id: table id to search for (default: 'table1')
    
    Returns:
        list of lists, where each inner list has same size as rgxstr.
        Each inner list contains matched results for one row.
        Example: rgxstr=[(0,r'(\S+)'), (3,r'(\S+)')] 
                returns [['val1', 'val2'], ['val3', 'val4'], ...]
    """
    global soup
    if not soup:
        return []
    
    # Validate rgxstr is a list of tuples
    if not isinstance(rgxstr, list):
        return []
    
    # Find table with id
    table = soup.find('table', {'id': id})
    if not table:
        return []
    
    results = []
    rows = table.find_all('tr')
    
    for row in rows:
        # If red=True, only process rows with class="colorred"
        if red:
            row_class = row.get('class', [])
            if isinstance(row_class, str):
                row_class = [row_class]
            if 'colorred' not in row_class:
                continue
        
        # Get cells in this row
        cells = row.find_all('td')
        if not cells:
            continue
        # Process each (col_idx, regex_pattern) tuple and collect results for this row
        row_results = []
        for col_idx, regex_pattern in rgxstr:
            # Check if column index is valid
            if col_idx >= len(cells):
                row_results.append("")
                continue
            
            # Get text from specified column
            col_text = cells[col_idx].get_text(strip=True)
            
            # Apply regex
            match = re.search(regex_pattern, col_text, re.IGNORECASE)
            if match:
                # If there are groups, join them with space
                if match.groups():
                    groups = [str(g) for g in match.groups() if g]
                    # Join multiple groups with space
                    row_results.append(" ".join(groups))
                else:
                    # If no groups, use entire match
                    row_results.append(match.group(0))
            else:
                # No match for this column
                row_results.append("")
        
        # Add this row's results as a list
        results.append(row_results)
    return results
    


    
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
def load_html_file(html_path):
    if not os.path.exists(html_path):
        dprint(f"[WARN] Missing HTML file: {html_path}")
        return None
    encodings_to_try = ["utf-8", "utf-8-sig", "utf-16", "cp1252", "latin-1"]
    for enc in encodings_to_try:
        try:
            with open(html_path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    dprint(f"[WARN] Could not decode HTML file: {html_path}")
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
    global soup
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
    global soup, origsubject
    dprint(f"[PARSER] parse_critical")
    text = soup.get_text(" ", strip=True)
    out = {"path": "--"}
    
    dprint(f"[DEBUG] raw_subject: {origsubject}")
    # Shared: build Info1 label from raw subject, linked to RFC
    rfc_match = re.search(r"rfc:\s*(https?://\S+)", text, re.IGNORECASE)
    rfc_link = rfc_match.group(1).strip() if rfc_match else ""
    subj_match = re.search(r"AlertRouter: CRITICAL (.*) is firing", origsubject, re.IGNORECASE)
    label = subj_match.group(1).strip() if subj_match else origsubject
    if label:
        out["info1"] = f'<a href="{rfc_link}">{label}</a>' if rfc_link else label

    # Per-type: fill server (Info2) and path based on what the subject contains
    if "Emergency rampdown" in origsubject:
        match = re.search(r"description:\s*(\S+)", text, re.IGNORECASE)
        if match:
            desc_path = match.group(1).strip()
            parts = [p for p in desc_path.replace("\\", "/").split("/") if p]
            out["info2"] = parsepath(desc_path, [1])[0]
            out["path"] = "/" + "/".join(parts[:-1]) if len(parts) > 1 else desc_path
    elif "MultipleClientsDownNetbatchClass" in origsubject:
        # description: More than 50% of SLES12_short in pool orto_e are not available.
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
    #one condition for subject containing NetbatchQOS is firing
    elif "NetbatchQOS is firing" in origsubject:
        matches = re.findall(r"Time\s+to\s+do\s+nbstatus\s+jobs\s+--target\s+(\S+)\s+is\s+high,\s+with\s+a\s+value\s+of\s+(\d+)\s+secs", text, re.IGNORECASE)
        if matches:
            out["info2"] = ", ".join(f"{target} - {value} secs" for target, value in matches)
        else:
            dprint("NBStatus parser: no match")

    return out



def parse_swapping_compute():
    global soup, origsubject
    dprint(f"[PARSER] parse_swapping_compute")
    text = soup.get_text(" ", strip=True)
    out = {}
    processed_rows = []
    if (origsubject.startswith("Swapping Compute General Batch is firing")):
        #dprint(f"[PARSER] parse_swapping_compute - subject starts with 'Swapping Compute'")
        rgxstr = [[0,r'(\S+)'],[4,"\/hnfs\/(t[^\/]+)\/vol\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(?:(?:[^\/]+\/){3}([^\/]+))?"]]
        table_results = getdata_tbl(rgxstr=rgxstr, red=False)
        #dprint(f"[PARSER] parse_swapping_compute - table_results: {table_results}")
        
    elif (origsubject.startswith("Swapping Compute Special is firing")):
    
        rgxstr = [[0,r'(\S+)'],[7,r'(\d+)'],[9,r'slots=(\d+),slots_per_host='],[11,"\/hnfs\/(t[^\/]+)\/vol\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(?:(?:[^\/]+\/){3}([^\/]+))?"]]
        table_results = getdata_tbl(rgxstr=rgxstr, red=True)
        # Process table_results: if first item is not "itotools", combine row with space
        # For multiple rows, combine with <br> and remove duplicates
    if table_results:
        for row in table_results:
            if row and row[0] != "itotools":
                # Combine entire row with space, filtering out None/empty values
                row_str = " ".join(filter(None, [str(item) if item else "" for item in row]))
                if row_str:  # Only add if not empty
                    processed_rows.append(row_str)
        
        # Remove duplicates while preserving order
    if processed_rows:
        unique_rows = []
        seen = set()
        for row in processed_rows:
            if row not in seen:
                unique_rows.append(row)
                seen.add(row)
        out["info2"] = "<br>".join(unique_rows)
    
    rgxstr1 = r"machine\s+(\S+)\s+is\s+swapping\s+at\s*(\S+)\s*"
    
    out["info1"] = getdata_p(rgxstr1, all=False)
    return out



def parse_tcs_storage():
    """
    Parser for TCS Storage alerts.
    Extracts:
    - rfc: <a> tag inside <p> element matching "To continue troubleshooting follow:"
    - dashboard: links after "Useful Links:"
    - path: first column from table id=table1
    - info1: second column from table id=table1
    """
    global soup
    dprint(f"[PARSER] parse_tcs_storage")
    out = {}
    
    # Extract RFC: find <p> matching "To continue troubleshooting follow:", then find <a> tag inside
    rfc_p = getdata_p(r"To continue troubleshooting follow:", all=False, getp=True)
    if rfc_p:
        rfc_link = rfc_p.find("a")
        if rfc_link:
            out["rfc"] = rfc_link.get("href", rfc_link.get_text(strip=True))
            dprint(f"[PARSER] RFC: {out['rfc']}")
    
    # Extract Dashboard links after "Useful Links:"
    dashboard_match = getdata_p(r"Useful Links:", all=False, getp=True)
    if dashboard_match:
        dashboard_links = dashboard_match.find_all("a")
        if dashboard_links:
            out["dashboard"] = dashboard_links[0].get("href", dashboard_links[0].get_text(strip=True))
            dprint(f"[PARSER] Dashboard: {out['dashboard']}")

    
    # Extract path (column 0) and info1 (column 1) from table id=table1
    table_data = getdata_tbl(rgxstr=[[0, r'(\S+)'], [1, r'(\S+)']], red=False, id='table1')
    
    if table_data and len(table_data) > 0:
        col0_items = []
        col1_items = []
        for row in table_data:
            if len(row) > 0 and row[0]:
                col0_items.append(row[0])
            if len(row) > 1 and row[1]:
                col1_items.append(row[1])
        
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
    """
    Default parser with two lists of regex patterns.
    Tries each regex in order, stops at first match.
    Only searches in <p> elements like getdata_p().
    """
    dprint(f"[PARSER] parse_with_regex_lists - default")
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
    info1_result = ""
    # Try each regex in info1_regexes, stop at first match
    for rgx in info1_regexes:
        result = getdata_p(rgx, all=True)  # all=False stops at first match
        #print(f"[DEBUG] Trying regex '{rgx}' got result: {result}")
        if result:
            info1_result = result
            break
    
    info2_result = ""
    # Try each regex in info2_regexes, stop at first match
    for rgx in info2_regexes:
        result = getdata_p(rgx, all=True)  # all=False stops at first match
        #dprint(f"[DEBUG] Trying regex '{rgx}' got result: {result}")
        if result:
            info2_result = result
            break
    path_result = ""
    for rgx in path_regexes:
        path_match = getdata_p(rgx, all=True)
        if path_match:
            path_result = path_match
            break
        
    result = {
        "info1": info1_result,
        "info2": info2_result,
        "path": path_result
    }
    return result

PARSER_RULES = [
    (subject_startswith("alertrouter: critical"), parse_critical),
    (subject_startswith("swapping compute"), parse_swapping_compute),
    (subject_contains("nap015: troubleshoot filer slowness"), parse_tcs_storage),  # TCS Storage alerts
    (lambda subject: True, parse_with_regex_lists),  # Default catch-all
]


def parse_email_by_subject(subject, html, raw_subject=None):
    global soup, origsubject
    soup = BeautifulSoup(html, "html.parser")
    origsubject = raw_subject or subject
    match_subject = origsubject.lower()
    #dprint(f"[DEBUG] parse_email_by_subject: subject (for output)='{subject}', origsubject (for matching)='{match_subject}'")
    parsed = default_parse_result()
    parsed.update(get_common_links())

    for matcher, parser_func in PARSER_RULES:
        if matcher(match_subject):
            parsed.update(parser_func())
            return parsed

    #parsed.update(parse_base())
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
def build_combined_data(allfiles):
    # 1. Load existing data
    global soup,origsubject
    combined_data = load_existing_json(OUTPUT_JSON)
    
    for file in allfiles:
        item_id = os.path.basename(file)
        htmlfile = f"{file}.html"
        rewrite_email(htmlfile)
        
        # Extract subject from HTML <p class="subject">
        html = load_html_file(htmlfile)
        #dprint(f"[DEBUG] Loaded HTML: {htmlfile[:60]}... (length: {len(html) if html else 0})")
        
        
        if html:
            soup = BeautifulSoup(html, 'html.parser')
            elem = soup.select_one('p.subject')
            if elem:
                origsubject = elem.get_text(strip=True).replace('Subject:', '').strip()
                dprint(f"[DEBUG] Subject extracted: {origsubject[:60]}...")
            else:
                dprint(f"[WARNING] No <p class='subject'> found in HTML")
        else:
            dprint(f"[ERROR] Failed to load HTML file: {htmlfile}")
        
        subject, server = cleanupsubject(origsubject)
        dprint(f"[INFO] Processing HTML: {htmlfile} | Subject: {subject[:50] if subject else 'EMPTY'} ")
        # Ensure subject key exists
        if subject not in combined_data:
            combined_data[subject] = {
                "ind_dats": {},
                "rfc": "", "dashboard": "", "notes": "", "info": ""
            }
        
        # Extract timestamp from HTML <p class="timestamp">
        timestamp_elem = soup.select_one('p.timestamp') if soup else None
        datetime_str = timestamp_elem.get_text(strip=True).replace('Sent:', '').strip() if timestamp_elem else ""
        
        # Prepare new data from parser
        new_ind_dat = {
            "info1": "", "info2": "", "path": "", 
            "status": "", "link":  f"http://localhost:5000/triagemails/{item_id}.html",
            "notes":"","users":"",
            "datetime":convert_datetime(datetime_str)
        }
        
        if html:
            parsed = parse_email_by_subject(subject, html, raw_subject=origsubject)
            new_ind_dat.update({
                "info1": parsed["info1"],
                "info2": parsed["info2"],
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
            #dprint(f"[DEBUG] Updated existing entry for ID: {item_id}")
        else:
            # Add new entry
            combined_data[subject]["ind_dats"][item_id] = new_ind_dat
            dprint(f"[DEBUG] Added new entry for ID: {item_id}")
            
        # Keep subject notes if they weren't already there
        if not combined_data[subject]["notes"]:
            combined_data[subject]["notes"] = ""  # Notes extracted from HTML if available
    return combined_data

def remove_gurbage_data(combined_data):
    """
    Remove items from combined_data that contain strings from the garbage list.
    Checks if any garbage string is contained in the subject (case-insensitive).
    
    Args:
        combined_data: Dictionary with subjects as keys
    
    Returns:
        Cleaned combined_data with matching subjects removed
    """
    # List of strings to match for removal
    garbage_strings = [
        "oncall transition notification",
        "Your home directory"
    ]
    
    # Convert garbage strings to lowercase for case-insensitive matching
    garbage_strings_lower = [s.lower() for s in garbage_strings]
    
    # Find subjects to remove
    subjects_to_remove = []
    for subject in combined_data.keys():
        # Skip None or non-string subjects
        if subject is None or not isinstance(subject, str):
            dprint(f"[CLEANUP] Skipping invalid subject: {subject} (type: {type(subject).__name__})")
            continue
        
        subject_lower = subject.lower()
        for garbage_str in garbage_strings_lower:
            if garbage_str in subject_lower:
                subjects_to_remove.append(subject)
                dprint(f"[CLEANUP] Removing subject: '{subject}' (matched: '{garbage_str}')")
                break  # No need to check other garbage strings for this subject
    
    # Remove the marked subjects
    for subject in subjects_to_remove:
        del combined_data[subject]
    
    if subjects_to_remove:
        dprint(f"[CLEANUP] Removed {len(subjects_to_remove)} garbage subjects")
    
    return combined_data

def main():
    allfiles = get_files_from_text()
    dprint(f"[INFO] Starting processing of {len(allfiles)} files...")
    
    combined_data = build_combined_data(allfiles)
    combined_data = remove_gurbage_data(combined_data) 
    dprint(f"[INFO] Total subjects processed: {len(combined_data)}")
    save_json(combined_data, OUTPUT_JSON)
    
    dprint(f"[OK] Merged data saved to: {OUTPUT_JSON}")

if __name__=="__main__":
    main()
