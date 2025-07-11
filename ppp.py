import urllib.request
from urllib.request import urlopen, Request
import urllib.error
from lxml import html
import re
import sys
import os

# Define the output file path globally or pass it as an argument
OUTPUT_FILE = "zzz.m3u"
ERROR_FILE = "error.txt"
INPUT_FILE = "_input.txt"

def process_links(beg, end):
    """
    Processes links from '_input.txt', extracts video information,
    writes the formatted output to 'zzz.m3u', and returns a status message.

    Args:
        beg (int): The starting line number (1-indexed) to process from _input.txt.
        end (int): The ending line number (1-indexed) to process from _input.txt.

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

    for line in lines:
        n += 1
        if end > 0 and (n > end):
            break
        if (n < beg):
            continue
        if not line.startswith('#'):
            if(line.strip() == ""):
                continue
            error_lines.append(str(n)+" "+line) 
            if( line.startswith("https://www.pornhub")):
                #output_lines.append(f"\nPornHub {n}: {line}")
                try:
                    data = urllib.request.urlopen(line.strip())
                    tree = html.fromstring(data.read())
                    item = tree.xpath(r'//*[@id="player"]/script[1]/text()')
                    title = str(n) + "." + tree.xpath(r'//h1/span')[0].text + "|pornhub"
                except urllib.error.HTTPError as e:
                    error_lines.append(f"Error: {e}")
                    continue
                except Exception as e2:
                    error_lines.append(f"Error: {e2}")
                    continue

                if(len(item) > 0):
                    res = item[0]
                    p = r'"videoUrl":"(.*?)"'
                    links = re.findall(p, res)
                    if(len(links) > 0):
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
            elif(line.startswith("https://pornheal.com")):
                #output_lines.append(f"\nFreshPorno {n}: {line}")
                headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'}
                try:
                    req = Request(url=line.strip(), headers=headers)
                    h = urlopen(req).read()
                    tree = html.fromstring(h)
                    video_src = tree.xpath('//video[@class="fp-engine"]/@src')
                    title_elements = tree.xpath('//title/text()')

                    if video_src and len(video_src) > 0:
                        video_link = video_src[0]
                        title = str(n) + "." + (title_elements[0] if title_elements else "FreshPorno Video")
                        #output_lines.append(f"link: {video_link}\n")
                        output_lines.append(f'#EXTINF:-1 group-title="fp",{title}')
                        output_lines.append(video_link)
                    else:
                        error_lines.append("Could not find video src on FreshPorno page.")

                except Exception as e:
                    error_lines.append(f"Error processing FreshPorno link: {e}")


            elif(line.startswith("https://xhamster")):
                #output_lines.append(f"\nXHamster {n}: {line}")
                headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'}
                reg_url = line.strip()
                try:
                    req = Request(url=reg_url,headers=headers)
                    h = urlopen(req).read()
                    tree = html.fromstring(h)
                    items = tree.xpath(r'/html/head/link')
                    title = str(n) +"."+ tree.xpath(r'//title')[0].text
                    for i in items:
                        l= i.attrib['href']
                        if l.endswith("m3u8"):
                            #output_lines.append(f"link: {l}\n")
                            output_lines.append(f'#EXTINF:-1 #EXTINF:-1 group-title="xh",{title}')
                            output_lines.append(l)
                except Exception as e:
                    error_lines.append(f"Error: {e}")
                    pass

    error_content = "\n".join(error_lines)
    try:
        with open(ERROR_FILE, 'w', encoding="utf-8") as file_o:
            file_o.write(error_content)
    except Exception as e:
        pass
    final_output_content = "\n".join(output_lines)
    try:
        with open(OUTPUT_FILE, 'w', encoding="utf-8") as file_o:
            file_o.write(final_output_content)
        return f"✅ Processing complete. Output saved to '{OUTPUT_FILE}'. You can download it below."
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
    print(result_message) # Print the message for command line usage
