#!/usr/bin/env python3
"""
YouTube字幕を直接HTTPリクエストで取得するスクリプト
youtube-transcript-api / yt-dlp で429エラーになった動画に対して使用
動画ページのHTMLから字幕URLを直接抽出する方式
"""

import json
import os
import re
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

INPUT_JSON = "transcripts_summary.json"
VIDEO_JSON = "video_list.json"
OUTPUT_DIR = "transcripts"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
}

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
    req = urllib.request.Request(url, headers=HEADERS)

    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    # playerCaptionsTracklistRenderer から字幕URLを探す
    pattern = r'"captionTracks":\s*(\[.*?\])'
    match = re.search(pattern, html)

    if not match:
        return None

    try:
        tracks_json = match.group(1)
        # JSONとしてパース（エスケープ処理）
        tracks_json = tracks_json.replace('\\u0026', '&')
        tracks = json.loads(tracks_json)

        # 日本語字幕を優先
        for track in tracks:
            lang = track.get("languageCode", "")
            if lang == "ja":
                return track.get("baseUrl", "")

        # 日本語がなければ最初の字幕
        if tracks:
            return tracks[0].get("baseUrl", "")
    except (json.JSONDecodeError, KeyError):
        pass

    return None

def fetch_caption_xml(caption_url):
    """字幕XMLを取得してテキストに変換"""
    # fmt=srv3 でXML形式を取得
    if "fmt=" not in caption_url:
        caption_url += "&fmt=srv3"

    req = urllib.request.Request(caption_url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        xml_data = resp.read().decode("utf-8", errors="replace")

    # XMLをパースしてテキストを抽出
    lines = []
    try:
        root = ET.fromstring(xml_data)
        for elem in root.iter():
            if elem.text and elem.text.strip():
                text = elem.text.strip()
                # HTML entities をデコード
                text = text.replace("&amp;", "&")
                text = text.replace("&lt;", "<")
                text = text.replace("&gt;", ">")
                text = text.replace("&#39;", "'")
                text = text.replace("&quot;", '"')
                lines.append(text)
    except ET.ParseError:
        # XML解析失敗時はregexでテキストを抽出
        text_matches = re.findall(r'>([^<]+)<', xml_data)
        lines = [t.strip() for t in text_matches if t.strip()]

    # 重複除去
    seen = set()
    unique_lines = []
    for line in lines:
        if line not in seen:
            seen.add(line)
            unique_lines.append(line)

    return "\n".join(unique_lines)

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
            caption_url = get_caption_url(video_id)

            if not caption_url:
                print(f"  -> No caption URL found")
                results.append({"id": video_id, "title": title, "success": False, "error": "No caption URL"})
                time.sleep(3)
                continue

            # Step 2: 字幕テキストを取得
            time.sleep(1)
            text = fetch_caption_xml(caption_url)

            if text and len(text) > 50:
                # 保存
                filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(f"# {title}\n")
                    f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                    f.write(f"# Views: {view_count}\n")
                    f.write(f"# Source: direct-caption-api\n\n")
                    f.write(text)

                success_count += 1
                print(f"  -> OK ({len(text)} chars)")
                results.append({"id": video_id, "title": title, "success": True, "chars": len(text)})
            else:
                print(f"  -> Text too short or empty")
                results.append({"id": video_id, "title": title, "success": False, "error": "Empty or too short"})

        except Exception as e:
            print(f"  -> ERROR: {str(e)[:80]}")
            results.append({"id": video_id, "title": title, "success": False, "error": str(e)[:200]})

        # レート制限対策
        if i < total - 1:
            wait = 5
            time.sleep(wait)

    # 結果保存
    with open("direct_fetch_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Complete ===")
    print(f"Total: {total}")
    print(f"Success: {success_count}")
    print(f"Failed: {total - success_count}")

if __name__ == "__main__":
    main()
