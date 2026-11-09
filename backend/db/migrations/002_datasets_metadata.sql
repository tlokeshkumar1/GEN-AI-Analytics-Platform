-- Migration: 002_datasets_metadata.sql
-- Dedicated metadata table for datasets, file versions, schema revisions, and ingestion provenance.
-- Separated from PLATFORM_METADATA (which handles execution dashboard data, credentials, and connections).

CREATE COLUMN TABLE DATASETS_METADATA (
    WORKSPACE_ID     NVARCHAR(100) NOT NULL DEFAULT 'default',
    DATASET_ID       NVARCHAR(100) NOT NULL,
    NAME             NVARCHAR(255) NOT NULL,
    FOLDER           NVARCHAR(255),
    CURRENT_VERSION  INTEGER DEFAULT 1,
    IS_ACTIVE        BOOLEAN DEFAULT FALSE,
    OWNER_ID         NVARCHAR(100),
    REVISION         BIGINT DEFAULT 1,
    VERSIONS_JSON    NCLOB,
    METADATA_JSON    NCLOB,
    UPDATED_AT       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (WORKSPACE_ID, DATASET_ID)
);

