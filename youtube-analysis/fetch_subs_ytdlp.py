#!/usr/bin/env python3
"""
yt-dlp を使って自動生成字幕をダウンロードするスクリプト
youtube-transcript-api で取得できなかった動画に対して使用
レート制限対策として十分な間隔を空ける
"""

import json
import os
import subprocess
import time
import re

INPUT_JSON = "transcripts_summary.json"
OUTPUT_DIR = "transcripts"
VTT_DIR = "transcripts_vtt"

def load_failed_ids():
    with open(INPUT_JSON, "r", encoding="utf-8") as f:
        summary = json.load(f)
    return [v for v in summary if not v["transcript_available"]]

def vtt_to_plain_text(vtt_content):
    """VTT字幕ファイルをプレーンテキストに変換"""
    lines = vtt_content.split("\n")
    text_lines = []
    seen = set()

    for line in lines:
        line = line.strip()
        # タイムスタンプ行やヘッダーをスキップ
        if not line:
            continue
        if line.startswith("WEBVTT"):
            continue
        if line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if line.startswith("NOTE"):
            continue
        if "-->" in line:
            continue
        if re.match(r"^\d+$", line):
            continue

        # HTMLタグを除去
        clean = re.sub(r"<[^>]+>", "", line)
        clean = clean.strip()

        if clean and clean not in seen:
            seen.add(clean)
            text_lines.append(clean)

    return "\n".join(text_lines)

def download_subtitle(video_id, title, view_count, delay=8):
    """yt-dlp で字幕をダウンロード"""
    os.makedirs(VTT_DIR, exist_ok=True)

    vtt_path = os.path.join(VTT_DIR, f"{video_id}.ja.vtt")

    cmd = [
        "yt-dlp",
        "--write-auto-sub",
        "--sub-lang", "ja",
        "--skip-download",
        "--sub-format", "vtt",
        "-o", os.path.join(VTT_DIR, f"%(id)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        if os.path.exists(vtt_path):
            with open(vtt_path, "r", encoding="utf-8") as f:
                vtt_content = f.read()

            plain_text = vtt_to_plain_text(vtt_content)

            # テキストファイルとして保存
            txt_path = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(f"# {title}\n")
                f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                f.write(f"# Views: {view_count}\n")
                f.write(f"# Source: yt-dlp auto-sub\n\n")
                f.write(plain_text)

            return True, len(plain_text)
        else:
            # 別の拡張子で保存されている可能性
            for ext in [".ja.vtt", ".ja.srt", ".ja.json3"]:
                alt_path = os.path.join(VTT_DIR, f"{video_id}{ext}")
                if os.path.exists(alt_path):
                    with open(alt_path, "r", encoding="utf-8") as f:
                        content = f.read()
                    plain_text = vtt_to_plain_text(content)
                    txt_path = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
                    with open(txt_path, "w", encoding="utf-8") as f:
                        f.write(f"# {title}\n")
                        f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                        f.write(f"# Views: {view_count}\n")
                        f.write(f"# Source: yt-dlp auto-sub\n\n")
                        f.write(plain_text)
                    return True, len(plain_text)

            stderr = result.stderr[:200] if result.stderr else "Unknown error"
            return False, stderr

    except subprocess.TimeoutExpired:
        return False, "Timeout"
    except Exception as e:
        return False, str(e)

def main():
    failed = load_failed_ids()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    total = len(failed)
    success_count = 0
    results = []

    for i, video in enumerate(failed):
        video_id = video["id"]
        title = video["title"]
        view_count = video.get("view_count", "N/A")

        print(f"[{i+1}/{total}] {title[:55]}...")

        ok, info = download_subtitle(video_id, title, view_count)

        if ok:
            success_count += 1
            print(f"  -> OK ({info} chars)")
            results.append({"id": video_id, "title": title, "success": True, "chars": info})
        else:
            print(f"  -> FAILED: {str(info)[:80]}")
            results.append({"id": video_id, "title": title, "success": False, "error": str(info)[:200]})

        # レート制限対策: 十分に間隔を空ける
        if i < total - 1:
            wait = 8
            print(f"  Waiting {wait}s...")
            time.sleep(wait)

    with open("ytdlp_retry_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n=== Complete ===")
    print(f"Total: {total}")
    print(f"Success: {success_count}")
    print(f"Failed: {total - success_count}")

if __name__ == "__main__":
    main()
