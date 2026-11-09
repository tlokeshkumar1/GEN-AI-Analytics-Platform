from fastapi import HTTPException

def validate_excel_file(filename: str):
    if not filename:
        raise HTTPException(status_code=400, detail="A filename is required.")
    allowed_extensions = {".xlsx", ".xls", ".csv"}
    ext = "." + filename.split(".")[-1].lower() if "." in filename else ""
    if ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type '{ext}'. Allowed types: {', '.join(allowed_extensions)}"
        )
