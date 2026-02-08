#!/usr/bin/env python3
"""
文字起こし取得に失敗した動画に対して、利用可能な字幕を調べ、
別の方法で再取得を試みるスクリプト
"""

import json
import os
import time
from youtube_transcript_api import YouTubeTranscriptApi

INPUT_JSON = "transcripts_summary.json"
VIDEO_JSON = "video_list.json"
OUTPUT_DIR = "transcripts"
RETRY_REPORT = "retry_report.json"

def load_failed_videos():
    with open(INPUT_JSON, "r", encoding="utf-8") as f:
        summary = json.load(f)
    return [v for v in summary if not v["transcript_available"]]

def check_available_transcripts(video_id):
    """動画で利用可能な字幕言語を一覧取得"""
    try:
        ytt_api = YouTubeTranscriptApi()
        transcript_list = ytt_api.list(video_id)
        available = []
        for t in transcript_list:
            available.append({
                "language": t.language,
                "language_code": t.language_code,
                "is_generated": t.is_generated,
                "is_translatable": t.is_translatable,
            })
        return available
    except Exception as e:
        return {"error": str(e)}

def try_fetch_any_language(video_id):
    """利用可能な任意の言語で字幕を取得"""
    ytt_api = YouTubeTranscriptApi()
    try:
        # まず利用可能な字幕を確認
        transcript_list = ytt_api.list(video_id)
        transcripts_info = list(transcript_list)

        if not transcripts_info:
            return None, "No transcripts available"

        # 優先順位: ja > ja(auto) > en > anything
        for t in transcripts_info:
            if t.language_code == "ja":
                transcript = ytt_api.fetch(video_id, languages=["ja"])
                text = "\n".join([s.text for s in transcript.snippets])
                return text, f"ja ({'auto' if t.is_generated else 'manual'})"

        for t in transcripts_info:
            if t.language_code == "en":
                transcript = ytt_api.fetch(video_id, languages=["en"])
                text = "\n".join([s.text for s in transcript.snippets])
                return text, f"en ({'auto' if t.is_generated else 'manual'})"

        # それ以外の言語でも取得
        first = transcripts_info[0]
        transcript = ytt_api.fetch(video_id, languages=[first.language_code])
        text = "\n".join([s.text for s in transcript.snippets])
        return text, f"{first.language_code} ({'auto' if first.is_generated else 'manual'})"

    except Exception as e:
        return None, str(e)

def main():
    failed = load_failed_videos()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 全動画情報を読み込み
    with open(VIDEO_JSON, "r", encoding="utf-8") as f:
        all_videos = {v["id"]: v for v in json.load(f)}

    report = []
    success_count = 0
    total = len(failed)

    for i, video in enumerate(failed):
        video_id = video["id"]
        title = video["title"]
        print(f"\n[{i+1}/{total}] {title[:60]}...")

        # Step 1: 利用可能な字幕を確認
        available = check_available_transcripts(video_id)
        if isinstance(available, dict) and "error" in available:
            print(f"  -> LIST ERROR: {available['error'][:80]}")
            report.append({
                "id": video_id,
                "title": title,
                "available_transcripts": [],
                "success": False,
                "error": available["error"],
            })
            time.sleep(0.5)
            continue

        print(f"  Available subtitles: {[a['language_code'] + ('(auto)' if a['is_generated'] else '') for a in available]}")

        if not available:
            print(f"  -> No subtitles available at all")
            report.append({
                "id": video_id,
                "title": title,
                "available_transcripts": [],
                "success": False,
                "error": "No subtitles available",
            })
            time.sleep(0.5)
            continue

        # Step 2: 取得を試みる
        text, lang_info = try_fetch_any_language(video_id)

        if text:
            # 保存
            filepath = os.path.join(OUTPUT_DIR, f"{video_id}.txt")
            vid_info = all_videos.get(video_id, {})
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(f"# {title}\n")
                f.write(f"# URL: https://www.youtube.com/watch?v={video_id}\n")
                f.write(f"# Views: {vid_info.get('view_count', 'N/A')}\n")
                f.write(f"# Language: {lang_info}\n\n")
                f.write(text)

            success_count += 1
            print(f"  -> SUCCESS ({lang_info}, {len(text)} chars)")
            report.append({
                "id": video_id,
                "title": title,
                "available_transcripts": available,
                "success": True,
                "language": lang_info,
                "text_length": len(text),
            })
        else:
            print(f"  -> FAILED: {lang_info[:80]}")
            report.append({
                "id": video_id,
                "title": title,
                "available_transcripts": available,
                "success": False,
                "error": lang_info,
            })

        time.sleep(0.5)

    # レポート保存
    with open(RETRY_REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n=== Retry Complete ===")
    print(f"Total retried: {total}")
    print(f"Newly succeeded: {success_count}")
    print(f"Still failed: {total - success_count}")

if __name__ == "__main__":
    main()
