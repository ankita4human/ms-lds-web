-- Speeds up the document list (open a folder, paging, sorting). Safe to run more than once. Run as sa / db_owner on the LDS database.
-- Only adds indexes; no data or existing index is changed. Takes a few seconds on a normal archive.
SET NOCOUNT ON;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PL_DocGrp_Group' AND object_id = OBJECT_ID('DocGrp'))
    CREATE INDEX IX_PL_DocGrp_Group ON DocGrp (IdGroup) INCLUDE (IdDoc);       -- "documents of this folder"

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PL_DocGrp_Doc' AND object_id = OBJECT_ID('DocGrp'))
    CREATE INDEX IX_PL_DocGrp_Doc ON DocGrp (IdDoc) INCLUDE (IdGroup);         -- "folders of this document" (visibility check)

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PL_Documents_LangMod' AND object_id = OBJECT_ID('Documents'))
    CREATE INDEX IX_PL_Documents_LangMod ON Documents (Lang, DateMod DESC) INCLUDE (IDDoc);   -- default sort: newest first

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PL_Mods_Doc' AND object_id = OBJECT_ID('Mods'))
    CREATE INDEX IX_PL_Mods_Doc ON Mods (IdDoc, Lang) INCLUDE (ModDate);       -- history tab

UPDATE STATISTICS DocGrp; UPDATE STATISTICS Documents;
PRINT 'Done.';
