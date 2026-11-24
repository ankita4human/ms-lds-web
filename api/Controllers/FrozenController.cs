using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class FreezeBody { public string? Lang { get; set; } public DateTime? Expires { get; set; } public MailPayload? Mail { get; set; } }
public class DefreezeBody { public string? Lang { get; set; } public DateTime? Expires { get; set; } }
public class ExpiryBody { public string? Lang { get; set; } public DateTime? DateExp { get; set; } public bool? DoNotExpire { get; set; } }
public class FrzRow
{
    public string? Lang { get; set; } public string? LangStandard { get; set; } public string? DocName { get; set; } public int? Status { get; set; }
    public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } public string? Extension { get; set; }
    public DateTime? DateExp { get; set; } public DateTime? DatePub { get; set; } public bool? DoNotExpire { get; set; } public int? Life { get; set; }
}

/// Frozen / Defrozen (manual p. 163-167; legacy LDSClientSession.changeDocumentExpDateAndStatusForAll) and editing the expiry date / "Do not expire"
/// (manual p. 11, 115-117, 160). Frozen = status 11, version 999.999.999, archive history, "do not expire" set for good, republished, mail to everybody.
/// Defrozen = back to Edit with the last real version + 1.
[ApiController, Route("api/lds"), Authorize]
public class FrozenController(IConfiguration cfg, IMemoryCache cache, PublishQueue queue, MailService mailSvc, ILogger<FrozenController> log) : ControllerBase
{
    public const int StFrozen = 11, StExpired = 6, StEdit = 2, StPublished = 3, StReleased = 8;
    const int RightAdminDoc = 37;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };

    const string RowSql = @"SELECT d.Lang, d.LangStandard, d.DocName, d.Status, d.V1, d.V2, d.V3, d.Extension, d.DateExp, d.DatePub, d.DoNotExpire,
        (SELECT TOP 1 t.Life FROM DocTypes t WHERE t.IDType = d.[Type] AND t.Lang = d.Lang) AS Life FROM Documents d";

    async Task<(FrzRow? d, IActionResult? err)> Load(SqlConnection con, int id, string lang)
    {
        var rights = await Access.Rights(con, Acc);
        if (!(Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightAdminDoc)))
            return (null, Err(403, "You need the Admin or Admin document right."));
        var vis = await Access.VisibleSql(con, Acc, lang);
        var d = await con.QueryFirstOrDefaultAsync<FrzRow>($"{RowSql} WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (d is null) return (null, Err(404, "Document not found."));
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND ISNULL(checkedOut, 0) = 1", new { id }) > 0)
            return (null, Err(409, "The document is checked out. Check it in first."));
        return (d, null);
    }
    static async Task<int> CfgInt(SqlConnection con, string name, int dflt)
    {
        var v = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name });
        return int.TryParse((v ?? "").Trim(), out var i) ? i : dflt;
    }

    /// Archive copy of the current row and file (the "Archive history" of the manual); the caller restores nothing: it runs inside the transaction.
    internal static async Task ArchiveFile(SqlConnection con, SqlTransaction tx, string dp, string ap, string dbId, int id, FrzRow d, List<string> created)
    {
        await DocFiles.ArchiveRow(con, tx, id, d.Lang!);
        var ext = DocFiles.Ext(d.Extension);
        var live = DocFiles.Live(dp, dbId, d.Lang!, id, ext);
        if (!string.IsNullOrWhiteSpace(ap) && System.IO.File.Exists(live))
        {
            var arch = DocFiles.Archived(ap, dbId, d.Lang!, id, d.V1 ?? 0, d.V2 ?? 0, d.V3 ?? 0, ext);
            Directory.CreateDirectory(Path.GetDirectoryName(arch)!);
            if (!System.IO.File.Exists(arch)) { System.IO.File.Copy(live, arch, false); created.Add(arch); }
        }
    }

    [HttpGet("frozen/options")]
    public async Task<IActionResult> Options()
    {
        await using var con = Con();
        var rights = await Access.Rights(con, Acc);
        return Ok(new { enabled = await CfgInt(con, "EnableFrozen", 0) == 1, canManage = Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightAdminDoc),
            doNotExpire = await CfgInt(con, "LDSIsEnableDoNotExpire", 0) == 1 });
    }

    [HttpPost("documents/{id:int}/freeze")]
    public async Task<IActionResult> Freeze(int id, [FromBody] FreezeBody b)
    {
        var lang = L(b.Lang);
        if (MailService.Validate(b.Mail) is { } me) return Err(400, me);
        await using var con = Con(); await con.OpenAsync();
        if (await CfgInt(con, "EnableFrozen", 0) != 1) return Err(409, "Frozen is not enabled (Config EnableFrozen).");
        var (d, err) = await Load(con, id, lang); if (err is not null) return err;
        if (d!.Status == StFrozen) return Err(409, "The document is already frozen.");
        if (d.Status is not (StPublished or StReleased or StExpired)) return Err(409, "Only released, published or expired documents can be frozen.");
        var (dp, ap, dbId) = await DocFiles.Paths(con);     // before the transaction: every command inside it needs the transaction
        var now = DateTime.Now; var created = new List<string>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
        try
        {
            await ArchiveFile(con, tx, dp, ap, dbId, id, d, created);
            var n = await con.ExecuteAsync(@"UPDATE Documents SET Status = @st, V1 = 999, V2 = 999, V3 = 999, DateFrozen = @now, IdFrozen = @acc, DoNotExpire = 1,
                    DateExp = ISNULL(@exp, DateExp) WHERE IDDoc = @id AND Lang = @lang AND Status = @was",
                new { st = StFrozen, now, acc = Acc, exp = b.Expires, id, lang, was = d.Status }, tx);
            if (n == 0) { await tx.RollbackAsync(); return Err(409, "The document was changed by someone else. Please refresh the list."); }
            await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @lang, 999, 999, 999, @acc, @now, 'Frozen')", new { id, lang, acc = Acc, now }, tx);
            await tx.CommitAsync();
        }
        catch (Exception ex)
        {
            try { await tx.RollbackAsync(); } catch { /* gone */ }
            foreach (var p in created) try { System.IO.File.Delete(p); } catch { /* best effort */ }
            log.LogError(ex, "freeze failed for {Id}", id);
            if (ex is SqlException { Number: 229 or 262 or 230 }) return Err(403, "The database login may not write here (UPDATE Documents, INSERT Mods and DocumentsArchives). " + ex.Message);
            throw;
        }
        cache.Remove($"stats:{Acc}:{lang}");
        // republish with the frozen data, then the popup mail to everybody (a mail problem never undoes the freeze)
        var job = queue.Enqueue(id, lang, string.IsNullOrWhiteSpace(d.DocName) ? $"#{id}" : d.DocName!, "999.999.999", Acc, "publish");
        bool sent = false; string? mailError = null;
        if (b.Mail is { Send: true } m)
        {
            try { await mailSvc.SendPayloadAsync(m, lang); sent = true; }
            catch (Exception ex) { mailError = ex is MailException ? ex.Message : ex.GetBaseException().Message; log.LogWarning("Frozen mail for D{Id} failed: {Msg}", id, mailError); }
        }
        return Ok(new { idDoc = id, lang, status = StFrozen, version = "999.999.999", queued = true, jobId = job.Id, mailSent = sent, mailError });
    }

    [HttpPost("documents/{id:int}/defreeze")]
    public async Task<IActionResult> Defreeze(int id, [FromBody] DefreezeBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var (d, err) = await Load(con, id, lang); if (err is not null) return err;
        if (d!.Status != StFrozen) return Err(409, "Only frozen documents can be defrozen.");
        // last archived version that is not 999.999.999; the new version is its third part + 1 (legacy loop over DocumentsOld)
        var last = await con.QueryFirstOrDefaultAsync<FrzRow>("SELECT TOP 1 V1, V2, V3 FROM DocumentsArchives WHERE IDDoc = @id AND Lang = @lang AND ISNULL(V1, 0) <> 999 ORDER BY V1 DESC, V2 DESC, V3 DESC", new { id, lang });
        int v1 = last?.V1 ?? 0, v2 = last?.V2 ?? 0, v3 = (last?.V3 ?? 0) + 1;
        var life = d.Life is > 0 ? d.Life.Value : 36;
        var now = DateTime.Now; var exp = b.Expires ?? now.AddMonths(life);
        var (dp, ap, dbId) = await DocFiles.Paths(con);
        var created = new List<string>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
        try
        {
            await ArchiveFile(con, tx, dp, ap, dbId, id, d, created);   // the frozen state stays in the history
            var n = await con.ExecuteAsync(@"UPDATE Documents SET Status = @st, V1 = @v1, V2 = @v2, V3 = @v3, DateMod = @now, IdMod = @acc, DateExp = @exp, IdFrozen = @acc, DoNotExpire = 0
                    WHERE IDDoc = @id AND Lang = @lang AND Status = @was", new { st = StEdit, v1, v2, v3, now, acc = Acc, exp, id, lang, was = StFrozen }, tx);
            if (n == 0) { await tx.RollbackAsync(); return Err(409, "The document was changed by someone else. Please refresh the list."); }
            await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @lang, @v1, @v2, @v3, @acc, @now, 'Defrozen')", new { id, lang, v1, v2, v3, acc = Acc, now }, tx);
            await tx.CommitAsync();
        }
        catch (Exception ex)
        {
            try { await tx.RollbackAsync(); } catch { /* gone */ }
            foreach (var p in created) try { System.IO.File.Delete(p); } catch { /* best effort */ }
            log.LogError(ex, "defreeze failed for {Id}", id);
            if (ex is SqlException { Number: 229 or 262 or 230 }) return Err(403, "The database login may not write here. " + ex.Message);
            throw;
        }
        cache.Remove($"stats:{Acc}:{lang}");
        return Ok(new { idDoc = id, lang, status = StEdit, version = $"{v1}.{v2}.{v3}", expires = exp });
    }

    // ───────────── expiry date / do not expire ─────────────
    /// Only Admin / Admin document users may change the expiry date. A date in the future (or "do not expire") on an expired document brings it back to
    /// Published / Released; changed in the main language it is carried to the other languages too (manual p. 115-116).
    [HttpPut("documents/{id:int}/expiry")]
    public async Task<IActionResult> Expiry(int id, [FromBody] ExpiryBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var (d, err) = await Load(con, id, lang); if (err is not null) return err;
        if (d!.Status == StFrozen) return Err(409, "A frozen document does not expire and its expiry cannot be changed.");
        if (b.DoNotExpire is not null && await CfgInt(con, "LDSIsEnableDoNotExpire", 0) != 1) return Err(400, "'Do not expire' is not enabled (Config LDSIsEnableDoNotExpire).");
        var dne = b.DoNotExpire ?? d.DoNotExpire ?? false;
        var exp = b.DateExp ?? d.DateExp;
        if (b.DateExp is { } dd && dd.Year is < 1990 or > 2200) return Err(400, "Please enter a valid expiry date.");
        var now = DateTime.Now;
        var live = dne || (exp is not null && exp > now);
        var main = string.Equals(d.LangStandard, d.Lang, StringComparison.OrdinalIgnoreCase);
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            var langs = main ? (await con.QueryAsync<string>("SELECT Lang FROM Documents WHERE IDDoc = @id", new { id }, tx)).ToList() : [lang];
            foreach (var l in langs)
            {
                // the other languages follow only in what the main language decides; a frozen language is never touched
                await con.ExecuteAsync(@"UPDATE Documents SET DateExp = @exp, DoNotExpire = @dne,
                        Status = CASE WHEN Status = 6 AND @live = 1 THEN (CASE WHEN YEAR(ISNULL(DatePub, '1900-01-01')) > 1901 THEN 3 ELSE 8 END) ELSE Status END
                    WHERE IDDoc = @id AND Lang = @l AND Status <> 11", new { exp, dne, live, id, l }, tx);
            }
            await tx.CommitAsync();
        }
        catch (SqlException e) when (e.Number is 229 or 262 or 230) { return Err(403, "The database login may not update Documents. " + e.Message); }
        cache.Remove($"stats:{Acc}:{lang}");
        return Ok(new { idDoc = id, lang, dateExp = exp, doNotExpire = dne, languages = main ? "all" : "this" });
    }
}

/// Expiry job (manual p. 11, 115): released / published documents whose expiry date has passed go to status Expired (6), unless "do not expire" is set.
/// Runs a minute after start and then every hour. The expiry mail (template LDSExpire) is sent when Config SendDefaultMail and SendDefaultExpMail are on.
public class ExpiryWorker(IConfiguration cfg, MailService mail, DocPublisher publisher, ILogger<ExpiryWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        try { await Task.Delay(TimeSpan.FromMinutes(1), stop); } catch (OperationCanceledException) { return; }
        while (!stop.IsCancellationRequested)
        {
            try { await Run(); } catch (Exception ex) { log.LogWarning(ex, "Expiry run failed"); }
            try { await Task.Delay(TimeSpan.FromHours(1), stop); } catch (OperationCanceledException) { return; }
        }
    }

    sealed class Exp { public int IDDoc { get; set; } public string? Lang { get; set; } public string? DocName { get; set; } public int? IdProcessOwner { get; set; } }

    async Task Run()
    {
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds")); await con.OpenAsync();
        var due = (await con.QueryAsync<Exp>(@"SELECT IDDoc, Lang, DocName, IdProcessOwner FROM Documents WHERE Status IN (3, 8) AND ISNULL(DoNotExpire, 0) = 0
            AND DateExp IS NOT NULL AND YEAR(DateExp) > 1901 AND DateExp < GETDATE()")).ToList();
        if (due.Count == 0) return;
        var send = await MailService.C(con, "SendDefaultMail") == "1" && await MailService.C(con, "SendDefaultExpMail") == "1" && (await mail.Settings(con)).Configured;
        foreach (var x in due)
        {
            var n = await con.ExecuteAsync("UPDATE Documents SET Status = 6 WHERE IDDoc = @IDDoc AND Lang = @Lang AND Status IN (3, 8)", x);
            if (n == 0 || !send) continue;
            await TemplateMail.Send(con, mail, publisher, x.IDDoc, x.Lang!, "LDSExpire", new Dictionary<string, object?> { ["Status"] = 6 }, log);
        }
        log.LogInformation("{N} document(s) expired", due.Count);
    }
}

/// Mail from a template of ApplicationEmail (LDSExpire, LDSDependency, ...) to the recipients of a document: Config EmailTo, the document's distribution
/// lists and the process owner. Never throws: a mail problem must not undo the change that caused it.
public static class TemplateMail
{
    public static async Task Send(SqlConnection con, MailService mail, DocPublisher publisher, int idDoc, string lang, string mailType, IDictionary<string, object?> over, ILogger? log = null)
    {
        try
        {
            var to = MailService.Split(await MailService.C(con, "EmailTo")).Where(MailService.IsValid).ToList();
            to.AddRange(await con.QueryAsync<string>(@"SELECT DISTINCT e.Email FROM DocMailList dm JOIN MailListEmailContact mc ON mc.IDML = dm.IDML JOIN EmailContact e ON e.IDEC = mc.IDEC
                WHERE dm.IDDoc = @idDoc AND ISNULL(e.Email, '') <> ''", new { idDoc }));
            to.AddRange(await con.QueryAsync<string>(@"SELECT e.Email FROM Documents d JOIN Accounts a ON a.IdAcc = d.IdProcessOwner JOIN EmailContact e ON e.IDEC = a.IDEC
                WHERE d.IDDoc = @idDoc AND d.Lang = @lang AND ISNULL(e.Email, '') <> ''", new { idDoc, lang }));
            to = to.Where(MailService.IsValid).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (to.Count == 0) return;
            var tpl = await con.QueryFirstOrDefaultAsync<(string? Body, string? Subject)>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mailType AND Lang = @lang", new { mailType, lang });
            if (string.IsNullOrWhiteSpace(tpl.Body)) tpl = await con.QueryFirstOrDefaultAsync<(string? Body, string? Subject)>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mailType AND Lang = 'EN'", new { mailType });
            if (string.IsNullOrWhiteSpace(tpl.Body)) tpl = await con.QueryFirstOrDefaultAsync<(string? Body, string? Subject)>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mailType", new { mailType });
            if (string.IsNullOrWhiteSpace(tpl.Body)) return;
            var tags = await publisher.MailTags(idDoc, lang, over);
            await mail.SendAsync(to, [], MailLayout.Apply(tpl.Subject ?? "MS LDS Notification", tags, false), MailLayout.Apply(tpl.Body!, tags, true), lang);
        }
        catch (Exception ex) { log?.LogWarning("{Type} mail for D{Id} failed: {Msg}", mailType, idDoc, ex.Message); }
    }
}
