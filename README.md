# Phase Lift web app (LDS) - Phase 1 scaffold (UNBUILT, UNTESTED)

Written without a .NET SDK or npm access, so nothing here has been compiled or run. Build it locally and fix what breaks.

## Run
API:    set ConnectionStrings__Lds and Jwt__Key (>= 32 chars), then `cd api && dotnet run`
Client: `cd client && npm install && npm run dev`  (set VITE_API_URL to the API address; add the client origin to Cors:Origins)

## Known gaps (must close before real use)
1. Documents list now applies the legacy group-rights rule (see DocumentsController), but it is UNVERIFIED. Compare results against the desktop client for several real users.
2. Login uses a temporary plaintext comparison (LegacyPasswordVerifier) pending the hash-upgrade decision.
3. Table and column names now come from the updated MS_QDS_Database_Schema.sql (database MSQDS_XCERT). The script's data confirms passwords are stored in plaintext.
4. Saved filters, full-text search, dashboard stats endpoint, and every other module are not started.
5. No tests yet. No rate limiting or lockout on login yet.
