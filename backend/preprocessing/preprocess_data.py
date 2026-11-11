import argparse
from pathlib import Path
import pandas as pd


BASE_DIR = Path(__file__).resolve().parent


def _resolve_default_input() -> Path:
    input_dir = BASE_DIR / "input"
    if input_dir.exists():
        for ext in ("*.xlsx", "*.xls", "*.csv"):
            matches = sorted(p for p in input_dir.glob(ext) if not p.name.startswith("~$"))
            if matches:
                return matches[0]
    return input_dir / "dataset.xlsx"


DEFAULT_INPUT_PATH = _resolve_default_input()
DEFAULT_OUTPUT_PATH = BASE_DIR / "output" / f"{DEFAULT_INPUT_PATH.stem}_Preprocessed.xlsx"


def load_dataset(input_path):
    """Load any CSV or Excel dataset."""
    path = Path(input_path)
    print(f"\nLoading dataset from:\n{path}")
    df = pd.read_csv(path) if path.suffix.lower() == ".csv" else pd.read_excel(path)
    print(f"\nDataset loaded successfully.")
    print(f"Rows    : {len(df)}")
    print(f"Columns : {len(df.columns)}")
    return df


# ============================================================
# 2. CHECK NULL VALUES
# ============================================================

def check_null_values(df):
    """
    Check for null/missing values in every column.

    This function only reports null values.
    It does not automatically fill or modify them.
    """

    print("\n" + "=" * 60)
    print("NULL VALUE CHECK")
    print("=" * 60)

    null_counts = df.isnull().sum()

    # Keep only columns that contain null values
    columns_with_nulls = null_counts[
        null_counts > 0
    ]

    if columns_with_nulls.empty:
        print("No null values found.")
    else:
        print("Null values found:")
        print(columns_with_nulls)

    return df


# ============================================================
# 3. CHECK AND REMOVE DUPLICATES
# ============================================================

def remove_duplicates(df, policy="keep"):
    """Repeated transactions remain unless an explicit drop policy is selected."""
    if policy not in {"keep", "drop", "reject"}:
        raise ValueError("Duplicate policy must be keep, drop, or reject")
    if policy == "reject" and df.duplicated().any():
        raise ValueError("Duplicate rows require review")
    return df.drop_duplicates() if policy == "drop" else df.copy()


def convert_financial_columns(df):
    """Parse currency-formatted string/object columns dynamically while preserving precision."""
    from decimal import Decimal, InvalidOperation

    def parse(value):
        if pd.isna(value) or str(value).strip() == "":
            return None
        try:
            number = Decimal(str(value).replace("$", "").replace(",", "").strip())
        except InvalidOperation as exc:
            raise ValueError("Invalid financial value; review source formatting") from exc
        if not number.is_finite():
            raise ValueError("Financial values must be finite")
        return number

    df = df.copy()
    currency_hints = ("price", "revenue", "cost", "margin", "amount", "salary", "budget", "spend", "usd", "eur", "inr")
    for column in df.columns:
        low = str(column).lower()
        if any(h in low for h in currency_hints) and not any(p in low for p in ("percent", "pct", "ratio")):
            if df[column].dtype == object or str(df[column].dtype) == "string":
                df[column] = df[column].map(parse)
    return df


def convert_percentage_columns(df):
    """Normalize percentage columns detected dynamically from column names or '%' values."""
    df = df.copy()
    for column in df.columns:
        low = str(column).lower()
        is_pct_col = "percent" in low or low.endswith("_pct") or low == "pct"
        has_percent_symbol = df[column].astype(str).str.contains("%", regex=False).any()
        if is_pct_col or (df[column].dtype == object and has_percent_symbol):
            df[column] = df[column].astype(str).str.replace("%", "", regex=False).str.strip()
            df[column] = pd.to_numeric(df[column], errors="coerce")
            if not has_percent_symbol:
                # Fractional ratios (0.0963 -> 9.63)
                non_null = df[column].dropna()
                if not non_null.empty and (non_null.abs() <= 1.0).all():
                    df[column] = df[column] * 100
            df[column] = df[column].round(2)
    return df


def format_date_columns(df):
    """Format detected date columns cleanly as YYYY-MM-DD."""
    df = df.copy()
    for column in df.columns:
        low = str(column).lower()
        if any(tok in low for tok in ("date", "timestamp", "_dt")) and not low.endswith("update"):
            parsed = pd.to_datetime(df[column], errors="coerce")
            if parsed.notna().any():
                df[column] = parsed.dt.strftime("%Y-%m-%d")
    return df


format_order_date = format_date_columns


# ============================================================
# 7. SAVE CLEANED DATASET
# ============================================================

def save_dataset(df, output_path):
    """
    Save the cleaned dataset to an Excel file.
    """

    # Create output directory if it doesn't exist.
    output_path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    # Save dataset.
    df.to_excel(
        output_path,
        index=False
    )

    print("\n" + "=" * 60)
    print("OUTPUT")
    print("=" * 60)

    print(
        f"Cleaned dataset saved successfully at:\n"
        f"{output_path}"
    )


# ============================================================
# 8. MAIN PREPROCESSING PIPELINE
# ============================================================

def preprocess_data(
    input_path=DEFAULT_INPUT_PATH,
    output_path=DEFAULT_OUTPUT_PATH
):
    """Execute dynamic dataset preprocessing for any uploaded workbook or CSV."""
    df = load_dataset(input_path)
    df = check_null_values(df)
    df = remove_duplicates(df)
    df = convert_financial_columns(df)
    df = convert_percentage_columns(df)
    df = format_date_columns(df)
    save_dataset(df, Path(output_path))

    print("\n" + "=" * 60)
    print("PREPROCESSING COMPLETED")
    print("=" * 60)
    print(f"Final rows    : {len(df)}")
    print(f"Final columns : {len(df.columns)}")
    return df


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Preprocess tabular CSV/Excel dataset dynamically.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    args = parser.parse_args()
    out = args.output if args.output != DEFAULT_OUTPUT_PATH or args.input == DEFAULT_INPUT_PATH else (BASE_DIR / "output" / f"{args.input.stem}_Preprocessed.xlsx")
    preprocess_data(args.input, out)