#!/usr/bin/env python3
import json
import inspect
import os
import sys
from collections.abc import Iterable
from pathlib import Path


def _load_dotenv():
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


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
    proxy_config = _build_proxy_config(required=True)

    def add_error(message):
        if message and message not in errors:
            errors.append(message)

    fetch_attempts = [
        {"kwargs": {"languages": ["en", "en-US", "en-GB"]}, "label": "fetch(languages=en*)"},
        {"kwargs": {}, "label": "fetch(default-language)"}
    ]

    try:
        api_instance = api_class(proxy_config=proxy_config)
    except Exception as exc:
        add_error(f"API class initialization failed: {exc}")
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


def _build_proxy_config(required=False):
    explicit_proxy_url = os.getenv("YT_PROXY_URL", "").strip()

    bright_data_username = os.getenv("BRIGHT_DATA_USERNAME", "").strip()
    bright_data_password = os.getenv("BRIGHT_DATA_PASSWORD", "").strip()
    bright_data_host = os.getenv("BRIGHT_DATA_HOST", "brd.superproxy.io").strip() or "brd.superproxy.io"
    bright_data_port = os.getenv("BRIGHT_DATA_PORT", "33335").strip() or "33335"

    proxy_url = explicit_proxy_url
    if not proxy_url and bright_data_username and bright_data_password:
        proxy_url = f"http://{bright_data_username}:{bright_data_password}@{bright_data_host}:{bright_data_port}"

    if not proxy_url:
        if required:
            raise RuntimeError(
                "Proxy is required but no proxy credentials were found. "
                "Set YT_PROXY_URL or BRIGHT_DATA_USERNAME and BRIGHT_DATA_PASSWORD (recommended via .env)."
            )
        return None

    proxy_class = None
    for module_name in ("yt_transcript_api.proxies", "youtube_transcript_api.proxies"):
        try:
            module = __import__(module_name, fromlist=["GenericProxyConfig"])
        except Exception:
            continue
        proxy_class = getattr(module, "GenericProxyConfig", None)
        if proxy_class:
            break

    if proxy_class is None:
        raise RuntimeError(
            "Proxy configuration requested but GenericProxyConfig is unavailable. "
            "Install an updated yt-transcript-api package from https://github.com/FFD2025/yt-transcript-api"
        )

    try:
        return proxy_class(http_url=proxy_url, https_url=proxy_url)
    except TypeError:
        return proxy_class(proxy_url, proxy_url)


def main():
    _load_dotenv()

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
