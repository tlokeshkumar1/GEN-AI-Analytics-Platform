-- Apply explicitly to the configured application schema with a migration user.
-- No application startup code creates or alters production tables.
CREATE COLUMN TABLE PLATFORM_METADATA (
    NAMESPACE NVARCHAR(240) NOT NULL,
    DOCUMENT_ID NVARCHAR(240) NOT NULL,
    REVISION BIGINT NOT NULL,
    PAYLOAD NCLOB NOT NULL,
    PRIMARY KEY (NAMESPACE, DOCUMENT_ID)
);

CREATE SYNONYM "Platform Metadata" FOR PLATFORM_METADATA;
CREATE SYNONYM PLATFORM_DOCUMENTS FOR PLATFORM_METADATA;
