using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public record LanguageRow(string Lang, string? Name);
public record StatRow(string? Label, int Count);
public record StatusIdRow(int? Status, int Count);

[ApiController, Route("api/lds"), Authorize]
public class LookupsController(IConfiguration cfg, IMemoryCache cache) : ControllerBase
{
    private const string Cte = DocumentsController.AccessCte;

    /// Active languages (Lang table). Documents exist once per language.
    [HttpGet("languages")]
    public async Task<IActionResult> Languages()
    {
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var rows = await con.QueryAsync<LanguageRow>(
            "SELECT Lang, Languags AS Name FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang");
        return Ok(rows);
    }

    /// All dashboard series for one language, limited to documents the user may see.
    [HttpGet("stats")]
    public async Task<IActionResult> Stats([FromQuery] string lang)
    {
        if (string.IsNullOrWhiteSpace(lang)) return BadRequest(new { error = "lang is required" });
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        // The dashboard runs ~12 heavy queries; keep the result per user+language for 2 minutes.
        var cacheKey = $"stats:{acc}:{lang}";
        if (cache.TryGetValue(cacheKey, out object? cached) && cached is not null) return Ok(cached);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var Vis = await Access.VisibleSql(con, acc, lang);
        var p = new { acc, lang };
        var w = $"WHERE ISNULL(d.LAIgnore, 0) = 0 AND d.Lang = @lang AND {Vis}";

        async Task<List<StatRow>> Series(string sql) =>
            (await con.QueryAsync<StatRow>($"{Cte} {sql} OPTION (MAXRECURSION 100)", p)).ToList();

        var byStatus = await Series($@"SELECT ISNULL(s.StatusDesc, CASE d.[Status] WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', d.[Status]) END) AS Label, COUNT(*) AS [Count]
            FROM Documents d OUTER APPLY (SELECT TOP 1 StatusDesc FROM [Status] WHERE IDStatus = d.[Status] AND Lang = d.Lang) s {w}
            GROUP BY ISNULL(s.StatusDesc, CASE d.[Status] WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', d.[Status]) END) ORDER BY [Count] DESC");
        var byType = await Series($@"SELECT REPLACE(ISNULL(t.TypeDesc, CONCAT('Type ', d.[Type])), '<DE>', '') AS Label, COUNT(*) AS [Count]
            FROM Documents d OUTER APPLY (SELECT TOP 1 TypeDesc FROM DocTypes WHERE IDType = d.[Type] AND Lang = d.Lang) t {w}
            GROUP BY REPLACE(ISNULL(t.TypeDesc, CONCAT('Type ', d.[Type])), '<DE>', '') ORDER BY [Count] DESC");
        var byAuthor = await Series($@"SELECT TOP 10 a.AccShort AS Label, COUNT(*) AS [Count]
            FROM Documents d JOIN Accounts a ON a.IdAcc = d.IdCre {w} GROUP BY a.AccShort ORDER BY [Count] DESC");
        var byPublisher = await Series($@"SELECT TOP 10 a.AccShort AS Label, COUNT(*) AS [Count]
            FROM Documents d JOIN Accounts a ON a.IdAcc = d.IdPub {w} AND d.DatePub IS NOT NULL GROUP BY a.AccShort ORDER BY [Count] DESC");
        var byReleaser = await Series($@"SELECT TOP 10 a.AccShort AS Label, COUNT(*) AS [Count]
            FROM Documents d JOIN Accounts a ON a.IdAcc = d.IdRel {w} AND d.DateRel IS NOT NULL GROUP BY a.AccShort ORDER BY [Count] DESC");
        var byExtension = await Series($@"SELECT UPPER(ISNULL(NULLIF(d.Extension, ''), 'n/a')) AS Label, COUNT(*) AS [Count]
            FROM Documents d {w} GROUP BY UPPER(ISNULL(NULLIF(d.Extension, ''), 'n/a')) ORDER BY [Count] DESC");
        var createdByYear = await Series($@"SELECT CAST(YEAR(d.DateCre) AS nvarchar(4)) AS Label, COUNT(*) AS [Count]
            FROM Documents d {w} AND d.DateCre IS NOT NULL GROUP BY YEAR(d.DateCre) ORDER BY YEAR(d.DateCre)");
        var publishedByYear = await Series($@"SELECT CAST(YEAR(d.DatePub) AS nvarchar(4)) AS Label, COUNT(*) AS [Count]
            FROM Documents d {w} AND d.DatePub IS NOT NULL GROUP BY YEAR(d.DatePub) ORDER BY YEAR(d.DatePub)");
        var expiry = await Series($@"SELECT CASE
                WHEN d.DateExp IS NULL OR ISNULL(d.DoNotExpire, 0) = 1 THEN 'No expiry'
                WHEN d.DateExp < GETDATE() THEN 'Expired'
                WHEN d.DateExp < DATEADD(day, 30, GETDATE()) THEN 'Within 30 days'
                WHEN d.DateExp < DATEADD(day, 90, GETDATE()) THEN '30-90 days'
                ELSE 'Later than 90 days' END AS Label, COUNT(*) AS [Count]
            FROM Documents d {w} GROUP BY CASE
                WHEN d.DateExp IS NULL OR ISNULL(d.DoNotExpire, 0) = 1 THEN 'No expiry'
                WHEN d.DateExp < GETDATE() THEN 'Expired'
                WHEN d.DateExp < DATEADD(day, 30, GETDATE()) THEN 'Within 30 days'
                WHEN d.DateExp < DATEADD(day, 90, GETDATE()) THEN '30-90 days'
                ELSE 'Later than 90 days' END");

        var expiringDocs = (await con.QueryAsync<DocumentRow>($@"{Cte} {DocumentsController.SelectColumns} {w}
            AND d.DateExp >= GETDATE() AND ISNULL(d.DoNotExpire, 0) = 0
            ORDER BY d.DateExp OFFSET 0 ROWS FETCH NEXT 6 ROWS ONLY OPTION (MAXRECURSION 100)", p)).ToList();

        // Documents per language: same visibility rule, across every active language.
        var byLanguage = (await con.QueryAsync<StatRow>($@"{Cte}
            SELECT d.Lang AS Label, COUNT(*) AS [Count] FROM Documents d
            WHERE ISNULL(d.LAIgnore, 0) = 0 AND {Vis} GROUP BY d.Lang ORDER BY d.Lang OPTION (MAXRECURSION 100)", p)).ToList();

        // KPI counts use the status ids (1 Draft, 2 Edit, 3 Published, 7 Verified, 8 Released) so they work in every language.
        var ids = (await con.QueryAsync<StatusIdRow>($@"{Cte}
            SELECT d.[Status] AS [Status], COUNT(*) AS [Count] FROM Documents d {w} GROUP BY d.[Status] OPTION (MAXRECURSION 100)", p)).ToList();
        int Id(int status) => ids.Where(x => x.Status == status).Sum(x => x.Count);
        int Cnt(IEnumerable<StatRow> s, string label) => s.Where(x => x.Label == label).Sum(x => x.Count);
        var total = ids.Sum(x => x.Count);
        var result = new
        {
            kpi = new
            {
                total,
                published = Id(3), draft = Id(1), edit = Id(2), verified = Id(7), released = Id(8),
                expired = Cnt(expiry, "Expired"), expiringSoon = Cnt(expiry, "Within 30 days")
            },
            byStatus, byType, byAuthor, byPublisher, byReleaser, byExtension, byLanguage, createdByYear, publishedByYear, expiry, expiringDocs
        };
        cache.Set(cacheKey, result, TimeSpan.FromMinutes(2));
        return Ok(result);
    }
}
