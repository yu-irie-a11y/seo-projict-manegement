#!/usr/bin/env python3
"""
最終版: レート制限解除を待ってから字幕を取得
最初に10分待機 → テスト → 成功したら15秒間隔で順次処理
"""

import json
import os
import re
import sys
import time
import requests
import xml.etree.ElementTree as ET

VIDEO_JSON = "video_list.json"
OUTPUT_DIR = "transcripts"

DELAY_BETWEEN = 15  # 動画間の待機秒数
INITIAL_WAIT = 600  # 初期待機（10分）

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
})

def get_missing_videos():
    with open(VIDEO_JSON, "r", encoding="utf-8") as f:
        all_videos = json.load(f)
    missing = []
    for v in all_videos:
        if not os.path.exists(os.path.join(OUTPUT_DIR, f"{v['id']}.txt")):
            missing.append(v)
    return missing

def fetch_one(video_id):
    """1本の動画の字幕テキストを取得。成功時はテキスト、失敗時はNone"""
    url = f"https://www.youtube.com/watch?v={video_id}"
    resp = SESSION.get(url, timeout=30)
    if resp.status_code != 200:
        return None, f"page status {resp.status_code}"

    match = re.search(r'"captionTracks":\s*(\[.*?\])', resp.text)
    if not match:
        return None, "no captionTracks"

    tracks_json = match.group(1).replace('\\u0026', '&')
    try:
        tracks = json.loads(tracks_json)
    except json.JSONDecodeError:
        return None, "JSON parse error"

    caption_url = None
    for track in tracks:
        if track.get("languageCode") == "ja":
            caption_url = track.get("baseUrl")
            break
    if not caption_url and tracks:
        caption_url = tracks[0].get("baseUrl")
    if not caption_url:
        return None, "no caption URL"

    time.sleep(2)
    resp2 = SESSION.get(caption_url, timeout=30)
    if resp2.status_code == 429:
        return None, "429"
    if resp2.status_code != 200:
        return None, f"caption status {resp2.status_code}"

    lines = []
    try:
        root = ET.fromstring(resp2.text)
        for elem in root.iter("text"):
            if elem.text and elem.text.strip():
                lines.append(elem.text.strip())
    except ET.ParseError:
        text_matches = re.findall(r'<text[^>]*>([^<]+)</text>', resp2.text)
        lines = [t.strip() for t in text_matches if t.strip()]

    seen = set()
    unique = []
    for line in lines:
        if line not in seen:
            seen.add(line)
            unique.append(line)

    text = "\n".join(unique)
    if len(text) < 50:
        return None, "text too short"
    return text, "ok"

def save_transcript(video, text):
    filepath = os.path.join(OUTPUT_DIR, f"{video['id']}.txt")
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(f"# {video['title']}\n")
        f.write(f"# URL: https://www.youtube.com/watch?v={video['id']}\n")
        f.write(f"# Views: {video.get('view_count', 'N/A')}\n\n")
        f.write(text)

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    missing = get_missing_videos()

    if not missing:
        print("All videos already have transcripts!")
        return

    total = len(missing)
    print(f"=== {total} videos need transcripts ===")
    sys.stdout.flush()

    # 初期待機
    print(f"Waiting {INITIAL_WAIT}s for rate limit to clear...")
    sys.stdout.flush()
    time.sleep(INITIAL_WAIT)

    success = 0
    fail = 0

    for i, video in enumerate(missing):
        vid_id = video["id"]
        title = video["title"]
        print(f"\n[{i+1}/{total}] {title[:55]}...")
        sys.stdout.flush()

        # 最大3回リトライ（429の場合）
        for attempt in range(3):
            text, status = fetch_one(vid_id)

            if text:
                save_transcript(video, text)
                success += 1
                print(f"  -> OK ({len(text)} chars)")
                sys.stdout.flush()
                break
            elif status == "429":
                wait = 120 * (attempt + 1)
                print(f"  -> 429 (attempt {attempt+1}/3). Waiting {wait}s...")
                sys.stdout.flush()
                time.sleep(wait)
            else:
                fail += 1
                print(f"  -> FAILED: {status}")
                sys.stdout.flush()
                break
        else:
            # 3回リトライしても429
            fail += 1
            print(f"  -> Gave up after 3 retries")
            sys.stdout.flush()

        # 次の動画まで待機
        if i < total - 1:
            time.sleep(DELAY_BETWEEN)

    print(f"\n=== DONE ===")
    print(f"Success: {success}/{total}")
    print(f"Failed: {fail}/{total}")

    remaining = get_missing_videos()
    if remaining:
        print(f"Still missing: {len(remaining)} videos")
        print("Run again: python3 fetch_subs_final.py")
    else:
        print("All videos now have transcripts!")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
