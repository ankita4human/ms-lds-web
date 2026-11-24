using System.Security.Claims;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class StdBody
{
    public string? Lang { get; set; }
    public int ParentId { get; set; }
    public string? Name { get; set; }
    public string? ShortName { get; set; }
    public string? ChapterNo { get; set; }
    public string? Description { get; set; }
    public bool InActive { get; set; }
}
public class StdImportRow { public string? ChapterNo { get; set; } public string? Name { get; set; } public string? Description { get; set; } }
public class StdImportBody { public string? Lang { get; set; } public string? Name { get; set; } public string? ShortName { get; set; } public string? Description { get; set; } public List<StdImportRow>? Rows { get; set; } }
public class StdIds { public List<int> Ids { get; set; } = new(); }
public class StdFlag { public bool Value { get; set; } }
public class StdAssocBody { public string? Name { get; set; } public int IdAssociation { get; set; } }
public class DocStdBody { public int[]? Ids { get; set; } }
class StdNode { public int IDGroup { get; set; } public int IDParent { get; set; } public string? GroupDesc { get; set; } public int SortG { get; set; } }
class StdChap { public int IDStandard { get; set; } public string? ChapterNo { get; set; } public string? ChapterName { get; set; } public string? Description { get; set; } public int? IDAssociation { get; set; } }
class StdRoot { public int IDStandard { get; set; } public string? Description { get; set; } public string? QShort { get; set; } public bool? InActive { get; set; } }

/// Options > Standard management (manual p. 62-66, 157). Standards are Groups with GroupType = 1; the root carries the table
/// ADS_Standard (description, short name, inactive), every chapter a row in ADS_StdChapter. Mandatory standards live in DocStandard.
/// Mirrors QDSClientSession.createStandard / updateStandard / removeStandard and the standard association methods.
[ApiController, Route("api/lds"), Authorize]
public class StandardsController(IConfiguration cfg) : ControllerBase, IAsyncActionFilter
{
    /// Config LDSEnableStandardFolder = 1 switches the whole standards feature on (Standard management, link to standard, mandatory check).
    public static async Task<bool> FeatureOn(SqlConnection con, System.Data.Common.DbTransaction? tx = null) =>
        (await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'LDSEnableStandardFolder'", transaction: tx))?.Trim() is "1" or "True" or "true";

    [NonAction]
    public async Task OnActionExecutionAsync(ActionExecutingContext ctx, ActionExecutionDelegate next)
    {
        var path = ctx.HttpContext.Request.Path.Value ?? "";
        // the options probe and the per-document lookup answer for themselves; everything else needs the feature
        if (!path.EndsWith("/standards/options", StringComparison.OrdinalIgnoreCase) && !Regex.IsMatch(path, @"/documents/\d+/standards$", RegexOptions.IgnoreCase))
        {
            await using var con = Con();
            if (!await FeatureOn(con)) { ctx.Result = new ObjectResult(new { error = "Standards are not enabled (Config LDSEnableStandardFolder)." }) { StatusCode = 404 }; return; }
        }
        await next();
    }

    [HttpGet("standards/options")]
    public async Task<IActionResult> StdOptions() { await using var con = Con(); return Ok(new { enabled = await FeatureOn(con) }); }

    const int RightManageStd = 106, StandardGroup = 1;
    int Me => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? lang) => string.IsNullOrWhiteSpace(lang) ? "EN" : lang.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static string Plain(string? s) => s is { Length: > 4 } && s[0] == '<' && s[3] == '>' ? s[4..] : s ?? "";
    static bool Untranslated(string? s) => s is { Length: > 4 } && s[0] == '<' && s[3] == '>';

    async Task<bool> Can(SqlConnection con)
    {
        var r = await Access.Rights(con, Me);
        return Access.IsAdmin(r) || r.Any(x => x.RCod == RightManageStd);
    }
    static IActionResult? Sql(SqlException e) => e.Number switch
    {
        229 or 262 or 230 => Err(403, "The database account used by the API may not change standards. Run the standards section of sql/grant-pl_app.sql."),
        _ => null
    };
    static Task<List<string>> ActiveLangs(SqlConnection con) =>
        con.QueryAsync<string>("SELECT Lang FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang").ContinueWith(t => t.Result.ToList());

    // ───────────── tree + details ─────────────
    [HttpGet("standards")]
    public async Task<IActionResult> Tree([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        var nodes = (await con.QueryAsync<StdNode>("SELECT IDGroup, ISNULL(IDParent,0) AS IDParent, GroupDesc, ISNULL(SortG,0) AS SortG FROM Groups WHERE Lang = @lang AND GroupType = 1", new { lang })).ToList();
        var chap = (await con.QueryAsync<StdChap>("SELECT IDStandard, ChapterNo, ChapterName, Description, IDAssociation FROM ADS_StdChapter WHERE Lang = @lang", new { lang })).ToDictionary(x => x.IDStandard);
        var roots = (await con.QueryAsync<StdRoot>("SELECT IDStandard, Description, QShort, InActive FROM ADS_Standard WHERE Lang = @lang", new { lang })).ToDictionary(x => x.IDStandard);
        var mand = (await con.QueryAsync<int>("SELECT DISTINCT IDGroup FROM DocStandard")).ToHashSet();
        var docs = (await con.QueryAsync<(int G, int N)>("SELECT IdGroup AS G, COUNT(DISTINCT IdDoc) AS N FROM DocGrp GROUP BY IdGroup")).ToDictionary(x => x.G, x => x.N);
        var items = nodes.OrderBy(n => n.SortG).ThenBy(n => n.IDGroup).Select(n => new
        {
            id = n.IDGroup, parent = n.IDParent, name = Plain(n.GroupDesc), untranslated = Untranslated(n.GroupDesc),
            chapterNo = n.IDParent == 0 ? "" : chap.GetValueOrDefault(n.IDGroup)?.ChapterNo ?? "",
            shortName = roots.GetValueOrDefault(n.IDGroup)?.QShort ?? "", inActive = roots.GetValueOrDefault(n.IDGroup)?.InActive ?? false,
            mandatory = mand.Contains(n.IDGroup), documents = docs.GetValueOrDefault(n.IDGroup),
            association = chap.GetValueOrDefault(n.IDGroup)?.IDAssociation ?? 0,
        });
        var stdName = await con.QueryFirstOrDefaultAsync<string>("SELECT FValue FROM Config WHERE FName = 'StdName'") ?? "Standards";
        return Ok(new { items, rootName = stdName, canManage = await Can(con) });
    }

    [HttpGet("standards/{id:int}")]
    public async Task<IActionResult> One(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        var g = await con.QueryFirstOrDefaultAsync<StdNode>("SELECT IDGroup, ISNULL(IDParent,0) AS IDParent, GroupDesc, ISNULL(SortG,0) AS SortG FROM Groups WHERE IDGroup = @id AND Lang = @lang AND GroupType = 1", new { id, lang });
        if (g is null) return Err(404, "This standard no longer exists. Reload the page.");
        var mandatory = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocStandard WHERE IDGroup = @id", new { id }) > 0;
        if (g.IDParent == 0)
        {
            var r = await con.QueryFirstOrDefaultAsync<StdRoot>("SELECT IDStandard, Description, QShort, InActive FROM ADS_Standard WHERE IDStandard = @id AND Lang = @lang", new { id, lang });
            return Ok(new { id, parent = 0, name = Plain(g.GroupDesc), chapterNo = "", shortName = r?.QShort ?? "", description = Plain(r?.Description), inActive = r?.InActive ?? false, mandatory, association = 0 });
        }
        var c = await con.QueryFirstOrDefaultAsync<StdChap>("SELECT IDStandard, ChapterNo, ChapterName, Description, IDAssociation FROM ADS_StdChapter WHERE IDStandard = @id AND Lang = @lang", new { id, lang });
        return Ok(new { id, parent = g.IDParent, name = Plain(g.GroupDesc), chapterNo = c?.ChapterNo ?? "", shortName = "", description = Plain(c?.Description), inActive = false, mandatory, association = c?.IDAssociation ?? 0 });
    }

    // ───────────── create ─────────────
    static string? Check(StdBody b, bool root)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return "Please enter a name.";
        if (name.Length > 240) return "The name is too long (240 characters at most).";
        if (root && (b.ShortName ?? "").Trim().Length > 5) return "The short name may have at most 5 characters.";
        if (!root && (b.ChapterNo ?? "").Trim().Length > 20) return "The chapter number may have at most 20 characters.";
        return null;
    }

    async Task<string?> DuplicateChapter(SqlConnection con, System.Data.Common.DbTransaction? tx, int parentId, string lang, string no, int exceptId)
    {
        // walk up to the root, then look through every chapter of this standard (legacy errDuplicateChapter)
        var rootId = parentId; var guard = 0;
        while (guard++ < 50)
        {
            var p = await con.ExecuteScalarAsync<int?>("SELECT TOP 1 ISNULL(IDParent,0) FROM Groups WHERE IDGroup = @id AND GroupType = 1", new { id = rootId }, tx);
            if (p is null or 0) break; rootId = p.Value;
        }
        var ids = new List<int> { rootId }; var frontier = new List<int> { rootId };
        while (frontier.Count > 0 && ids.Count < 5000)
        {
            var kids = (await con.QueryAsync<int>("SELECT DISTINCT IDGroup FROM Groups WHERE GroupType = 1 AND IDParent IN @f", new { f = frontier }, tx)).ToList();
            kids = kids.Except(ids).ToList(); ids.AddRange(kids); frontier = kids;
        }
        var dup = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM ADS_StdChapter WHERE Lang = @lang AND ChapterNo = @no AND IDStandard <> @ex AND IDStandard IN @ids", new { lang, no, ex = exceptId, ids }, tx);
        return dup > 0 ? $"Chapter {no} already exists in this standard." : null;
    }

    [HttpPost("standards")]
    public async Task<IActionResult> Create([FromBody] StdBody b)
    {
        var lang = L(b.Lang); var root = b.ParentId == 0;
        var bad = Check(b, root); if (bad is not null) return Err(400, bad);
        var name = b.Name!.Trim(); var desc = (b.Description ?? "").Trim(); var no = (b.ChapterNo ?? "").Trim(); var sn = (b.ShortName ?? "").Trim();
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        if (!root && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE IDGroup = @p AND GroupType = 1", new { p = b.ParentId }) == 0) return Err(404, "The parent standard no longer exists.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE Lang = @lang AND GroupType = 1 AND ISNULL(IDParent,0) = @p AND GroupDesc = @n", new { lang, p = b.ParentId, n = name }) > 0)
            return Err(409, "A standard or chapter with this name already exists here.");
        try
        {
            var langs = await ActiveLangs(con);
            if (!root && no.Length > 0) { var d = await DuplicateChapter(con, null, b.ParentId, lang, no, 0); if (d is not null) return Err(409, d); }
            await using var tx = await con.BeginTransactionAsync();
            var id = await NewNode(con, tx, langs, lang, b.ParentId, name, desc, sn, no);
            await tx.CommitAsync();
            GroupCache.Bump();
            return Ok(new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    /// One Groups row per active language plus the standard / chapter rows (createStandard). Languages other than the typed one get "<LANG>text".
    static async Task<int> NewNode(SqlConnection con, System.Data.Common.DbTransaction tx, List<string> langs, string lang, int parent, string name, string desc, string sn, string no)
    {
        var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDGroup), 0) + 1 FROM Groups WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
        foreach (var l in langs)
        {
            string tr(string s) => l == lang || s.Length == 0 ? s : $"<{lang}>{s}";
            await con.ExecuteAsync(@"INSERT INTO Groups (IDGroup, Lang, GroupDesc, IDParent, SortG, SpecialType, DoNotPublish, IDProcessOwner, GroupType)
                VALUES (@id, @l, @d, @p, @id, 0, 0, 0, 1)", new { id, l, d = tr(name), p = parent }, tx);
            if (parent == 0)
                await con.ExecuteAsync("INSERT INTO ADS_Standard (IDStandard, Lang, Description, QShort, MaxQuestionID, InActive) VALUES (@id, @l, @d, @s, 0, 0)", new { id, l, d = tr(desc), s = sn }, tx);
            else
                await con.ExecuteAsync("INSERT INTO ADS_StdChapter (IDStandard, Lang, ChapterNo, ChapterName, Description, IDAssociation) VALUES (@id, @l, @no, @n, @d, 0)",
                    new { id, l, no = no.Length > 0 ? no : id.ToString(), n = tr(name), d = tr(desc) }, tx);
        }
        return id;
    }

    // ───────────── update ─────────────
    [HttpPut("standards/{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] StdBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        var parent = await con.ExecuteScalarAsync<int?>("SELECT TOP 1 ISNULL(IDParent,0) FROM Groups WHERE IDGroup = @id AND GroupType = 1", new { id });
        if (parent is null) return Err(404, "This standard no longer exists. Reload the page.");
        var root = parent == 0;
        var bad = Check(b, root); if (bad is not null) return Err(400, bad);
        var name = b.Name!.Trim(); var desc = (b.Description ?? "").Trim(); var no = (b.ChapterNo ?? "").Trim(); var sn = (b.ShortName ?? "").Trim();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(DISTINCT IDGroup) FROM Groups WHERE Lang = @lang AND GroupType = 1 AND ISNULL(IDParent,0) = @p AND GroupDesc = @n AND IDGroup <> @id", new { lang, p = parent, n = name, id }) > 0)
            return Err(409, "A standard or chapter with this name already exists here.");
        try
        {
            var langs = await ActiveLangs(con);
            if (!root && no.Length > 0) { var d = await DuplicateChapter(con, null, parent!.Value, lang, no, id); if (d is not null) return Err(409, d); }
            await using var tx = await con.BeginTransactionAsync();
            foreach (var l in langs)
            {
                var cur = await con.ExecuteScalarAsync<string?>("SELECT GroupDesc FROM Groups WHERE IDGroup = @id AND Lang = @l", new { id, l }, tx);
                var mark = $"<{lang}>";
                // typed language: plain text; other languages only while they still hold the "<LANG>" placeholder (legacy updateStandard)
                var typed = l == lang; var placeholder = !typed && (cur ?? "").StartsWith(mark);
                if (!typed && !placeholder) { if (root) await con.ExecuteAsync("UPDATE ADS_Standard SET QShort = @sn, InActive = @ia WHERE IDStandard = @id AND Lang = @l", new { id, l, sn, ia = b.InActive }, tx); else await con.ExecuteAsync("UPDATE ADS_StdChapter SET ChapterNo = @no WHERE IDStandard = @id AND Lang = @l", new { id, l, no = no.Length > 0 ? no : id.ToString() }, tx); continue; }
                string tr(string s) => typed || s.Length == 0 ? s : mark + s;
                await con.ExecuteAsync("UPDATE Groups SET GroupDesc = @d WHERE IDGroup = @id AND Lang = @l", new { id, l, d = tr(name) }, tx);
                if (root)
                {
                    var n = await con.ExecuteAsync("UPDATE ADS_Standard SET Description = @d, QShort = @sn, InActive = @ia WHERE IDStandard = @id AND Lang = @l", new { id, l, d = tr(desc), sn, ia = b.InActive }, tx);
                    if (n == 0) await con.ExecuteAsync("INSERT INTO ADS_Standard (IDStandard, Lang, Description, QShort, MaxQuestionID, InActive) VALUES (@id, @l, @d, @sn, 0, @ia)", new { id, l, d = tr(desc), sn, ia = b.InActive }, tx);
                }
                else
                {
                    var cn = no.Length > 0 ? no : id.ToString();
                    var n = await con.ExecuteAsync("UPDATE ADS_StdChapter SET ChapterNo = @no, ChapterName = @n, Description = @d WHERE IDStandard = @id AND Lang = @l", new { id, l, no = cn, n = tr(name), d = tr(desc) }, tx);
                    if (n == 0) await con.ExecuteAsync("INSERT INTO ADS_StdChapter (IDStandard, Lang, ChapterNo, ChapterName, Description, IDAssociation) VALUES (@id, @l, @no, @n, @d, 0)", new { id, l, no = cn, n = tr(name), d = tr(desc) }, tx);
                }
            }
            await tx.CommitAsync();
            GroupCache.Bump();
            return Ok(new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    // ───────────── remove ─────────────
    /// removeStandard: the node and everything below it go; a document that is linked only to nodes of this subtree blocks the removal
    /// (manual p. 157: documents linked to another node do not).
    [HttpDelete("standards/{id:int}")]
    public async Task<IActionResult> Remove(int id, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE IDGroup = @id AND GroupType = 1", new { id }) == 0) return Err(404, "This standard no longer exists. Reload the page.");
        var ids = new List<int> { id }; var frontier = new List<int> { id };
        while (frontier.Count > 0 && ids.Count < 5000)
        {
            var kids = (await con.QueryAsync<int>("SELECT DISTINCT IDGroup FROM Groups WHERE GroupType = 1 AND IDParent IN @f", new { f = frontier })).Except(ids).ToList();
            ids.AddRange(kids); frontier = kids;
        }
        var stuck = (await con.QueryAsync<(int Id, string? Name)>(@"SELECT DISTINCT dg.IdDoc AS Id, (SELECT TOP 1 DocName FROM Documents WHERE IDDoc = dg.IdDoc) AS Name FROM DocGrp dg
            WHERE dg.IdGroup IN @ids AND NOT EXISTS (SELECT 1 FROM DocGrp o WHERE o.IdDoc = dg.IdDoc AND o.IdGroup NOT IN @ids)", new { ids })).ToList();
        if (stuck.Count > 0)
            return Err(409, $"{stuck.Count} document(s) are linked only to this standard (e.g. {stuck[0].Id} {stuck[0].Name}). Link them to another node first.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM DocGrp WHERE IdGroup IN @ids", new { ids }, tx);
            await con.ExecuteAsync("DELETE FROM DocStandard WHERE IDGroup IN @ids", new { ids }, tx);
            await con.ExecuteAsync("DELETE FROM ADS_StdChapter WHERE IDStandard IN @ids", new { ids }, tx);
            await con.ExecuteAsync("DELETE FROM ADS_Standard WHERE IDStandard IN @ids", new { ids }, tx);
            await con.ExecuteAsync("DELETE FROM Groups WHERE IDGroup IN @ids", new { ids }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { removed = ids.Count });
    }

    // ───────────── mandatory ─────────────
    [HttpPut("standards/{id:int}/mandatory")]
    public async Task<IActionResult> Mandatory(int id, [FromBody] StdFlag b)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE IDGroup = @id AND GroupType = 1", new { id }) == 0) return Err(404, "This standard no longer exists.");
        try
        {
            if (b.Value) await con.ExecuteAsync("IF NOT EXISTS (SELECT 1 FROM DocStandard WHERE IDGroup = @id) INSERT INTO DocStandard (IDGroup) VALUES (@id)", new { id });
            else await con.ExecuteAsync("DELETE FROM DocStandard WHERE IDGroup = @id", new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        return Ok(new { id, mandatory = b.Value });
    }

    /// "Mandatory Standards" window: the set of root standards documents must be linked to before release.
    [HttpPut("standards/mandatory")]
    public async Task<IActionResult> SetMandatoryRoots([FromBody] StdIds b)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        var ids = (b.Ids ?? new()).Distinct().ToList();
        var all = (await con.QueryAsync<int>("SELECT IDGroup FROM Groups WHERE GroupType = 1 AND ISNULL(IDParent,0) = 0")).ToHashSet();
        if (ids.Any(i => !all.Contains(i))) return Err(400, "Only standards (not chapters) can be mandatory.");
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM DocStandard WHERE IDGroup IN @all AND IDGroup NOT IN @ids", new { all = all.ToList(), ids = ids.Count == 0 ? new List<int> { -1 } : ids }, tx);
            foreach (var id in ids) await con.ExecuteAsync("IF NOT EXISTS (SELECT 1 FROM DocStandard WHERE IDGroup = @id) INSERT INTO DocStandard (IDGroup) VALUES (@id)", new { id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { await tx.RollbackAsync(); return r; }
        return Ok(new { mandatory = ids.Count });
    }

    // ───────────── association ("link standards together") ─────────────
    [HttpGet("standards/associations")]
    public async Task<IActionResult> Associations()
    {
        await using var con = Con();
        var rows = await con.QueryAsync<(int Id, string? Name, int N)>(@"SELECT a.IDAssciation AS Id, a.Description AS Name,
            (SELECT COUNT(DISTINCT IDStandard) FROM ADS_StdChapter c WHERE c.IDAssociation = a.IDAssciation) AS N FROM ADS_StdAssociation a ORDER BY a.Description");
        return Ok(rows.Select(r => new { id = r.Id, name = r.Name, chapters = r.N }));
    }
    [HttpPost("standards/associations")]
    public async Task<IActionResult> AssocCreate([FromBody] StdAssocBody b)
    {
        var n = (b.Name ?? "").Trim(); if (n.Length == 0) return Err(400, "Please enter a name.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        try { var id = await con.ExecuteScalarAsync<int>("INSERT INTO ADS_StdAssociation (Description) VALUES (@n); SELECT CAST(SCOPE_IDENTITY() AS int)", new { n }); return Ok(new { id }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }
    [HttpPut("standards/associations/{id:int}")]
    public async Task<IActionResult> AssocRename(int id, [FromBody] StdAssocBody b)
    {
        var n = (b.Name ?? "").Trim(); if (n.Length == 0) return Err(400, "Please enter a name.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        try { await con.ExecuteAsync("UPDATE ADS_StdAssociation SET Description = @n WHERE IDAssciation = @id", new { n, id }); return Ok(new { id }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }
    [HttpDelete("standards/associations/{id:int}")]
    public async Task<IActionResult> AssocDelete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("UPDATE ADS_StdChapter SET IDAssociation = 0 WHERE IDAssociation = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM ADS_StdAssociation WHERE IDAssciation = @id", new { id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        return Ok(new { id });
    }
    /// createStdAssociation / delStdAssociation: link a chapter to an association (0 removes the link).
    [HttpPut("standards/{id:int}/association")]
    public async Task<IActionResult> AssocLink(int id, [FromBody] StdAssocBody b)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        try { await con.ExecuteAsync("UPDATE ADS_StdChapter SET IDAssociation = @a WHERE IDStandard = @id", new { id, a = b.IdAssociation }); return Ok(new { id }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    // ───────────── import (list of chapters, numbering decides the hierarchy) ─────────────
    static readonly Regex NoRx = new(@"^[0-9A-Za-z]+(\.[0-9A-Za-z]+)*$", RegexOptions.Compiled);
    [HttpPost("standards/import")]
    public async Task<IActionResult> Import([FromBody] StdImportBody b)
    {
        var lang = L(b.Lang); var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return Err(400, "Please enter the name of the standard.");
        var rows = (b.Rows ?? []).Where(r => !string.IsNullOrWhiteSpace(r.Name)).ToList();
        if (rows.Count == 0) return Err(400, "The file contains no chapters.");
        if (rows.Count > 5000) return Err(400, "A file may contain 5000 chapters at most.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE Lang = @lang AND GroupType = 1 AND ISNULL(IDParent,0) = 0 AND GroupDesc = @n", new { lang, n = name }) > 0)
            return Err(409, "A standard with this name already exists.");
        try
        {
            var langs = await ActiveLangs(con);
            await using var tx = await con.BeginTransactionAsync();
            var rootId = await NewNode(con, tx, langs, lang, 0, name, (b.Description ?? "").Trim(), (b.ShortName ?? "").Trim(), "");
            var byNo = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase); var made = 0;
            foreach (var r in rows)
            {
                var no = (r.ChapterNo ?? "").Trim().TrimEnd('.');
                var parent = rootId;
                if (NoRx.IsMatch(no))
                {   // parent = the longest existing prefix: 4.1.2 hangs below 4.1, below 4
                    var parts = no.Split('.');
                    for (var k = parts.Length - 1; k >= 1; k--) if (byNo.TryGetValue(string.Join('.', parts.Take(k)), out var p)) { parent = p; break; }
                }
                var nm = r.Name!.Trim(); if (nm.Length > 240) nm = nm[..240];
                var id = await NewNode(con, tx, langs, lang, parent, nm, (r.Description ?? "").Trim(), "", no.Length <= 20 ? no : no[..20]);
                if (no.Length > 0 && !byNo.ContainsKey(no)) byNo[no] = id;
                made++;
            }
            await tx.CommitAsync();
            GroupCache.Bump();
            return Ok(new { id = rootId, chapters = made });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }


    // ───────────── import of the Excel template (one sheet per language: Standard_EN, Standard_DE, ...) ─────────────
    sealed class XRow { public string Seq = "", Std = "", ChapterNo = "", Desc = "", Prefix = ""; public string[] Lv = new string[4]; public int Level; public string Name = ""; }

    /// Template columns: Seq, Standard, Level 1..4, ChapterNo, Desc, QuestionPrefix, Question1..6. Row 1 holds the standard, every other row one chapter
    /// whose name stands in the Level column that gives its depth. All sheets list the same chapters; each sheet carries the texts of its language.
    static (Dictionary<string, List<XRow>>? sheets, string? error) ReadTemplate(Stream xlsx)
    {
        Dictionary<string, List<string[]>> raw;
        try { raw = XlsxReader.Read(xlsx); } catch (Exception) { return (null, "The file is not a valid Excel (.xlsx) file."); }
        var res = new Dictionary<string, List<XRow>>(StringComparer.OrdinalIgnoreCase);
        foreach (var (sheet, rows) in raw)
        {
            var m = Regex.Match(sheet, @"^Standard[_ -]?([A-Za-z]{2})$");
            if (!m.Success) continue;
            var list = new List<XRow>();
            foreach (var r in rows.Skip(1))
            {
                string C(int i) => i < r.Length ? (r[i] ?? "").Trim() : "";
                var x = new XRow { Seq = C(0), Std = C(1), ChapterNo = C(6), Desc = C(7), Prefix = C(8) };
                for (var k = 0; k < 4; k++) { x.Lv[k] = C(2 + k); }
                if (x.Std.Length > 0) { x.Level = 0; x.Name = x.Std; }
                else { var k = Array.FindIndex(x.Lv, v => v.Length > 0); if (k < 0) continue; x.Level = k + 1; x.Name = x.Lv[k]; }
                list.Add(x);
            }
            res[m.Groups[1].Value.ToUpperInvariant()] = list;
        }
        if (res.Count == 0) return (null, "No sheet named Standard_<language> (for example Standard_EN) was found.");
        var first = res.Values.First();
        if (first.Count == 0 || first[0].Level != 0) return (null, "The first row of every sheet must contain the name of the standard.");
        foreach (var (l, v) in res)
            if (v.Count != first.Count || v.Select((x, i) => x.Level == first[i].Level).Contains(false)) return (null, $"Sheet Standard_{l} does not have the same rows and levels as the other sheets.");
        return (res, null);
    }

    [HttpPost("standards/import-xlsx")]
    [RequestSizeLimit(10_000_000)]
    public async Task<IActionResult> ImportXlsx(IFormFile? file, [FromForm] bool commit, [FromForm] string? lang)
    {
        if (file is null || file.Length == 0) return Err(400, "Choose the Excel file first.");
        (Dictionary<string, List<XRow>>? sheets, string? error) t;
        await using (var st = file.OpenReadStream()) t = ReadTemplate(st);
        if (t.sheets is null) return Err(400, t.error!);
        var sheets = t.sheets; var first = sheets.Values.First();
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Standards management' right.");
        var langs = await ActiveLangs(con);
        var unknown = sheets.Keys.Where(k => !langs.Contains(k)).ToList();
        var ui = L(lang);
        var baseLang = sheets.ContainsKey(ui) ? ui : sheets.ContainsKey("EN") ? "EN" : sheets.Keys.First();
        var baseRows = sheets[baseLang]; var name = baseRows[0].Name;
        var dup = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Groups WHERE GroupType = 1 AND ISNULL(IDParent,0) = 0 AND GroupDesc = @n", new { n = name });
        var prefix = baseRows.Skip(1).Select(r => r.Prefix).FirstOrDefault(p => p.Length > 0) ?? "";
        var info = new { name, chapters = baseRows.Count - 1, languages = sheets.Keys.OrderBy(k => k).ToArray(), ignored = unknown, missing = langs.Where(l => !sheets.ContainsKey(l)).ToArray(), duplicate = dup > 0, shortName = prefix.Length <= 5 ? prefix : prefix[..5] };
        if (!commit) return Ok(info);
        if (dup > 0) return Err(409, "A standard with this name already exists.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            var ids = new int[baseRows.Count]; var stack = new int[6];
            for (var i = 0; i < baseRows.Count; i++)
            {
                var r = baseRows[i];
                var parent = r.Level == 0 ? 0 : stack[r.Level - 1];
                var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDGroup), 0) + 1 FROM Groups WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
                foreach (var l in langs)
                {
                    var own = sheets.TryGetValue(l, out var rows) ? rows[i] : null;           // languages without a sheet get "<BASE>text" until they are translated
                    string txt(string v) => own is not null || v.Length == 0 ? v : $"<{baseLang}>{v}";
                    var nm = own?.Name ?? r.Name; var ds = own?.Desc ?? r.Desc;
                    if (nm.Length > 240) nm = nm[..240];
                    await con.ExecuteAsync(@"INSERT INTO Groups (IDGroup, Lang, GroupDesc, IDParent, SortG, SpecialType, DoNotPublish, IDProcessOwner, GroupType) VALUES (@id, @l, @d, @p, @id, 0, 0, 0, 1)",
                        new { id, l, d = txt(nm), p = parent }, tx);
                    if (parent == 0)
                        await con.ExecuteAsync("INSERT INTO ADS_Standard (IDStandard, Lang, Description, QShort, MaxQuestionID, InActive) VALUES (@id, @l, @d, @s, 0, 0)", new { id, l, d = txt(ds), s = info.shortName }, tx);
                    else
                    {
                        var no = r.ChapterNo.Length > 0 ? r.ChapterNo : id.ToString(); if (no.Length > 20) no = no[..20];
                        await con.ExecuteAsync("INSERT INTO ADS_StdChapter (IDStandard, Lang, ChapterNo, ChapterName, Description, IDAssociation) VALUES (@id, @l, @no, @n, @d, 0)", new { id, l, no, n = txt(nm), d = txt(ds) }, tx);
                    }
                }
                ids[i] = id; stack[r.Level] = id;
            }
            await tx.CommitAsync();
            GroupCache.Bump();
            return Ok(new { id = ids[0], info.chapters, info.languages, info.ignored, info.missing });
        }
        catch (SqlException e) when (Sql(e) is { } r2) { return r2; }
    }

    // ───────────── documents ↔ mandatory standards ─────────────
    /// Standards a document is linked to, and which mandatory ones it still lacks (FindDocStandardGrp / FindMandatoryStandards).
    [HttpGet("documents/{id:int}/standards")]
    public async Task<IActionResult> DocStandards(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await FeatureOn(con)) return Ok(new { items = Array.Empty<object>(), notifyAdmin = false });
        var mand = await MandatoryStandards.Status(con, id, lang);
        var flag = await mail_Flag(con, "LDSDocLinkToStandard");
        return Ok(new { items = mand.Select(m => new { id = m.Id, name = Plain(m.Name), linked = m.Linked }), notifyAdmin = flag });
    }
    static async Task<bool> mail_Flag(SqlConnection con, string name) => (await MailService.C(con, name)).Trim() is "1" or "True" or "true";

    [HttpPut("documents/{id:int}/standards")]
    public async Task<IActionResult> SetDocStandards(int id, [FromBody] DocStdBody b, [FromQuery] string lang = "EN")
    {
        var want = (b.Ids ?? []).Distinct().ToArray();
        await using var con = Con(); await con.OpenAsync();
        if (!await FeatureOn(con)) return Ok(new { id });
        try
        {
            var mand = (await con.QueryAsync<int>("SELECT IDGroup FROM DocStandard")).ToHashSet();
            var ok = want.Where(mand.Contains).ToArray();
            var below = new Dictionary<int, List<int>>();   // unticking a standard also removes links to its chapters
            foreach (var g in mand.Where(g => !ok.Contains(g))) below[g] = (await MandatoryStandards.Subtree(con, g, L(lang))).ToList();
            await using var tx = await con.BeginTransactionAsync();
            foreach (var g in mand)
            {
                if (ok.Contains(g))
                    await con.ExecuteAsync("IF NOT EXISTS (SELECT 1 FROM DocGrp WHERE IdDoc = @id AND IdGroup = @g) INSERT INTO DocGrp (IdDoc, IdGroup, SortD) SELECT @id, @g, ISNULL(MAX(SortD), 0) + 1 FROM DocGrp WHERE IdGroup = @g", new { id, g }, tx);
                else
                    await con.ExecuteAsync("DELETE FROM DocGrp WHERE IdDoc = @id AND IdGroup IN @gs", new { id, gs = below[g] }, tx);
            }
            await tx.CommitAsync();
            GroupCache.Bump();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        return Ok(new { id });
    }
}

/// The release check shared by single and bulk release: which mandatory standards is the document not yet linked to.
public static class MandatoryStandards
{
    public class Std { public int Id { get; set; } public string? Name { get; set; } public bool Linked { get; set; } }
    class GRow { public int IDGroup { get; set; } public int IDParent { get; set; } }

    /// A node and everything below it (chapters, sub-chapters). Language-independent: IDs are shared by all languages.
    public static async Task<HashSet<int>> Subtree(SqlConnection con, int root, string lang, System.Data.Common.DbTransaction? tx = null)
    {
        var rows = (await con.QueryAsync<GRow>("SELECT DISTINCT IDGroup, ISNULL(IDParent,0) AS IDParent FROM Groups WHERE GroupType = 1", transaction: tx)).ToList();
        var set = new HashSet<int> { root }; var todo = new Queue<int>(); todo.Enqueue(root);
        while (todo.Count > 0) { var p = todo.Dequeue(); foreach (var r in rows) if (r.IDParent == p && set.Add(r.IDGroup)) todo.Enqueue(r.IDGroup); }
        return set;
    }

    /// Every mandatory standard with whether the document is linked to it (FindDocStandardGrp): the document's links are walked up to their
    /// root standard, and only that root is compared with the mandatory list. Which chapter the document sits in does not matter.
    public static async Task<List<Std>> Status(SqlConnection con, int idDoc, string lang, System.Data.Common.DbTransaction? tx = null)
    {
        if (!await StandardsController.FeatureOn(con, tx)) return new List<Std>();
        var mand = (await con.QueryAsync<Std>("SELECT g.IDGroup AS Id, g.GroupDesc AS Name FROM Groups g WHERE g.Lang = @lang AND g.IDGroup IN (SELECT IDGroup FROM DocStandard) ORDER BY g.GroupDesc", new { lang }, tx)).ToList();
        if (mand.Count == 0) return mand;
        var parent = new Dictionary<int, int>();
        foreach (var r in await con.QueryAsync<GRow>("SELECT DISTINCT IDGroup, ISNULL(IDParent,0) AS IDParent FROM Groups WHERE GroupType = 1", transaction: tx)) parent[r.IDGroup] = r.IDParent;
        var roots = new HashSet<int>();
        foreach (var g in await con.QueryAsync<int>("SELECT IdGroup FROM DocGrp WHERE IdDoc = @idDoc", new { idDoc }, tx))
        {
            var cur = g; var guard = 0;
            while (parent.TryGetValue(cur, out var up) && up != 0 && guard++ < 50) cur = up;
            if (parent.ContainsKey(cur)) roots.Add(cur);
        }
        foreach (var m in mand) m.Linked = roots.Contains(m.Id);
        return mand;
    }

    public static async Task<List<string>> Missing(SqlConnection con, int idDoc, string lang, System.Data.Common.DbTransaction? tx = null) =>
        (await Status(con, idDoc, lang, tx)).Where(m => !m.Linked).Select(m => m.Name ?? "")
        .Select(n => n is { Length: > 4 } && n[0] == '<' && n[3] == '>' ? n[4..] : n).ToList();

    /// Mail to the administrators (template LDSDocLinkToStandard) when Config LDSDocLinkToStandard is on. Never throws.
    public static async Task NotifyAdmins(MailService mail, SqlConnection con, int idDoc, string lang, string docName, List<string> missing, ILogger? log = null)
    {
        try
        {
            if ((await MailService.C(con, "LDSDocLinkToStandard")).Trim() is not ("1" or "True" or "true")) return;
            var to = (await con.QueryAsync<string>(@"SELECT DISTINCT e.Email FROM Accounts a JOIN EmailContact e ON e.IDEC = a.IDEC
                WHERE a.IdAcc IN (SELECT IDAccount FROM AccountsRights WHERE RCod = 1 AND IDAccount IS NOT NULL
                    UNION SELECT aa.IdAcc FROM AccountsRights r JOIN AccountAccGrp aa ON aa.IdAccGroup = r.IDAccGroup WHERE r.RCod = 1)")).Where(MailService.IsValid).ToList();
            if (to.Count == 0) return;
            var tpl = await con.QueryFirstOrDefaultAsync<(string? Body, string? Subject)>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = 'LDSDocLinkToStandard' AND Lang = @lang", new { lang });
            var subject = string.IsNullOrWhiteSpace(tpl.Subject) ? "Added document has no linkage to Standard." : tpl.Subject!;
            var body = $"<p>Document <b>{System.Net.WebUtility.HtmlEncode(docName)}</b> (ID {idDoc}) was released without linkage to the mandatory standard(s): {System.Net.WebUtility.HtmlEncode(string.Join(", ", missing))}.</p>";
            await mail.SendAsync(to, [], subject, body, lang);
        }
        catch (Exception e) { log?.LogWarning(e, "Mandatory standard mail failed"); }
    }
}

/// Minimal .xlsx reader (zip + XML, no extra package): sheet name -> rows -> cell texts by column.
public static class XlsxReader
{
    static int Col(string cellRef) { var n = 0; foreach (var ch in cellRef) { if (ch is < 'A' or > 'Z') break; n = n * 26 + (ch - 'A' + 1); } return n - 1; }
    public static Dictionary<string, List<string[]>> Read(Stream s)
    {
        using var zip = new System.IO.Compression.ZipArchive(s, System.IO.Compression.ZipArchiveMode.Read);
        System.Xml.Linq.XDocument Load(string path) { var e = zip.GetEntry(path) ?? throw new InvalidDataException(path); using var st = e.Open(); return System.Xml.Linq.XDocument.Load(st); }
        System.Xml.Linq.XNamespace ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main", rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", pr = "http://schemas.openxmlformats.org/package/2006/relationships";
        var shared = new List<string>();
        if (zip.GetEntry("xl/sharedStrings.xml") is not null)
            shared = Load("xl/sharedStrings.xml").Root!.Elements(ns + "si").Select(si => string.Concat(si.Descendants(ns + "t").Select(t => t.Value))).ToList();
        var rels = Load("xl/_rels/workbook.xml.rels").Root!.Elements(pr + "Relationship").ToDictionary(r => (string)r.Attribute("Id")!, r => (string)r.Attribute("Target")!);
        var res = new Dictionary<string, List<string[]>>();
        foreach (var sh in Load("xl/workbook.xml").Root!.Element(ns + "sheets")!.Elements(ns + "sheet"))
        {
            var target = rels[(string)sh.Attribute(rel + "id")!]; target = target.TrimStart('/'); if (!target.StartsWith("xl/")) target = "xl/" + target;
            var rows = new List<string[]>();
            foreach (var row in Load(target).Root!.Element(ns + "sheetData")!.Elements(ns + "row"))
            {
                var cells = new List<string>();
                foreach (var c in row.Elements(ns + "c"))
                {
                    var ci = Col((string)c.Attribute("r")!); while (cells.Count <= ci) cells.Add("");
                    var t = (string?)c.Attribute("t"); var v = c.Element(ns + "v")?.Value ?? "";
                    cells[ci] = t == "s" && int.TryParse(v, out var k) && k < shared.Count ? shared[k] : t == "inlineStr" ? string.Concat(c.Descendants(ns + "t").Select(x => x.Value)) : v;
                }
                rows.Add(cells.ToArray());
            }
            res[(string)sh.Attribute("name")!] = rows;
        }
        return res;
    }
}
