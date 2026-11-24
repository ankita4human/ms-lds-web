using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class DraftDoc
{
    public string? DocName { get; set; } public int? Status { get; set; } public string? Extension { get; set; } public int? IdProcessOwner { get; set; }
    public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; }
}
public class TplRow { public string? Body { get; set; } public string? Subject { get; set; } }
public class DocEmailRow
{
    public string? Email { get; set; } public string? Subject { get; set; } public string? Header { get; set; } public string? Footer { get; set; }
    public bool? RelFlg { get; set; } public bool? PubFlg { get; set; } public string? EmailTo { get; set; }
}
public class MailContactRow { public string? Name { get; set; } public string? Email { get; set; } public string? ListName { get; set; } }
public record Recip(string Email, string? Name, string Src);

/// Release / publish e-mails (manual p. 108-109, "Add Email Address" window). Config: SendDefaultMail (master switch), SendDefaultRelMail / SendDefaultPubMail
/// (pre-ticked), EmailTo / EmailCC (default recipients), EmailHeader / EmailFooter, mailDocChangeSubject, SendDefaultProOwner, Weburl / EnableWeburl,
/// StopEmail / StartTime / EndTime. The mail itself comes from ApplicationEmail (LDSRelease / LDSPublish) and is shown to the user as an editable draft.
[ApiController, Route("api/lds"), Authorize]
public class MailController(IConfiguration cfg, MailService mail, DocPublisher publisher) : ControllerBase
{
    const int RightRelease = 36, RightPublish = 19, StReleased = 8, StPublished = 3, StVerified = 7;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    [HttpGet("mail/options")]
    public async Task<IActionResult> Options()
    {
        await using var con = Con(); await con.OpenAsync();
        var s = await mail.Settings(con);
        var until = await mail.QuietUntil(con);
        return Ok(new
        {
            enabled = await MailService.C(con, "SendDefaultMail") == "1",
            release = await MailService.C(con, "SendDefaultRelMail") == "1",
            publish = await MailService.C(con, "SendDefaultPubMail") == "1",
            smtpOk = s.Configured, from = s.Configured ? s.FromText : "", quietUntil = until
        });
    }

    async Task<bool> MayUse(SqlConnection con)
    {
        var rights = await Access.Rights(con, Acc);
        return Access.IsAdmin(rights) || rights.Any(r => r.RCod is RightRelease or RightPublish or 37);
    }

    [HttpGet("documents/{id:int}/mail-draft")]
    public async Task<IActionResult> Draft(int id, [FromQuery] string lang = "EN", [FromQuery] string stage = "release", [FromQuery] string? header = null, [FromQuery] string? footer = null)
    {
        stage = (stage ?? "").Trim().ToLowerInvariant();
        if (stage is not ("release" or "publish" or "frozen")) return BadRequest(new { error = "stage must be release, publish or frozen." });
        lang = (lang ?? "EN").Trim().ToUpperInvariant();
        await using var con = Con(); await con.OpenAsync();
        if (!await MayUse(con)) return StatusCode(403, new { error = "You do not have the right to release or publish documents." });
        var vis = await Access.VisibleSql(con, Acc, lang);
        var d = await con.QueryFirstOrDefaultAsync<DraftDoc>($"SELECT d.DocName, d.Status, d.Extension, d.IdProcessOwner, d.V1, d.V2, d.V3 FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (d is null) return NotFound(new { error = "Document not found." });

        var now = DateTime.Now;
        // document data as it will be after the step
        var over = new Dictionary<string, object?>();
        if (stage == "release") { over["Status"] = StReleased; over["DateRel"] = now; over["IdRel"] = Acc; }
        else if (stage == "frozen") { over["Status"] = 11; over["V1"] = 999; over["V2"] = 999; over["V3"] = 999; over["DateFrozen"] = now; over["IdFrozen"] = Acc; }
        else
        {
            over["Status"] = StPublished; over["DatePub"] = now; over["IdPub"] = Acc;
            if (d.Status is not (StPublished or StReleased)) { over["DateRel"] = now; over["IdRel"] = Acc; }
        }
        if (d.Status == StVerified)
        {   // the release sets a new expiry date: show the one that will be written
            var fr = await con.QueryFirstOrDefaultAsync<FlowRow>($"{WorkflowController.FlowSql} WHERE d.IDDoc = @id AND d.Lang = @lang", new { id, lang });
            if (fr is not null) over["DateExp"] = await WorkflowController.ExpiryAfterRelease(con, id, fr, now);
        }
        var tags = await publisher.MailTags(id, lang, over);

        var mt = stage == "publish" ? "LDSPublish" : stage == "frozen" ? "Eingefroren" : "LDSRelease";
        var tpl = await con.QueryFirstOrDefaultAsync<TplRow>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mt AND Lang = @lang", new { mt, lang })
               ?? await con.QueryFirstOrDefaultAsync<TplRow>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mt AND Lang = 'EN'", new { mt })
               ?? await con.QueryFirstOrDefaultAsync<TplRow>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = @mt", new { mt });

        var row = await con.QueryFirstOrDefaultAsync<DocEmailRow>("SELECT TOP 1 Email, Subject, Header, Footer, RelFlg, PubFlg, EmailTo FROM DocEmail WHERE IDDoc = @id AND Lang = @lang", new { id, lang });
        string C(string n) => MailService.C(con, n).GetAwaiter().GetResult();

        // ---- recipients ----
        var to = new List<Recip>(); var cc = new List<Recip>();
        bool Has(string e) => to.Concat(cc).Any(r => string.Equals(r.Email, e, StringComparison.OrdinalIgnoreCase));
        void Add(List<Recip> l, string? raw, string src, string? name = null)
        {
            foreach (var e in MailService.Split(raw)) if (MailService.IsValid(e) && !Has(e)) l.Add(new Recip(e, name, src));
        }
        if (row is not null) Add(to, row.EmailTo, "saved"); else Add(to, C("EmailTo"), "default");
        var contacts = await con.QueryAsync<MailContactRow>(@"SELECT DISTINCT e.Name, e.Email, m.Name AS ListName FROM DocMailList dm
            JOIN MailList m ON m.IDML = dm.IDML JOIN MailListEmailContact mc ON mc.IDML = m.IDML JOIN EmailContact e ON e.IDEC = mc.IDEC
            WHERE dm.IDDoc = @id AND ISNULL(e.Email, '') <> ''", new { id });
        foreach (var c in contacts) Add(to, c.Email, "list:" + c.ListName, c.Name);
        if (C("SendDefaultProOwner") == "1" && d.IdProcessOwner is > 0)
        {
            var o = await con.QueryFirstOrDefaultAsync<MailContactRow>("SELECT TOP 1 e.Name, e.Email FROM EmailContact e JOIN Accounts a ON a.IDEC = e.IDEC WHERE a.IdAcc = @o", new { o = d.IdProcessOwner });
            if (o is not null) Add(to, o.Email, "owner", o.Name);
        }
        if (row is not null) Add(cc, row.Email, "saved"); else Add(cc, C("EmailCC"), "default");

        // ---- subject, header, footer ----
        var subject = !string.IsNullOrWhiteSpace(row?.Subject) ? row!.Subject!
                    : !string.IsNullOrWhiteSpace(C("mailDocChangeSubject")) ? C("mailDocChangeSubject") : tpl?.Subject ?? "MS LDS Notification";
        subject = MailLayout.Apply(subject, tags, false);
        var hdr = header ?? (!string.IsNullOrWhiteSpace(row?.Header) ? row!.Header : C("EmailHeader"));
        var ftr = footer ?? (!string.IsNullOrWhiteSpace(row?.Footer) ? row!.Footer : C("EmailFooter"));

        // ---- links of the published document ----
        string? wHtml = null, wPdf = null, wOrig = null;
        var web = C("Weburl");
        if (stage == "publish" && C("EnableWeburl") == "1" && web.Length > 0)
        {
            var b = web.EndsWith('/') ? web : web + "/"; var p = $"{b}{lang}/D{id}/D{id}";
            wHtml = p + ".htm"; wPdf = p + ".pdf";
            var ext = (d.Extension ?? "").Trim().TrimStart('.');
            if (ext.Length > 0) wOrig = p + "." + ext;
        }
        var ff = C("EmailFontFamily");
        var model = new MailLayout.Model
        {
            Stage = stage, Lang = lang, Template = tpl?.Body ?? "", Tags = tags, HeaderHtml = MailLayout.TextToHtml(hdr), FooterHtml = MailLayout.TextToHtml(ftr),
            Brand = C("DBName"), FontFamily = ff.Length > 0 ? ff : "Arial", WebHtml = wHtml, WebPdf = wPdf, WebOriginal = wOrig,
            DocName = d.DocName ?? "", DocId = id.ToString(), Version = stage == "frozen" ? "999.999.999" : $"{d.V1 ?? 0}.{d.V2 ?? 0}.{d.V3 ?? 0}"
        };
        var s = await mail.Settings(con);
        var master = C("SendDefaultMail") == "1";
        var flag = stage == "release" ? row?.RelFlg ?? C("SendDefaultRelMail") == "1" : row?.PubFlg ?? C("SendDefaultPubMail") == "1";
        return Ok(new
        {
            stage, lang, enabled = master, smtpOk = s.Configured, from = s.Configured ? s.FromText : "",
            sendDefault = master && flag && s.Configured, to, cc, subject, header = hdr, footer = ftr,
            html = MailLayout.Modern(model), classicHtml = MailLayout.Classic(model), hasTemplate = tpl is not null,
            quietUntil = stage == "publish" ? await mail.QuietUntil(con) : null, saved = row is not null
        });
    }

    /// "Send me a test copy": the edited draft goes to the signed-in user's own address only.
    [HttpPost("documents/{id:int}/mail/test")]
    public async Task<IActionResult> Test(int id, [FromBody] MailPayload b, [FromQuery] string lang = "EN")
    {
        lang = (lang ?? "EN").Trim().ToUpperInvariant();
        await using var con = Con(); await con.OpenAsync();
        if (!await MayUse(con)) return StatusCode(403, new { error = "You do not have the right to release or publish documents." });
        var me = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 e.Email FROM EmailContact e JOIN Accounts a ON a.IDEC = e.IDEC WHERE a.IdAcc = @a", new { a = Acc });
        if (!MailService.IsValid(me)) return BadRequest(new { error = "Your account has no e-mail address. Add it in Options > User management first." });
        try { await mail.SendAsync(new[] { me!.Trim() }, Array.Empty<string>(), "[TEST] " + (b.Subject ?? ""), b.Html ?? "", lang); }
        catch (MailException ex) { return StatusCode(502, new { error = ex.Message }); }
        return Ok(new { sentTo = me });
    }
}
