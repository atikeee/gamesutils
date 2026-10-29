import urllib.request

url = "https://hv-h.phncdn.com/hls/videos/201905/15/223855191/190517_1002_720P_4000K_223855191.mp4/master.m3u8?h=d4p8BCMWxFL5PduiLkKV0THwKBc%3D&e=1793083566&f=1"
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.pornhub.com/'
}

try:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as response:
        content = response.read().decode('utf-8')
        print("✅ Success! Master playlist content received:")
        print(content[:500]) # Print the first 500 characters of the playlist
except Exception as e:
    print(f"❌ Failed: {e}")