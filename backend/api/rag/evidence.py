"""Evidence selection and provenance shared by semantic and hybrid answers."""
import json
import math
import re


def metadata(chunk):
    value = chunk.get('METADATA') or {}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return value if isinstance(value, dict) else {}


def cosine_score(chunk):
    meta = metadata(chunk)
    if meta.get('score_type') == 'lexical' or meta.get('retrieval') in ('fallback', 'snapshot_lexical', 'structured_record'):
        return None
    value = chunk.get('SCORE')
    try:
        number = float(value)
        return number if math.isfinite(number) and -1 <= number <= 1 else None
    except (ValueError, TypeError):
        return None


def select_evidence(chunks, record_id=None, limit=10):
    """Keep exact entity evidence for record questions; never confuse PRJ-002 with PRJ-0020."""
    pattern = None
    if record_id:
        parts = re.split(r'[-_\s]+', record_id)
        pattern = re.compile(r'(?<![A-Za-z0-9])' + r'[-_\s]*'.join(map(re.escape, parts)) + r'(?![A-Za-z0-9])', re.I)
    selected, seen = [], set()
    for chunk in chunks or []:
        text = str(chunk.get('TEXT_CHUNK') or '').strip()
        meta = metadata(chunk)
        score = cosine_score(chunk)
        lexical = meta.get('lexical_score', chunk.get('LEXICAL_SCORE', 0))
        if not text or (pattern and not pattern.search(text)):
            continue
        if not pattern and not ((score is not None and score >= .15) or lexical > 0):
            continue
        key = (chunk.get('ID'), text)
        if key in seen:
            continue
        seen.add(key)
        selected.append(chunk)
    selected.sort(key=lambda chunk: cosine_score(chunk) if cosine_score(chunk) is not None else -1, reverse=True)
    return selected[:max(1, min(int(limit), 20))]


def budget_evidence(chunks, characters=14000):
    """Only attribute sources whose excerpts actually enter the model context."""
    result = []
    for chunk in chunks:
        if characters < 300:
            break
        text = str(chunk.get('TEXT_CHUNK') or '')
        length = min(len(text), characters, 3000)
        excerpt = text[:length] + (' [source excerpt truncated]' if length < len(text) else '')
        result.append({**chunk, 'TEXT_CHUNK': excerpt})
        characters -= length
    return result
