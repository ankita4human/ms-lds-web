using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class SearchDocRow { public int IDDoc { get; set; } public string Lang { get; set; } = ""; public string? DocName { get; set; } public string? Extension { get; set; } public int Status { get; set; } public string? StatusName { get; set; } public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } }

/// Search inside the text of the documents (the "knowledge base" of the AI Assistant). Results are limited to the documents the user may see.
[ApiController, Route("api/lds/search"), Authorize]
public class SearchController(IConfiguration cfg, DocTextIndex index, DocIndexWorker worker) : ControllerBase
{
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    [HttpGet("content")]
    public async Task<IActionResult> Content([FromQuery] string q = "", [FromQuery] string lang = "EN", [FromQuery] int limit = 8)
    {
        q = (q ?? "").Trim();
        if (q.Length < 2) return BadRequest(new { error = "Type at least two characters." });
        limit = Math.Clamp(limit, 1, 25); lang = (lang ?? "EN").Trim().ToUpperInvariant();
        var hits = index.Search(q, lang, limit * 4);          // ask for more: some may be hidden from this user
        if (hits.Count == 0) return Ok(new { items = Array.Empty<object>(), indexed = index.Status.Documents, running = index.Status.Running });
        await using var con = Con(); await con.OpenAsync();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var ids = hits.Select(h => h.IdDoc).Distinct().ToList();
        var rows = (await con.QueryAsync<SearchDocRow>($@"SELECT d.IDDoc, d.Lang, d.DocName, d.Extension, ISNULL(d.[Status], 0) AS [Status], d.V1, d.V2, d.V3,
                ISNULL((SELECT TOP 1 StatusDesc FROM [Status] s WHERE s.IDStatus = d.[Status] AND s.Lang = d.Lang), '') AS StatusName
            FROM Documents d WHERE d.Lang = @lang AND d.IDDoc IN ({string.Join(",", ids)}) AND {vis}", new { lang })).ToDictionary(r => r.IDDoc);
        // Folder location(s) of each hit, only groups this user may see
        var all = await Access.Groups(con, lang);
        var accessible = Access.AccessibleGroups(all, await Access.Rights(con, Acc));
        var byG = all.ToDictionary(g => g.IDGroup);
        var links = (await con.QueryAsync<(int IdDoc, int? IdGroup)>($"SELECT IdDoc, IdGroup FROM DocGrp WHERE IdDoc IN ({string.Join(",", ids)})")).ToList();
        string? FolderOf(int idDoc)
        {
            foreach (var l in links.Where(x => x.IdDoc == idDoc && x.IdGroup is int g0 && byG.ContainsKey(g0) && (accessible is null || accessible.Contains(g0))))
            {
                var parts = new List<string>(); var cur = l.IdGroup!.Value; var guard = 0;
                while (byG.TryGetValue(cur, out var g) && guard++ < 50) { parts.Insert(0, g.GroupDesc ?? $"Group {g.IDGroup}"); cur = g.IDParent; }
                return string.Join(" / ", parts);
            }
            return null;
        }
        var items = hits.Where(h => rows.ContainsKey(h.IdDoc)).Take(limit).Select(h =>
        {
            var r = rows[h.IdDoc];
            return new { idDoc = r.IDDoc, lang = r.Lang, docName = r.DocName ?? "", ext = (r.Extension ?? "").TrimStart('.').ToLowerInvariant(), status = r.Status, statusName = r.StatusName ?? "", version = $"{r.V1 ?? 0}.{r.V2 ?? 0}.{r.V3 ?? 0}", folder = FolderOf(r.IDDoc), snippet = h.Snippet, score = Math.Round(h.Score, 2) };
        }).ToList();
        return Ok(new { items, indexed = index.Status.Documents, running = index.Status.Running });
    }

    [HttpGet("status")]
    public IActionResult Status() => Ok(index.Status);

    /// Admin: scan now (changed files only) or rebuild everything.
    [HttpPost("reindex")]
    public async Task<IActionResult> Reindex([FromQuery] bool full = false)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!Access.IsAdmin(await Access.Rights(con, Acc))) return StatusCode(403, new { error = "Only an administrator can rebuild the search index." });
        worker.Request(full);
        return Ok(new { started = true, full });
    }
}
