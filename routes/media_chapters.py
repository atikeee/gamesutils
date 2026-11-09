import math
import re


_CHAPTER_SEPARATOR = re.compile(r"[\s,]+")
_CHAPTER_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def normalize_chapter_timestamps(value):
    timestamps = set()
    for token in _CHAPTER_SEPARATOR.split(str(value or '').strip()):
        parts = token.split(':')
        if not token or len(parts) > 3 or not all(_CHAPTER_NUMBER.fullmatch(part) for part in parts):
            continue
        if any('.' in part for part in parts[:-1]):
            continue
        seconds = float(parts[0])
        for part in parts[1:]:
            seconds = seconds * 60 + float(part)
        if math.isfinite(seconds) and seconds >= 0:
            timestamps.add(seconds)

    return ' '.join(
        str(int(seconds)) if seconds.is_integer() else format(seconds, '.15g')
        for seconds in sorted(timestamps)
    )