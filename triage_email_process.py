
import os
import json,re
from bs4 import BeautifulSoup
INPUT_JSON = r"c:\temp\email.txt"
HTML_DIR = r"C:\github\gamesutils\templates\triagemails"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_JSON = os.path.join(SCRIPT_DIR, "triage_email_data.json")
OUTPUT_HTML = os.path.join(SCRIPT_DIR, "triage_email_dashboard.html")


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
    elif (subject.startswith("Alertrouter: CRITICAL ITS Alert:")):
        subject = "Alertrouter: CRITICAL ITS Alert"
        #print("debug"+subject)
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
        print(f"[WARN] Missing HTML file: {html_path}")
        return None
    encodings_to_try = ["utf-8", "utf-8-sig", "utf-16", "cp1252", "latin-1"]
    for enc in encodings_to_try:
        try:
            with open(html_path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError:
            continue
    print(f"[WARN] Could not decode HTML file: {html_path}")
    return None
# ----------------------------
# Save / render
# ----------------------------
def save_json(data, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)INPUT_JSON = r"c:/temp/email.txt"

# ----------------------------
# Parser classes
# ----------------------------
class BaseHTMLParser:
    def init(self, html):
        self.soup = BeautifulSoup(html, "html.parser")
    def getpercent(self):
        return "-%"
    def getserver(self):
        return "-"
    def getpath(self):
        return "-"
    def getuser(self):
        return "-"
    def getnotes(self):
        return "-"
    def getrfc(self):
        # First try text-based extraction from paragraph content
        text = self.soup.get_text("\n", strip=True)
        match = re.search(r"RFC:\s*(https?://\S+)", text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
        return self._by_selector(".rfc")
    def getdashboard(self):
        text = self.soup.get_text("\n", strip=True)
        match = re.search(r"Dashboard:\s*(https?://\S+)", text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
        return self._by_selector(".dashboard")
    def byselector(self, selector):
        el = self.soup.select_one(selector)
        return el.get_text(" ", strip=True) if el else ""
class TTDrefVolFillHTMLParser(BaseHTMLParser):
    #Summary: p1280_g volume on tsccfs13 is 96.22% full 
    def init(self, html):
        super().__init__(html)
        text = self.soup.get_text(" ", strip=True)
        self.server = ""
        match = re.search(r"Summary: (\S+)\s+volume\s+on\s+(\S+)\s+is\s+(\S+)\s+full", text, re.IGNORECASE)
        if match:
            self.server = "<b>"+match.group(2)+"</b> Vol: "+match.group(1)
            self.percent = match.group(3)
        else:
            print("TTDrefVolFillHTMLParser: no match") 
    def getserver(self):
        return self.server
        
    def getpercent(self):
        return self.percent
class CriticalITSHTMLParser(BaseHTMLParser):
    #Summary: ITS ticket 22022301727 needs your attention: torirnr05 - MemoryExhaustedInfra and InfraNodeSwapUsage
    #find all
    #rfc: https://hsdes.intel.com/resource/22022301727
    def init(self, html):
        super().__init__(html)
        self.text = self.soup.get_text(" ", strip=True)
        self.server = ""
        match = re.search(r"Summary: ITS ticket (\S+) needs your attention:\s+(\S+) - (.+)$", self.text, re.IGNORECASE)
        if match:
            self.server = "<b>"+match.group(2)+"</b>"
            self.notes =  match.group(3)
        else:
            print("CriticalITSHTMLParser: no match") 
    def getserver(self):
        return self.server
        
    def getnotes(self):
        return self.notes
    def getpath(self):
        pattern = re.compile(
            r"rfc:\s*(\S+)",
            re.IGNORECASE | re.MULTILINE
        )
        matches = pattern.findall(self.text)
        if matches:
            return "<br> ".join(f"<a href={its}>{its}</a>" for its in matches)
            #print(self.server)
        return "--"
        
class ITOVolFillHTMLParser(BaseHTMLParser):
    def init(self, html):
        super().__init__(html)
        text = self.soup.get_text(" ", strip=True)
        self.server = ""
        pattern = re.compile(
            r"description:\s*(\S+)\s+from\s+(\S+)\s*will\s*fill\s*in\s*less\s*than\s*(\S)\s*days.",
            re.IGNORECASE | re.MULTILINE
        )
        matches = pattern.findall(text)
        if matches:
            self.server = ",<br> ".join(f"{aggr}({volume} {d} days)" for volume, aggr,d in matches)
            #print(self.server)
        else:
            print("no match server")
        
        
        pattern = re.compile(
            r"Sname:\s*(\S+)",
            re.IGNORECASE | re.MULTILINE
        )
        matches = pattern.findall(text)
        if matches:
            self.notes = ",<br> ".join(f"{n}" for n in matches)
            #print(self.notes)
        else:
            print("no match notes")
    def getserver(self):
        return self.server or super().getserver()
    def getnotes(self):
        return self.notes or super().getnotes()
class EmergencyRampDownHTMLParser(BaseHTMLParser):
    """
    Example derived parser for alert-router style HTML.
    Adjust selectors or logic based on your real HTML structure.
    """
    def getpercent(self):
        return ""
    def getserver(self):
        return "none"
    def getpath(self):
        text = self.soup.get_text(" ", strip=True)
        match = re.search(r"job_path:\s*(\S+)", text, re.IGNORECASE)
        if match:
            return match.group(1)
        return super().getpath()
class TTDNetAppAggrHTMLParser(BaseHTMLParser):
    #Summary: Aggregate aggr1_tsccfs01n20a_S is at 85.64%
    def init(self, html):
        super().__init__(html)
        text = self.soup.get_text(" ", strip=True)
        self.percent = ""
        self.server = ""
        match = re.search(r"Summary:\s+Aggregate\s+(\S+)\s+is\s+at\s+(\S+)%", text, re.IGNORECASE)
        if match:
            self.server = match.group(1)
            self.percent = match.group(2) + "%"
            
        else:
            print("TTDNetAppAggrHTMLParser: no match")
    def getpercent(self):
        return self.percent or super().getpercent()
    def getserver(self):
        return self.server or super().getserver()
class AggrWillFillHTMLParser(BaseHTMLParser):
    #Summary: aggr1_tsccfs01n20a_S will fill in less than 2 days
    def init(self, html):
        super().__init__(html)
        text = self.soup.get_text(" ", strip=True)
        self.percent = ""
        self.server = ""
        match = re.search(r"Summary:\s+(\S+)\s+will\s+fill\s+in\s+less\s+than\s+(\d+)\s+days", text, re.IGNORECASE)
        if match:
            self.server = match.group(1)
            self.percent = match.group(2) +" day"
            
        else:
            print("AggrWillFillHTMLParser: no match")
    def getpercent(self):
        return self.percent or super().getpercent()
    def getserver(self):
        return self.server or super().getserver()
class SwappingComputeHTMLParser(BaseHTMLParser):
    def init(self, html):
        super().__init__(html)
        self.percent = ""
        self.server = ""
        self.table1 = []
        # Parse free-text from the full HTML text
        self.text = self.soup.get_text(" ", strip=True)
        match = re.search(
            r"Machine\s+(\S+)\s+is\s+swapping\s+at\s*(\S+)\s*%",
            self.text,
            re.IGNORECASE
        )
        if match:
            self.server = match.group(1)
            self.percent = match.group(2) + "%"
        # Parse table data if present
        headertext = "Min slots needed"
        self.table1 = gettabledatas(self.soup, [0, 7, 9, 12], headertext, red=True)
        
    def getpercent(self):
        return self.percent or super().getpercent()
    def getserver(self):
        return self.server or super().getserver()
    def getpath(self):
        return self.table1[3][0] if len(self.table1) > 3 and self.table1[3] else super().getpath()
    
    def getuser(self):
        return  ", ".join(set(self.table1[0])) or super().getpath()
    
def get_parser(subject, html):
    """
    Choose parser based on subject.
    Extend this later with more derived parsers.
    """
    
    if subject.startswith("Alertrouter: WARNING Emergency rampdown is firing"):
        return EmergencyRampDownHTMLParser(html)
    elif subject.startswith("Swapping Compute"):
        return SwappingComputeHTMLParser(html)
    elif subject.startswith("Alertrouter: WARNING ttd_netapp_aggr_full is firing"):
        return TTDNetAppAggrHTMLParser(html)
    elif subject.startswith("Alertrouter: WARNING ito_aggr_will_fill_in_x_days is firing"):
        return AggrWillFillHTMLParser(html)
    #elif subject.startswith("Alertrouter: WARNING ttd_ref_volume_full is firing):
    #    return TTDNetAppAggrHTMLParser(html)
    #Alertrouter: WARNING ttd_netapp_aggr_full is firing
    #Alertrouter: WARNING ito_aggr_will_fill_in_x_days is firing
    #Alertrouter: CRITICAL ITS Alert:
    #Alertrouter: CRITICAL MultipleClientsDownNetbatchClass
    #Alertrouter: CRITICAL Emergency rampdown is firing
    #Alertrouter: WARNING ttd_ref_volume_full is firing
    elif subject.startswith("Alertrouter: WARNING ttd_ref_volume_full is firing"):
        return TTDrefVolFillHTMLParser(html)
    elif subject.startswith("Alertrouter: WARNING ito_vol_will_fill_in_x_days is firing"):
        return ITOVolFillHTMLParser(html)
    elif subject.startswith("Alertrouter: CRITICAL ITS Alert"):
        print("debug"+subject)
        return CriticalITSHTMLParser(html)
    
    return BaseHTMLParser(html)
# ----------------------------
# Model build
# ----------------------------
def build_combined_data(input_items):
    """
    Final structure:
    {
      "subject": {
        "ind_dats": {
          "id": {
            "percent": "",
            "server": "",
            "path": "",
            "status": "",
            "info":""
          }
        },
        "rfc": "...",
        "dashboard": "...",
        "notes": "..."
      }
    }
    """
    combined_data = {}
    for item in input_items:
        subject = item.get("subject", "")
        subject,server = cleanupsubject(subject)
        item_id = item.get("id", "")
        if subject not in combined_data:
            combined_data[subject] = {
                "ind_dats": {},
                "rfc": "",
                "dashboard": "",
                "notes": "",
                "info":""
            }
        
        html_path = os.path.join(HTML_DIR, f"{item_id}.html")
        html = load_html_file(html_path)
        
        # default ind_dat
        ind_dat = {
            "percent": "",
            "server": "",
            "path": "",
            "status": "",
            "link":""
        }
        if html:
            parser = get_parser(subject, html)
            ind_dat["percent"] = parser.getpercent()
            ind_dat["server"] = server or parser.getserver()
            ind_dat["path"] = parser.getpath()
            
            ind_dat["link"] = html_path
            # subject-level fields can be captured from one HTML or input source
            # here we only set them once if empty
            if not combined_data[subject]["rfc"]:
                combined_data[subject]["rfc"] = parser.getrfc()
            if not combined_data[subject]["dashboard"]:
                combined_data[subject]["dashboard"] = parser.getdashboard()
        # optional subject-level notes from input json
        if not combined_data[subject]["notes"]:
            combined_data[subject]["notes"] = item.get("notes", "")
        # store by id
        combined_data[subject]["ind_dats"][item_id] = ind_dat
    return combined_data
def generate_dashboard_html(combined_data, path):
    parts = []
    parts.append("""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h2 { margin-top: 30px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 25px; }
        th, td { border: 1px solid #ccc; padding: 8px; vertical-align: top; }
        th { background: #f2f2f2; }
        tr:nth-child(even) { background: #fafafa; }
    </style>
</head>
<body>
    <h1>Dashboard</h1>
""")
    for subject, data in combined_data.items():
        parts.append(f"<h2>{subject}</h2>")
        parts.append(f"""
        <p>
<strong>RFC:</strong> <a href="{data.get("rfc", "")}">{data.get("rfc", "")}</a><br>
    <strong>Dashboard:</strong> <a href="{data.get("dashboard", "")}">{data.get("dashboard", "")}</a><br>            <strong>Notes:</strong> {data.get("notes", "")}
        </p>
        """)
        parts.append("""
        <table>
            <thead>
                <tr>
                    <th style="display:none;">ID</th>
                    <th>Percent</th>
                    <th>Server</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>link</th>
                </tr>
            </thead>
            <tbody>
        """)
        for item_id, ind_dat in data.get("ind_dats", {}).items():
            parts.append(f"""
                <tr>
                    <td style="display:none;">{item_id}</td>
                    <td>{ind_dat.get("percent", "")}</td>
                    <td>{ind_dat.get("server", "")}</td>
                    <td>{ind_dat.get("path", "")}</td>
                    <td>{ind_dat.get("status", "")}</td>
                    <td><a href="{ind_dat.get("link","")}">mail</a></td>
                </tr>
            """)
        parts.append("""
            </tbody>
        </table>
        """)
    parts.append("""
</body>
</html>
""")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
def main():
    input_items = load_input_json(INPUT_JSON)
    combined_data = build_combined_data(input_items)
    save_json(combined_data, OUTPUT_JSON)
    generate_dashboard_html(combined_data, OUTPUT_HTML)
    print(f"[OK] Input JSON: {INPUT_JSON}")
    print(f"[OK] Output JSON: {OUTPUT_JSON}")
    print(f"[OK] Output HTML: {OUTPUT_HTML}")
if name == "__main__":
    main()
    
    
    
    
    
    
