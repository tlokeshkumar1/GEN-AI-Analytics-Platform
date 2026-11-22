"""Answer greetings and workspace inventory questions from authorized metadata only."""
import json
import re

from fastapi import HTTPException

from api.models.execution_context import current_selection, require_dataset_access


def catalog_intent(message):
    text = re.sub(r"[^\w\s]", "", str(message or "").casefold())
    text = re.sub(r"\s+", " ", text).strip()
    if text in {
        "hi", "hello", "hey", "greetings", "good morning", "good afternoon",
        "good evening", "howdy", "hola", "hi there", "hello there", "hey there",
        "who are you", "what can you do", "help",
    }:
        return "greeting"
    text = re.sub(r"^please\s+|\s+please$", "", text).strip()
    noun = r"(?:data|datasets|data sets|tables|files|sources)"
    patterns = (
        rf"(?:what|which) {noun} (?:(?:do|can) i (?:have|access|see)|i have|is available|are available|is loaded|are loaded|is uploaded|are uploaded)",
        rf"(?:what|which) {noun} (?:do you have|you have|can you access)",
        rf"(?:show|list|display)(?: me)?(?: all)?(?: my| the| available| uploaded| loaded)? {noun}(?: available)?",
        rf"(?:give me )?(?:an? )?(?:overview|summary) of (?:my |the |available )?{noun}",
        r"what (?:is|s) (?:in my data|in the database|available)",
    )
    return "catalog" if any(re.fullmatch(pattern, text) for pattern in patterns) else None


def _cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def named_dataset_response(message, catalog):
    """Resolve an explicit catalog name before record-identifier heuristics."""
    text = str(message).casefold()
    if not re.search(r'\b(data|dataset|table|about|overview|summary|describe)\b', text):
        return None
    matches = []
    for identifier, entry in catalog.get('datasets', {}).items():
        names = [entry.get(key) for key in ('name', 'displayName', 'tableName')]
        matched_name = next((str(name).casefold() for name in names if name and str(name).casefold() in text), None)
        if not matched_name:
            continue
        remainder = text.replace(matched_name, '').strip(' .?!"`')
        if not re.fullmatch(r'(?:(?:give|gvie|show|display)(?: me)?(?: the)?(?: data| dataset| table)?(?: about| for| from)?|(?:tell me|what is|overview|summary)(?: about| of)?|describe)', remainder):
            continue
        try:
            require_dataset_access(entry, for_chat=True)
        except HTTPException:
            continue
        matches.append((identifier, entry))
    if len(matches) != 1:
        return None
    identifier, entry = matches[0]
    from api.services.dataset_service import dataset_service
    from api.platform.data_resolution import dataset_frame
    selected = current_selection.get()
    version = selected.context.version if selected and selected.context.dataset_id == identifier else entry.get('currentVersion', 1)
    snapshot = selected.snapshot if selected and selected.context.dataset_id == identifier else dataset_service._snapshot(entry, version)
    frame = dataset_frame(entry, snapshot, version)
    names = list(frame.columns)
    table = ['| ' + ' | '.join(_cell(name) for name in names) + ' |',
             '| ' + ' | '.join('---' for _ in names) + ' |']
    for values in frame.head(5).itertuples(index=False, name=None):
        table.append('| ' + ' | '.join(_cell(value) for value in values) + ' |')
    title = entry.get('displayName') or entry.get('name') or identifier
    return {'reply': f"**{title}** contains **{len(frame):,} rows** and **{len(names)} columns** (version {version}).\n\nFirst five rows:\n\n" + '\n'.join(table),
            'sources': [{'ID': f'{identifier}:v{version}:overview', 'TEXT_CHUNK': f'Overview of {title}',
                         'METADATA': json.dumps({'source': title, 'dataset_id': identifier, 'version': version})}],
            'intent': 'dataset_overview', 'status': 'success', 'model': 'Dataset catalog', 'cosine_score': None,
            'context': {'dataset_id': identifier, 'version': version}}


def catalog_response(message, catalog):
    intent = catalog_intent(message)
    if intent != "catalog":
        return None
    entries = []
    for identifier, entry in catalog.get("datasets", {}).items():
        try:
            require_dataset_access(entry, for_chat=True)
        except HTTPException:
            continue
        entries.append((identifier, entry))
    sections = []
    table = ["| Dataset | Rows | Version |", "| --- | ---: | ---: |"]
    if entries:
        sections.append(f"You have **{len(entries)} accessible dataset{'s' if len(entries) != 1 else ''}** in this workspace:")
    else:
        sections.append("There are no datasets available to your account in this workspace. Upload a dataset or ask an administrator for access.")
    sources = []
    for identifier, entry in entries:
        version = entry.get("currentVersion", 1)
        meta = next((v for v in entry.get("versions", []) if v.get("version") == version), {})
        name = entry.get("displayName") or entry.get("name") or entry.get("tableName") or identifier
        rows = meta.get("rowCount", entry.get("rowCount"))
        row_label = f"{rows:,}" if isinstance(rows, int) else "Not recorded"
        table.append(f"| {_cell(name)} | {row_label} | {_cell(version)} |")
        sources.append({
            "ID": f"{identifier}:v{version}:catalog",
            "TEXT_CHUNK": f"Dataset: {name}. Version: {version}. Rows: {row_label}.",
            "METADATA": json.dumps({"source": name, "dataset_id": identifier, "version": version, "retrieval": "catalog"}),
        })
    if entries:
        sections.append("\n".join(table))
    selection = current_selection.get()
    return {
        "reply": "\n\n".join(sections),
        "sources": sources, "intent": intent, "status": "success",
        "context": selection.context.model_dump() if selection else None,
        "model": "Dataset catalog", "cosine_score": None,
    }
