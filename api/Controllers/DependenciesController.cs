using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class DepBody { public string? Lang { get; set; } public string? Name { get; set; } }
public class DepDocsBody { public int[]? Ids { get; set; } }
public class DepEditBody { public string? Lang { get; set; } public int[]? Ids { get; set; } }
public class DepDoc { public int IdDoc { get; set; } public string? Lang { get; set; } public string? DocName { get; set; } public int Status { get; set; } public string? StatusName { get; set; } public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; } public string? Dependency { get; set; } public int IdCollect { get; set; } }

/// Options > Dependency (manual p. 83-85, 167-170). A dependency is a group of documents of one language (tables Collect / DocCollect, right 32).
/// When a document of the group is changed, the other documents of the group go to Edit mode (legacy DocumentFactory.doCollection / doCollection2);
/// Config EnableEditDependentDoc = 1 lets the user choose which ones (manual p. 167), 0 moves all of them.
[ApiController, Route("api/lds"), Authorize]
public class DependenciesController(IConfiguration cfg, IMemoryCache cache, MailService mail, DocPublisher publisher, ILogger<DependenciesController> log) : ControllerBase
{
    const int RightCollect = 32;
    const int StEdit = 2, StPublished = 3, StVerified = 7, StReleased = 8, StBlocked = 9;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static IActionResult? Sql(SqlException e) => e.Number is 229 or 262 or 230 ? Err(403, "The database account used by the API may not change dependencies. Run the dependency section of sql/grant-pl_app.sql.") : null;
    async Task<bool> Can(SqlConnection con) { var r = await Access.Rights(con, Acc); return Access.IsAdmin(r) || r.Any(x => x.RCod == RightCollect); }

    const string DocSql = @"SELECT d.IDDoc AS IdDoc, d.Lang, d.DocName, d.Status, ISNULL(s.StatusDesc, CASE d.Status WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', d.Status) END) AS StatusName,
            ISNULL(d.V1,0) AS V1, ISNULL(d.V2,0) AS V2, ISNULL(d.V3,0) AS V3
        FROM Documents d OUTER APPLY (SELECT TOP 1 StatusDesc FROM [Status] WHERE IDStatus = d.Status AND Lang = d.Lang) s";

    [HttpGet("dependencies")]
    public async Task<IActionResult> List([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        var rows = await con.QueryAsync<(int Id, string? Name, int N)>(@"SELECT c.IDCollect AS Id, c.CollectName AS Name,
            (SELECT COUNT(DISTINCT dc.IDDoc) FROM DocCollect dc WHERE dc.IDCollect = c.IDCollect) AS N FROM Collect c WHERE c.Lang = @lang ORDER BY c.CollectName", new { lang });
        return Ok(new { items = rows.Select(r => new { id = r.Id, name = r.Name, documents = r.N }), canManage = await Can(con), editChoice = await Choice(con) });
    }
    static async Task<bool> Choice(SqlConnection con) => (await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'EnableEditDependentDoc'"))?.Trim() == "1";

    [HttpPost("dependencies")]
    public async Task<IActionResult> Create([FromBody] DepBody b)
    {
        var lang = L(b.Lang); var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return Err(400, "Please enter a name.");
        if (name.Length > 50) return Err(400, "The name may have at most 50 characters.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Management dependencies' right.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Collect WHERE Lang = @lang AND CollectName = @name", new { lang, name }) > 0) return Err(409, "A dependency with this name already exists.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDCollect), 0) + 1 FROM Collect WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            await con.ExecuteAsync("INSERT INTO Collect (IDCollect, Lang, CollectName) VALUES (@id, @lang, @name)", new { id, lang, name }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    [HttpPut("dependencies/{id:int}")]
    public async Task<IActionResult> Rename(int id, [FromBody] DepBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return Err(400, "Please enter a name.");
        if (name.Length > 50) return Err(400, "The name may have at most 50 characters.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Management dependencies' right.");
        var lang = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Lang FROM Collect WHERE IDCollect = @id", new { id });
        if (lang is null) return Err(404, "This dependency no longer exists.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Collect WHERE Lang = @lang AND CollectName = @name AND IDCollect <> @id", new { lang, name, id }) > 0) return Err(409, "A dependency with this name already exists.");
        try { await con.ExecuteAsync("UPDATE Collect SET CollectName = @name WHERE IDCollect = @id", new { id, name }); return Ok(new { id }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    [HttpDelete("dependencies/{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Management dependencies' right.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM DocCollect WHERE IDCollect = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM Collect WHERE IDCollect = @id", new { id }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    [HttpGet("dependencies/{id:int}/documents")]
    public async Task<IActionResult> Docs(int id)
    {
        await using var con = Con();
        var lang = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Lang FROM Collect WHERE IDCollect = @id", new { id });
        if (lang is null) return Err(404, "This dependency no longer exists.");
        var rows = await con.QueryAsync<DepDoc>($"{DocSql} WHERE d.Lang = @lang AND d.IDDoc IN (SELECT IDDoc FROM DocCollect WHERE IDCollect = @id) ORDER BY d.DocName, d.IDDoc", new { id, lang });
        return Ok(new { lang, items = rows.Select(r => new { r.IdDoc, name = r.DocName, r.Status, statusName = r.StatusName, version = $"{r.V1}.{r.V2}.{r.V3}" }) });
    }

    /// Documents to choose from ("Choose Group" of the manual: the selected language, original-language documents only; blocked ones cannot be added).
    [HttpGet("dependencies/candidates")]
    public async Task<IActionResult> Candidates([FromQuery] string lang = "EN", [FromQuery] string? q = null, [FromQuery] int? groupId = null)
    {
        lang = L(lang);
        await using var con = Con();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var text = (q ?? "").Trim(); int.TryParse(text, out var asId);
        var where = $"d.Lang = @lang AND d.LangStandard = d.Lang AND ISNULL(d.Status, 0) <> {StBlocked} AND {vis}";
        if (groupId is > 0) where += " AND d.IDDoc IN (SELECT IdDoc FROM DocGrp WHERE IdGroup = @groupId)";
        if (text.Length > 0) where += " AND (d.DocName LIKE @like OR d.IDDoc = @asId)";
        var rows = await con.QueryAsync<DepDoc>($"{DocSql.Replace("SELECT d.IDDoc", "SELECT TOP 200 d.IDDoc")} WHERE {where} ORDER BY d.DocName, d.IDDoc",
            new { lang, groupId, like = "%" + text.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%", asId });
        return Ok(rows.Select(r => new { r.IdDoc, name = r.DocName, r.Status, statusName = r.StatusName, version = $"{r.V1}.{r.V2}.{r.V3}" }));
    }

    [HttpPost("dependencies/{id:int}/documents")]
    public async Task<IActionResult> AddDocs(int id, [FromBody] DepDocsBody b)
    {
        var ids = (b.Ids ?? []).Distinct().ToArray();
        if (ids.Length == 0) return Err(400, "Choose at least one document.");
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Management dependencies' right.");
        var lang = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Lang FROM Collect WHERE IDCollect = @id", new { id });
        if (lang is null) return Err(404, "This dependency no longer exists.");
        var ok = (await con.QueryAsync<int>($"SELECT d.IDDoc FROM Documents d WHERE d.Lang = @lang AND d.LangStandard = d.Lang AND ISNULL(d.Status, 0) <> {StBlocked} AND d.IDDoc IN @ids", new { lang, ids })).ToList();
        try
        {
            foreach (var d in ok) await con.ExecuteAsync("IF NOT EXISTS (SELECT 1 FROM DocCollect WHERE IDCollect = @id AND IDDoc = @d) INSERT INTO DocCollect (IDCollect, IDDoc) VALUES (@id, @d)", new { id, d });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        return Ok(new { added = ok.Count, skipped = ids.Length - ok.Count });
    }

    [HttpDelete("dependencies/{id:int}/documents/{idDoc:int}")]
    public async Task<IActionResult> RemoveDoc(int id, int idDoc)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await Can(con)) return Err(403, "You need the 'Management dependencies' right.");
        try { await con.ExecuteAsync("DELETE FROM DocCollect WHERE IDCollect = @id AND IDDoc = @idDoc", new { id, idDoc }); return Ok(new { id, idDoc }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    // ───────────── dependent documents of a document that is being changed ─────────────
    /// Documents that depend on this one (same group), in every language, with the dependency they come from.
    [HttpGet("documents/{id:int}/dependents")]
    public async Task<IActionResult> Dependents(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        var rows = await Dependents(con, id, lang);
        return Ok(new { choose = await Choice(con), items = rows.Select(r => new { r.IdDoc, name = r.DocName, lang = r.Lang, r.Status, statusName = r.StatusName, version = $"{r.V1}.{r.V2}.{r.V3}", dependency = r.Dependency, movable = r.Status is StPublished or StVerified or StReleased }) });
    }
    static async Task<List<DepDoc>> Dependents(SqlConnection con, int id, string lang) =>
        (await con.QueryAsync<DepDoc>($@"{DocSql} JOIN DocCollect dc ON dc.IDDoc = d.IDDoc
            JOIN Collect c ON c.IDCollect = dc.IDCollect AND c.Lang = @lang
            WHERE d.Lang = @lang AND d.IDDoc <> @id AND dc.IDCollect IN (SELECT IDCollect FROM DocCollect WHERE IDDoc = @id)
            ORDER BY d.DocName, d.IDDoc".Replace("SELECT d.IDDoc AS IdDoc", "SELECT d.IDDoc AS IdDoc, c.CollectName AS Dependency, c.IDCollect AS IdCollect"), new { id, lang })).GroupBy(x => x.IdDoc).Select(g => g.First()).ToList();

    /// Puts the chosen dependent documents in Edit mode (doCollection2): a published one is archived and gets the next middle version (x.y+1.0),
    /// a verified / released one only changes to Edit. Every language of the document follows. The linked users get the dependency mail.
    [HttpPost("documents/{id:int}/dependents/edit")]
    public async Task<IActionResult> Move(int id, [FromBody] DepEditBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!(Access.IsAdmin(rights) || rights.Any(r => r.RCod is 38 or 37 or RightCollect))) return Err(403, "You do not have the right to edit documents.");
        var allowed = (await Dependents(con, id, lang)).Select(x => x.IdDoc).ToHashSet();
        var ids = (b.Ids ?? []).Distinct().Where(allowed.Contains).ToArray();
        if (ids.Length == 0) return Ok(new { moved = 0, documents = Array.Empty<int>() });
        var (dp, ap, dbId) = await DocFiles.Paths(con);
        var now = DateTime.Now; var created = new List<string>(); var moved = new List<(int Id, string Lang)>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
        try
        {
            foreach (var did in ids)
            {
                var rows = (await con.QueryAsync<FrzRow>("SELECT Lang, LangStandard, DocName, Status, V1, V2, V3, Extension, DateExp, DatePub, DoNotExpire FROM Documents WHERE IDDoc = @did", new { did }, tx)).ToList();
                foreach (var r in rows)
                {
                    if (r.Status == StPublished)
                    {
                        await FrozenController.ArchiveFile(con, tx, dp, ap, dbId, did, r, created);
                        var v1 = r.V1 ?? 0; var v2 = (r.V2 ?? 0) + 1;
                        await con.ExecuteAsync("UPDATE Documents SET Status = @st, V2 = @v2, V3 = 0, DateMod = @now, IdMod = @acc WHERE IDDoc = @did AND Lang = @l AND Status = @was", new { st = StEdit, v2, now, acc = Acc, did, l = r.Lang, was = StPublished }, tx);
                        await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@did, @l, @v1, @v2, 0, @acc, @now, @d)", new { did, l = r.Lang, v1, v2, acc = Acc, now, d = $"Dependency of document {id}" }, tx);
                        moved.Add((did, r.Lang!));
                    }
                    else if (r.Status is StVerified or StReleased)
                    {
                        await con.ExecuteAsync("UPDATE Documents SET Status = @st, DateMod = @now, IdMod = @acc WHERE IDDoc = @did AND Lang = @l AND Status = @was", new { st = StEdit, now, acc = Acc, did, l = r.Lang, was = r.Status }, tx);
                        moved.Add((did, r.Lang!));
                    }
                }
            }
            await tx.CommitAsync();
        }
        catch (Exception ex)
        {
            try { await tx.RollbackAsync(); } catch { /* gone */ }
            foreach (var p in created) try { System.IO.File.Delete(p); } catch { /* best effort */ }
            log.LogError(ex, "dependent documents of {Id} could not be moved to Edit", id);
            if (ex is SqlException { Number: 229 or 262 or 230 }) return Err(403, "The database login may not write here. " + ex.Message);
            throw;
        }
        cache.Remove($"stats:{Acc}:{lang}");
        var mailOn = await MailService.C(con, "SendDefaultMail") == "1" && (await mail.Settings(con)).Configured;
        if (mailOn)
            foreach (var (did, l) in moved.Where(m => m.Lang == lang))
                await TemplateMail.Send(con, mail, publisher, did, l, "LDSDependency", new Dictionary<string, object?> { ["Status"] = StEdit }, log);
        return Ok(new { moved = moved.Select(m => m.Id).Distinct().Count(), documents = moved.Select(m => m.Id).Distinct() });
    }
}
