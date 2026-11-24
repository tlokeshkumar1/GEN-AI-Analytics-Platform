-- Execute only in the isolated My Files schema, under an approved change.
-- The platform SQL console principal must have no privileges on this schema.
-- For an existing installation verify column definitions before reusing the table.
DO BEGIN
    DECLARE table_count INTEGER;
    SELECT COUNT(*) INTO table_count FROM SYS.TABLES
        WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = 'PLATFORM_DOCUMENTS';
    IF :table_count = 0 THEN
        EXECUTE IMMEDIATE 'CREATE COLUMN TABLE "PLATFORM_DOCUMENTS" (
            "NAMESPACE" NVARCHAR(240) NOT NULL,
            "DOCUMENT_ID" NVARCHAR(240) NOT NULL,
            "REVISION" BIGINT NOT NULL,
            "PAYLOAD" NCLOB NOT NULL,
            PRIMARY KEY ("NAMESPACE", "DOCUMENT_ID")
        )';
    END IF;
END;

