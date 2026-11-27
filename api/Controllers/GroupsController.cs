using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public record GroupCount(int IdGroup, int Count);
public class GroupMeta { public int IdGroup { get; set; } public bool DoNotPublish { get; set; } public bool PubOriginal { get; set; } public int IdProcessOwner { get; set; } public string? ProcessOwner { get; set; } }

[ApiController, Route("api/lds/groups"), Authorize]
public class GroupsController(IConfiguration cfg, IMemoryCache cache) : ControllerBase
{
    /// The document group tree for one language: only groups the user can navigate to,
    /// with the number of visible documents linked directly to each group.
    [HttpGet]
    public async Task<IActionResult> Tree([FromQuery] string lang = "EN", [FromQuery] int? parent = null, [FromQuery] bool counts = false)
    {
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        var key = GroupCache.TreeKey(acc, lang) + (parent is null ? "" : $":p{parent}") + (counts ? "" : ":nc");   // parent = one level only (progressive loading)
        if (cache.TryGetValue(key, out object? hit) && hit is not null) return Ok(hit);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var all = await Access.Groups(con, lang);
        var accessible = Access.AccessibleGroups(all, await Access.Rights(con, acc));
        var nav = Access.NavigableGroups(all, accessible);

        var vis = await Access.VisibleSql(con, acc, lang);
        var levelIds = parent is null ? null : all.Where(g => g.IDParent == parent && nav.Contains(g.IDGroup)).Select(g => g.IDGroup).ToHashSet();
        var gids = (accessible ?? all.Select(g => g.IDGroup).ToHashSet()).Where(i => levelIds is null || levelIds.Contains(i)).ToArray();
        // document counts are slow on big databases: the web page no longer asks for them (counts=false); they are only calculated when counts=true is requested
        var cnt = counts ? await Counts(con, acc, lang, vis, gids) : new Dictionary<int, int>();

        // properties shown in the right-click menu: web visibility, publish as original, process owner, template folder (same for every user: cached)
        var (meta, templateGroup) = await Access.Cached($"gmeta:{lang}:{GroupCache.TreeKey(0, "")}", TimeSpan.FromSeconds(60), async () =>
        {
            var m = (await con.QueryAsync<GroupMeta>(@"SELECT g.IDGroup AS IdGroup, CAST(ISNULL(g.DoNotPublish, 0) AS bit) AS DoNotPublish, ISNULL(g.IDProcessOwner, 0) AS IdProcessOwner,
                    CAST(CASE WHEN EXISTS (SELECT 1 FROM GroupProperties p WHERE p.IdGroup = g.IDGroup AND ISNULL(p.isPubOriginal, 0) = 1) THEN 1 ELSE 0 END AS bit) AS PubOriginal,
                    ISNULL(NULLIF(e.Name, ''), a.AccShort) AS ProcessOwner
                FROM Groups g LEFT JOIN Accounts a ON a.IdAcc = g.IDProcessOwner LEFT JOIN EmailContact e ON e.IDEC = a.IDEC
                WHERE g.Lang = @lang AND g.IDGroup IS NOT NULL", new { lang })).GroupBy(x => x.IdGroup).ToDictionary(x => x.Key, x => x.First());
            var template = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'GroupTemplate'");
            int.TryParse(template, out var tg);
            return (m, tg);
        });
        var rights = await Access.Rights(con, acc);

        var parentsWithKids = all.Where(x => nav.Contains(x.IDGroup)).Select(x => x.IDParent).ToHashSet();   // computed once: no scan of all groups per group
        var groups = all.Where(g => nav.Contains(g.IDGroup) && (levelIds is null || levelIds.Contains(g.IDGroup))).OrderBy(g => g.SortG).ThenBy(g => g.GroupDesc)
            .Select(g =>
            {
                meta.TryGetValue(g.IDGroup, out var m);
                return new
                {
                    idGroup = g.IDGroup, idParent = g.IDParent, name = g.GroupDesc ?? $"Group {g.IDGroup}", sort = g.SortG, groupType = g.GroupType,
                    docCount = cnt.GetValueOrDefault(g.IDGroup), accessible = accessible is null || accessible.Contains(g.IDGroup),
                    hasChildren = parentsWithKids.Contains(g.IDGroup),
                    doNotPublish = m?.DoNotPublish ?? false, pubOriginal = m?.PubOriginal ?? false,
                    idProcessOwner = m?.IdProcessOwner ?? 0, processOwner = m?.ProcessOwner
                };
            });

        (int Total, int Expired) totals = (0, 0);
        if (counts && parent is null or 0)   // overall numbers are only needed with the first level
            totals = await con.QueryFirstAsync<(int Total, int Expired)>($@"{DocumentsController.AccessCte}
            SELECT COUNT(*) AS Total, SUM(CASE WHEN {DocumentsController.ExpiredPredicate} THEN 1 ELSE 0 END) AS Expired
            FROM Documents d WHERE ISNULL(d.LAIgnore, 0) = 0 AND d.Lang = @lang AND {vis}
            OPTION (MAXRECURSION 100)", new { acc, lang });
        var result = new { groups = groups.ToList(), total = totals.Total, expired = totals.Expired, templateGroup, canCreateRoot = Access.SeesAllGroups(rights) };
        cache.Set(key, result, TimeSpan.FromSeconds(60));
        return Ok(result);
    }

    static async Task<Dictionary<int, int>> Counts(SqlConnection con, int acc, string lang, string vis, int[] gids) =>
        (await con.QueryAsync<GroupCount>($@"{DocumentsController.AccessCte}
            SELECT dg.IdGroup, COUNT(DISTINCT d.IDDoc) AS [Count]
            FROM DocGrp dg JOIN Documents d ON d.IDDoc = dg.IdDoc AND d.Lang = @lang
            WHERE ISNULL(d.LAIgnore, 0) = 0 AND dg.IdGroup IN @gids AND {vis}
            GROUP BY dg.IdGroup OPTION (MAXRECURSION 100)", new { acc, lang, gids })).ToDictionary(c => c.IdGroup, c => c.Count);

    /// Document counts per group plus the overall totals; loaded in the background after the tree is already on screen.
    [HttpGet("counts")]
    public async Task<IActionResult> CountsOnly([FromQuery] string lang = "EN")
    {
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        var key = GroupCache.TreeKey(acc, lang) + ":counts";
        if (cache.TryGetValue(key, out object? hit) && hit is not null) return Ok(hit);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var all = await Access.Groups(con, lang);
        var accessible = Access.AccessibleGroups(all, await Access.Rights(con, acc));
        var vis = await Access.VisibleSql(con, acc, lang);
        var gids = (accessible ?? all.Select(g => g.IDGroup).ToHashSet()).ToArray();
        var cnt = await Counts(con, acc, lang, vis, gids);
        var totals = await con.QueryFirstAsync<(int Total, int Expired)>($@"{DocumentsController.AccessCte}
            SELECT COUNT(*) AS Total, ISNULL(SUM(CASE WHEN {DocumentsController.ExpiredPredicate} THEN 1 ELSE 0 END), 0) AS Expired
            FROM Documents d WHERE ISNULL(d.LAIgnore, 0) = 0 AND d.Lang = @lang AND {vis}
            OPTION (MAXRECURSION 100)", new { acc, lang });
        var result = new { counts = cnt.ToDictionary(x => x.Key.ToString(), x => x.Value), total = totals.Total, expired = totals.Expired };
        cache.Set(key, result, TimeSpan.FromSeconds(60));
        return Ok(result);
    }
}
