export interface SchemaColumn {
  name: string;
  dataType: string;
  type: 'Dimension' | 'Measure';
  category?: 'Dimension' | 'Measure' | 'Identifier' | 'Time';
  description: string;
}

export const SCHEMA_COLUMNS: SchemaColumn[] = [
  // Identifiers
  { name: 'InvoiceID', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Identifier', description: 'Unique SAP billing document identifier' },
  { name: 'OrderID', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Identifier', description: 'Unique SAP sales order identifier' },
  { name: 'CustomerID', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Identifier', description: 'Unique customer account master ID' },
  { name: 'ProductID', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Identifier', description: 'Unique material master ID' },
  { name: 'ProductSKU', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Identifier', description: 'Material SKU stock-keeping code' },
  { name: 'SalesRepID', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Identifier', description: 'Employee master personnel ID' },

  // Temporal
  { name: 'BillingDate', dataType: 'DATE', type: 'Dimension', category: 'Time', description: 'Posting date of customer invoice' },
  { name: 'OrderDate', dataType: 'DATE', type: 'Dimension', category: 'Time', description: 'Creation date of sales order' },
  { name: 'Year', dataType: 'INTEGER', type: 'Dimension', category: 'Time', description: 'Fiscal calendar year' },
  { name: 'Quarter', dataType: 'NVARCHAR(8)', type: 'Dimension', category: 'Time', description: 'Fiscal calendar quarter (Q1-Q4)' },
  { name: 'MonthNum', dataType: 'INTEGER', type: 'Dimension', category: 'Time', description: 'Month index number (1-12)' },
  { name: 'MonthName', dataType: 'NVARCHAR(16)', type: 'Dimension', category: 'Time', description: 'Full month name string' },
  { name: 'MonthLabel', dataType: 'NVARCHAR(16)', type: 'Dimension', category: 'Time', description: 'Short month label (e.g. Jan 2024)' },

  // Customer & Market Dimensions
  { name: 'CustomerName', dataType: 'NVARCHAR(128)', type: 'Dimension', category: 'Dimension', description: 'Commercial customer account name' },
  { name: 'CustomerCategory', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Account tier (Enterprise, Mid-Market, SMB)' },
  { name: 'CustomerSegment', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Strategic account classification' },
  { name: 'IndustryVertical', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Industry vertical sector classification' },
  
  // Organization & Geography
  { name: 'SalesOrg', dataType: 'NVARCHAR(16)', type: 'Dimension', category: 'Dimension', description: 'SAP Sales Organization code' },
  { name: 'SalesOffice', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Regional branch sales office' },
  { name: 'SalesRegion', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Commercial sales territory boundary' },
  { name: 'Region', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Macro geographic sales region' },
  { name: 'Country', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Country of customer billing address' },
  
  // Product Hierarchy
  { name: 'ProductName', dataType: 'NVARCHAR(128)', type: 'Dimension', category: 'Dimension', description: 'Commercial material product name' },
  { name: 'Category', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Primary product category classification' },
  { name: 'Subcategory', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Secondary product subcategory' },
  
  // Sales Execution & Operations
  { name: 'Channel', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Go-to-market distribution channel' },
  { name: 'SalesRepName', dataType: 'NVARCHAR(128)', type: 'Dimension', category: 'Dimension', description: 'Account executive or representative name' },
  { name: 'SalesRepRole', dataType: 'NVARCHAR(64)', type: 'Dimension', category: 'Dimension', description: 'Sales rep designation or role' },
  { name: 'OrderType', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Dimension', description: 'SAP document type (Standard, Return, Service)' },
  { name: 'OrderStatus', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Dimension', description: 'Fulfillment order state (Completed, Pending)' },
  { name: 'PaymentTerms', dataType: 'NVARCHAR(32)', type: 'Dimension', category: 'Dimension', description: 'Commercial payment terms (Net 30, Net 60)' },
  { name: 'TransactionCurrency', dataType: 'NVARCHAR(8)', type: 'Dimension', category: 'Dimension', description: 'Invoice currency ISO code' },
  { name: 'UnitOfMeasure', dataType: 'NVARCHAR(16)', type: 'Dimension', category: 'Dimension', description: 'Sales quantity unit measure' },

  // Measures (Metrics)
  { name: 'Quantity', dataType: 'INTEGER', type: 'Measure', category: 'Measure', description: 'Total units ordered / billed' },
  { name: 'NetRevenueUSD', dataType: 'DECIMAL(15,2)', type: 'Measure', category: 'Measure', description: 'Net sales revenue in USD' },
  { name: 'TotalCostUSD', dataType: 'DECIMAL(15,2)', type: 'Measure', category: 'Measure', description: 'Total cost of goods sold in USD' },
  { name: 'GrossMarginUSD', dataType: 'DECIMAL(15,2)', type: 'Measure', category: 'Measure', description: 'Gross profit margin contribution in USD' },
  { name: 'GrossMarginPercent', dataType: 'DECIMAL(5,2)', type: 'Measure', category: 'Measure', description: 'Gross profit margin percentage (%' },
  { name: 'UnitListPriceUSD', dataType: 'DECIMAL(15,2)', type: 'Measure', category: 'Measure', description: 'Catalog list unit price in USD' },
  { name: 'DiscountPercent', dataType: 'DECIMAL(5,2)', type: 'Measure', category: 'Measure', description: 'Applied discount percentage (%)' },
];

export interface SampleRecord {
  orderNumber: string;
  salesDate: string;
  region: string;
  category: string;
  netRevenue: string;
  grossMarginPercent: string;
  InvoiceID?: string;
  BillingDate?: string;
  CustomerName?: string;
  ProductSKU?: string;
  NetRevenueUSD?: number;
  GrossMarginUSD?: number;
}

export const SAMPLE_RECORDS: SampleRecord[] = [
  {
    orderNumber: 'SO-106760',
    salesDate: '2024-09-14',
    region: 'EMEA (Germany)',
    category: 'Enterprise Software',
    netRevenue: '$480,000.00',
    grossMarginPercent: '70.00%',
    InvoiceID: 'INV-2024-8849',
    BillingDate: '2024-09-14',
    CustomerName: 'Siemens AG Energy',
    ProductSKU: 'SKU-HANA-500',
    NetRevenueUSD: 480000.00,
    GrossMarginUSD: 336000.00,
  },
  {
    orderNumber: 'SO-106761',
    salesDate: '2024-09-15',
    region: 'North America (US)',
    category: 'AI & Machine Learning',
    netRevenue: '$315,000.00',
    grossMarginPercent: '70.00%',
    InvoiceID: 'INV-2024-8850',
    BillingDate: '2024-09-15',
    CustomerName: 'Bosch Global Logistics',
    ProductSKU: 'SKU-AI-CORE',
    NetRevenueUSD: 315000.00,
    GrossMarginUSD: 220500.00,
  },
  {
    orderNumber: 'SO-106762',
    salesDate: '2024-09-16',
    region: 'APAC (Japan)',
    category: 'Cloud Storage',
    netRevenue: '$620,000.00',
    grossMarginPercent: '68.50%',
    InvoiceID: 'INV-2024-8851',
    BillingDate: '2024-09-16',
    CustomerName: 'Toyota Motor Systems',
    ProductSKU: 'SKU-CLOUD-900',
    NetRevenueUSD: 620000.00,
    GrossMarginUSD: 424700.00,
  }
];
