using System.Security.Claims;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class CatchWordsBody { public string? Lang { get; set; } public List<string>? Words { get; set; } }
public class CatchStateBody { public string? Lang { get; set; } public List<int>? Ids { get; set; } public bool Active { get; set; } }
public class CatchWordBody { public string? Word { get; set; } }
public class CatchIdsBody { public List<int>? Ids { get; set; } }
public class CatchDocItem { public int IdDoc { get; set; } public int IdCatch { get; set; } public bool Active { get; set; } }
public class CatchDocStateBody { public List<CatchDocItem>? Items { get; set; } }

public class DocControlRow
{
    public DateTime? DateCre { get; set; } public string? Cre { get; set; }
    public DateTime? DateRel { get; set; } public string? Rel { get; set; }
    public DateTime? DateMod { get; set; } public string? Edt { get; set; }
    public DateTime? DatePrv { get; set; } public string? Ver { get; set; }
    public DateTime? DatePub { get; set; } public string? Pub { get; set; }
}
public class DocCatchRow { public int IDCatch { get; set; } public string? CatchLong { get; set; } public string? CatchShow { get; set; } public bool? IsActiv { get; set; } public bool? IsManual { get; set; } public bool? DocActive { get; set; } }
public class CatchListRow { public int IDCatch { get; set; } public string? CatchLong { get; set; } public bool? IsActiv { get; set; } public int Docs { get; set; } }
public class CatchDocRow { public int IdDoc { get; set; } public string? DocName { get; set; } public bool? IsManual { get; set; } public bool? DocActive { get; set; } public int Status { get; set; } }
public class DocLinkRow { public int IDDoc { get; set; } public string? Link { get; set; } public int? IsDoc { get; set; } }
public class DocNameRow { public int IDDoc { get; set; } public string? DocName { get; set; } public int Status { get; set; } }
public class DepMemberRow { public int IdCollect { get; set; } public int IdDoc { get; set; } public string? DocName { get; set; } public int Status { get; set; } }
public class DepHeadRow { public int Id { get; set; } public string? Name { get; set; } }

/// Tabs of the document properties window (manual p. 18-23) that were still missing, and Options > Catch Management (manual p. 86-89):
///   Control      Documents.DateCre/IdCre, DateRel/IdRel, DateMod/IdMod, DatePrv/IdPrv (verified), DatePub/IdPub
///   Catch        DocCatch(IdDoc, IdCatch, isManual, isActiv) + Catch(IDCatch, Lang, CatchShort, CatchLong, CatchShow, IsActiv, IsNew)
///   Linking      Links(IDDoc, Lang, Link, isDoc): outgoing = rows of the document, incoming = rows whose isDoc is the document (legacy getHyperlinks)
///   Dependency   Collect / DocCollect of the document
/// Catch needs the right "Catch Management" (15, legacy rightCatchwords) and Config IsCatchWordEnabled (default on).
/// Config EnableDocLevelCatchword = 1: activate/deactivate works per document (DocCatch.isActiv), else for the word (Catch.IsActiv), as in legacy changeCatchwords.
/// Words of at least 4 characters can be registered; Config CatchMinLength (optional, 1..30) lowers the limit (the manual's "3 characters" admin option).
[ApiController, Route("api/lds"), Authorize]
public class DocTabsController(IConfiguration cfg) : ControllerBase
{
    const int RightCatch = 15, RightCollect = 32, MaxWord = 30;
    static readonly Regex Split = new(@"[\s,;]+", RegexOptions.Compiled);
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static IActionResult Denied(SqlException e) => Err(403, "The database login may not change catchwords (needs INSERT, UPDATE, DELETE on Catch and DocCatch; see sql/grant-pl_app.sql). " + e.Message);

    static async Task<string> Cfg(SqlConnection con, string name, SqlTransaction? tx = null) =>
        (await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name }, tx))?.Trim() ?? "";
    static async Task<bool> CatchOn(SqlConnection con) => await Cfg(con, "IsCatchWordEnabled") is not ("0" or "False" or "false");
    static async Task<bool> DocLevel(SqlConnection con, SqlTransaction? tx = null) => await Cfg(con, "EnableDocLevelCatchword", tx) == "1";
    static async Task<int> MinLen(SqlConnection con, SqlTransaction? tx = null) => int.TryParse(await Cfg(con, "CatchMinLength", tx), out var n) && n is >= 1 and <= MaxWord ? n : 4;
    async Task<bool> HasRight(SqlConnection con, int right) { var r = await Access.Rights(con, Acc); return Access.IsAdmin(r) || r.Any(x => x.RCod == right); }

    async Task<bool> CanSeeDoc(SqlConnection con, int id, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        return await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang }) > 0;
    }
    async Task<IActionResult?> NeedCatch(SqlConnection con)
    {
        if (!await CatchOn(con)) return Err(404, "Catchwords are switched off (Config IsCatchWordEnabled).");
        return await HasRight(con, RightCatch) ? null : Err(403, "You need the 'Catch Management' right.");
    }

    // ═════════════════════════ Control ═════════════════════════
    [HttpGet("documents/{id:int}/control")]
    public async Task<IActionResult> Control(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var r = await con.QueryFirstOrDefaultAsync<DocControlRow>($@"SELECT d.DateCre, c.AccShort AS Cre, d.DateRel, rl.AccShort AS Rel, d.DateMod, m.AccShort AS Edt, d.DatePrv, v.AccShort AS Ver, d.DatePub, p.AccShort AS Pub
            FROM Documents d
            LEFT JOIN Accounts c ON c.IdAcc = d.IdCre LEFT JOIN Accounts rl ON rl.IdAcc = d.IdRel LEFT JOIN Accounts m ON m.IdAcc = d.IdMod
            LEFT JOIN Accounts v ON v.IdAcc = d.IdPrv LEFT JOIN Accounts p ON p.IdAcc = d.IdPub
            WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (r is null) return Err(404, "Document not found.");
        return Ok(new
        {
            created = new { on = r.DateCre, by = r.Cre ?? "" }, released = new { on = r.DateRel, by = r.Rel ?? "" }, edited = new { on = r.DateMod, by = r.Edt ?? "" },
            verified = new { on = r.DatePrv, by = r.Ver ?? "" }, published = new { on = r.DatePub, by = r.Pub ?? "" }
        });
    }

    // ═════════════════════════ Catch (document tab) ═════════════════════════
    [HttpGet("documents/{id:int}/catch")]
    public async Task<IActionResult> DocCatchList(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await CatchOn(con)) return Ok(new { enabled = false, canManage = false, docLevel = false, minLen = 4, items = Array.Empty<object>() });
        if (!await CanSeeDoc(con, id, lang)) return Err(404, "Document not found.");
        var can = await HasRight(con, RightCatch);
        var docLevel = await DocLevel(con);
        var items = new List<DocCatchRow>();
        if (can)
            items = (await con.QueryAsync<DocCatchRow>(@"SELECT c.IDCatch, c.CatchLong, c.CatchShow, c.IsActiv, dc.isManual AS IsManual, dc.isActiv AS DocActive
                FROM DocCatch dc JOIN Catch c ON c.IDCatch = dc.IdCatch AND c.Lang = @lang WHERE dc.IdDoc = @id ORDER BY c.CatchShow, c.IDCatch", new { id, lang })).ToList();
        return Ok(new
        {
            enabled = true, canManage = can, docLevel, minLen = await MinLen(con),
            items = items.Select(x => new { idCatch = x.IDCatch, word = string.IsNullOrEmpty(x.CatchShow) ? x.CatchLong ?? "" : x.CatchShow, active = docLevel ? x.DocActive ?? false : x.IsActiv ?? false, manual = x.IsManual ?? false })
        });
    }

    static string? CheckWord(string w, int min) =>
        w.Length < min ? $"'{w}' is too short: catchwords need at least {min} characters." : w.Length > MaxWord ? $"'{w}' is too long: {MaxWord} characters at most." : null;

    /// "Add": registers the words (new ones in table Catch) and links them to the document as manual catchwords (legacy addCatch).
    [HttpPost("documents/{id:int}/catch")]
    public async Task<IActionResult> AddDocCatch(int id, [FromBody] CatchWordsBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        if (!await CanSeeDoc(con, id, lang)) return Err(404, "Document not found.");
        var words = (b.Words ?? []).SelectMany(w => Split.Split(w ?? "")).Select(w => w.Trim()).Where(w => w.Length > 0).Distinct(StringComparer.CurrentCultureIgnoreCase).ToList();
        if (words.Count == 0) return Err(400, "Please enter a catchword.");
        var min = await MinLen(con);
        foreach (var w in words) if (CheckWord(w, min) is { } bad) return Err(400, bad);
        int created = 0, linked = 0;
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            var docLevel = await DocLevel(con, tx);
            foreach (var w in words)
            {
                var cid = await con.QueryFirstOrDefaultAsync<int?>("SELECT TOP 1 IDCatch FROM Catch WITH (UPDLOCK, HOLDLOCK) WHERE Lang = @lang AND CatchLong = @w", new { lang, w }, tx);
                if (cid is null)
                {
                    var n = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDCatch), 0) + 1 FROM Catch WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
                    await con.ExecuteAsync("INSERT INTO Catch (IDCatch, Lang, CatchShort, CatchLong, CatchShow, IsActiv, IsNew) VALUES (@n, @lang, @s, @w, @w, 1, 0)", new { n, lang, s = w[..1], w }, tx);
                    cid = n; created++;
                }
                else if (!docLevel) await con.ExecuteAsync("UPDATE Catch SET IsActiv = 1 WHERE IDCatch = @cid", new { cid }, tx);
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCatch WITH (UPDLOCK, HOLDLOCK) WHERE IdDoc = @id AND IdCatch = @cid", new { id, cid }, tx) == 0)
                {
                    await con.ExecuteAsync("INSERT INTO DocCatch (IdDoc, IdCatch, isManual, isActiv) VALUES (@id, @cid, 1, 1)", new { id, cid }, tx); linked++;
                }
            }
            await tx.CommitAsync();
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
        return Ok(new { created, linked, message = "Newly added catchwords will be effective on the web after the document is published." });
    }

    /// Activate / Deactivate (several words at once). Per document when EnableDocLevelCatchword = 1, else for the word itself.
    [HttpPut("documents/{id:int}/catch/state")]
    public async Task<IActionResult> DocCatchState(int id, [FromBody] CatchStateBody b)
    {
        var lang = L(b.Lang);
        var ids = (b.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) return Err(400, "Select at least one catchword.");
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        if (!await CanSeeDoc(con, id, lang)) return Err(404, "Document not found.");
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            var n = await DocLevel(con, tx)
                ? await con.ExecuteAsync("UPDATE DocCatch SET isActiv = @a WHERE IdDoc = @id AND IdCatch IN @ids", new { a = b.Active, id, ids }, tx)
                : await con.ExecuteAsync("UPDATE Catch SET IsActiv = @a WHERE Lang = @lang AND IDCatch IN (SELECT IdCatch FROM DocCatch WHERE IdDoc = @id AND IdCatch IN @ids)", new { a = b.Active, lang, id, ids }, tx);
            await tx.CommitAsync();
            return Ok(new { changed = n });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    // ═════════════════════════ Options > Catch Management ═════════════════════════
    [HttpGet("catch/config")]
    public async Task<IActionResult> CatchConfig()
    {
        await using var con = Con();
        var on = await CatchOn(con);
        return Ok(new { enabled = on, canManage = on && await HasRight(con, RightCatch), docLevel = await DocLevel(con), minLen = await MinLen(con) });
    }

    /// All catchwords of a language with the number of documents that use them (legacy getAllCatchwords; words with IsNew 2 / 5 are not listed).
    [HttpGet("catch")]
    public async Task<IActionResult> CatchList([FromQuery] string lang = "EN", [FromQuery] string? q = null, [FromQuery] string state = "all", [FromQuery] int page = 1, [FromQuery] int pageSize = 100)
    {
        lang = L(lang);
        await using var con = Con();
        if (await NeedCatch(con) is { } e) return e;
        pageSize = Math.Clamp(pageSize, 10, 500); page = Math.Max(1, page);
        var where = "c.Lang = @lang AND ISNULL(c.IsNew, 0) NOT IN (2, 5)";
        if (!string.IsNullOrWhiteSpace(q)) where += " AND c.CatchLong LIKE @like ESCAPE '\\'";
        if (state == "active") where += " AND ISNULL(c.IsActiv, 0) = 1"; else if (state == "inactive") where += " AND ISNULL(c.IsActiv, 0) = 0";
        var like = "%" + (q ?? "").Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("[", "\\[") + "%";
        var total = await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Catch c WHERE {where}", new { lang, like });
        var rows = await con.QueryAsync<CatchListRow>($@"SELECT c.IDCatch, c.CatchLong, c.IsActiv, (SELECT COUNT(*) FROM DocCatch x WHERE x.IdCatch = c.IDCatch) AS Docs
            FROM Catch c WHERE {where} ORDER BY c.CatchLong, c.IDCatch OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY", new { lang, like, skip = (page - 1) * pageSize, take = pageSize });
        var active = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Catch c WHERE c.Lang = @lang AND ISNULL(c.IsNew, 0) NOT IN (2, 5) AND ISNULL(c.IsActiv, 0) = 1", new { lang });
        var all = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Catch c WHERE c.Lang = @lang AND ISNULL(c.IsNew, 0) NOT IN (2, 5)", new { lang });
        return Ok(new { total, page, pageSize, all, active, items = rows.Select(r => new { id = r.IDCatch, word = r.CatchLong ?? "", active = r.IsActiv ?? false, documents = r.Docs }) });
    }

    /// Documents that use a catchword with their own active flag (legacy getAllCatchwordsWithDoc; activate/deactivate per document, 2019 change).
    [HttpGet("catch/{id:int}/documents")]
    public async Task<IActionResult> CatchDocs(int id)
    {
        await using var con = Con();
        if (await NeedCatch(con) is { } e) return e;
        var lang = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Lang FROM Catch WHERE IDCatch = @id", new { id });
        if (lang is null) return Err(404, "This catchword no longer exists.");
        var vis = await Access.VisibleSql(con, Acc, lang);
        var rows = await con.QueryAsync<CatchDocRow>($@"SELECT d.IDDoc AS IdDoc, d.DocName, d.[Status], dc.isManual AS IsManual, dc.isActiv AS DocActive
            FROM DocCatch dc JOIN Documents d ON d.IDDoc = dc.IdDoc AND d.Lang = @lang WHERE dc.IdCatch = @id AND {vis} ORDER BY d.DocName", new { id, lang });
        return Ok(new { items = rows.Select(r => new { idDoc = r.IdDoc, name = r.DocName ?? "", status = r.Status, manual = r.IsManual ?? false, active = r.DocActive ?? false }) });
    }

    [HttpPut("catch/state")]
    public async Task<IActionResult> CatchState([FromBody] CatchStateBody b)
    {
        var ids = (b.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) return Err(400, "Select at least one catchword.");
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        try { return Ok(new { changed = await con.ExecuteAsync("UPDATE Catch SET IsActiv = @a WHERE IDCatch IN @ids", new { a = b.Active, ids }) }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    [HttpPut("catch/documents/state")]
    public async Task<IActionResult> CatchDocState([FromBody] CatchDocStateBody b)
    {
        var items = (b.Items ?? []).ToList();
        if (items.Count == 0) return Err(400, "Nothing to change.");
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            var n = 0;
            foreach (var i in items) n += await con.ExecuteAsync("UPDATE DocCatch SET isActiv = @a WHERE IdDoc = @d AND IdCatch = @c", new { a = i.Active, d = i.IdDoc, c = i.IdCatch }, tx);
            await tx.CommitAsync();
            return Ok(new { changed = n });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    /// Edit an existing catchword.
    [HttpPut("catch/{id:int}")]
    public async Task<IActionResult> CatchEdit(int id, [FromBody] CatchWordBody b)
    {
        var w = (b.Word ?? "").Trim();
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        if (w.Length == 0) return Err(400, "Please enter a catchword.");
        if (Split.IsMatch(w)) return Err(400, "A catchword is a single word without spaces, commas or semicolons.");
        if (CheckWord(w, await MinLen(con)) is { } bad) return Err(400, bad);
        var lang = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Lang FROM Catch WHERE IDCatch = @id", new { id });
        if (lang is null) return Err(404, "This catchword no longer exists.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Catch WHERE Lang = @lang AND CatchLong = @w AND IDCatch <> @id", new { lang, w, id }) > 0) return Err(409, $"The catchword '{w}' already exists.");
        try { await con.ExecuteAsync("UPDATE Catch SET CatchLong = @w, CatchShow = @w, CatchShort = @s WHERE IDCatch = @id", new { id, w, s = w[..1] }); return Ok(new { id }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    /// Delete catchwords together with their links to documents (legacy removeCatch).
    [HttpPost("catch/delete")]
    public async Task<IActionResult> CatchDelete([FromBody] CatchIdsBody b)
    {
        var ids = (b.Ids ?? []).Distinct().ToList();
        if (ids.Count == 0) return Err(400, "Select at least one catchword.");
        await using var con = Con(); await con.OpenAsync();
        if (await NeedCatch(con) is { } e) return e;
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM DocCatch WHERE IdCatch IN @ids", new { ids }, tx);
            var n = await con.ExecuteAsync("DELETE FROM Catch WHERE IDCatch IN @ids", new { ids }, tx);
            await tx.CommitAsync();
            return Ok(new { removed = n });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    // ═════════════════════════ Linking ═════════════════════════
    /// Incoming and outgoing links of a document (legacy getHyperlinks over table Links).
    [HttpGet("documents/{id:int}/links")]
    public async Task<IActionResult> LinksOf(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await CanSeeDoc(con, id, lang)) return Err(404, "Document not found.");
        var outg = (await con.QueryAsync<DocLinkRow>("SELECT IDDoc, Link, isDoc AS IsDoc FROM Links WHERE IDDoc = @id AND Lang = @lang ORDER BY Link", new { id, lang })).ToList();
        var inc = (await con.QueryAsync<DocLinkRow>("SELECT DISTINCT IDDoc, CAST(NULL AS nvarchar(100)) AS Link, CAST(NULL AS int) AS IsDoc FROM Links WHERE isDoc = @id AND Lang = @lang", new { id, lang })).ToList();
        var want = outg.Where(x => (x.IsDoc ?? 0) > 0).Select(x => x.IsDoc!.Value).Concat(inc.Select(x => x.IDDoc)).Distinct().ToList();
        var names = new Dictionary<int, DocNameRow>();
        if (want.Count > 0)
        {
            var vis = await Access.VisibleSql(con, Acc, lang);
            names = (await con.QueryAsync<DocNameRow>($"SELECT d.IDDoc, d.DocName, d.[Status] FROM Documents d WHERE d.Lang = @lang AND d.IDDoc IN @want AND {vis}", new { lang, want })).ToDictionary(x => x.IDDoc);
        }
        string Name(int docId) => names.TryGetValue(docId, out var n) ? n.DocName ?? "" : "";
        return Ok(new
        {
            outgoing = outg.Select(x => new
            {
                link = x.Link ?? "", targetId = x.IsDoc ?? 0, name = (x.IsDoc ?? 0) > 0 ? Name(x.IsDoc!.Value) : "", accessible = (x.IsDoc ?? 0) > 0 && names.ContainsKey(x.IsDoc!.Value),
                kind = (x.IsDoc ?? 0) > 0 ? "document" : (x.Link ?? "").StartsWith("mailto:", StringComparison.OrdinalIgnoreCase) ? "mail" : "external"
            }),
            incoming = inc.OrderBy(x => Name(x.IDDoc), StringComparer.CurrentCultureIgnoreCase).Select(x => new { sourceId = x.IDDoc, name = Name(x.IDDoc), accessible = names.ContainsKey(x.IDDoc) })
        });
    }

    // ═════════════════════════ Dependency (document tab) ═════════════════════════
    [HttpGet("documents/{id:int}/dependencies")]
    public async Task<IActionResult> DocDependencies(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await CanSeeDoc(con, id, lang)) return Err(404, "Document not found.");
        var can = await HasRight(con, RightCollect);
        var heads = (await con.QueryAsync<DepHeadRow>("SELECT c.IDCollect AS Id, c.CollectName AS Name FROM Collect c WHERE c.Lang = @lang AND c.IDCollect IN (SELECT IDCollect FROM DocCollect WHERE IDDoc = @id) ORDER BY c.CollectName", new { lang, id })).ToList();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var ids = heads.Select(h => h.Id).ToList();
        var mem = ids.Count == 0 ? new List<DepMemberRow>() : (await con.QueryAsync<DepMemberRow>($@"SELECT dc.IDCollect AS IdCollect, d.IDDoc AS IdDoc, d.DocName, d.[Status]
            FROM DocCollect dc JOIN Documents d ON d.IDDoc = dc.IDDoc AND d.Lang = @lang WHERE dc.IDCollect IN @ids AND {vis} ORDER BY d.DocName", new { lang, ids })).ToList();
        var available = !can ? new List<DepHeadRow>() : (await con.QueryAsync<DepHeadRow>("SELECT c.IDCollect AS Id, c.CollectName AS Name FROM Collect c WHERE c.Lang = @lang AND c.IDCollect NOT IN (SELECT IDCollect FROM DocCollect WHERE IDDoc = @id) ORDER BY c.CollectName", new { lang, id })).ToList();
        return Ok(new
        {
            canManage = can,
            items = heads.Select(h => new { id = h.Id, name = h.Name ?? "", documents = mem.Where(m => m.IdCollect == h.Id).Select(m => new { idDoc = m.IdDoc, name = m.DocName ?? "", status = m.Status, self = m.IdDoc == id }) }),
            available = available.Select(a => new { id = a.Id, name = a.Name ?? "" })
        });
    }
}
