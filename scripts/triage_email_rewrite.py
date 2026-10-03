#!/usr/bin/env python3
"""
Parse Word-generated HTML email files and extract content.
Extract MsoPlainText and MsoNormal content, find Subject line, and generate clean HTML.
"""

listoffiles='c:\\temp\\email.txt'
HTML_DIR="../templates/triagemails"
template_string = r'''<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <title>*</title>
        <link rel="stylesheet" href="triage_email_style.css">
    </head>
    <body>
    </body>
    </html>
    '''
from bs4 import BeautifulSoup
import os,re
import shutil
from pathlib import Path

# Debug flag - set to True to enable debug output
DEBUG = True

def dprint(*args, **kwargs):
    """Print only if DEBUG is True"""
    if DEBUG:
        print(*args, **kwargs)

def get_files_from_text():
    """
    Read filenames from templist.txt (one filename per line).
    Return list of full file paths located in the specified folder.
    Handles UTF-8, UTF-16 with BOM, and other encodings.
    
    Args:
        HTML_DIR (str): Directory where the files are located
        listoffiles (str): Path to the templist.txt file
    
    Returns:
        list: List of full file paths from templist.txt
    """
    files_list = []
    
    if not os.path.exists(listoffiles):
        print(f"[ERROR] file list source not found: {listoffiles}")
        exit(1)
    
    try:
        # Try multiple encodings, with UTF-16 first (for PowerAutomate files)
        encodings_to_try = ["utf-16", "utf-16-sig", "utf-8", "utf-8-sig", "cp1252", "latin-1"]
        
        html_content = None
        for enc in encodings_to_try:
            try:
                with open(listoffiles, 'r', encoding=enc) as f:
                    html_content = f.read()
                    dprint(f"[DEBUG] Successfully read templist.txt with encoding: {enc}")
                    break
            except (UnicodeDecodeError, LookupError):
                continue
        
        if html_content is None:
            print(f"[ERROR] Could not decode templist.txt with any supported encoding")
            exit(1)
        
        for line in html_content.split('\n'):
            filename = line.strip()
            if filename:  # Skip empty lines
                full_path = os.path.join(HTML_DIR, filename)
                files_list.append(full_path)
        
        dprint(f"[INFO] Loaded {len(files_list)} files from templist.txt")
        if files_list:
            dprint(f"[INFO] Processing {len(files_list)} files\n")
            return files_list
        else:
            dprint(f"[ERROR] No files listed in {listoffiles}")
            exit(1)
    except Exception as e:
        print(f"[ERROR] Error reading templist.txt: {e}")
        exit(1)
    return files_list

def extract_content_elements(soup):
    """
    Extract content elements in order of appearance from HTML body.
    Handles two formats:
    1. Classic Word HTML with <p> and <table> tags
    2. Simplified format with <span>, <b>, <br> tags
    
    Args:
        soup: BeautifulSoup object of the HTML
    
    Returns:
        list: List of BeautifulSoup elements
    """
    content_elements = []
    
    # Try to find body tag
    body = soup.find('body')
    
    if not body:
        print(f"[WARNING] body tag not found in input HTML")
        return content_elements
    
    # Try to find WordSection1 div (where content usually lives)
    word_section = body.find('div', {'class': 'WordSection1'})
    search_container = word_section if word_section else body
    
    # Get all p and table elements from container
    all_elements = search_container.find_all(['p', 'table'])
    dprint(f"[DEBUG] Found {len(all_elements)} p/table elements")
    
    # If we found p/table elements, use them (classic format)
    if all_elements:
        for elem in all_elements:
            if elem.name == 'p':
                # Skip p elements inside tables
                if elem.find_parent('table'):
                    continue
                
                # Clean Word-specific tags from paragraph
                for tag in elem.find_all('o:p'):
                    tag.decompose()
                
                # Only add non-empty elements
                if elem.get_text(strip=True):
                    content_elements.append(elem)
            
            elif elem.name == 'table':
                # Clean o:p tags in all table cells
                for td in elem.find_all('td'):
                    for tag in td.find_all('o:p'):
                        tag.decompose()
                
                # Only add non-empty tables
                if elem.get_text(strip=True):
                    content_elements.append(elem)
    
    # If no p/table elements, try simplified format (split by <br>)
    else:
        dprint(f"[DEBUG] No p/table elements found, trying simplified format...")
        
        # Get all direct children of search_container
        for child in search_container.children:
            if isinstance(child, str):
                # Skip plain text nodes
                if child.strip():
                    dprint(f"[DEBUG] Found text node: {child.strip()[:40]}...")
                continue
            
            # Look for non-empty text blocks
            if hasattr(child, 'name'):
                if child.name in ['br', 'o:p']:
                    # Skip these structural elements
                    continue
                
                # Get text content
                text = child.get_text(strip=True)
                if text and len(text) > 3:  # Skip very short text
                    content_elements.append(child)
        
        dprint(f"[DEBUG] Extracted {len(content_elements)} simplified elements")
    
    return content_elements



def create_clean_elements(content_elements):
    """
    Create clean copies of content elements with all Word styling removed.
    - Tables: recreate with fresh tr/td, no attributes, add 'colorred' class to red cells
    - Paragraphs: create fresh p tags with text content, convert URLs to clickable links, preserve <br> tags
    - Bold and color keywords at start of text (Subject:, From:, To:, etc.)
    
    Args:
        content_elements (list): List of original BeautifulSoup elements
    
    Returns:
        list: List of clean BeautifulSoup elements
    """
    # Keywords to highlight with bold and color
    HIGHLIGHT_KEYWORDS = ['Subject:',  'Sent:', 'dashboard:','description:', 'rfc:', 'dashboard:','summary:','Sname','Instance:','Instances:','AlertRouter']
    table_counter = 0
    def process_text_with_styling(text, url_pattern):
        """
        Process text to:
        1. Bold and color keywords at start of text (case-insensitive)
        2. Convert URLs to links
        Returns list of elements/strings to append
        """
        result = []
        
        # Check if text starts with any highlight keyword (case-insensitive)
        keyword_found = None
        keyword_len = 0
        text_lower = text.lower()
        
        for keyword in HIGHLIGHT_KEYWORDS:
            if text_lower.startswith(keyword.lower()):
                keyword_found = keyword
                keyword_len = len(keyword)
                break
        
        if keyword_found:
            # Create bold colored span for keyword (use original text)
            bold_span = BeautifulSoup('<span style="font-weight: bold; color: blue;"></span>', 'html.parser').find('span')
            bold_span.string = text[:keyword_len]  # Use original text casing
            result.append(bold_span)
            
            # Process the rest of text (after keyword) for URLs
            rest_of_text = text[keyword_len:]
            if rest_of_text:
                parts = re.split(url_pattern, rest_of_text)
                for part in parts:
                    if re.match(url_pattern, part):
                        clean_link = BeautifulSoup('<a></a>', 'html.parser').find('a')
                        clean_link['href'] = part if part.startswith('http') else f'http://{part}'
                        clean_link.string = part
                        result.append(clean_link)
                    elif part:
                        result.append(part)
        else:
            # No keyword match, just process for URLs
            parts = re.split(url_pattern, text)
            for part in parts:
                if re.match(url_pattern, part):
                    clean_link = BeautifulSoup('<a></a>', 'html.parser').find('a')
                    clean_link['href'] = part if part.startswith('http') else f'http://{part}'
                    clean_link.string = part
                    result.append(clean_link)
                elif part:
                    result.append(part)
        
        return result
    
    cleaned = []
    
    # Regex pattern for URLs
    url_pattern = r'(https?://[^\s<>]+|www\.[^\s<>]+)'
    
    for elem in content_elements:
        if elem.name == 'p':
            # Create new clean p 
            new_p = BeautifulSoup('<p></p>', 'html.parser').find('p')
            
            # Find all existing links
            existing_links = elem.find_all('a')
            text = elem.get_text(strip=True)
            
            if text or existing_links:
                # Iterate through children to preserve structure (including <br> tags)
                for child in elem.children:
                    if isinstance(child, str):
                        text_node = str(child).strip().replace('\n', ' ')
                        text_node = ' '.join(text_node.split())  # Remove extra spaces
                        if text_node:
                            # Process text with styling and URL detection
                            processed = process_text_with_styling(text_node, url_pattern)
                            for item in processed:
                                new_p.append(item)
                    elif hasattr(child, 'name'):
                        if child.name == 'br':
                            # Preserve <br> tags for line breaks
                            br_tag = BeautifulSoup('<br/>', 'html.parser').find('br')
                            new_p.append(br_tag)
                        elif child.name == 'a':
                            # Create clean link
                            clean_link = BeautifulSoup('<a></a>', 'html.parser').find('a')
                            clean_link['href'] = child.get('href', '#')
                            clean_link.string = child.get_text(strip=True)
                            new_p.append(clean_link)
                        elif child.name == 'o:p':
                            # Skip Word-specific tags
                            continue
                        else:
                            # Check for nested content (links, br, etc)
                            inner_links = child.find_all('a')
                            inner_brs = child.find_all('br')
                            
                            if inner_links or inner_brs:
                                # Process nested children
                                for inner_child in child.children:
                                    if isinstance(inner_child, str):
                                        inner_text = str(inner_child).strip().replace('\n', ' ')
                                        inner_text = ' '.join(inner_text.split())  # Remove extra spaces
                                        if inner_text:
                                            # Process text with styling and URL detection
                                            processed = process_text_with_styling(inner_text, url_pattern)
                                            for item in processed:
                                                new_p.append(item)
                                    elif hasattr(inner_child, 'name'):
                                        if inner_child.name == 'br':
                                            br_tag = BeautifulSoup('<br/>', 'html.parser').find('br')
                                            new_p.append(br_tag)
                                        elif inner_child.name == 'a':
                                            clean_link = BeautifulSoup('<a></a>', 'html.parser').find('a')
                                            clean_link['href'] = inner_child.get('href', '#')
                                            clean_link.string = inner_child.get_text(strip=True)
                                            new_p.append(clean_link)
                            else:
                                inner_text = child.get_text(strip=True).replace('\n', ' ')
                                inner_text = ' '.join(inner_text.split())  # Remove extra spaces
                                if inner_text:
                                    # Process text with styling and URL detection
                                    processed = process_text_with_styling(inner_text, url_pattern)
                                    for item in processed:
                                        new_p.append(item)
                
                # Add class to element based on content
                p_text = new_p.get_text(strip=True)
                if p_text.startswith('Subject:'):
                    new_p['class'] = 'subject'
                elif p_text.startswith('Sent:'):
                    new_p['class'] = 'timestamp'
                elif p_text.lower().startswith(('from:', 'to:', 'categories:')):
                    new_p['class'] = 'hideme'
                
                cleaned.append(new_p)
        
        elif elem.name == 'table':
            # Create new clean table
            table_counter += 1
            new_table = BeautifulSoup('<table></table>', 'html.parser').find('table')
            new_table['id'] = f'table{table_counter}'
            
            rows = elem.find_all('tr')
            for row_idx, tr in enumerate(rows):
                new_tr = BeautifulSoup('<tr></tr>', 'html.parser').find('tr')
                has_colored_td = False
                is_first_row = (row_idx == 0)
                
                cells = tr.find_all('td')
                for td in cells:
                    # Use <th> for first row, <td> for others
                    if is_first_row:
                        new_cell = BeautifulSoup('<th></th>', 'html.parser').find('th')
                    else:
                        new_cell = BeautifulSoup('<td></td>', 'html.parser').find('td')
                    
                    text = td.get_text(strip=True)
                    new_cell.string = text
                    
                    # Check if td has colored span (color:red) and preserve only that style
                    colored_spans = td.find_all('span', style=lambda x: x and 'color:red' in x)
                    if colored_spans:
                        new_cell['style'] = 'color:red'
                        has_colored_td = True
                    
                    new_tr.append(new_cell)
                
                # Add colorred class to row if any cell has color:red
                if has_colored_td:
                    new_tr['class'] = 'colorred'
                
                new_table.append(new_tr)
            
            cleaned.append(new_table)
    
    return cleaned



def parse_email_html(html_file):
    """
    Read HTML file, create soup, extract subject and content elements.
    Detects encoding by checking for UTF-16LE BOM.
    
    Args:
        html_file (str): Path to the HTML file
    
    Returns:
        tuple: (subject, content_elements_list) or ("", [])
    """
    # Verify file exists
    if not os.path.exists(html_file):
        print(f"[ERROR] File does not exist: {html_file}")
        return "", []
    
    # Detect encoding by checking first 2 bytes for BOM
    try:
        with open(html_file, "rb") as f:
            raw_bytes = f.read(2)
            encoding = 'utf-16-le' if raw_bytes == b'\xff\xfe' else 'utf-16-be' if raw_bytes == b'\xfe\xff' else 'utf-8'
    except Exception as e:
        print(f"[ERROR] Failed to detect encoding: {e}")
        return "", []
    
    # Read HTML file
    try:
        with open(html_file, 'r', encoding=encoding, errors='ignore') as f:
            html_content = f.read()
        #dprint(f"[DEBUG] File read: {len(html_content)} bytes (encoding: {encoding})")
    except Exception as e:
        print(f"[ERROR] Failed to read file: {e}")
        return "", []
    
    # Create soup
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # Check if already processed (HTML title starts with *)
    title_tag = soup.find('title')
    if title_tag and title_tag.string and title_tag.string.strip().startswith('*'):
        dprint(f"[INFO] File already processed (title starts with *)")
        return None, []
    
    # Test for body tag
    body_tag = soup.find('body')
    if not body_tag:
        print(f"[ERROR] Body tag NOT found!")
        return "", []
    
    dprint(f"[DEBUG] Body tag found")
    
    # Extract content elements
    dprint(f"[DEBUG] Extracting content elements...")
    content_elements = extract_content_elements(soup)
    dprint(f"[DEBUG] Extracted {len(content_elements)} elements")
    
    # Extract subject from first content element that contains "Subject:"
    subject = ""
    for elem in content_elements:
        text = elem.get_text(strip=True)
        if text.startswith('Subject:'):
            # Remove "Subject:" prefix and clean up
            subject = text.replace('Subject:', '').strip()
            break
    
    if subject:
        dprint(f"[DEBUG] Subject: {subject[:60]}...")
    else:
        dprint(f"[DEBUG] Subject not found")
    
    print()
    return subject, content_elements



def generate_html_from_template(input_html):
    """
    Parse email HTML, create clean elements, and generate output HTML file.
    
    Args:
        input_html (str): Path to the input HTML file
    
    Returns:
        None. Writes output file with _o suffix (e.g., sample.html > sample_o.html)
    """
    
    # Verify file exists
    if not os.path.exists(input_html):
        print(f"[ERROR] Input file not found: {input_html}")
        return
    
    # Parse email to extract subject and original content elements
    dprint(f"[INFO] Processing: {input_html}\n")
    subject, content_elements = parse_email_html(input_html)
    
    if not content_elements:
        print(f"[ERROR] No content elements extracted")
        return
    
    # Create clean elements (removes styling, adds redcolor class to rows)
    cleaned_elements = create_clean_elements(content_elements)
    
    if not cleaned_elements:
        print(f"[ERROR] No cleaned elements generated")
        return
    
    # Generate output filename with _o suffix
    output_file = input_html.replace('.html', '_o.html')
    output_file = input_html
    
    # Create HTML from template
    template = template_string
    soup = BeautifulSoup(template, 'html.parser')
    body = soup.find('body')
    
    if body:
        # Clear the body
        body.clear()
        
        # Add title with * prefix to mark as processed
        if subject:
            title_tag = soup.find('title')
            if title_tag:
                title_tag.string = f"*{subject}"
        
        # Add cleaned content elements (p, table)
        for elem in cleaned_elements:
            # Append directly - elements are already fresh copies from create_clean_elements()
            body.append(elem)
    
    # Write output file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(str(soup.prettify()))
    
    # Summary
    print(f"\n[RESULT] Summary:")
    print(f"  Subject: {subject[:70] if subject else 'Not found'}...")
    print(f"  Content elements: {len(cleaned_elements)}")
    print(f"  Output file: {output_file}")
    print(f"\n[SUCCESS] Done!")


def remove_directory_if_exists(dirname):
    """
    Verify if a directory exists and if so, remove everything under it 
    and remove the directory itself. Changes file permissions to handle locked files.
    
    Args:
        dirname (str): Path to the directory to remove
    """
    if not os.path.exists(dirname):
        dprint(f"[INFO] Directory does not exist: {dirname}")
        return
    
    try:
        # Try simple rmtree first
        shutil.rmtree(dirname)
        dprint(f"[INFO] Removed directory: {dirname}")
    except PermissionError:
        # If permissions issue, change chmod and try manual deletion
        import stat
        for root, dirs, files in os.walk(dirname, topdown=False):
            # Remove files
            for name in files:
                filepath = os.path.join(root, name)
                os.chmod(filepath, stat.S_IWUSR | stat.S_IREAD)
                os.remove(filepath)
            
            # Remove directories
            for name in dirs:
                dirpath = os.path.join(root, name)
                os.chmod(dirpath, stat.S_IWUSR | stat.S_IREAD | stat.S_IXUSR)
                os.rmdir(dirpath)
        
        # Remove the root directory
        os.chmod(dirname, stat.S_IWUSR | stat.S_IREAD | stat.S_IXUSR)
        os.rmdir(dirname)
        dprint(f"[INFO] Removed directory: {dirname}")
    except Exception as e:
        print(f"[ERROR] Failed to remove directory {dirname}: {e}")


def rewrite_email(filepath):


        print(filepath)
        # Optional: Remove associated _files directory
        file_path = Path(filepath)
        generate_html_from_template(filepath)
        dirname = str(file_path.parent / (file_path.stem + "_files"))
        if os.path.exists(dirname):
            print(f"[DEBUG] Cleaning _files directory: {dirname}")
            remove_directory_if_exists(dirname)



if __name__ == "__main__":
    ## Get list of files from templist.txt
    allfiles = get_files_from_text()
    #

    #
    ## Process each file
    for idx, filepath in enumerate(allfiles, 1):
        dprint(f"\n[{idx}/{len(allfiles)}] {'='*65}")
        # Check if file exists
        filepath += ".html"
        if not os.path.exists(filepath):
            dprint(f"[WARNING] File not found: {filepath}")
            continue
    #    
    rewrite_email(filepath)

