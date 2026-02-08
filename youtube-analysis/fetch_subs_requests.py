#!/usr/bin/env python3
"""
requestsライブラリでYouTube字幕を直接取得するスクリプト
SSL問題を回避し、動画ページHTMLから字幕URLを抽出して取得
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

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
})

def load_failed_ids():
    with open(INPUT_JSON, "r", encoding="utf-8") as f:
        summary = json.load(f)
    return [v for v in summary if not v["transcript_available"]]

def load_video_info():
    with open(VIDEO_JSON, "r", encoding="utf-8") as f:
        return {v["id"]: v for v in json.load(f)}

def get_caption_url(video_id):
    """動画ページのHTMLから字幕トラックURLを抽出"""
    url = f"https://www.youtube.com/watch?v={video_id}"
    resp = SESSION.get(url, timeout=30)
    resp.raise_for_status()
    html = resp.text

    # captionTracks を探す
    pattern = r'"captionTracks":\s*(\[.*?\])'
    match = re.search(pattern, html)

    if not match:
        return None, "No captionTracks found"

    try:
        tracks_json = match.group(1)
        tracks_json = tracks_json.replace('\\u0026', '&')
        tracks = json.loads(tracks_json)

        # 日本語字幕を優先
        for track in tracks:
            lang = track.get("languageCode", "")
            if lang == "ja":
                base_url = track.get("baseUrl", "")
                return base_url, "ja"

        # なければ最初の字幕
        if tracks:
            base_url = tracks[0].get("baseUrl", "")
            lang = tracks[0].get("languageCode", "unknown")
            return base_url, lang

    except (json.JSONDecodeError, KeyError) as e:
        return None, f"Parse error: {e}"

    return None, "No tracks found"

def fetch_caption_text(caption_url):
    """字幕URLからテキストを取得"""
    # XML形式で取得
    resp = SESSION.get(caption_url, timeout=30)
    resp.raise_for_status()
    xml_data = resp.text

    lines = []
    try:
        root = ET.fromstring(xml_data)
        for elem in root.iter("text"):
            if elem.text and elem.text.strip():
                text = elem.text.strip()
                text = text.replace("&amp;", "&")
                text = text.replace("&#39;", "'")
                text = text.replace("&quot;", '"')
                lines.append(text)
    except ET.ParseError:
        # フォールバック: regex
        text_matches = re.findall(r'<text[^>]*>([^<]+)</text>', xml_data)
        lines = [t.strip() for t in text_matches if t.strip()]

    # 重複除去しつつ順序維持
    seen = set()
    unique = []
    for line in lines:
        if line not in seen:
            seen.add(line)
            unique.append(line)

    return "\n".join(unique)

def main():
    failed = load_failed_ids()
    video_info = load_video_info()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    total = len(failed)
    success_count = 0
    results = []

    for i, video in enumerate(failed):
        video_id = video["id"]
        title = video["title"]
        vid = video_info.get(video_id, {})
        view_count = vid.get("view_count", "N/A")

        print(f"[{i+1}/{total}] {title[:55]}...")

        try:
            # Step 1: 字幕URLを取得
            caption_url, lang = get_caption_url(video_id)

            if not caption_url:
                print(f"  -> No caption URL: {lang}")
                results.append({"id": video_id, "title": title, "success": False, "error": lang})
                time.sleep(4)
                continue

            print(f"  Caption found ({lang}), fetching text...")
            time.sleep(1)

            # Step 2: 字幕テキストを取得
            text = fetch_caption_text(caption_url)

            if text and len(text) > 50:
                filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(f"# {title}\n")
                    f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                    f.write(f"# Views: {view_count}\n")
                    f.write(f"# Source: direct-html-parse ({lang})\n\n")
                    f.write(text)

                success_count += 1
                print(f"  -> OK ({len(text)} chars)")
                results.append({"id": video_id, "title": title, "success": True, "chars": len(text), "lang": lang})
            else:
                print(f"  -> Text too short ({len(text) if text else 0} chars)")
                results.append({"id": video_id, "title": title, "success": False, "error": "Text too short"})

        except requests.exceptions.HTTPError as e:
            if e.response and e.response.status_code == 429:
                print(f"  -> RATE LIMITED (429). Waiting 30s...")
                time.sleep(30)
            else:
                print(f"  -> HTTP ERROR: {e}")
            results.append({"id": video_id, "title": title, "success": False, "error": str(e)[:200]})
        except Exception as e:
            print(f"  -> ERROR: {str(e)[:80]}")
            results.append({"id": video_id, "title": title, "success": False, "error": str(e)[:200]})

        # レート制限対策
        if i < total - 1:
            time.sleep(5)

    # 結果保存
    with open("direct_requests_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Complete ===")
    print(f"Total: {total}")
    print(f"Success: {success_count}")
    print(f"Failed: {total - success_count}")

if __name__ == "__main__":
    main()
