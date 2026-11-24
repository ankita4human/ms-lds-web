using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Data.SqlClient;
using MimeKit;

namespace PhaseLift.Api;

/// What the browser sends for one e-mail (release or publish): the edited draft.
public class MailPayload
{
    public bool Send { get; set; } = true;
    public List<string>? To { get; set; }
    public List<string>? Cc { get; set; }
    public string? Subject { get; set; }
    public string? Html { get; set; }       // the whole message as edited in the rich text editor (fragment, no <html>/<body>)
    public string? Header { get; set; }     // plain text of the header block (saved to DocEmail like the legacy "Add Email Address" window)
    public string? Footer { get; set; }
}

public class FlagRow { public bool? RelFlg { get; set; } public bool? PubFlg { get; set; } }

public class MailException(string message) : Exception(message);

public class SmtpSettings
{
    public string Host { get; set; } = ""; public int Port { get; set; } = 587; public string Security { get; set; } = "StartTls";
    public string User { get; set; } = ""; public string Password { get; set; } = "";
    public string FromAddress { get; set; } = ""; public string FromName { get; set; } = "";
    public bool Configured => Host.Length > 0 && FromAddress.Length > 0;
    public string FromText => FromName.Length > 0 ? $"{FromName} <{FromAddress}>" : FromAddress;
}

/// E-mail sending (legacy QDSPostMan). Server and sender come from the Config table:
///   smtpServer (host, optionally host:port), smtpFrom (sender name, or address), pop3login / pop3password (sign-in of the mail account).
/// The mail account is also the sender address when smtpFrom holds only a display name (as in the legacy database).
/// appsettings / environment can override: Smtp:Host, Smtp:Port, Smtp:Security (StartTls | Ssl | Auto | None), Smtp:User, Smtp:Password (use Smtp__Password), Smtp:From.
/// The password is never logged or returned to the browser.
public partial class MailService(IConfiguration cfg, ILogger<MailService> log)
{
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    public static async Task<string> C(SqlConnection con, string name) =>
        (await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name }))?.Trim() ?? "";

    public async Task<SmtpSettings> Settings(SqlConnection con)
    {
        var s = new SmtpSettings();
        var host = cfg["Smtp:Host"] ?? await C(con, "smtpServer");
        int? port = int.TryParse(cfg["Smtp:Port"], out var p0) ? p0 : null;
        var colon = host.LastIndexOf(':');
        if (colon > 0 && host.IndexOf(':') == colon && int.TryParse(host[(colon + 1)..], out var p1)) { port ??= p1; host = host[..colon]; }
        s.Host = host.Trim(); s.Port = port ?? 587;
        s.User = cfg["Smtp:User"] ?? await C(con, "pop3login");
        s.Password = cfg["Smtp:Password"] ?? await C(con, "pop3password");
        var from = cfg["Smtp:From"] ?? await C(con, "smtpFrom");
        if (from.Contains('@')) s.FromAddress = from;
        else { s.FromName = from; if (s.User.Contains('@')) s.FromAddress = s.User; }
        s.Security = cfg["Smtp:Security"] ?? (s.Port == 465 ? "Ssl" : "StartTls");
        return s;
    }

    /// Config StopEmail / StartTime / EndTime: no publish mails in that time window (legacy checkForEmailSent). Returns when sending may resume.
    public async Task<DateTime?> QuietUntil(SqlConnection con)
    {
        if (await C(con, "StopEmail") != "1") return null;
        if (!TimeSpan.TryParse(await C(con, "StartTime"), out var start) || !TimeSpan.TryParse(await C(con, "EndTime"), out var end)) return null;
        var now = DateTime.Now; var t = now.TimeOfDay;
        var inside = start <= end ? t >= start && t <= end : t >= start || t <= end;
        if (!inside) return null;
        var until = now.Date + end;
        if (until <= now) until = until.AddDays(1);
        return until;
    }

    // ---------------- addresses ----------------
    static readonly Regex Addr = new(@"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$", RegexOptions.Compiled);
    public static bool IsValid(string? a) => !string.IsNullOrWhiteSpace(a) && a.Length <= 254 && Addr.IsMatch(a.Trim());
    public static List<string> Split(string? s) =>
        (s ?? "").Split(new[] { ';', ',', '\n', '\r', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// null = fine (or no mail wanted); otherwise the message for the user.
    public static string? Validate(MailPayload? p)
    {
        if (p is not { Send: true }) return null;
        var all = (p.To ?? new()).Concat(p.Cc ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        if (all.Count == 0) return "The e-mail has no recipient. Add an address in To or CC, or switch the e-mail off.";
        var bad = all.FirstOrDefault(x => !IsValid(x));
        if (bad is not null) return $"“{bad}” is not a valid e-mail address.";
        if (string.IsNullOrWhiteSpace(p.Html)) return "The e-mail text is empty.";
        return null;
    }

    // ---------------- html ----------------
    [GeneratedRegex(@"<\s*(script|iframe|object|embed|link|meta|base|form|style)\b[^>]*>.*?<\s*/\s*\1\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex BadBlocks();
    [GeneratedRegex(@"<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*/?>", RegexOptions.IgnoreCase)]
    private static partial Regex BadTags();
    [GeneratedRegex(@"\s+on\w+\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex Handlers();
    [GeneratedRegex(@"(href|src)\s*=\s*(""|')?\s*javascript:[^""'>\s]*(""|')?", RegexOptions.IgnoreCase)]
    private static partial Regex JsUrls();

    /// The mail is written by a signed-in user, but anything that could run code in a mail client is removed anyway.
    public static string Clean(string? html)
    {
        var h = html ?? "";
        h = BadBlocks().Replace(h, "");
        h = BadTags().Replace(h, "");
        h = Handlers().Replace(h, "");
        h = JsUrls().Replace(h, "$1=\"#\"");
        return h;
    }

    public static string ToText(string html)
    {
        var t = Regex.Replace(html ?? "", @"<\s*(br|/p|/div|/tr|/h\d|/li)\s*/?>", "\n", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, @"</t[dh]\s*>", "  ", RegexOptions.IgnoreCase);
        t = Regex.Replace(t, @"<[^>]+>", "");
        t = WebUtility.HtmlDecode(t);
        t = Regex.Replace(t, @"[ \t]+\n", "\n"); t = Regex.Replace(t, @"\n{3,}", "\n\n");
        return t.Trim();
    }

    public static string Document(string fragment, string subject, string lang) =>
        "<!DOCTYPE html><html lang=\"" + WebUtility.HtmlEncode((lang ?? "en").ToLowerInvariant()) + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<meta name=\"x-apple-disable-message-reformatting\"><title>" + WebUtility.HtmlEncode(subject) + "</title></head><body style=\"margin:0;padding:0;background:#eef2f7\">" + fragment + "</body></html>";

    // ---------------- send ----------------
    /// Sends one message. Throws MailException with a readable text.
    public async Task SendAsync(IEnumerable<string> to, IEnumerable<string> cc, string subject, string htmlFragment, string lang, CancellationToken ct = default)
    {
        await using var con = Con(); await con.OpenAsync(ct);
        var s = await Settings(con);
        if (!s.Configured) throw new MailException("The mail server is not set up: fill Config smtpServer, smtpFrom and pop3login (or Smtp__Host / Smtp__From in the API settings).");
        var toL = to.Where(IsValid).Select(x => x.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var ccL = cc.Where(IsValid).Select(x => x.Trim()).Where(x => !toL.Contains(x, StringComparer.OrdinalIgnoreCase)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (toL.Count + ccL.Count == 0) throw new MailException("There is no valid recipient.");

        var msg = new MimeMessage();
        msg.From.Add(new MailboxAddress(s.FromName, s.FromAddress));
        // Only one visible list is needed: when there is no To address the first CC address becomes the To address.
        if (toL.Count == 0) { toL.Add(ccL[0]); ccL.RemoveAt(0); }
        foreach (var a in toL) msg.To.Add(MailboxAddress.Parse(a));
        foreach (var a in ccL) msg.Cc.Add(MailboxAddress.Parse(a));
        msg.Subject = string.IsNullOrWhiteSpace(subject) ? "MS LDS Notification" : subject.Trim();
        var clean = Clean(htmlFragment);
        var body = new BodyBuilder { HtmlBody = Document(clean, msg.Subject, lang), TextBody = ToText(clean) };
        msg.Body = body.ToMessageBody();

        var opt = s.Security.ToLowerInvariant() switch
        {
            "ssl" or "sslonconnect" => SecureSocketOptions.SslOnConnect,
            "none" => SecureSocketOptions.None,
            "auto" => SecureSocketOptions.Auto,
            _ => SecureSocketOptions.StartTls
        };
        using var client = new SmtpClient { Timeout = 30000 };
        try
        {
            await client.ConnectAsync(s.Host, s.Port, opt, ct);
            if (s.User.Length > 0) await client.AuthenticateAsync(s.User, s.Password, ct);
            await client.SendAsync(msg, ct);
            await client.DisconnectAsync(true, ct);
            log.LogInformation("Mail sent: \"{Subject}\" to {To} (+{Cc} cc)", msg.Subject, string.Join(", ", toL), ccL.Count);
        }
        catch (AuthenticationException ex) { throw new MailException($"The mail server {s.Host} rejected the sign-in (Config pop3login / pop3password): {ex.Message}"); }
        catch (SmtpCommandException ex) { throw new MailException($"The mail server {s.Host} refused the message: {ex.Message}"); }
        catch (SslHandshakeException ex) { throw new MailException($"Secure connection to {s.Host}:{s.Port} failed ({ex.Message}). Try Smtp__Security = Ssl (port 465) or StartTls (port 587)."); }
        catch (Exception ex) when (ex is System.Net.Sockets.SocketException or IOException or TimeoutException or OperationCanceledException or SmtpProtocolException)
        { throw new MailException($"The mail server {s.Host}:{s.Port} could not be reached: {ex.Message}"); }
    }

    /// Validates the edited draft and sends it. Used by release (at once) and by the publish worker (after publishing, honouring the quiet hours).
    public Task SendPayloadAsync(MailPayload p, string lang, string subjectPrefix = "", CancellationToken ct = default) =>
        SendAsync(p.To ?? new(), p.Cc ?? new(), subjectPrefix + (p.Subject ?? ""), p.Html ?? "", lang, ct);

    /// Remembers the edited values for the document like the legacy "Add Email Address" window (table DocEmail): CC, Subject, Header, Footer,
    /// the To list and the release / publish flags. Release and publish mails of the same document use them.
    public async Task SaveDocEmail(int idDoc, string lang, MailPayload p, string stage)
    {
        await using var con = Con(); await con.OpenAsync();
        var old = await con.QueryFirstOrDefaultAsync<FlagRow>("SELECT TOP 1 RelFlg, PubFlg FROM DocEmail WHERE IDDoc = @idDoc AND Lang = @lang", new { idDoc, lang });
        var relDefault = await C(con, "SendDefaultRelMail") == "1"; var pubDefault = await C(con, "SendDefaultPubMail") == "1";
        var rel = stage == "release" ? p.Send : old?.RelFlg ?? relDefault;
        var pub = stage == "publish" ? p.Send : old?.PubFlg ?? pubDefault;
        static string Cut(string? s, int n) { s ??= ""; return s.Length <= n ? s : s[..n]; }
        await using var tx = await con.BeginTransactionAsync();
        await con.ExecuteAsync("DELETE FROM DocEmail WHERE IDDoc = @idDoc AND Lang = @lang", new { idDoc, lang }, tx);
        await con.ExecuteAsync(@"INSERT INTO DocEmail (IDDoc, Lang, Email, Subject, Header, Footer, RelFlg, PubFlg, EmailTo)
            VALUES (@idDoc, @lang, @cc, @subject, @header, @footer, @rel, @pub, @to)",
            new { idDoc, lang, cc = Cut(string.Join(";", p.Cc ?? new()), 1056), subject = Cut(p.Subject, 1056), header = Cut(p.Header, 1056), footer = Cut(p.Footer, 1056),
                  rel, pub, to = Cut(string.Join(";", p.To ?? new()), 4000) }, tx);
        await tx.CommitAsync();
    }

    /// Runs after a publish job finished: waits for the end of the quiet hours when needed, then sends and reports into the job.
    public async Task SendForJob(PubJob job, MailPayload p)
    {
        try
        {
            DateTime? until;
            await using (var con = Con()) { await con.OpenAsync(); until = await QuietUntil(con); }
            if (until is { } u)
            {
                job.MailStatus = $"waiting until {u:HH:mm}";
                await Task.Delay(u - DateTime.Now + TimeSpan.FromSeconds(2));
            }
            job.MailStatus = "sending";
            await SendPayloadAsync(p, job.Lang);
            job.MailStatus = "sent";
        }
        catch (Exception ex)
        {
            job.MailStatus = "failed"; job.MailError = ex is MailException ? ex.Message : ex.GetBaseException().Message;
            log.LogWarning("Publish mail for D{Id} failed: {Msg}", job.IdDoc, job.MailError);
        }
    }
}
