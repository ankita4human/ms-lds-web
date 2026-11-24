using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class ReleaseBody
{
    public string? Password { get; set; }
    public MailPayload? Mail { get; set; }          // e-mail of this step (release for Release, publish for Publish)
    public MailPayload? PublishMail { get; set; }   // Release + Publish: the second e-mail
    public bool AutoMail { get; set; }              // bulk release/publish and background jobs: no window, send the default mail (recipients, subject, text from the template and Config)
}
public class FlowRow
{
    public string? Lang { get; set; }
    public string? LangStandard { get; set; }
    public string? DocName { get; set; }
    public int? Status { get; set; }
    public int? Type { get; set; }
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
    public string? Extension { get; set; }
    public DateTime? DateExp { get; set; }
    public bool? DoNotExpire { get; set; }
    public bool? Translated { get; set; }
    public int? Life { get; set; }
}
public class VerRow { public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } }
public class ModCopyRow { public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } public string? ModDesc { get; set; } }

/// Document menu > Verify and Release (manual p. 108-109). Ported from the legacy server methods
/// LDSClientSession.approveDocument (Draft/Edit -> Verified, right 18) and relDocument (Verified -> Released, right 36).
/// Not ported yet: the release e-mails (next phase), the "Link to standard" mail and the PDF-in-mail option.
[ApiController, Route("api/lds"), Authorize]
public class WorkflowController(IConfiguration cfg, IMemoryCache cache, IPasswordVerifier verifier, PublishQueue queue, MailService mailSvc, DocPublisher publisher, ILogger<WorkflowController> log) : ControllerBase
{
    const int RightVerify = 18, RightRelease = 36, RightPublish = 19;
    const int StDraft = 1, StEdit = 2, StPublished = 3, StVerified = 7, StReleased = 8;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    static async Task<int> CfgInt(SqlConnection con, string name, int dflt)
    {
        var v = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name });
        return int.TryParse((v ?? "").Trim(), out var i) ? i : dflt;
    }


    /// Bulk / background steps have no mail window: build the same draft the window would have shown and send it if the Config
    /// switches (SendDefaultMail + SendDefaultRelMail / SendDefaultPubMail, document specific DocEmail flags) say so.
    async Task<MailPayload?> AutoPayload(int id, string lang, string stage)
    {
        try
        {
            var ctl = new MailController(cfg, mailSvc, publisher) { ControllerContext = ControllerContext };
            if ((await ctl.Draft(id, lang, stage)) is not OkObjectResult ok || ok.Value is null) return null;
            var t = ok.Value.GetType();
            if (t.GetProperty("sendDefault")?.GetValue(ok.Value) as bool? != true) return null;
            static List<string> Mails(object? l) => (l as IEnumerable<Recip> ?? []).Select(r => r.Email).ToList();
            var to = Mails(t.GetProperty("to")?.GetValue(ok.Value)); if (to.Count == 0) return null;
            return new MailPayload
            {
                Send = true, To = to, Cc = Mails(t.GetProperty("cc")?.GetValue(ok.Value)),
                Subject = t.GetProperty("subject")?.GetValue(ok.Value) as string, Html = t.GetProperty("html")?.GetValue(ok.Value) as string,
                Header = t.GetProperty("header")?.GetValue(ok.Value) as string, Footer = t.GetProperty("footer")?.GetValue(ok.Value) as string,
            };
        }
        catch (Exception ex) { log.LogWarning(ex, "Default {Stage} mail of D{Id} could not be prepared", stage, id); return null; }
    }

    /// Manual p. 64-66 (Link to Standard): a document has to be linked to every mandatory standard before it is released.
    async Task<IActionResult?> StandardGate(SqlConnection con, int id, FlowRow d)
    {
        var missing = await MandatoryStandards.Missing(con, id, d.Lang!);
        if (missing.Count == 0) return null;
        await MandatoryStandards.NotifyAdmins(mailSvc, con, id, d.Lang!, d.DocName ?? $"#{id}", missing, log);
        return Conflict(new { error = $"The document must be linked to the mandatory standard(s) before it can be released: {string.Join(", ", missing)}. Use Document > Link to standard.", missingStandards = missing });
    }

    /// Config "ValidateUserOnRelease": the releaser has to type the password again (electronic signature).
    [HttpGet("workflow/options")]
    public async Task<IActionResult> Options()
    {
        await using var con = Con();
        return Ok(new { validateOnRelease = await CfgInt(con, "ValidateUserOnRelease", 0) == 1 });
    }

    internal const string FlowSql = @"SELECT d.Lang, d.LangStandard, d.DocName, d.Status, d.Type, d.V1, d.V2, d.V3, d.Extension, d.DateExp, d.DoNotExpire, d.Translated,
        (SELECT TOP 1 t.Life FROM DocTypes t WHERE t.IDType = d.Type AND t.Lang = d.Lang) AS Life FROM Documents d";


    /// Expiry date a release will write (same rules as Release below) - used to show the right "Expiry date" in the release e-mail draft.
    internal static async Task<DateTime?> ExpiryAfterRelease(SqlConnection con, int id, FlowRow d, DateTime now)
    {
        var skip = await SkipOtherLanguages(con, id, d);
        var life = d.Life ?? 0;
        var updMinor = await CfgInt(con, "UpdateExpireDateInMinorVersion", 0) == 1;
        var enableNoExpire = await CfgInt(con, "LDSIsEnableDoNotExpire", 0) == 1;
        var noExpire = d.DoNotExpire == true;
        var dateExp = d.DateExp;
        bool IsDefault(DateTime? x) => x is null || x.Value.Year <= 1901;
        if (!skip && !noExpire && updMinor) dateExp = now.AddMonths(life);
        if (updMinor) { if (enableNoExpire && !noExpire && IsDefault(dateExp)) dateExp = now.AddMonths(life); }
        else if (enableNoExpire && !noExpire) dateExp = now.AddMonths(life);
        return dateExp;
    }

    static string Ver(FlowRow r) => $"{r.V1 ?? 0}.{r.V2 ?? 0}.{r.V3 ?? 0}";

    /// Minor revision (x.y.z+1 of the last archived version) or very first version 0.0.x: the other languages are not touched.
    static async Task<bool> SkipOtherLanguages(SqlConnection con, int id, FlowRow d, System.Data.Common.DbTransaction? tx = null)
    {
        var a = await con.QueryFirstOrDefaultAsync<VerRow>("SELECT TOP 1 V1, V2, V3 FROM DocumentsArchives WHERE IDDoc = @id AND Lang = @l ORDER BY V1 DESC, V2 DESC, V3 DESC", new { id, l = d.Lang }, tx);
        if (a is null) return (d.V1 ?? 0) == 0 && (d.V2 ?? 0) == 0;
        return (d.V1 ?? 0) == (a.V1 ?? 0) && (d.V2 ?? 0) == (a.V2 ?? 0) && (d.V3 ?? 0) == (a.V3 ?? 0) + 1;
    }

    /// Common checks of Verify and Release. Returns null when fine, otherwise the error result.
    async Task<(FlowRow? doc, IActionResult? err)> Load(SqlConnection con, int id, string lang, int right, string what)
    {
        lang = (lang ?? "").Trim().ToUpperInvariant();
        var rights = await Access.Rights(con, Acc);
        if (!(Access.IsAdmin(rights) || rights.Any(r => r.RCod == right)))
            return (null, StatusCode(403, new { error = $"You do not have the right to {what} documents." }));
        var vis = await Access.VisibleSql(con, Acc, lang);
        var d = await con.QueryFirstOrDefaultAsync<FlowRow>($"{FlowSql} WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (d is null) return (null, NotFound(new { error = "Document not found." }));
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND ISNULL(checkedOut, 0) = 1", new { id }) > 0)
            return (null, Conflict(new { error = "The document is checked out. Check it in (or cancel the check-out) first." }));
        return (d, null);
    }

    /// Legacy rule: in a language other than the original one the original document must be Released/Published first,
    /// unless it is a minor revision or the original document already carries a different version.
    async Task<IActionResult?> OriginalFirst(SqlConnection con, int id, FlowRow d, System.Data.Common.DbTransaction? tx = null)
    {
        if (string.Equals(d.LangStandard, d.Lang, StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(d.LangStandard)) return null;
        if (await SkipOtherLanguages(con, id, d, tx)) return null;
        var o = await con.QueryFirstOrDefaultAsync<FlowRow>($"{FlowSql} WHERE d.IDDoc = @id AND d.Lang = @l", new { id, l = d.LangStandard }, tx);
        if (o is null) return null;
        if (o.Status != StReleased && o.Status != StPublished && Ver(o) == Ver(d))
            return Conflict(new { error = $"The document in the original language ({d.LangStandard}) has to be released first." });
        return null;
    }

    // ---------------- Verify (legacy approveDocument) ----------------
    [HttpPost("documents/{id:int}/verify")]
    public async Task<IActionResult> Verify(int id, [FromQuery] string lang = "EN")
    {
        await using var con = Con(); await con.OpenAsync();
        var (d, err) = await Load(con, id, lang, RightVerify, "verify");
        if (err is not null) return err;
        if (d!.Status != StDraft && d.Status != StEdit) return Conflict(new { error = "Only documents in Draft or Edit status can be verified." });
        if (await OriginalFirst(con, id, d) is { } e2) return e2;
        var now = DateTime.Now; lang = d.Lang!;
        try
        {
            var n = await con.ExecuteAsync("UPDATE Documents SET Status = @st, DatePrv = @now, IdPrv = @acc WHERE IDDoc = @id AND Lang = @lang AND Status IN (1, 2)",
                new { st = StVerified, now, acc = Acc, id, lang });
            if (n == 0) return Conflict(new { error = "The document was changed by someone else. Please refresh the list." });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230)
        { return StatusCode(403, new { error = "The database login may not update Documents. " + ex.Message }); }
        cache.Remove($"stats:{Acc}:{lang}");
        return Ok(new { idDoc = id, lang, status = StVerified, version = Ver(d), verifiedOn = now });
    }

    // ---------------- Release (legacy relDocument) ----------------
    [HttpPost("documents/{id:int}/release")]
    public async Task<IActionResult> Release(int id, [FromBody] ReleaseBody? b, [FromQuery] string lang = "EN")
    {
        await using var con = Con(); await con.OpenAsync();
        var (d, err) = await Load(con, id, lang, RightRelease, "release");
        if (err is not null) return err;
        if (d!.Status != StVerified) return Conflict(new { error = "Only verified documents can be released. Verify the document first." });
        if (MailService.Validate(b?.Mail) is { } mailErr) return BadRequest(new { error = mailErr });
        if (await StandardGate(con, id, d) is { } stdStop) return stdStop;
        if (b is { AutoMail: true, Mail: null }) b.Mail = await AutoPayload(id, d.Lang!, "release");

        if (await CfgInt(con, "ValidateUserOnRelease", 0) == 1)
        {
            var stored = await con.ExecuteScalarAsync<string?>("SELECT Passwort FROM Accounts WHERE IdAcc = @a", new { a = Acc });
            if (string.IsNullOrEmpty(b?.Password) || !verifier.Verify(b.Password, stored))
                return BadRequest(new { error = "The password is not correct. The release has to be confirmed with your password." });
        }
        if (await OriginalFirst(con, id, d) is { } e2) return e2;

        lang = d.Lang!;
        var skip = await SkipOtherLanguages(con, id, d);
        var now = DateTime.Now;
        var life = d.Life ?? 0;
        var updMinor = await CfgInt(con, "UpdateExpireDateInMinorVersion", 0) == 1;
        var enableNoExpire = await CfgInt(con, "LDSIsEnableDoNotExpire", 0) == 1;
        var noExpire = d.DoNotExpire == true;
        var dateExp = d.DateExp;
        bool IsDefault(DateTime? x) => x is null || x.Value.Year <= 1901;
        // Expiry date exactly as the legacy relDocument decides it.
        if (!skip && !noExpire && updMinor) dateExp = now.AddMonths(life);
        if (updMinor) { if (enableNoExpire && !noExpire && IsDefault(dateExp)) dateExp = now.AddMonths(life); }
        else if (enableNoExpire && !noExpire) dateExp = now.AddMonths(life);

        // Other languages follow the original language (only for the original language and not for minor revisions).
        var others = new List<FlowRow>();
        var (dp, ap, dbId) = await DocFiles.Paths(con);
        var origExt = DocFiles.Ext(d.Extension);
        var origFile = DocFiles.Live(dp, dbId, lang, id, origExt);
        var copyFiles = false;
        if (!skip && string.Equals(d.LangStandard, d.Lang, StringComparison.OrdinalIgnoreCase))
        {
            others = (await con.QueryAsync<FlowRow>($"{FlowSql} WHERE d.IDDoc = @id AND d.Lang <> @lang", new { id, lang })).ToList();
            copyFiles = d.Translated != true && others.Count > 0;
            if (copyFiles && string.IsNullOrWhiteSpace(dp)) return StatusCode(500, new { error = "Config DocPath is not set." });
            if (copyFiles && !System.IO.File.Exists(origFile)) return StatusCode(500, new { error = $"The document file was not found on the server ({lang}{dbId}\\D{id}{origExt})." });
        }

        var restore = new List<(string path, string? backup)>();   // files we touched: path + backup copy (null = file did not exist)
        var created = new List<string>();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var n = await con.ExecuteAsync("UPDATE Documents SET Status = @st, DateRel = @now, IdRel = @acc, DateExp = @exp WHERE IDDoc = @id AND Lang = @lang AND Status = @was",
                new { st = StReleased, now, acc = Acc, exp = dateExp, id, lang, was = StVerified }, tx);
            if (n == 0) { await tx.RollbackAsync(); return Conflict(new { error = "The document was changed by someone else. Please refresh the list." }); }

            var touched = new List<string>();
            foreach (var t in others)
            {
                var tl = t.Lang!; var tDraft = t.Status == StDraft;
                if (copyFiles)
                {
                    var tExt = DocFiles.Ext(string.IsNullOrWhiteSpace(t.Extension) ? origExt : t.Extension);
                    var tFile = DocFiles.Live(dp, dbId, tl, id, tExt);
                    if (!tDraft)
                    {
                        await DocFiles.ArchiveRow(con, (SqlTransaction)tx, id, tl);
                        if (!string.IsNullOrWhiteSpace(ap) && System.IO.File.Exists(tFile))
                        {
                            var arch = DocFiles.Archived(ap, dbId, tl, id, t.V1 ?? 0, t.V2 ?? 0, t.V3 ?? 0, tExt);
                            Directory.CreateDirectory(Path.GetDirectoryName(arch)!);
                            var existed = System.IO.File.Exists(arch);
                            if (existed) { var bk = arch + ".webbak"; System.IO.File.Copy(arch, bk, true); restore.Add((arch, bk)); } else created.Add(arch);
                            System.IO.File.Copy(tFile, arch, true);
                        }
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(tFile)!);
                    if (System.IO.File.Exists(tFile)) { var bk = tFile + ".webbak"; System.IO.File.Copy(tFile, bk, true); restore.Add((tFile, bk)); } else created.Add(tFile);
                    System.IO.File.Copy(origFile, tFile, true);
                    var m = await con.QueryFirstOrDefaultAsync<ModCopyRow>("SELECT TOP 1 V1, V2, V3, ModDesc FROM Mods WHERE IdDoc = @id AND Lang = @lang ORDER BY ModDate DESC", new { id, lang }, tx);
                    if (m is not null)
                        await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @tl, @v1, @v2, @v3, @acc, @now, @d)",
                            new { id, tl, v1 = m.V1, v2 = m.V2, v3 = m.V3, acc = Acc, now, d = m.ModDesc }, tx);
                }
                await con.ExecuteAsync("UPDATE Documents SET Status = CASE WHEN Status = 1 THEN 1 ELSE 2 END, V1 = @v1, V2 = @v2, V3 = @v3, DateMod = @now WHERE IDDoc = @id AND Lang = @tl",
                    new { v1 = d.V1 ?? 0, v2 = d.V2 ?? 0, v3 = d.V3 ?? 0, now, id, tl }, tx);
                touched.Add(tl);
            }
            await tx.CommitAsync();
            foreach (var (_, bk) in restore) if (bk is not null && System.IO.File.Exists(bk)) System.IO.File.Delete(bk);
            cache.Remove($"stats:{Acc}:{lang}");
            var (mailSent, mailError) = await ReleaseMail(id, lang, b?.Mail);   // the release is done; a mail problem never undoes it
            return Ok(new { idDoc = id, lang, status = StReleased, version = Ver(d), releasedOn = now, expires = dateExp, languages = touched, mailSent, mailError });
        }
        catch (Exception ex)
        {
            try { await tx.RollbackAsync(); } catch { /* already gone */ }
            try
            {
                foreach (var (path, bk) in restore) if (bk is not null && System.IO.File.Exists(bk)) { System.IO.File.Copy(bk, path, true); System.IO.File.Delete(bk); }
                foreach (var p in created) if (System.IO.File.Exists(p)) System.IO.File.Delete(p);
            }
            catch (Exception ex2) { log.LogError(ex2, "release cleanup failed for {Id}", id); }
            log.LogError(ex, "release failed for {Id}", id);
            if (ex is SqlException { Number: 229 or 262 or 230 })
                return StatusCode(403, new { error = "The database login may not write here (needs UPDATE Documents, INSERT Mods and DocumentsArchives). " + ex.Message });
            if (ex is IOException or UnauthorizedAccessException)
                return StatusCode(500, new { error = "A file could not be written on the server: " + ex.Message });
            throw;
        }
    }

    // ---------------- Publish (legacy releaseDocument -> Job/Worker -> DocPublish) ----------------
    /// Puts the document in the publish queue and returns at once; PublishWorker writes the HTML / PDF / original copies to the web folder
    /// and sets the status to Published. The bell in the top bar shows progress and result.
    [HttpPost("documents/{id:int}/publish")]
    public async Task<IActionResult> Publish(int id, [FromBody] ReleaseBody? b, [FromQuery] string lang = "EN")
    {
        if (MailService.Validate(b?.Mail) is { } mailErr) return BadRequest(new { error = mailErr });
        await using var con = Con();
        await con.OpenAsync();
        var (d, err) = await Load(con, id, lang, RightPublish, "publish");
        if (err is not null) return err;
        if (d!.Status != StReleased && d.Status != StPublished) return Conflict(new { error = "Only released documents can be published. Release the document first." });
        if (b is { AutoMail: true, Mail: null }) b.Mail = await AutoPayload(id, d.Lang!, "publish");
        await SavePublishMail(id, d.Lang!, b?.Mail);
        return Queued(id, d.Lang!, d.DocName, Ver(d), "publish", null, d.Status ?? StReleased, b?.Mail, false, null);
    }

    /// Release and publish in one step (Document menu > Release/Publish). Needs both rights. The release is done now, the publishing is queued.
    [HttpPost("documents/{id:int}/release-publish")]
    public async Task<IActionResult> ReleasePublish(int id, [FromBody] ReleaseBody? b, [FromQuery] string lang = "EN")
    {
        if (MailService.Validate(b?.Mail) is { } e1) return BadRequest(new { error = e1 });
        if (MailService.Validate(b?.PublishMail) is { } e2) return BadRequest(new { error = e2 });
        string? name;
        await using (var con = Con())
        {
            await con.OpenAsync();
            var rights = await Access.Rights(con, Acc);
            if (!(Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightPublish)))
                return StatusCode(403, new { error = "You do not have the right to publish documents." });
            name = await con.ExecuteScalarAsync<string?>("SELECT DocName FROM Documents WHERE IDDoc = @id AND Lang = @l", new { id, l = (lang ?? "EN").Trim().ToUpperInvariant() });
        }
        var rel = await Release(id, b, lang);
        if (rel is not OkObjectResult ok) return rel;
        var releasedOn = ok.Value?.GetType().GetProperty("releasedOn")?.GetValue(ok.Value);
        var version = ok.Value?.GetType().GetProperty("version")?.GetValue(ok.Value) as string ?? "";
        var relSent = (ok.Value?.GetType().GetProperty("mailSent")?.GetValue(ok.Value) as bool?) ?? false;
        var relErr = ok.Value?.GetType().GetProperty("mailError")?.GetValue(ok.Value) as string;
        var ln = (lang ?? "EN").Trim().ToUpperInvariant();
        if (b is { AutoMail: true, PublishMail: null }) b.PublishMail = await AutoPayload(id, ln, "publish");
        await SavePublishMail(id, ln, b?.PublishMail);
        return Queued(id, ln, name, version, "relpub", releasedOn, StReleased, b?.PublishMail, relSent, relErr);
    }

    /// Release e-mail: remember the edited values (DocEmail) and send. Returns (sent, error text).
    async Task<(bool sent, string? error)> ReleaseMail(int id, string lang, MailPayload? m)
    {
        if (m is null) return (false, null);
        try { await mailSvc.SaveDocEmail(id, lang, m, "release"); }
        catch (Exception ex) { log.LogWarning(ex, "DocEmail of {Id} ({Lang}) could not be saved", id, lang); }   // convenience only
        if (!m.Send) return (false, null);
        try { await mailSvc.SendPayloadAsync(m, lang); return (true, null); }
        catch (Exception ex) { log.LogWarning("Release mail for D{Id} failed: {Msg}", id, ex.Message); return (false, ex is MailException ? ex.Message : ex.GetBaseException().Message); }
    }

    async Task SavePublishMail(int id, string lang, MailPayload? m)
    {
        if (m is null) return;
        try { await mailSvc.SaveDocEmail(id, lang, m, "publish"); }
        catch (Exception ex) { log.LogWarning(ex, "DocEmail of {Id} ({Lang}) could not be saved", id, lang); }
    }

    IActionResult Queued(int id, string lang, string? name, string version, string kind, object? releasedOn, int status, MailPayload? publishMail, bool mailSent, string? mailError)
    {
        var job = queue.Enqueue(id, lang, string.IsNullOrWhiteSpace(name) ? $"#{id}" : name!, version, Acc, kind, publishMail is { Send: true } ? publishMail : null);
        return Accepted(new { idDoc = id, lang, status, version, releasedOn, queued = true, jobId = job.Id, position = queue.Position(job), mailSent, mailError, publishMail = publishMail is { Send: true } });
    }
}
