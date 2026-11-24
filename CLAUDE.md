# Phase Lift: MS LDS legacy WinForms/WCF -> Web

## Goal
Face-lift migration of MS LDS (Lean Documentation System) only. Do NOT migrate ADS, MDS, BDS, D8S, CDS.

## Target stack
- Backend: ASP.NET Core 8 Web API in code/web-app/api. Reuse legacy-src logic (MS QDS Common, MSQDS_DAL) by retargeting copies to netstandard2.0/net8.0.
- Frontend: React + TypeScript (Vite) in code/web-app/client, admin template with dashboard charts, TanStack Query, React Router.
- Database: existing SQL Server schema stays AS IS. No schema changes without explicit approval.
- Auth: JWT replacing custom sessionId; keep existing Accounts/Rights tables and password hashing for compatibility.

## Rules
- legacy-src/ is read-only reference. Never edit it.
- Never commit secrets. Connection strings via env vars/user-secrets. Legacy App.config contains plaintext sa passwords: do not copy them.
- Map each WCF operation in IMSLDS_Service to a REST endpoint (see docs/inventory.md). Keep DTO field names compatible.
- Large file upload/download must stream.
- Port background work (cycles, cleaner, email, Lucene indexing) to hosted services.
- Each migrated module needs tests and a line in the status table below.

## Status
| Module | API | UI | Tests |
|---|---|---|---|
| Auth/session | todo | todo | todo |
| Documents | todo | todo | todo |
| Versioning (V1/V2/V3, see legacy-src/Document_Versioning_MultiLanguage_Governance.md) | todo | todo | todo |
| Workflow | todo | todo | todo |
| Users/Groups/Rights | todo | todo | todo |
| Doc types / Standards / Links / Catchwords | todo | todo | todo |
| Distribution/Email | todo | todo | todo |
| Dashboard/Reports | todo | todo | todo |
