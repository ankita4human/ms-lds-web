using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class FeedRow
{
    public int IDDoc { get; set; } public string? Lang { get; set; } public string? DocName { get; set; } public string? Extension { get; set; }
    public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; }
    public DateTime? DatePub { get; set; } public int? IdPub { get; set; } public string? PublishedBy { get; set; } public string? TypeDesc { get; set; }
}

/// Notification bell: the publish jobs of the signed-in user (queue) and a "who published what" feed of the last 30 days,
/// built from Documents (Status = Published, DatePub, IdPub), limited to the documents the user may see.
[ApiController, Route("api/lds"), Authorize]
public class NotificationsController(IConfiguration cfg, PublishQueue queue) : ControllerBase
{
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    [HttpGet("notifications")]
    public async Task<IActionResult> Get([FromQuery] string lang = "EN", [FromQuery] int days = 30, [FromQuery] int limit = 40)
    {
        days = Math.Clamp(days, 1, 365); limit = Math.Clamp(limit, 1, 100);
        await using var con = Con(); await con.OpenAsync();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var since = DateTime.Now.AddDays(-days);
        var rows = await con.QueryAsync<FeedRow>($@"SELECT TOP (@limit) d.IDDoc, d.Lang, d.DocName, d.Extension, d.V1, d.V2, d.V3, d.DatePub, d.IdPub,
                (SELECT TOP 1 e.Name FROM Accounts a JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = d.IdPub) AS PublishedBy,
                (SELECT TOP 1 t.TypeDesc FROM DocTypes t WHERE t.IDType = d.Type AND t.Lang = d.Lang) AS TypeDesc
            FROM Documents d WHERE d.Status = 3 AND d.DatePub >= @since AND ISNULL(d.DoNotPublish, 0) = 0 AND {vis} ORDER BY d.DatePub DESC",
            new { limit, since });
        var total = await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.Status = 3 AND d.DatePub >= @since AND ISNULL(d.DoNotPublish, 0) = 0 AND {vis}", new { since });

        var items = rows.Select(r => new
        {
            idDoc = r.IDDoc, lang = r.Lang, docName = r.DocName, ext = (r.Extension ?? "").TrimStart('.').ToLowerInvariant(),
            version = $"{r.V1 ?? 0}.{r.V2 ?? 0}.{r.V3 ?? 0}", publishedOn = r.DatePub, publishedById = r.IdPub,
            publishedBy = string.IsNullOrWhiteSpace(r.PublishedBy) ? "Someone" : r.PublishedBy, type = r.TypeDesc
        });
        var jobs = queue.For(Acc).Where(j => j.Status is "queued" or "running" || j.FinishedAt > DateTime.Now.AddHours(-1)).Take(30).Select(j => new
        {
            id = j.Id, idDoc = j.IdDoc, lang = j.Lang, docName = j.DocName, version = j.Version, kind = j.Kind, status = j.Status, position = queue.Position(j),
            queuedAt = j.QueuedAt, finishedAt = j.FinishedAt, error = j.Error, warnings = j.Warnings, files = j.Files, tagsReplaced = j.TagsReplaced, mailStatus = j.MailStatus, mailError = j.MailError
        });
        return Ok(new { total, days, items, jobs, me = Acc });
    }

    [HttpPost("publish/jobs/{id}/dismiss")]
    public IActionResult Dismiss(string id) => queue.Dismiss(Acc, id) ? Ok(new { ok = true }) : NotFound(new { error = "Job not found or still running." });

    [HttpPost("publish/jobs/dismiss-all")]
    public IActionResult DismissAll() { queue.DismissAll(Acc); return Ok(new { ok = true }); }
}
