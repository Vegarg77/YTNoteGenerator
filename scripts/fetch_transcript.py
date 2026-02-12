#!/usr/bin/env python3
import json
import inspect
import sys
from collections.abc import Iterable


def _load_api_class():
    errors = []

    try:
        from yt_transcript_api import YouTubeTranscriptApi  # type: ignore

        return YouTubeTranscriptApi
    except Exception as exc:  # pragma: no cover - depends on runtime env
        errors.append(f"yt_transcript_api import failed: {exc}")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore

        return YouTubeTranscriptApi
    except Exception as exc:  # pragma: no cover - depends on runtime env
        errors.append(f"youtube_transcript_api import failed: {exc}")

    raise RuntimeError(
        "Unable to import transcript API package. Install the dependency from "
        "https://github.com/FFD2025/yt-transcript-api. Details: "
        + " | ".join(errors)
    )


def _normalize_items(raw):
    if raw is None:
        return []

    if hasattr(raw, "to_raw_data") and callable(raw.to_raw_data):
        try:
            raw = raw.to_raw_data()
        except Exception:
            pass

    if hasattr(raw, "snippets"):
        raw = getattr(raw, "snippets")

    if isinstance(raw, dict):
        raw = raw.get("transcript") or raw.get("segments") or []

    if not isinstance(raw, list) and isinstance(raw, Iterable) and not isinstance(raw, (str, bytes)):
        try:
            raw = list(raw)
        except Exception:
            raw = []

    if not isinstance(raw, list):
        return []

    normalized = []
    for item in raw:
        if isinstance(item, dict):
            text = item.get("text") or item.get("utf8") or ""
        else:
            if hasattr(item, "text"):
                text = getattr(item, "text")
            elif hasattr(item, "utf8"):
                text = getattr(item, "utf8")
            elif hasattr(item, "content"):
                text = getattr(item, "content")
            else:
                text = str(item)

        text = " ".join(text.split()).strip()
        if text:
            normalized.append(text)

    return normalized


def _fetch_transcript(api_class, video_id):
    errors = []

    def add_error(message):
        if message and message not in errors:
            errors.append(message)

    def call_maybe_bound(target, video_id_arg, **kwargs):
        """Call transcript API methods whether they are class/static or instance methods."""
        sig = None
        try:
            sig = inspect.signature(target)
        except Exception:
            sig = None

        if sig:
            params = list(sig.parameters.values())
            if params and params[0].name in {"self", "cls"}:
                raise TypeError("unbound instance/class method")

        return target(video_id_arg, **kwargs)

    fetch_attempts = [
        {"kwargs": {"languages": ["en", "en-US", "en-GB"]}, "label": "fetch(languages=en*)"},
        {"kwargs": {}, "label": "fetch(default-language)"}
    ]

    if hasattr(api_class, "get_transcript"):
        try:
            return call_maybe_bound(api_class.get_transcript, video_id, languages=["en"]), "yt-transcript-api:get_transcript"
        except Exception as exc:
            add_error(f"get_transcript failed: {exc}")

    if hasattr(api_class, "fetch"):
        for attempt in fetch_attempts:
            try:
                return call_maybe_bound(api_class.fetch, video_id, **attempt["kwargs"]), "yt-transcript-api:fetch"
            except TypeError as exc:
                add_error(f"class-{attempt['label']} signature mismatch: {exc}")
                if attempt["kwargs"]:
                    continue
            except Exception as exc:
                add_error(f"class-{attempt['label']} failed: {exc}")

    try:
        api_instance = api_class()
    except Exception:
        api_instance = None

    if api_instance and hasattr(api_instance, "fetch"):
        for attempt in fetch_attempts:
            try:
                return api_instance.fetch(video_id, **attempt["kwargs"]), "yt-transcript-api:fetch"
            except TypeError as exc:
                add_error(f"{attempt['label']} signature mismatch: {exc}")
                if attempt["kwargs"]:
                    continue
            except Exception as exc:
                add_error(f"{attempt['label']} failed: {exc}")

    transcript_list_method = None
    if api_instance and hasattr(api_instance, "list"):
        transcript_list_method = api_instance.list
    elif api_instance and hasattr(api_instance, "list_transcripts"):
        transcript_list_method = api_instance.list_transcripts

    if transcript_list_method:
        try:
            transcript_list = transcript_list_method(video_id)
            if hasattr(transcript_list, "find_transcript"):
                try:
                    transcript = transcript_list.find_transcript(["en", "en-US", "en-GB"]).fetch()
                except Exception:
                    transcript = next(iter(transcript_list)).fetch() if isinstance(transcript_list, Iterable) else []
            elif hasattr(transcript_list, "find_generated_transcript"):
                transcript = transcript_list.find_generated_transcript(["en", "en-US", "en-GB"]).fetch()
            else:
                transcript = next(iter(transcript_list)).fetch() if isinstance(transcript_list, Iterable) else []
            return transcript, "yt-transcript-api:list"
        except Exception as exc:
            add_error(f"list/find_transcript failed: {exc}")

    raise RuntimeError("; ".join(errors[:4]) if errors else "No compatible transcript API method found")


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        raise RuntimeError("Missing video ID argument")

    video_id = sys.argv[1].strip()
    api_class = _load_api_class()
    raw, source = _fetch_transcript(api_class, video_id)

    lines = _normalize_items(raw)
    transcript = "\n".join(lines).strip()
    if not transcript:
        raise RuntimeError("Transcript is empty")

    print(json.dumps({"videoId": video_id, "source": source, "transcript": transcript}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
