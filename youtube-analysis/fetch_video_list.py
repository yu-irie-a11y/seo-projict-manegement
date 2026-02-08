#!/usr/bin/env python3
"""
RakutenSakabe YouTube チャンネルの動画一覧を取得し、JSON/CSVで保存するスクリプト
"""

import json
import csv
import subprocess
import sys

CHANNEL_URL = "https://www.youtube.com/@RakutenSakabe/videos"
OUTPUT_JSON = "video_list.json"
OUTPUT_CSV = "video_list.csv"

def fetch_videos():
    """yt-dlp で動画メタデータを取得"""
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--dump-json",
        CHANNEL_URL
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    videos = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        data = json.loads(line)
        videos.append({
            "id": data.get("id", ""),
            "title": data.get("title", ""),
            "url": f"https://www.youtube.com/watch?v={data.get('id', '')}",
            "upload_date": data.get("upload_date", ""),
            "view_count": data.get("view_count", 0),
            "duration": data.get("duration", 0),
            "duration_min": round(data.get("duration", 0) / 60, 1),
            "description": data.get("description", ""),
        })

    return videos

def save_json(videos, filepath):
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(videos, f, ensure_ascii=False, indent=2)
    print(f"JSON saved: {filepath} ({len(videos)} videos)")

def save_csv(videos, filepath):
    if not videos:
        return
    fieldnames = ["id", "title", "url", "upload_date", "view_count", "duration_min"]
    with open(filepath, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(videos)
    print(f"CSV saved: {filepath} ({len(videos)} videos)")

if __name__ == "__main__":
    print("Fetching videos from RakutenSakabe channel...")
    videos = fetch_videos()

    # 再生回数順でソート
    videos.sort(key=lambda x: x.get("view_count", 0) or 0, reverse=True)

    save_json(videos, OUTPUT_JSON)
    save_csv(videos, OUTPUT_CSV)
    print("Done!")
