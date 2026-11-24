"""Bounded, application-owned Matplotlib and Seaborn chart templates."""

import base64
import io
import threading

import numpy as np
import pandas as pd
from fastapi import HTTPException

_render_lock = threading.Lock()


def render_frame(frame, kind, plan, title=""):
    if frame.empty:
        raise HTTPException(422, "There are no matching records to chart.")
    if len(frame) > 100000:
        raise HTTPException(422, "Filter the chart to at most 100,000 source records.")
    kinds = {
        "bar",
        "horizontal_bar",
        "line",
        "area",
        "pie",
        "donut",
        "scatter",
        "heatmap",
        "box",
        "violin",
        "histogram",
        "stacked_bar",
    }
    if kind not in kinds:
        raise HTTPException(422, "Unsupported template chart type: " + str(kind))
    dims = plan.get("dimensions") or [
        x.strip() for x in (plan.get("dimension") or "").split(",") if x.strip()
    ]
    if kind == "heatmap" and len(dims) < 2 and "correlation" not in title.lower():
        normalized = title.lower().replace("_", " ")
        requested = [
            c for c in frame.columns if str(c).lower().replace("_", " ") in normalized
        ]
        dims = list(dict.fromkeys(dims + requested))[:2]
    metric = plan.get("metric") or plan.get("measure")
    for field in dims + ([metric] if metric and metric != "*" else []):
        if field not in frame.columns:
            raise HTTPException(422, "Unknown chart field: " + str(field))
    agg = (plan.get("aggregation") or "SUM").upper()
    functions = {
        "SUM": "sum",
        "AVG": "mean",
        "MIN": "min",
        "MAX": "max",
        "COUNT": "count",
        "COUNT_DISTINCT": "nunique",
    }
    if agg not in functions:
        raise HTTPException(422, "Unsupported chart aggregation.")
    if (
        metric != "*"
        and metric
        and agg not in {"COUNT", "COUNT_DISTINCT"}
        and not pd.api.types.is_numeric_dtype(frame[metric])
    ):
        raise HTTPException(
            422, "Choose a numeric metric or use COUNT for categorical data."
        )
    with _render_lock:
        import seaborn as sns
        from matplotlib.figure import Figure
        from matplotlib.backends.backend_agg import FigureCanvasAgg

        figure = Figure(figsize=(10, 6), layout="constrained")
        FigureCanvasAgg(figure)
        axis = figure.subplots()
        try:
            if kind == "heatmap":
                if len(dims) == 2:
                    if any(frame[d].nunique() > 50 for d in dims):
                        raise HTTPException(
                            422,
                            "Filter heatmap dimensions to at most 50 categories each.",
                        )
                    if metric == "*" and agg == "COUNT":
                        matrix = pd.crosstab(frame[dims[0]], frame[dims[1]])
                    elif metric:
                        matrix = (
                            frame.groupby(dims, dropna=False)[metric]
                            .agg(functions[agg])
                            .unstack(fill_value=0)
                        )
                    else:
                        raise HTTPException(
                            422, "Select a heatmap metric and aggregation."
                        )
                elif not dims:
                    numeric = frame.select_dtypes(include="number")
                    if not 2 <= len(numeric.columns) <= 50:
                        raise HTTPException(
                            422, "Correlation heatmaps require 2 to 50 numeric columns."
                        )
                    matrix = numeric.corr()
                else:
                    raise HTTPException(
                        422, "A categorical heatmap needs two dimensions."
                    )
                if matrix.empty or not np.isfinite(matrix.to_numpy(dtype=float)).any():
                    raise HTTPException(422, "No finite heatmap values are available.")
                sns.heatmap(
                    matrix, ax=axis, cmap="Blues", annot=matrix.size <= 100, fmt=".2g"
                )
            elif kind in {"box", "violin", "histogram", "scatter"}:
                if (
                    not metric
                    or metric == "*"
                    or not pd.api.types.is_numeric_dtype(frame[metric])
                ):
                    raise HTTPException(422, "This chart needs a numeric metric.")
                if kind == "histogram":
                    sns.histplot(data=frame, x=metric, bins=30, ax=axis)
                else:
                    if len(dims) != 1 or frame[dims[0]].nunique() > 50:
                        raise HTTPException(
                            422, "Select one dimension with at most 50 values."
                        )
                    if kind == "scatter":
                        sns.scatterplot(data=frame, x=dims[0], y=metric, ax=axis)
                    elif kind == "box":
                        sns.boxplot(data=frame, x=dims[0], y=metric, ax=axis)
                    else:
                        sns.violinplot(data=frame, x=dims[0], y=metric, ax=axis, cut=0)
            else:
                if not dims or not metric or (metric == "*" and agg != "COUNT"):
                    raise HTTPException(
                        422, "Select chart dimensions, metric, and aggregation."
                    )
                grouped = frame.groupby(dims, dropna=False)
                values = (
                    grouped.size()
                    if metric == "*"
                    else grouped[metric].agg(functions[agg])
                )
                if len(values) > 200:
                    raise HTTPException(422, "Filter charts to at most 200 categories.")
                if kind == "stacked_bar":
                    if len(dims) != 2:
                        raise HTTPException(
                            422, "Stacked charts require two dimensions."
                        )
                    values.unstack(fill_value=0).plot.bar(stacked=True, ax=axis)
                else:
                    labels = [str(x)[:100] for x in values.index]
                    nums = values.to_numpy(dtype=float)
                    if not len(nums) or not np.isfinite(nums).all():
                        raise HTTPException(
                            422, "No finite chart values are available."
                        )
                    if kind in {"pie", "donut"}:
                        if (nums < 0).any() or nums.sum() <= 0:
                            raise HTTPException(
                                422,
                                "Pie charts require nonnegative values and a positive total.",
                            )
                        axis.pie(
                            nums,
                            labels=labels,
                            wedgeprops={"width": 0.4} if kind == "donut" else None,
                        )
                    elif kind == "horizontal_bar":
                        axis.barh(labels, nums, color="#2563eb")
                    elif kind in {"line", "area"}:
                        axis.plot(labels, nums, color="#2563eb")
                        if kind == "area":
                            axis.fill_between(range(len(nums)), nums, alpha=0.25)
                    else:
                        axis.bar(labels, nums, color="#2563eb")
            axis.set_title(str(title)[:160], parse_math=False)
            axis.tick_params(axis="x", rotation=30)
            output = io.BytesIO()
            figure.savefig(output, format="png", dpi=120)
            return "data:image/png;base64," + base64.b64encode(
                output.getvalue()
            ).decode("ascii")
        finally:
            figure.clear()
