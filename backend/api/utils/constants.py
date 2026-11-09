# Standardized 39 Column Names for SAC Sales Dataset
SALES_COLUMNS = [
    "OrderID",
    "OrderDate",
    "Year",
    "Quarter",
    "MonthNum",
    "MonthName",
    "MonthLabel",
    "Category",
    "Subcategory",
    "ProductID",
    "ProductName",
    "UnitOfMeasure",
    "Region",
    "Country",
    "IndustryVertical",
    "CustomerID",
    "CustomerName",
    "CustomerSegment",
    "SalesRegion",
    "SalesOffice",
    "SalesRepID",
    "SalesRepName",
    "SalesRepRole",
    "Channel",
    "OrderType",
    "OrderStatus",
    "PaymentTerms",
    "Quantity",
    "UnitListPriceUSD",
    "DiscountPercent",
    "NetUnitPriceUSD",
    "NetRevenueUSD",
    "UnitCostUSD",
    "TotalCostUSD",
    "GrossMarginUSD",
    "GrossMarginPercent",
    "TransactionCurrency",
    "FXRateToUSD",
    "NetRevenueLocalCurrency"
]

FINANCIAL_COLUMNS = [
    "UnitListPriceUSD",
    "NetUnitPriceUSD",
    "NetRevenueUSD",
    "UnitCostUSD",
    "TotalCostUSD",
    "GrossMarginUSD",
    "NetRevenueLocalCurrency"
]

PERCENTAGE_COLUMNS = [
    "DiscountPercent",
    "GrossMarginPercent"
]

DIMENSION_COLUMNS = [
    "Region",
    "Country",
    "Category",
    "Subcategory",
    "CustomerSegment",
    "SalesRegion",
    "Channel",
    "OrderType",
    "OrderStatus"
]
