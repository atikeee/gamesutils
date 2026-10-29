import urllib.request
from urllib.request import urlopen, Request
import urllib.error
from lxml import html
import re
import sys
import os
import traceback

#************************************************#
# NOTE: THIS IS BEING USED BY routes_ppp_tool.py #
# ***********************************************#

# Define the output file path globally or pass it as an argument
OUTPUT_FILE = "zzz.m3u"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
ERROR_FILE = os.path.join(DATA_DIR, "error.txt")
INPUT_FILE = os.path.join(DATA_DIR, "_input.txt")

def process_links(beg, end):
    """
    Processes links from 'data/_input.txt', extracts video information,
    writes the formatted output to 'zzz.m3u', and returns a status message.

    Args:
        beg (int): The starting line number (1-indexed) to process from data/_input.txt.
        end (int): The ending line number (1-indexed) to process from data/_input.txt.

    Returns:
        str: A status message indicating success or failure, including file path if successful.
    """
    output_lines = []
    error_lines = []
    
    if not os.path.exists(INPUT_FILE):
        return f"Error: Input file '{INPUT_FILE}' not found on the server. Please create it."

    try:
        with open(INPUT_FILE, "r", encoding="utf-8") as f:
            input_content = f.read()
    except Exception as e:
        return f"Error reading '{INPUT_FILE}': {e}"

    n = 0
    lines = input_content.splitlines()
    print(f"[DEBUG] Starting process_links from line {beg} to {end}. Total lines in file: {len(lines)}")

    for line in lines:
        n += 1
        if end > 0 and (n > end):
            break
        if (n < beg):
            continue
            
        line_clean = line.strip()
        if not line_clean or line_clean.startswith('#'):
            continue

        print(f"\n[DEBUG] Processing Line {n}: {line_clean}")
        error_lines.append(f"--- Line {n}: {line_clean} ---")

        try:
            if line_clean.startswith("https://www.pornhub"):
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
                req = Request(url=line_clean, headers=headers)
                
                print(f"[DEBUG] [Pornhub] Opening URL...")
                with urlopen(req) as response:
                    html_bytes = response.read()
                    print(f"[DEBUG] [Pornhub] Fetched {len(html_bytes)} bytes.")
                    tree = html.fromstring(html_bytes)
                
                item = tree.xpath(r'//*[@id="player"]/script[1]/text()')
                title_elements = tree.xpath(r'//h1/span')
                title = str(n) + "." + (title_elements[0].text if title_elements else "Pornhub Video") + "|pornhub"
                print(f"[DEBUG] [Pornhub] Extracted title: {title}, script items found: {len(item)}")

                if len(item) > 0:
                    res = item[0]
                    p = r'"videoUrl":"(.*?)"'
                    links = re.findall(p, res)
                    print(f"[DEBUG] [Pornhub] Found {len(links)} videoUrl matches via regex.")
                    if len(links) > 0:
                        highres = 0
                        l = ""
                        for link in reversed(links):
                            m = re.match(r'.*?\D(\d+)P_\d+K.*', link)
                            if m:
                                newres = int(m.group(1))
                                if newres > highres:
                                    highres = newres
                                    l = link.replace('\\', '')
                                    output_lines.append(f'#EXTINF:-1 group-title="ph",{title}')
                                    output_lines.append(l)
                                    print(f"[DEBUG] [Pornhub] Selected resolution {highres}P: {l}")
                    else:
                        print(f"[DEBUG] [Pornhub] WARNING: Regex found no videoUrl in script tag.")
                else:
                    print(f"[DEBUG] [Pornhub] WARNING: XPath for player script returned empty.")

            elif line_clean.startswith("https://pornheal.com"):
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
                req = Request(url=line_clean, headers=headers)
                print(f"[DEBUG] [FreshPorno] Opening URL...")
                h = urlopen(req).read()
                tree = html.fromstring(h)
                video_src = tree.xpath('//video[@class="fp-engine"]/@src')
                title_elements = tree.xpath('//title/text()')
                print(f"[DEBUG] [FreshPorno] video_src found: {len(video_src)}")

                if video_src and len(video_src) > 0:
                    video_link = video_src[0]
                    title = str(n) + "." + (title_elements[0] if title_elements else "FreshPorno Video")
                    output_lines.append(f'#EXTINF:-1 group-title="fp",{title}')
                    output_lines.append(video_link)
                    print(f"[DEBUG] [FreshPorno] Added video link successfully.")
                else:
                    error_lines.append("Could not find video src on FreshPorno page.")

            elif line_clean.startswith("https://xhamster"):
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
                print(f"[DEBUG] [XHamster] Opening URL...")
                req = Request(url=line_clean, headers=headers)
                h = urlopen(req).read()
                tree = html.fromstring(h)
                items = tree.xpath(r'/html/head/link')
                title_nodes = tree.xpath(r'//title')
                title = str(n) + "." + (title_nodes[0].text if title_nodes else "XHamster Video")
                print(f"[DEBUG] [XHamster] Found header link tags: {len(items)}")
                
                m3u8_found = False
                for i in items:
                    if 'href' in i.attrib:
                        l = i.attrib['href']
                        if l.endswith("m3u8"):
                            output_lines.append(f'#EXTINF:-1 group-title="xh",{title}')
                            output_lines.append(l)
                            m3u8_found = True
                            print(f"[DEBUG] [XHamster] Found m3u8 link: {l}")
                if not m3u8_found:
                    print(f"[DEBUG] [XHamster] WARNING: No matching .m3u8 link found in head links.")

            elif line_clean.startswith("https://www.wow.xxx"):
                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
                print(f"[DEBUG] [Wow] Opening URL...")
                req = Request(url=line_clean, headers=headers)
                h = urlopen(req).read()
                tree = html.fromstring(h)
                items = tree.xpath(r'/html/body//video/source/@src')
                title_nodes = tree.xpath(r'//title')
                title = str(n) + "." + (title_nodes[0].text if title_nodes else "Wow Video")
                print(f"[DEBUG] [Wow] Found video source tags: {len(items)}")

                for i in items:
                    output_lines.append(f'#EXTINF:-1 group-title="wow",{title}')
                    output_lines.append(i)
                    print(f"[DEBUG] [Wow] Added source link: {i}")

        except Exception as e:
            # Capture complete stack trace into error logs and terminal
            tb_str = traceback.format_exc()
            print(f"[ERROR] Exception on line {n}: {e}\n{tb_str}")
            error_lines.append(f"EXCEPTION: {str(e)}\n{tb_str}")

    # Write out comprehensive debug errors to error.txt
    error_content = "\n".join(error_lines)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(ERROR_FILE, 'w', encoding="utf-8") as file_o:
            file_o.write(error_content)
    except Exception as e:
        print(f"[ERROR] Could not write to error file: {e}")

    final_output_content = "\n".join(output_lines)
    try:
        with open(OUTPUT_FILE, 'w', encoding="utf-8") as file_o:
            file_o.write(final_output_content)
        return f"✅ Processing complete. Output saved to '{OUTPUT_FILE}'. Check '{ERROR_FILE}' for detailed debug traces."
    except Exception as e:
        return f"❌ Error writing output to '{OUTPUT_FILE}': {e}"

# The original script's direct execution block (for command line usage)
if __name__ == '__main__':
    n_args = len(sys.argv)
    if n_args > 2:
        bs = sys.argv[1]
        es = sys.argv[2]
    else:
        print("pass 2 number argument for lines to process")
        sys.exit(1)

    beg_val = int(bs)
    end_val = int(es)

    result_message = process_links(beg_val, end_val)
    print(result_message)