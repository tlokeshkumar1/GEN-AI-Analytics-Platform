"""Render calculated answers directly; the model cannot rewrite their values."""
from decimal import Decimal


def markdown_cell(value, numeric=False):
    if value is None:
        return "Not available"
    if numeric and isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        text = format(Decimal(str(value)), ",f")
    else:
        text = str(value)
    return text.replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def format_calculated_result(result, plan, semantic_model=None):
    fields = {field.name: field for field in semantic_model.fields} if semantic_model else {}
    sections = []
    summary = result.summary
    if summary and "value" in summary:
        field = fields.get(summary.get("metric"))
        label = field.semantic_name if field else summary.get("metric", "Value")
        unit = (field.currency or field.unit) if field else None
        value = markdown_cell(summary["value"], numeric=True)
        if unit and summary.get("aggregation") not in ("COUNT", "COUNT_DISTINCT"):
            value = f"{markdown_cell(unit)} {value}"
        sections.append(f"**{markdown_cell(summary.get('aggregation', 'Result'))} of {markdown_cell(label)}: {value}**")
    else:
        sections.append("Calculated result:")
        columns = list(dict.fromkeys(key for row in result.data for key in row))
        dimensions = plan.get("dimensions") or [d.strip() for d in (plan.get("dimension") or "").split(",") if d.strip()]
        if plan.get("time_grouping"):
            dimensions = [*dimensions, "period"]
        table = ["| " + " | ".join(markdown_cell(key) for key in columns) + " |",
                 "| " + " | ".join("---" for _ in columns) + " |"]
        for row in result.data[:100]:
            table.append("| " + " | ".join(markdown_cell(row.get(key), numeric=key not in dimensions) for key in columns) + " |")
        sections.append("\n".join(table))
        if len(result.data) > 100:
            sections.append(f"Showing 100 of {len(result.data):,} result rows. Narrow the question to see a smaller breakdown.")
    if result.warnings:
        sections.append("Notes:\n" + "\n".join(f"- {markdown_cell(warning)}" for warning in result.warnings))
    return "\n\n".join(sections)
