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
        await using var con = Con(); await con.OpenAsync();
        // Catchwords: documents whose ACTIVE catchword equals (or starts with) a word of the question are found too, also without a text hit
        var catchBy = await CatchMatches(con, q, lang, limit * 4);
        if (hits.Count == 0 && catchBy.Count == 0) return Ok(new { items = Array.Empty<object>(), indexed = index.Status.Documents, running = index.Status.Running });
        var vis = await Access.VisibleSql(con, Acc, lang);
        var ids = hits.Select(h => h.IdDoc).Concat(catchBy.Keys).Distinct().ToList();
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
        var order = hits.Select(h => (IdDoc: h.IdDoc, Snippet: h.Snippet, Score: (double)h.Score, Text: true))
            .Concat(catchBy.Keys.Where(k => hits.All(h => h.IdDoc != k)).Select(k => (IdDoc: k, Snippet: "", Score: 0.0, Text: false)))
            .Where(h => rows.ContainsKey(h.IdDoc))
            .OrderByDescending(h => h.Text && catchBy.ContainsKey(h.IdDoc)).ThenByDescending(h => h.Text).ThenByDescending(h => h.Score).Take(limit);
        var items = order.Select(h =>
        {
            var r = rows[h.IdDoc]; catchBy.TryGetValue(h.IdDoc, out var cw);
            return new { idDoc = r.IDDoc, lang = r.Lang, docName = r.DocName ?? "", ext = (r.Extension ?? "").TrimStart('.').ToLowerInvariant(), status = r.Status, statusName = r.StatusName ?? "", version = $"{r.V1 ?? 0}.{r.V2 ?? 0}.{r.V3 ?? 0}", folder = FolderOf(r.IDDoc), snippet = h.Snippet, score = Math.Round(h.Score, 2),
                catchWords = cw ?? new List<string>(), via = h.Text ? (cw is null ? "text" : "text+catch") : "catch" };
        }).ToList();
        return Ok(new { items, indexed = index.Status.Documents, running = index.Status.Running });
    }

    /// idDoc -> catchwords that matched the question. Only active catchwords count (word level, or document level when EnableDocLevelCatchword = 1).
    static async Task<Dictionary<int, List<string>>> CatchMatches(SqlConnection con, string q, string lang, int max)
    {
        var res = new Dictionary<int, List<string>>();
        var terms = System.Text.RegularExpressions.Regex.Matches(q.ToLowerInvariant(), @"\p{L}[\p{L}\p{M}\p{N}_'’-]*").Select(m => m.Value).Where(t => t.Length >= 2).Distinct().Take(12).ToList();
        if (terms.Count == 0) return res;
        var on = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'IsCatchWordEnabled'");
        if (on is "0" or "False" or "false") return res;
        var docLevel = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'EnableDocLevelCatchword'") == "1";
        var p = new DynamicParameters(); p.Add("lang", lang); var cond = new List<string>();
        for (var i = 0; i < terms.Count; i++)
        {
            p.Add("t" + i, terms[i]); cond.Add($"c.CatchLong = @t{i}");
            if (terms[i].Length >= 3) { p.Add("p" + i, terms[i].Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%"); cond.Add($"c.CatchLong LIKE @p{i}"); }
        }
        var rows = await con.QueryAsync<(int IdDoc, string Word)>($@"SELECT DISTINCT TOP ({max * 5}) dc.IdDoc, c.CatchLong FROM DocCatch dc JOIN Catch c ON c.IDCatch = dc.IdCatch AND c.Lang = @lang
            WHERE ({string.Join(" OR ", cond)}) AND ISNULL(c.IsNew, 0) <> 2 AND {(docLevel ? "ISNULL(dc.isActiv, 0)" : "ISNULL(c.IsActiv, 0)")} = 1", p);
        foreach (var (id, w) in rows) { if (!res.TryGetValue(id, out var l)) res[id] = l = new(); if (!l.Contains(w)) l.Add(w); }
        return res;
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
