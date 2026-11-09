from pydantic import BaseModel, ConfigDict
from typing import Optional, Any, Dict
from datetime import date

class DynamicRecord(BaseModel):
    """Dynamic, generic record container that accepts any columns without hardcoding."""
    model_config = ConfigDict(extra="allow")

class SalesRecord(BaseModel):
    OrderID: int
    OrderDate: Optional[str] = None
    Year: Optional[int] = None
    Quarter: Optional[str] = None
    MonthNum: Optional[int] = None
    MonthName: Optional[str] = None
    MonthLabel: Optional[str] = None
    Category: Optional[str] = None
    Subcategory: Optional[str] = None
    ProductID: Optional[str] = None
    ProductName: Optional[str] = None
    UnitOfMeasure: Optional[str] = None
    Region: Optional[str] = None
    Country: Optional[str] = None
    IndustryVertical: Optional[str] = None
    CustomerID: Optional[str] = None
    CustomerName: Optional[str] = None
    CustomerSegment: Optional[str] = None
    SalesRegion: Optional[str] = None
    SalesOffice: Optional[str] = None
    SalesRepID: Optional[str] = None
    SalesRepName: Optional[str] = None
    SalesRepRole: Optional[str] = None
    Channel: Optional[str] = None
    OrderType: Optional[str] = None
    OrderStatus: Optional[str] = None
    PaymentTerms: Optional[str] = None
    Quantity: Optional[int] = None
    UnitListPriceUSD: Optional[float] = None
    DiscountPercent: Optional[float] = None
    NetUnitPriceUSD: Optional[float] = None
    NetRevenueUSD: Optional[float] = None
    UnitCostUSD: Optional[float] = None
    TotalCostUSD: Optional[float] = None
    GrossMarginUSD: Optional[float] = None
    GrossMarginPercent: Optional[float] = None
    TransactionCurrency: Optional[str] = None
    FXRateToUSD: Optional[float] = None
    NetRevenueLocalCurrency: Optional[float] = None

class VectorRecord(BaseModel):
    id: str
    text_chunk: str
    embedding: list[float]
    metadata_json: Optional[str] = None
