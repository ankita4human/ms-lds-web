using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class AppTagBody { public string? Lang { get; set; } public string? Description { get; set; } public string? Replacement { get; set; } }
public class TagRow { public int IdRep { get; set; } public string? NameFind { get; set; } public string? NameDesc { get; set; } public string? Ersetzung { get; set; } public int IdApp { get; set; } }
public class AppTagHistRow { public int SNo { get; set; } public int IdTag { get; set; } public string? NameFind { get; set; } public string? Substitution { get; set; } public DateTime? DateCre { get; set; } public string? CreBy { get; set; } public DateTime? DateMod { get; set; } public string? ModBy { get; set; } public bool? Status { get; set; } }
public class DeletedDocRow { public int IDDoc { get; set; } public string? Lang { get; set; } public string? DocName { get; set; } public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; } public int Status { get; set; } public string? TypeName { get; set; } public DateTime? DateDel { get; set; } public string? DelBy { get; set; } public int Total { get; set; } }
public class LinkCheckRow { public int IDDoc { get; set; } public string? DocName { get; set; } public string? Link { get; set; } public int TargetId { get; set; } public string? TargetName { get; set; } public int? TargetStatus { get; set; } public bool? TargetHidden { get; set; } public bool TargetMissing { get; set; } public bool Archived { get; set; } }
public class WebLogRow { public int IDDoc { get; set; } public string? DocName { get; set; } public int Hits { get; set; } public DateTime? Last { get; set; } public int Total { get; set; } }
public class WebLogDeleteBody { public DateTime? From { get; set; } public DateTime? To { get; set; } }

/// Options > Tags (manual p. 91-93) and Options > Program options > Admin tab (manual p. 91-92; legacy "MS LDS-Program-options" window).
///   Tags            Replacements(Lang, NameFind, NameDesc, Ersetzung, IdRep, IdSort, IdApp, IdOp): IdApp 1 + IdOp 0 = document level,
///                   IdApp 0 + IdOp 0 = application level ($$name$$ = value), IdApp 2..n (installed products) = other application tags.
///   History         ApplicationLevelTags_History: current row Status 1; on change/delete the old row gets Status 0 and DateMod, a changed tag adds a new Status 1 row.
///   Deleted docs    DocumentsArchives rows with DateDel (legacy getDeleteDocuments), only when no live document exists any more.
///   Captured links  legacy getBrokenLinks: internal (document missing / not published / expired) and network (\\path missing) links.
///   Web history     WebLog (legacy getWebLogDetails / deleteWebLog).
/// Everything under admin/ needs the Admin right (1), as the legacy server checks rightAdmin.
[ApiController, Route("api/lds"), Authorize]
public class AdminOptionsController(IConfiguration cfg) : ControllerBase
{
    const int StatusPublished = 3, StatusExpired = 6, MaxDesc = 21, MaxRepl = 50;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static IActionResult Denied(SqlException e) => Err(403, "The database login may not change this (see sql/grant-pl_app.sql: Replacements, ApplicationLevelTags_History, WebLog). " + e.Message);
    async Task<bool> IsAdmin(SqlConnection con) => Access.IsAdmin(await Access.Rights(con, Acc));
    static IActionResult NotAdmin() => Err(403, "You need the Administrator right.");

    // ═════════════════════════ Options > Tags (every user) ═════════════════════════
    [HttpGet("tags")]
    public async Task<IActionResult> Tags([FromQuery] string lang = "EN", [FromQuery] string kind = "doc", [FromQuery] int app = 0)
    {
        lang = L(lang);
        await using var con = Con();
        var others = (await con.QueryAsync<ProductRow>(@"SELECT a.idApplication AS Id, a.Abbreviation AS Abbr
            FROM Applications a WHERE a.idApplication > 1 AND a.IsInstalled = 1
              AND EXISTS (SELECT 1 FROM Replacements r WHERE r.IdApp = a.idApplication AND ISNULL(r.IdOp, 0) = 0 AND r.Lang = @lang)
            ORDER BY a.idApplication", new { lang })).ToList();
        string where = kind switch
        {
            "app" => "r.IdApp = 0",
            "other" => app > 0 ? "r.IdApp = @app" : "r.IdApp IN (SELECT idApplication FROM Applications WHERE idApplication > 1 AND IsInstalled = 1)",
            _ => "r.IdApp = 1"
        };
        var rows = await con.QueryAsync<TagRow>($@"SELECT r.IdRep, r.NameFind, r.NameDesc, r.Ersetzung, r.IdApp FROM Replacements r
            WHERE r.Lang = @lang AND ISNULL(r.IdOp, 0) = 0 AND {where} ORDER BY r.IdApp, r.IdSort, r.IdRep", new { lang, app });
        return Ok(new
        {
            kind, lang, otherEnabled = others.Count > 0,
            products = others.Select(o => new { id = o.Id, name = o.Abbr }),
            items = rows.Select(r => new { id = r.IdRep, name = r.NameFind, description = r.NameDesc, value = kind == "app" ? r.Ersetzung : null, app = r.IdApp })
        });
    }
    class ProductRow { public int Id { get; set; } public string? Abbr { get; set; } }

    // ═════════════════════════ Application level tags ═════════════════════════
    [HttpGet("admin/app-tags")]
    public async Task<IActionResult> AppTags([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = await con.QueryAsync<TagRow>("SELECT IdRep, NameFind, NameDesc, Ersetzung, IdApp FROM Replacements WHERE Lang = @lang AND IdApp = 0 AND ISNULL(IdOp, 0) = 0 ORDER BY IdSort, IdRep", new { lang });
        return Ok(new { lang, maxDescription = MaxDesc, maxReplacement = MaxRepl, items = rows.Select(r => new { id = r.IdRep, tag = r.NameFind, description = Inner(r.NameFind), replacement = r.Ersetzung }) });
    }
    static string Inner(string? t) => (t ?? "").Trim().Trim('$');

    static string? Check(AppTagBody b, out string desc, out string repl)
    {
        desc = (b.Description ?? "").Trim().Trim('$').Trim(); repl = (b.Replacement ?? "").Trim();
        if (desc.Length == 0) return "Enter the tag description.";
        if (desc.Length > MaxDesc) return $"The tag description may have {MaxDesc} characters at most.";
        if (desc.Contains('$')) return "The tag description must not contain '$'.";
        if (repl.Length == 0) return "Enter the replacement value.";
        if (repl.Length > MaxRepl) return $"The replacement may have {MaxRepl} characters at most.";
        return null;
    }

    [HttpPost("admin/app-tags")]
    public async Task<IActionResult> AddAppTag([FromBody] AppTagBody b)
    {
        var lang = L(b.Lang);
        var bad = Check(b, out var desc, out var repl); if (bad != null) return Err(400, bad);
        var name = $"$${desc}$$";
        await using var con = Con(); await con.OpenAsync();
        if (!await IsAdmin(con)) return NotAdmin();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Replacements WITH (UPDLOCK, HOLDLOCK) WHERE Lang = @lang AND IdApp = 0 AND NameFind = @name", new { lang, name }, tx) > 0)
            { await tx.RollbackAsync(); return Err(409, "A tag with this description already exists."); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdRep), 0) + 1 FROM Replacements WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            var sort = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdSort), 0) + 1 FROM Replacements WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            await con.ExecuteAsync(@"INSERT INTO Replacements (Lang, NameFind, Tabelle, ColName, Quelle, IDQuelle, Ersetzung, IdRep, NameDesc, IdSort, IdApp, IdOp)
                VALUES (@lang, @name, '', '', '', '', @repl, @id, @desc, @sort, 0, 0)", new { lang, name, repl, id, desc, sort }, tx);
            await con.ExecuteAsync(@"INSERT INTO ApplicationLevelTags_History (ID_Tag, NameFind, Substitution, Lang, DateCre, ID_Cre_By, DateMod, ID_Mod_By, Status)
                VALUES (@id, @name, @repl, @lang, GETDATE(), @acc, NULL, @acc, 1)", new { id, name, repl, lang, acc = Acc }, tx);
            await tx.CommitAsync();
            return Ok(new { id, tag = name });
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return Denied(e); }
    }

    [HttpPut("admin/app-tags/{id:int}")]
    public async Task<IActionResult> EditAppTag(int id, [FromBody] AppTagBody b)
    {
        var lang = L(b.Lang);
        var bad = Check(b, out var desc, out var repl); if (bad != null) return Err(400, bad);
        var name = $"$${desc}$$";
        await using var con = Con(); await con.OpenAsync();
        if (!await IsAdmin(con)) return NotAdmin();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var cur = await con.QueryFirstOrDefaultAsync<TagRow>("SELECT IdRep, NameFind, NameDesc, Ersetzung, IdApp FROM Replacements WITH (UPDLOCK, HOLDLOCK) WHERE IdRep = @id AND Lang = @lang AND IdApp = 0", new { id, lang }, tx);
            if (cur == null) { await tx.RollbackAsync(); return Err(404, "The tag does not exist."); }
            if (cur.NameFind == name && cur.Ersetzung == repl) { await tx.RollbackAsync(); return Ok(new { id, changed = false }); }
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Replacements WHERE Lang = @lang AND IdApp = 0 AND NameFind = @name AND IdRep <> @id", new { lang, name, id }, tx) > 0)
            { await tx.RollbackAsync(); return Err(409, "A tag with this description already exists."); }
            await con.ExecuteAsync("UPDATE Replacements SET NameFind = @name, NameDesc = @desc, Ersetzung = @repl WHERE IdRep = @id AND Lang = @lang AND IdApp = 0", new { name, desc, repl, id, lang }, tx);
            await con.ExecuteAsync("UPDATE ApplicationLevelTags_History SET Status = 0, DateMod = GETDATE(), ID_Mod_By = @acc WHERE ID_Tag = @id AND Lang = @lang AND Status = 1", new { acc = Acc, id, lang }, tx);
            await con.ExecuteAsync(@"INSERT INTO ApplicationLevelTags_History (ID_Tag, NameFind, Substitution, Lang, DateCre, ID_Cre_By, DateMod, ID_Mod_By, Status)
                VALUES (@id, @name, @repl, @lang, GETDATE(), @acc, NULL, @acc, 1)", new { id, name, repl, lang, acc = Acc }, tx);
            await tx.CommitAsync();
            return Ok(new { id, changed = true });
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return Denied(e); }
    }

    [HttpDelete("admin/app-tags/{id:int}")]
    public async Task<IActionResult> DeleteAppTag(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await IsAdmin(con)) return NotAdmin();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var n = await con.ExecuteAsync("DELETE FROM Replacements WHERE IdRep = @id AND Lang = @lang AND IdApp = 0", new { id, lang }, tx);
            if (n == 0) { await tx.RollbackAsync(); return Err(404, "The tag does not exist."); }
            await con.ExecuteAsync("UPDATE ApplicationLevelTags_History SET Status = 0, DateMod = GETDATE(), ID_Mod_By = @acc WHERE ID_Tag = @id AND Lang = @lang AND Status = 1", new { acc = Acc, id, lang }, tx);
            await tx.CommitAsync();
            return Ok(new { removed = n });
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return Denied(e); }
    }

    [HttpGet("admin/app-tags/history")]
    public async Task<IActionResult> AppTagHistory([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = await con.QueryAsync<AppTagHistRow>(@"SELECT h.S_No AS SNo, h.ID_Tag AS IdTag, h.NameFind, h.Substitution, h.DateCre, c.AccShort AS CreBy, h.DateMod, m.AccShort AS ModBy, h.Status
            FROM ApplicationLevelTags_History h LEFT JOIN Accounts c ON c.IdAcc = h.ID_Cre_By LEFT JOIN Accounts m ON m.IdAcc = h.ID_Mod_By
            WHERE h.Lang = @lang ORDER BY h.S_No DESC", new { lang });
        return Ok(rows.Select(r => new { r.SNo, tag = r.IdTag, name = r.NameFind, replacement = r.Substitution, created = r.DateCre, createdBy = r.CreBy, modified = r.DateMod, modifiedBy = r.ModBy, current = r.Status == true }));
    }

    // ═════════════════════════ View deleted documents ═════════════════════════
    [HttpGet("admin/deleted-docs")]
    public async Task<IActionResult> Deleted([FromQuery] string lang = "EN", [FromQuery] string? q = null, [FromQuery] int page = 1)
    {
        lang = L(lang); page = Math.Max(1, page); const int size = 100;
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = (await con.QueryAsync<DeletedDocRow>(@"
            WITH x AS (SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.IDDoc, a.Lang ORDER BY a.DateDel DESC, a.V1 DESC, a.V2 DESC, a.V3 DESC) AS rn
                       FROM DocumentsArchives a
                       WHERE a.Lang = @lang AND a.DateDel IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM Documents d WHERE d.IDDoc = a.IDDoc AND d.Lang = a.Lang)
                         AND (@q = '' OR a.DocName LIKE '%' + @q + '%' OR CAST(a.IDDoc AS nvarchar(20)) = @q))
            SELECT x.IDDoc, x.Lang, x.DocName, ISNULL(x.V1, 0) AS V1, ISNULL(x.V2, 0) AS V2, ISNULL(x.V3, 0) AS V3, ISNULL(x.Status, 0) AS Status,
                   REPLACE(ISNULL(t.TypeDesc, ''), '<DE>', '') AS TypeName, x.DateDel, u.AccShort AS DelBy, COUNT(*) OVER () AS Total
            FROM x LEFT JOIN DocTypes t ON t.IDType = x.Type AND t.Lang = x.Lang LEFT JOIN Accounts u ON u.IdAcc = x.IdDel
            WHERE x.rn = 1 ORDER BY x.DateDel DESC, x.IDDoc
            OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY", new { lang, q = (q ?? "").Trim(), skip = (page - 1) * size, size })).ToList();
        return Ok(new { lang, page, pageSize = size, total = rows.FirstOrDefault()?.Total ?? 0, items = rows.Select(r => new { id = r.IDDoc, name = r.DocName, version = $"{r.V1}.{r.V2}.{r.V3}", r.Status, type = r.TypeName, deleted = r.DateDel, deletedBy = r.DelBy }) });
    }

    // ═════════════════════════ View captured (broken) links ═════════════════════════
    [HttpGet("admin/broken-links")]
    public async Task<IActionResult> Broken([FromQuery] string lang = "EN", [FromQuery] string type = "all")
    {
        lang = L(lang); type = type is "int" or "net" ? type : "all";
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = (await con.QueryAsync<LinkCheckRow>(@"
            SELECT l.IDDoc, s.DocName, l.Link, ISNULL(l.isDoc, 0) AS TargetId, t.DocName AS TargetName, t.Status AS TargetStatus, CAST(ISNULL(t.DoNotPublish, 0) AS bit) AS TargetHidden,
                   CAST(CASE WHEN ISNULL(l.isDoc, 0) > 0 AND t.IDDoc IS NULL THEN 1 ELSE 0 END AS bit) AS TargetMissing,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM DocumentsArchives o WHERE o.IDDoc = l.isDoc AND o.Lang = l.Lang AND ISNULL(o.Status, 0) = 3) THEN 1 ELSE 0 END AS bit) AS Archived
            FROM Links l
            JOIN Documents s ON s.IDDoc = l.IDDoc AND s.Lang = l.Lang
            LEFT JOIN Documents t ON t.IDDoc = l.isDoc AND t.Lang = l.Lang AND ISNULL(l.isDoc, 0) > 0
            WHERE l.Lang = @lang AND (ISNULL(l.isDoc, 0) > 0 OR l.Link LIKE '\\%')
            ORDER BY l.IDDoc", new { lang })).ToList();
        var res = new List<object>();
        foreach (var r in rows)
        {
            string? err = null; string target = r.TargetName ?? "";
            if (r.TargetId > 0)
            {
                if (type == "net") continue;
                if (r.TargetMissing) err = "The linked document does not exist.";
                else if (r.TargetHidden == true) err = "The linked document is not shown on the web.";
                else if (r.TargetStatus == StatusExpired) err = "The linked document is expired.";
                else if (r.TargetStatus != StatusPublished && !r.Archived) err = "The linked document was never released.";
            }
            else
            {
                if (type == "int") continue;
                target = r.Link ?? "";
                bool ok; try { ok = System.IO.File.Exists(target) || Directory.Exists(target); } catch { ok = false; }
                if (!ok) err = "The network path is not reachable.";
            }
            if (err != null) res.Add(new { id = r.IDDoc, name = r.DocName, targetId = r.TargetId, target, error = err });
        }
        return Ok(new { lang, type, items = res });
    }

    // ═════════════════════════ Web history ═════════════════════════
    [HttpGet("admin/web-history")]
    public async Task<IActionResult> WebHistory([FromQuery] string lang = "EN", [FromQuery] DateTime? from = null, [FromQuery] DateTime? to = null, [FromQuery] int page = 1)
    {
        lang = L(lang); page = Math.Max(1, page); const int size = 100;
        var f = (from ?? DateTime.Today.AddMonths(-1)).Date; var t = (to ?? DateTime.Today).Date.AddDays(1);
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = (await con.QueryAsync<WebLogRow>(@"
            SELECT w.IDDoc, ISNULL(d.DocName, CONCAT('Document ', w.IDDoc)) AS DocName, COUNT(*) AS Hits, MAX(w.DateAccess) AS [Last], COUNT(*) OVER () AS Total
            FROM WebLog w LEFT JOIN Documents d ON d.IDDoc = w.IDDoc AND d.Lang = w.Lang
            WHERE w.Lang = @lang AND w.DateAccess >= @f AND w.DateAccess < @t
            GROUP BY w.IDDoc, d.DocName ORDER BY COUNT(*) DESC, w.IDDoc
            OFFSET @skip ROWS FETCH NEXT @size ROWS ONLY", new { lang, f, t, skip = (page - 1) * size, size })).ToList();
        var hits = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM WebLog WHERE Lang = @lang AND DateAccess >= @f AND DateAccess < @t", new { lang, f, t });
        return Ok(new { lang, from = f, to = t.AddDays(-1), page, pageSize = size, total = rows.FirstOrDefault()?.Total ?? 0, hits, items = rows.Select(r => new { id = r.IDDoc, name = r.DocName, hits = r.Hits, last = r.Last }) });
    }

    [HttpPost("admin/web-history/delete")]
    public async Task<IActionResult> DeleteWebHistory([FromBody] WebLogDeleteBody b)
    {
        if (b.From == null || b.To == null || b.To < b.From) return Err(400, "Select a valid date range.");
        var f = b.From.Value.Date; var t = b.To.Value.Date.AddDays(1);
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        try { var n = await con.ExecuteAsync("DELETE FROM WebLog WHERE DateAccess >= @f AND DateAccess < @t", new { f, t }); return Ok(new { removed = n }); }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { return Denied(e); }
    }

    // ═════════════════════════ Application level catchwords ═════════════════════════
    // Catch.IsNew = 5 marks words created by the administrator for the application (hidden from Catch management, legacy flag).
    [HttpGet("admin/app-catch")]
    public async Task<IActionResult> AppCatch([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        var rows = await con.QueryAsync<AppCatchRow>("SELECT IDCatch AS Id, CatchLong AS Word, ISNULL(IsActiv, 0) AS Active FROM [Catch] WHERE Lang = @lang AND IsNew = 5 ORDER BY CatchLong", new { lang });
        return Ok(new { lang, items = rows });
    }
    public class AppCatchRow { public int Id { get; set; } public string? Word { get; set; } public bool Active { get; set; } }

    [HttpPost("admin/app-catch")]
    public async Task<IActionResult> AddAppCatch([FromBody] CatchWordsBody b)
    {
        var lang = L(b.Lang);
        var words = (b.Words ?? new()).SelectMany(w => System.Text.RegularExpressions.Regex.Split(w ?? "", @"[\s,;]+")).Where(w => w.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (words.Count == 0) return Err(400, "Enter at least one catchword.");
        if (words.Any(w => w.Length > 30)) return Err(400, "A catchword may have 30 characters at most.");
        await using var con = Con(); await con.OpenAsync();
        if (!await IsAdmin(con)) return NotAdmin();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            int added = 0, existing = 0;
            foreach (var w in words)
            {
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM [Catch] WITH (UPDLOCK, HOLDLOCK) WHERE Lang = @lang AND CatchLong = @w", new { lang, w }, tx) > 0) { existing++; continue; }
                var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDCatch), 0) + 1 FROM [Catch] WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
                await con.ExecuteAsync("INSERT INTO [Catch] (IDCatch, Lang, CatchShort, CatchLong, CatchShow, IsActiv, IsNew) VALUES (@id, @lang, @short, @w, @w, 1, 5)", new { id, lang, w, @short = w.ToLowerInvariant() }, tx);
                added++;
            }
            await tx.CommitAsync();
            return Ok(new { added, existing });
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return Denied(e); }
    }

    [HttpPut("admin/app-catch/state")]
    public async Task<IActionResult> AppCatchState([FromBody] CatchStateBody b)
    {
        var lang = L(b.Lang); var ids = b.Ids ?? new();
        if (ids.Count == 0) return Err(400, "Select a catchword.");
        await using var con = Con();
        if (!await IsAdmin(con)) return NotAdmin();
        try { var n = await con.ExecuteAsync("UPDATE [Catch] SET IsActiv = @a WHERE Lang = @lang AND IsNew = 5 AND IDCatch IN @ids", new { a = b.Active, lang, ids }); return Ok(new { changed = n }); }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { return Denied(e); }
    }

    [HttpPost("admin/app-catch/delete")]
    public async Task<IActionResult> DeleteAppCatch([FromBody] CatchIdsBody b)
    {
        var ids = b.Ids ?? new();
        if (ids.Count == 0) return Err(400, "Select a catchword.");
        await using var con = Con(); await con.OpenAsync();
        if (!await IsAdmin(con)) return NotAdmin();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM DocCatch WHERE IdCatch IN (SELECT IDCatch FROM [Catch] WHERE IsNew = 5 AND IDCatch IN @ids)", new { ids }, tx);
            var n = await con.ExecuteAsync("DELETE FROM [Catch] WHERE IsNew = 5 AND IDCatch IN @ids", new { ids }, tx);
            await tx.CommitAsync(); return Ok(new { removed = n });
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return Denied(e); }
    }
}
