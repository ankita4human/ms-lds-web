using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class NoWebBody { public string? Lang { get; set; } public bool Hide { get; set; } }
public class BlockBody { public string? Lang { get; set; } public string? Reason { get; set; } }
public class BlkRow { public string Lang { get; set; } = ""; public string? LangStandard { get; set; } public int? Status { get; set; } public bool IsCycle { get; set; } public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } }

/// Right-click menu of a document: "Don't view in web" (manual p. 18, 127; legacy changeDocPublish = Documents.DoNotPublish for every language)
/// and "Block" / "Unblock" (manual p. 94-96, 127; legacy blockDocument = status 9 for every language, reason is written to the history).
/// Block needs the Admin or Admin document right; a document in a workflow cannot be blocked.
[ApiController, Route("api/lds/documents"), Authorize]
public class DocWebBlockController(IConfiguration cfg, ILogger<DocWebBlockController> log) : ControllerBase
{
    const int RightAdminDoc = 37, RightEdit = 38, StEdit = 2, StBlocked = 9, StFrozen = 11;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };

    async Task<(List<BlkRow>? rows, IActionResult? err)> Load(SqlConnection con, int id, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        var seen = await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (seen == 0) return (null, Err(404, "Document not found."));
        var rows = (await con.QueryAsync<BlkRow>("SELECT Lang, LangStandard, Status, CAST(ISNULL(IsCycle, 0) AS bit) AS IsCycle, V1, V2, V3 FROM Documents WHERE IDDoc = @id", new { id })).ToList();
        return (rows, null);
    }
    static IActionResult? SqlErr(SqlException e) => e.Number is 229 or 262 or 230
        ? Err(403, "The database account used by the API may not change this. Run the document section of sql/grant-pl_app.sql. " + e.Message) : null;

    [HttpPost("{id:int}/noweb")]
    public async Task<IActionResult> NoWeb(int id, [FromBody] NoWebBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod is RightEdit or RightAdminDoc)) return Err(403, "You do not have the right to change documents.");
        var (rows, err) = await Load(con, id, lang); if (err is not null) return err;
        try { await con.ExecuteAsync("UPDATE Documents SET DoNotPublish = @h WHERE IDDoc = @id", new { id, h = b.Hide }); }
        catch (SqlException e) when (SqlErr(e) is { } r) { return r; }
        return Ok(new { idDoc = id, hidden = b.Hide });
    }

    [HttpPost("{id:int}/block")]
    public async Task<IActionResult> Block(int id, [FromBody] BlockBody b)
    {
        var lang = L(b.Lang);
        var reason = (b.Reason ?? "").Trim();
        if (reason.Length > 450) return Err(400, "The reason can have 450 characters at most.");
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightAdminDoc)) return Err(403, "You need the Admin or Admin document right to block a document.");
        var (rows, err) = await Load(con, id, lang); if (err is not null) return err;
        var cur = rows!.FirstOrDefault(r => r.Lang == lang) ?? rows![0];
        if (cur.Status == StBlocked) return Err(409, "The document is already blocked.");
        if (cur.Status == StFrozen) return Err(409, "A frozen document cannot be blocked. Defrost it first.");
        if (rows!.Any(r => r.IsCycle)) return Err(409, "A document that is in a workflow cannot be blocked.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND ISNULL(checkedOut, 0) = 1", new { id }) > 0)
            return Err(409, "The document is checked out. Check it in first.");
        await using var tx = con.BeginTransaction();
        try
        {
            await con.ExecuteAsync("UPDATE Documents SET Status = @s WHERE IDDoc = @id", new { s = StBlocked, id }, tx);
            foreach (var r in rows)
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @l, @v1, @v2, @v3, @acc, @now, @desc)",
                    new { id, l = r.Lang, v1 = r.V1 ?? 0, v2 = r.V2 ?? 0, v3 = r.V3 ?? 0, acc = Acc, now = DateTime.Now, desc = reason.Length > 0 ? $"Document blocked: {reason}" : "Document blocked" }, tx);
            tx.Commit();
        }
        catch (SqlException e) { tx.Rollback(); log.LogError(e, "block failed for {Id}", id); return SqlErr(e) ?? Err(500, "Blocking failed: " + e.Message); }
        return Ok(new { idDoc = id, status = StBlocked });
    }

    [HttpPost("{id:int}/unblock")]
    public async Task<IActionResult> Unblock(int id, [FromBody] BlockBody b)
    {
        var lang = L(b.Lang);
        var reason = (b.Reason ?? "").Trim();
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightAdminDoc)) return Err(403, "You need the Admin or Admin document right to unblock a document.");
        var (rows, err) = await Load(con, id, lang); if (err is not null) return err;
        var cur = rows!.FirstOrDefault(r => r.Lang == lang) ?? rows![0];
        if (cur.Status != StBlocked) return Err(409, "The document is not blocked.");
        await using var tx = con.BeginTransaction();
        try
        {
            await con.ExecuteAsync("UPDATE Documents SET Status = @s WHERE IDDoc = @id AND Status = @b", new { s = StEdit, b = StBlocked, id }, tx);
            foreach (var r in rows)
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @l, @v1, @v2, @v3, @acc, @now, @desc)",
                    new { id, l = r.Lang, v1 = r.V1 ?? 0, v2 = r.V2 ?? 0, v3 = r.V3 ?? 0, acc = Acc, now = DateTime.Now, desc = reason.Length > 0 ? $"Document unblocked: {reason}" : "Document unblocked (status Edit)" }, tx);
            tx.Commit();
        }
        catch (SqlException e) { tx.Rollback(); log.LogError(e, "unblock failed for {Id}", id); return SqlErr(e) ?? Err(500, "Unblocking failed: " + e.Message); }
        return Ok(new { idDoc = id, status = StEdit });
    }
}
