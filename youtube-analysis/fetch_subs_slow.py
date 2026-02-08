#!/usr/bin/env python3
"""
レート制限対策版: 長い間隔を空けて1本ずつ字幕を取得
最初にテスト1本を取得し、成功したら残りを順次処理
"""

import json
import os
import re
import time
import requests
import xml.etree.ElementTree as ET

INPUT_JSON = "transcripts_summary.json"
VIDEO_JSON = "video_list.json"
OUTPUT_DIR = "transcripts"
RESULT_FILE = "slow_fetch_results.json"

# 1本あたりの待機時間（秒）
DELAY_BETWEEN = 15

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
})

def load_failed_ids():
    """まだ transcripts/ にファイルがない動画を取得"""
    with open(VIDEO_JSON, "r", encoding="utf-8") as f:
        all_videos = json.load(f)

    failed = []
    for v in all_videos:
        txt_path = os.path.join(OUTPUT_DIR, f"{v['id']}.txt")
        if not os.path.exists(txt_path):
            failed.append(v)
    return failed

def get_caption_text(video_id):
    """動画ページから字幕URLを取得し、テキストを返す"""
    url = f"https://www.youtube.com/watch?v={video_id}"
    resp = SESSION.get(url, timeout=30)
    resp.raise_for_status()
    html = resp.text

    pattern = r'"captionTracks":\s*(\[.*?\])'
    match = re.search(pattern, html)
    if not match:
        return None, "No captionTracks"

    tracks_json = match.group(1).replace('\\u0026', '&')
    tracks = json.loads(tracks_json)

    caption_url = None
    for track in tracks:
        if track.get("languageCode") == "ja":
            caption_url = track.get("baseUrl")
            break
    if not caption_url and tracks:
        caption_url = tracks[0].get("baseUrl")

    if not caption_url:
        return None, "No caption URL"

    # 字幕テキスト取得
    time.sleep(2)
    resp2 = SESSION.get(caption_url, timeout=30)
    resp2.raise_for_status()

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

    return "\n".join(unique), "ok"

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    failed = load_failed_ids()

    if not failed:
        print("All videos already have transcripts!")
        return

    total = len(failed)
    print(f"=== {total} videos remaining ===")
    print(f"Delay between requests: {DELAY_BETWEEN}s\n")

    # まずテスト1本（レート制限が解除されたか確認）
    test_vid = failed[0]
    print(f"[TEST] {test_vid['title'][:50]}...")

    max_retries = 5
    wait_times = [60, 120, 180, 300, 600]  # 1分→2分→3分→5分→10分

    test_ok = False
    for attempt in range(max_retries):
        try:
            text, status = get_caption_text(test_vid["id"])
            if text and len(text) > 50:
                filepath = os.path.join(OUTPUT_DIR, f"{test_vid['id']}.txt")
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(f"# {test_vid['title']}\n")
                    f.write(f"# URL: https://www.youtube.com/watch?v={test_vid['id']}\n")
                    f.write(f"# Views: {test_vid.get('view_count', 'N/A')}\n\n")
                    f.write(text)
                print(f"  -> TEST OK! ({len(text)} chars). Proceeding...\n")
                test_ok = True
                break
            else:
                print(f"  -> TEST FAILED: {status}")
                break
        except requests.exceptions.HTTPError as e:
            if e.response and e.response.status_code == 429:
                wait = wait_times[attempt]
                print(f"  -> Rate limited (attempt {attempt+1}/{max_retries}). Waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  -> HTTP Error: {e}")
                break
        except Exception as e:
            print(f"  -> Error: {e}")
            break

    if not test_ok:
        print("Could not overcome rate limit. Try again later: python3 fetch_subs_slow.py")
        return

    success_count = 1
    results = [{"id": test_vid["id"], "success": True}]

    for i, video in enumerate(failed[1:], start=2):
        video_id = video["id"]
        title = video["title"]

        # 既にファイルがあればスキップ
        if os.path.exists(os.path.join(OUTPUT_DIR, f"{video_id}.txt")):
            continue

        print(f"[{i}/{total}] {title[:50]}...")
        time.sleep(DELAY_BETWEEN)

        try:
            text, status = get_caption_text(video_id)
            if text and len(text) > 50:
                filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(f"# {title}\n")
                    f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                    f.write(f"# Views: {video.get('view_count', 'N/A')}\n\n")
                    f.write(text)
                success_count += 1
                print(f"  -> OK ({len(text)} chars)")
                results.append({"id": video_id, "success": True, "chars": len(text)})
            else:
                print(f"  -> Failed: {status}")
                results.append({"id": video_id, "success": False, "error": status})

        except requests.exceptions.HTTPError as e:
            if e.response and e.response.status_code == 429:
                print(f"  -> Rate limited again. Waiting 60s and retrying...")
                time.sleep(60)
                try:
                    text, status = get_caption_text(video_id)
                    if text and len(text) > 50:
                        filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
                        with open(filepath, "w", encoding="utf-8") as f:
                            f.write(f"# {title}\n")
                            f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                            f.write(f"# Views: {video.get('view_count', 'N/A')}\n\n")
                            f.write(text)
                        success_count += 1
                        print(f"  -> OK on retry ({len(text)} chars)")
                        results.append({"id": video_id, "success": True, "chars": len(text)})
                    else:
                        print(f"  -> Failed on retry")
                        results.append({"id": video_id, "success": False, "error": "retry failed"})
                except Exception:
                    print(f"  -> Failed on retry too. Stopping to avoid more rate limits.")
                    results.append({"id": video_id, "success": False, "error": "rate limit persistent"})
                    break
            else:
                print(f"  -> HTTP Error: {e}")
                results.append({"id": video_id, "success": False, "error": str(e)[:200]})

        except Exception as e:
            print(f"  -> Error: {str(e)[:80]}")
            results.append({"id": video_id, "success": False, "error": str(e)[:200]})

    with open(RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Complete ===")
    print(f"Newly succeeded: {success_count}/{total}")

    # 残りを確認
    still_missing = load_failed_ids()
    if still_missing:
        print(f"Still missing: {len(still_missing)} videos")
        print(f"Run again later: python3 fetch_subs_slow.py")
    else:
        print("All videos now have transcripts!")

if __name__ == "__main__":
    main()
