-- Run ONCE in SSMS as sa (or any sysadmin). Replace the database name and the password placeholder first.
-- The API then connects as pl_app, never as sa.
USE [master];
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'pl_app')
    CREATE LOGIN [pl_app] WITH PASSWORD = N'<CHOOSE-A-STRONG-PASSWORD>', CHECK_POLICY = ON;
GO
USE [<YOUR-LDS-DATABASE>];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'pl_app')
    CREATE USER [pl_app] FOR LOGIN [pl_app];
-- read access used by the existing screens
ALTER ROLE db_datareader ADD MEMBER [pl_app];
-- write access for upload, change version, edit/check-in
GRANT INSERT, UPDATE ON dbo.Documents          TO [pl_app];
GRANT INSERT         ON dbo.DocGrp             TO [pl_app];
GRANT INSERT         ON dbo.Mods               TO [pl_app];
GRANT INSERT         ON dbo.DocumentsArchives  TO [pl_app];
GRANT INSERT, DELETE ON dbo.DocCheckout        TO [pl_app];
GO
-- filters (Options > Filter management), document types (Options > Type management)
GRANT INSERT, UPDATE, DELETE ON dbo.Filter      TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.FilterValue TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.DocTypes    TO [pl_app];
GRANT INSERT, UPDATE         ON dbo.Config      TO [pl_app];   -- only for "Set as default" type
GO
-- user management (Options > User management)
GRANT INSERT, UPDATE         ON dbo.Accounts      TO [pl_app];
GRANT INSERT, UPDATE         ON dbo.EmailContact  TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.AccGroups     TO [pl_app];
GRANT INSERT, DELETE         ON dbo.AccountAccGrp TO [pl_app];
GRANT INSERT, DELETE         ON dbo.AccountsRights TO [pl_app];
GRANT DELETE                 ON dbo.MailListEmailContact TO [pl_app];   -- removed from mailing lists when a user is deleted
GO
-- e-mail distribution (Options > E-mail distribution, Distribution tab of a document)
GRANT INSERT, UPDATE, DELETE ON dbo.MailList             TO [pl_app];
GRANT INSERT, DELETE         ON dbo.MailListEmailContact TO [pl_app];
GRANT DELETE                 ON dbo.EmailContact         TO [pl_app];   -- INSERT/UPDATE were granted for User management
GRANT INSERT, DELETE         ON dbo.DocMailList          TO [pl_app];
GO
-- groups right-click menu of the document tree (new group, rename, delete, order, owner, do not view in web, publish as original)
GRANT INSERT, UPDATE, DELETE ON dbo.Groups          TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.GroupProperties TO [pl_app];   -- "Publish as original"
GRANT UPDATE                 ON dbo.DocGrp          TO [pl_app];   -- order of the documents inside a group
GO
-- document right-click menu: Copy, Assignment, Rename, Delete (Documents INSERT/UPDATE, DocGrp INSERT, Mods, DocumentsArchives, DocMailList are granted above)
GRANT DELETE ON dbo.Documents  TO [pl_app];
GRANT DELETE ON dbo.DocGrp     TO [pl_app];   -- remove an assignment / links of a deleted document
GRANT DELETE ON dbo.DocCollect TO [pl_app];
GRANT DELETE ON dbo.DocCatch   TO [pl_app];
GRANT DELETE ON dbo.Links      TO [pl_app];
GO
-- release / publish e-mails: the window remembers CC, Subject, Header, Footer per document (table DocEmail, like the legacy "Add Email Address" window).
-- Reading ApplicationEmail, Config (smtpServer, smtpFrom, pop3login, pop3password, SendDefault*), Replacements, MailList, EmailContact comes from db_datareader.
GRANT INSERT, DELETE ON dbo.DocEmail TO [pl_app];
GO
-- Options > Standard management, Dependency, Frozen / Defrozen, expiry (Groups, DocGrp, DocCollect, DocEmail, Mods, DocumentsArchives are granted above)
GRANT INSERT, UPDATE, DELETE ON dbo.ADS_Standard       TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.ADS_StdChapter     TO [pl_app];
GRANT INSERT, UPDATE, DELETE ON dbo.ADS_StdAssociation TO [pl_app];
GRANT INSERT, DELETE         ON dbo.DocStandard        TO [pl_app];   -- mandatory standards
GRANT INSERT, UPDATE, DELETE ON dbo.Collect            TO [pl_app];   -- dependencies
GRANT INSERT                 ON dbo.DocCollect         TO [pl_app];
GRANT INSERT                 ON dbo.DocGrp             TO [pl_app];
GO
