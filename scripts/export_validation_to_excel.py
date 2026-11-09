"""
Export Outlook Validation Email to Formatted Excel Report.

Uses outlook_manager.py to read the latest email directly from your open
Outlook instance ('My Folders/validation') without requiring any authentication.
Parses summary and detail tables, matches Sr.No to Validation Number, and
generates a formatted Excel report.

Configured to keep columns (TES, Site, Status, Tool Status) hidden in Excel,
allowing easy unhiding when needed.

Target output:
C:\\Users\\rahmanma\\OneDrive - Intel Corporation\\Documents\\3_work\\validation\\validation_report_YYYYMMDD_HHMMSS.xlsx
"""

import os
import re
import csv
import glob
import datetime
from bs4 import BeautifulSoup
import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

# Import the reusable Outlook management module from the current script directory
try:
    from outlook_manager import OutlookManager
except ImportError:
    import sys
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from outlook_manager import OutlookManager

WORK_DIR = r"C:\Users\rahmanma\OneDrive - Intel Corporation\Documents\3_work\validation"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET_FOLDER_PATH = "My Folders/validation"

# Columns to keep hidden in the generated Excel workbook
COLUMNS_TO_HIDE = {"TES", "Site", "Status", "Tool Status"}

def parse_validation_email_html(html_content):
    """
    Parses the email HTML:
    - Top summary table (Sr.No, TES, Project Type, ..., Pending for)
    - Detail tables (Validation Number, Recipe Set Name, Run Directory, Recipe File, YAML File, Log File, Errors)
    Matches Sr.No with Validation Number.
    """
    soup = BeautifulSoup(html_content, "html.parser")

    # 1. Parse Top Summary Table
    top_table = None
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True) for th in table.find_all("th")]
        if "Sr.No" in headers and "Pending for" in headers:
            top_table = table
            break

    if not top_table:
        raise ValueError("Top summary table not found in email content.")

    headers = [th.get_text(strip=True) for th in top_table.find_all("th")]
    summary_rows = []
    for tr in top_table.find_all("tr")[1:]:
        tds = [td.get_text(strip=True) for td in tr.find_all("td")]
        if tds and len(tds) == len(headers):
            summary_rows.append(dict(zip(headers, tds)))

    # 2. Parse Detail Information Blocks
    detail_data = {}
    for table in soup.find_all("table"):
        text = table.get_text()
        if "Validation Number" in text and "Recipe Set Name" in text:
            val_num = None
            info = {
                "Recipe Set Name": "",
                "Run Directory": "",
                "Recipe File": "",
                "YAML File": "",
                "Log File": "",
                "Errors": ""
            }
            for tr in table.find_all("tr"):
                tds = tr.find_all("td")
                if len(tds) >= 2:
                    k = tds[0].get_text(strip=True).replace("<u>", "").replace("</u>", "").strip()
                    k = re.sub(r"^[_\s]+|[_\s]+$", "", k)
                    v = tds[1].get_text(separator="\n", strip=True)
                    if "Validation Number" in k:
                        val_num = v.strip()
                    elif "Recipe Set Name" in k:
                        info["Recipe Set Name"] = v
                    elif "Run Directory" in k:
                        info["Run Directory"] = v
                    elif "Recipe File" in k:
                        info["Recipe File"] = v
                    elif "YAML File" in k:
                        info["YAML File"] = v
                    elif "Log File" in k:
                        info["Log File"] = v
                    elif "Errors" in k:
                        info["Errors"] = v
            if val_num:
                detail_data[val_num] = info

    # 3. Merge Summary Rows with Detail Columns
    combined_rows = []
    detail_cols = ["Recipe Set Name", "Run Directory", "Recipe File", "YAML File", "Log File", "Errors"]
    for row in summary_rows:
        sr_no = str(row.get("Sr.No", "")).strip()
        details = detail_data.get(sr_no, {})
        for col in detail_cols:
            row[col] = details.get(col, "")
        combined_rows.append(row)

    all_columns = headers + detail_cols
    return all_columns, combined_rows

def load_from_existing_csv(csv_path):
    """
    Fallback loader if needed: reads pre-exported CSV.
    """
    print(f"[*] Reading data from fallback CSV: {csv_path}")
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        columns = reader.fieldnames
        rows = list(reader)
    return columns, rows

def create_formatted_excel(columns, rows, output_filepath):
    """
    Builds the formatted .xlsx file matching all specifications:
    - Row 1 AutoFilter
    - Errors width ~88, wrap_text=True
    - Path columns width ~50
    - Remaining columns auto-fitted, top-aligned
    - Hides specified columns (TES, Site, Status, Tool Status)
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Validation Requests"

    # Header Row
    ws.append(columns)
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for col_idx in range(1, len(columns) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align

    # Data Rows
    for row_dict in rows:
        row_vals = [row_dict.get(col, "") for col in columns]
        ws.append(row_vals)

    # Enable AutoFilter on Row 1
    ws.auto_filter.ref = ws.dimensions

    # Styling cells
    top_align = Alignment(vertical="top")
    wrap_top_align = Alignment(vertical="top", wrap_text=True)
    thin_border = Border(
        left=Side(style="thin", color="D9D9D9"),
        right=Side(style="thin", color="D9D9D9"),
        top=Side(style="thin", color="D9D9D9"),
        bottom=Side(style="thin", color="D9D9D9")
    )
    path_cols = {"Run Directory", "Recipe File", "YAML File", "Log File"}

    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=ws.max_column):
        for cell in row:
            col_name = columns[cell.column - 1]
            cell.border = thin_border
            if col_name == "Errors":
                cell.alignment = wrap_top_align
            else:
                cell.alignment = top_align

    # Column Widths and Hidden Column Settings
    for col_idx, col_name in enumerate(columns, 1):
        col_letter = get_column_letter(col_idx)

        # Set appropriate column width
        if col_name == "Errors":
            ws.column_dimensions[col_letter].width = 88
        elif col_name in path_cols:
            ws.column_dimensions[col_letter].width = 50
        else:
            max_len = max(
                len(str(ws.cell(row=r, column=col_idx).value or ""))
                for r in range(1, ws.max_row + 1)
            )
            ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

        # Hide requested columns (TES, Site, Status, Tool Status)
        if col_name in COLUMNS_TO_HIDE:
            ws.column_dimensions[col_letter].hidden = True
            print(f"[*] Set column '{col_name}' ({col_letter}) to HIDDEN.")

    ws.freeze_panes = "A2"
    os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
    wb.save(output_filepath)
    print(f"[+] Successfully created formatted Excel report at:\n    {output_filepath}")

def main():
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"validation_report_{timestamp}.xlsx"
    target_path = os.path.join(WORK_DIR, output_filename)

    columns, rows = None, None

    # 1. Fetch latest email directly from opened Outlook desktop app
    print(f"[*] Accessing open Outlook application...")
    try:
        mgr = OutlookManager()
        email = mgr.get_latest_email(TARGET_FOLDER_PATH)
        if email:
            print(f"[+] Retrieved email: '{email.Subject}' (Received: {email.ReceivedTime})")
            html_body = email.HTMLBody
            print("[*] Parsing HTML tables and matching details...")
            columns, rows = parse_validation_email_html(html_body)
    except Exception as e:
        print(f"[!] Outlook access issue: {e}")

    # 2. Fallback to existing CSV export if Outlook not reachable
    if not rows:
        print("[*] Falling back to pre-exported CSV data in validation directory...")
        csv_files = sorted(glob.glob(os.path.join(WORK_DIR, "validation_report_*.csv")), reverse=True)
        if csv_files:
            columns, rows = load_from_existing_csv(csv_files[0])

    if not rows:
        print("[!] No data available to generate Excel report.")
        return

    # 3. Generate Formatted Excel Report
    print(f"[*] Formatting Excel report with {len(rows)} validation records...")
    create_formatted_excel(columns, rows, target_path)

if __name__ == "__main__":
    main()
