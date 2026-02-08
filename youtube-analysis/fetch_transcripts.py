#!/usr/bin/env python3
"""
YouTube動画の文字起こし（トランスクリプト）を一括取得するスクリプト
video_list.json から動画IDを読み込み、日本語字幕を取得する
"""

import json
import os
import time
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter

INPUT_JSON = "video_list.json"
OUTPUT_DIR = "transcripts"
SUMMARY_JSON = "transcripts_summary.json"

def load_video_list():
    with open(INPUT_JSON, "r", encoding="utf-8") as f:
        return json.load(f)

def fetch_transcript(video_id):
    """動画の日本語字幕を取得。自動生成字幕も含む"""
    try:
        ytt_api = YouTubeTranscriptApi()
        transcript = ytt_api.fetch(video_id, languages=["ja"])

        # テキストを結合
        full_text = ""
        for entry in transcript.snippets:
            full_text += entry.text + "\n"

        return {
            "success": True,
            "text": full_text.strip(),
            "snippet_count": len(transcript.snippets),
        }
    except Exception as e:
        # 日本語がなければ英語を試す
        try:
            transcript = ytt_api.fetch(video_id, languages=["en"])
            full_text = ""
            for entry in transcript.snippets:
                full_text += entry.text + "\n"
            return {
                "success": True,
                "text": full_text.strip(),
                "snippet_count": len(transcript.snippets),
                "language": "en",
            }
        except Exception as e2:
            return {
                "success": False,
                "error": str(e2),
            }

def main():
    videos = load_video_list()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    summary = []
    total = len(videos)

    for i, video in enumerate(videos):
        video_id = video["id"]
        title = video["title"]
        print(f"[{i+1}/{total}] {title[:50]}...")

        result = fetch_transcript(video_id)

        if result["success"]:
            # 個別テキストファイルとして保存
            filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(f"# {title}\n")
                f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                f.write(f"# Views: {video.get('view_count', 'N/A')}\n\n")
                f.write(result["text"])

            summary.append({
                "id": video_id,
                "title": title,
                "url": video["url"],
                "view_count": video.get("view_count", 0),
                "transcript_available": True,
                "text_length": len(result["text"]),
                "snippet_count": result.get("snippet_count", 0),
                "language": result.get("language", "ja"),
            })
            print(f"  -> OK ({len(result['text'])} chars)")
        else:
            summary.append({
                "id": video_id,
                "title": title,
                "url": video["url"],
                "view_count": video.get("view_count", 0),
                "transcript_available": False,
                "error": result["error"],
            })
            print(f"  -> FAILED: {result['error'][:80]}")

        # レート制限対策
        time.sleep(0.5)

    # サマリー保存
    with open(SUMMARY_JSON, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # 結果レポート
    success_count = sum(1 for s in summary if s["transcript_available"])
    fail_count = total - success_count
    print(f"\n=== Complete ===")
    print(f"Total: {total} videos")
    print(f"Success: {success_count}")
    print(f"Failed: {fail_count}")

if __name__ == "__main__":
    main()
