
#!/usr/bin/env python3

"""
Extract HTML body content using regex only (no third-party libraries).
- Reads file as raw bytes, decodes as ASCII, drops all non-ASCII/non-printable characters
- Removes <head>...</head> entirely
- Removes <p> tags, adds <br> after each paragraph
- Formats: /nfs paths bold+blue, http URLs clickable, first 1-3 words ending with ':' bold
- 4+ dashes replaced with <hr>
"""
import re,os,shutil
import sys
def apply_formatting(content: str) -> str:
    lines = content.split("\n")
    result = []
    # Regex for Linux absolute paths
    linux_path_re = re.compile(r'(?<!\w)(\/[\w\.\-\/]+)')
    # Regex for http/https URLs
    url_re = re.compile(r'(https?://[^\s<>"\']+)')
    for line in lines:
        # Rule 1: Bold and blue for /nfs paths only
        line = linux_path_re.sub(
            lambda m: f'<b><span style="color:teal;">{m.group(1)}</span></b>'
            if m.group(1).startswith("/nfs") or m.group(1).startswith("/hnfs") or m.group(1).startswith("/p/tapeout")
            else m.group(1),
            line
        )
        # Rule 2: Make http/https URLs clickable links
        line = url_re.sub(r'<a href="\1">\1</a>', line)
        # Rule 3: Bold first 1-3 words if they end with ':'
        line = re.sub(r'^(\s*)((\w+\s){0,2}\w+:)(\s)', r'\1<b>\2</b>\4', line)
        # Rule 4: Replace 4 or more dashes with a horizontal ruler
        line = re.sub(r'-{4,}', '<hr>', line)
        result.append(line)
    return "\n".join(result)
def extract_body(input_file: str, output_file: str) -> None:
    # Read file as raw bytes, decode as ASCII, drop all non-ASCII bytes
    with open(input_file, "rb") as f:
        raw = f.read()
    # Decode as ASCII ignoring non-ASCII bytes, then remove null characters
    html = raw.decode("ascii", errors="ignore").replace("\x00", "")
    # Strip any remaining non-printable control characters (keep \t \n \r and space-~)
    html = re.sub(r'[^\x09\x0A\x0D\x20-\x7E]', '', html)
    print("Read file as ASCII (non-ASCII and non-printable characters stripped)")
    # Remove everything from <head to </head>
    html = re.sub(r"<head[\s\S]*?</head>", "", html, flags=re.IGNORECASE | re.DOTALL)
    # Remove <p ...> opening tags entirely
    html = re.sub(r"<p[^>]*>", "", html, flags=re.IGNORECASE)
    # Replace </p> closing tags with <br>
    html = re.sub(r"</p>", "<br>", html, flags=re.IGNORECASE)
    # Extract content inside <body>...</body>
    body_match = re.search(r"<body[^>]*>([\s\S]*?)</body>", html, flags=re.IGNORECASE)
    if body_match:
        body_content = body_match.group(1).strip()
    else:
        body_content = re.sub(r"</?html[^>]*>", "", html, flags=re.IGNORECASE).strip()
    # Apply formatting rules
    body_content = apply_formatting(body_content)
    # Rebuild a clean HTML document
    output_html = f"""<!DOCTYPE html>
<html>
<body>
{body_content}
</body>
</html>
"""
    with open(output_file, "w", encoding="ascii") as f:
        f.write(output_html)
    print(f"Done! Cleaned HTML written to: {output_file}")
        
def scan_and_clean_files_dirs(directory: str) -> None:
    """
    Scan a directory (non-recursively) for all subdirectories ending with '_files'
    and call remove_html_dir on each one by reconstructing the matching html filename.
 
    Example:
        report_files/  →  calls remove_html_dir('report.html')
 
    Args:
        directory: Path to the root directory to scan
    """
    if not os.path.isdir(directory):
        print(f"Error: '{directory}' is not a valid directory")
        return
 
    # Find all subdirectories ending with _files (non-recursive)
    files_dirs = [
        f for f in os.listdir(directory)
        if f.endswith("_files") and os.path.isdir(os.path.join(directory, f))
    ]
 
    if not files_dirs:
        print(f"No '_files' directories found in: {directory}")
        return
 
    print(f"Found {len(files_dirs)} '_files' director(ies) in: {directory}")
    for dirname in files_dirs:
        # Strip _files suffix and reconstruct the matching .html filename
        base_name = dirname[:-6]  # remove trailing '_files'
        html_file = os.path.join(directory, base_name + ".html")
        html_file2 = os.path.join(directory, base_name + "_n.html")
        full_dir_path = os.path.join(directory, dirname)
 
        # Remove the _files directory directly since we already know it
        shutil.rmtree(full_dir_path)
        print(f"Removed directory: {full_dir_path} (matched from {html_file})")
        extract_body(html_file,html_file)
 
if name == "__main__":
    
    if len(sys.argv) == 2:
        scan_and_clean_files_dirs(sys.argv[1])
    else:
        print("Usage: python remove_html_dir.py <directory>")
        sys.exit(1)
