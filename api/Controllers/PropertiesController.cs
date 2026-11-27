using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class PropBody
{
    public string? Lang { get; set; }
    public string? Name { get; set; }
    public int? TypeId { get; set; }
    public int? AuthorId { get; set; }
    public int? OwnerId { get; set; }      // 0 = no process owner
    public string? Reason { get; set; }
}
class PropDoc
{
    public string Lang { get; set; } = "";
    public string? DocName { get; set; }
    public int Status { get; set; }
    public int Type { get; set; }
    public int? IdCre { get; set; }
    public int? IdProcessOwner { get; set; }
    public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; }
}

/// General tab of the document properties (manual p. 18-20): Name, Type, Author and Process owner can be changed with a reason
/// ("Reason for change" window). Needs the Admin Document right (37) or Admin. The reason is kept in "Property Changes" (Archives tab);
/// a published document is published again automatically. Type, Author and Process owner apply to every language of the document.
[ApiController, Route("api/lds/documents/{id:int}/properties"), Authorize]
public class PropertiesController(IConfiguration cfg, IMemoryCache cache, PublishQueue queue, ILogger<PropertiesController> log) : ControllerBase
{
    const int RightAdminDoc = 37;
    const int StPublished = 3, StArchived = 5, StFrozen = 11;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    static string L(string? l) => (l ?? "").Trim().ToUpperInvariant();
    static string Clean(string? s) => new string((s ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();

    async Task<bool> CanEdit(SqlConnection con)
    {
        var r = await Access.Rights(con, Acc);
        return Access.IsAdmin(r) || r.Any(x => x.RCod == RightAdminDoc);
    }
    static Task<List<PropDoc>> Rows(SqlConnection con, int id, SqlTransaction? tx = null) =>
        con.QueryAsync<PropDoc>("SELECT Lang, DocName, ISNULL(Status, 0) AS Status, ISNULL([Type], 0) AS [Type], IdCre, IdProcessOwner, ISNULL(V1, 0) AS V1, ISNULL(V2, 0) AS V2, ISNULL(V3, 0) AS V3 FROM Documents WHERE IDDoc = @id", new { id }, tx).ContinueWith(t => t.Result.ToList());

    [HttpGet]
    public async Task<IActionResult> Get(int id, [FromQuery] string lang)
    {
        lang = L(lang);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var vis = await Access.VisibleSql(con, Acc, lang);
        if (await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang }) == 0) return NotFound(new { error = "Document not found." });
        var can = await CanEdit(con);
        var cur = (await Rows(con, id)).FirstOrDefault(r => r.Lang.Equals(lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        if (!can) return Ok(new { canEdit = false });
        var types = (await con.QueryAsync<IdName>("SELECT IDType AS Id, REPLACE(ISNULL(TypeDesc, CONCAT('Type ', IDType)), '<DE>', '') AS Name FROM DocTypes WHERE Lang = @lang AND IDType IS NOT NULL", new { lang }))
            .OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        // active users plus whoever is set now (so an inactive author still shows)
        var users = (await con.QueryAsync<IdName>(@"SELECT a.IdAcc AS Id, CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE CONCAT(e.Name, '[', a.AccShort, ']') END AS Name
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC
            WHERE ISNULL(a.IsDeleted, 0) = 0 AND (ISNULL(a.AccInactive, 0) = 0 OR a.IdAcc IN (@a, @o))", new { a = cur.IdCre ?? -1, o = cur.IdProcessOwner ?? -1 }))
            .OrderBy(u => u.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        return Ok(new
        {
            canEdit = true, name = cur.DocName, typeId = cur.Type, authorId = cur.IdCre ?? 0, ownerId = cur.IdProcessOwner ?? 0,
            status = cur.Status, published = cur.Status == StPublished,
            types = types.Select(t => new { id = t.Id, name = t.Name }), users = users.Select(u => new { id = u.Id, name = u.Name }),
        });
    }

    [HttpPut]
    public async Task<IActionResult> Put(int id, [FromBody] PropBody b)
    {
        var lang = L(b.Lang);
        if (lang.Length != 2) return BadRequest(new { error = "Language is missing." });
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        if (!await CanEdit(con)) return StatusCode(403, new { error = "Changing document properties needs the Admin Document right." });
        var vis = await Access.VisibleSql(con, Acc, lang);
        if (await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang }) == 0) return NotFound(new { error = "Document not found." });
        var rows = await Rows(con, id);
        var cur = rows.FirstOrDefault(r => r.Lang.Equals(lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        if (cur.Status is StArchived or StFrozen) return Conflict(new { error = "An archived or frozen document cannot be changed." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND checkedOut = 1 AND accountId <> @acc", new { id, acc = Acc }) > 0)
            return Conflict(new { error = "The document is checked out by another user." });

        var reason = Clean(b.Reason);
        if (reason.Length > 1000) reason = reason[..1000];
        var changes = new List<(string Type, string? Old, string? New)>();

        string? newName = null;
        if (b.Name is not null)
        {
            var n = Clean(b.Name);
            if (n.Length == 0) return BadRequest(new { error = "Please enter a document name." });
            if (n.Length > 80) return BadRequest(new { error = "The name is too long (80 characters at most)." });
            if (!string.Equals(n, cur.DocName, StringComparison.Ordinal)) { newName = n; changes.Add(("Name", cur.DocName, n)); }
        }
        int? newType = null;
        if (b.TypeId is { } t && t != cur.Type)
        {
            var names = (await con.QueryAsync<IdName>("SELECT IDType AS Id, REPLACE(ISNULL(TypeDesc, ''), '<DE>', '') AS Name FROM DocTypes WHERE Lang = @lang AND IDType IN (@o, @n)", new { lang, o = cur.Type, n = t })).ToDictionary(x => x.Id, x => x.Name);
            if (!names.ContainsKey(t)) return BadRequest(new { error = "This document type does not exist." });
            newType = t; changes.Add(("Type", names.GetValueOrDefault(cur.Type) ?? cur.Type.ToString(), names[t]));
        }
        async Task<string> Who(int? acc) => (acc is null || acc <= 0) ? "-" :
            await con.ExecuteScalarAsync<string?>("SELECT TOP 1 CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE CONCAT(e.Name, '[', a.AccShort, ']') END FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = @acc", new { acc }) ?? acc.ToString()!;
        int? newAuthor = null;
        if (b.AuthorId is { } au && au > 0 && au != (cur.IdCre ?? 0))
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc = @au AND ISNULL(IsDeleted, 0) = 0", new { au }) == 0) return BadRequest(new { error = "This author does not exist." });
            newAuthor = au; changes.Add(("Author", await Who(cur.IdCre), await Who(au)));
        }
        int? newOwner = null;
        if (b.OwnerId is { } ow && ow >= 0 && ow != (cur.IdProcessOwner ?? 0))
        {
            if (ow > 0 && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc = @ow AND ISNULL(IsDeleted, 0) = 0", new { ow }) == 0) return BadRequest(new { error = "This process owner does not exist." });
            newOwner = ow; changes.Add(("Process owner", await Who(cur.IdProcessOwner), await Who(ow)));
        }
        if (changes.Count == 0) return BadRequest(new { error = "Nothing was changed." });
        if (reason.Length == 0) return BadRequest(new { error = "Please enter the reason for the change." });

        var republish = new List<PropDoc>();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var t0 = (SqlTransaction)tx;
            if (newName is not null) await con.ExecuteAsync("UPDATE Documents SET DocName = @newName, DateMod = @now, IdMod = @acc WHERE IDDoc = @id AND Lang = @lang", new { newName, now = DateTime.Now, acc = Acc, id, lang }, t0);
            if (newType is not null) await con.ExecuteAsync("UPDATE Documents SET [Type] = @newType WHERE IDDoc = @id", new { newType, id }, t0);
            if (newAuthor is not null) await con.ExecuteAsync("UPDATE Documents SET IdCre = @newAuthor WHERE IDDoc = @id", new { newAuthor, id }, t0);
            if (newOwner is not null) await con.ExecuteAsync("UPDATE Documents SET IdProcessOwner = @o WHERE IDDoc = @id", new { o = newOwner == 0 ? (int?)null : newOwner, id }, t0);
            foreach (var c in changes) await PropMods.Log(con, t0, id, lang, cur.V1, cur.V2, cur.V3, Acc, c.Type, c.Old, c.New, reason, log);
            await tx.CommitAsync();
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230)
        {
            await tx.RollbackAsync();
            return StatusCode(403, new { error = "The database login may not update documents here (needs UPDATE on Documents and INSERT on PropertyMods). " + ex.Message });
        }
        catch { await tx.RollbackAsync(); throw; }

        // manual p. 19: a published document is published again after the change (every language that is published)
        var after = await Rows(con, id);
        foreach (var r in after.Where(r => r.Status == StPublished && (r.Lang.Equals(lang, StringComparison.OrdinalIgnoreCase) || newType is not null || newAuthor is not null || newOwner is not null)))
        {
            queue.Enqueue(id, r.Lang, r.DocName ?? "", $"{r.V1}.{r.V2}.{r.V3}", Acc, "publish"); republish.Add(r);
        }
        cache.Remove($"stats:{Acc}:{lang}");
        return Ok(new { idDoc = id, lang, changed = changes.Select(c => c.Type), republished = republish.Select(r => r.Lang) });
    }
}
