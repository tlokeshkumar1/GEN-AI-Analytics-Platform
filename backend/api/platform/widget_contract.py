"""Canonical widget identity and explicit natural-language output constraints."""
import re


def widget_signature(item):
    plan = dict(item.get('query_plan') or {})
    for key in ('metric', 'dimension', 'aggregation', 'filters', 'date_range'):
        if key not in plan and key in item:
            plan[key] = item[key]
    from api.platform.agent_chart_recommender import recommendation_signature
    kind = item.get('kind', 'bar')
    return (kind, recommendation_signature({'kind': kind, 'query_plan': plan}))


def requested_counts(prompt):
    text = str(prompt).casefold()
    words = {'a': 1, 'an': 1, 'single': 1, 'one': 1, 'two': 2, 'three': 3,
             'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10}
    result = {}
    for key, noun in [('kpis', r'kpis?|metrics?'), ('charts', r'charts?|visualizations?|plots?')]:
        matches = re.findall(r'\b(\d+|' + '|'.join(words) + r')\s+(?:(?:python|bar|line|pie|donut|scatter)\s+)?(?:' + noun + r')\b', text)
        if matches:
            result[key] = sum(int(v) if v.isdigit() else words[v] for v in matches)
    if 'kpis' in result and not re.search(r'\b(chart|plot|visualization)s?\b', text):
        result['charts'] = 0
    if 'charts' in result and not re.search(r'\b(kpi|metric)s?\b', text):
        result['kpis'] = 0
    return result
