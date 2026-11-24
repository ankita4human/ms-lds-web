using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace PhaseLift.Api;

/// Builds the release / publish e-mail from the template stored in table ApplicationEmail (MailType LDSRelease / LDSPublish, one row per language).
/// The template stays the source of the wording and of which document properties are listed (an administrator can still edit it in the DB Tool):
/// its first sentence becomes the intro, every "Label: $Tag$" row becomes a detail row, its link line becomes the buttons.
/// The result is laid out as a modern e-mail (inline styles, tables, 600 px card - works in Outlook, Gmail and on phones).
/// If the template cannot be read the original layout is returned with the tags replaced ("Classic").
public static partial class MailLayout
{
    public class Model
    {
        public string Stage = "release";            // release | publish
        public string Lang = "EN";
        public string Template = "";                // ApplicationEmail.Body
        public Dictionary<string, string> Tags = new(StringComparer.OrdinalIgnoreCase);   // $Tag$ -> value
        public string HeaderHtml = "";              // already html (encoded)
        public string FooterHtml = "";
        public string Brand = "";                   // Config DBName
        public string FontFamily = "Arial";
        public string? WebHtml, WebPdf, WebOriginal;   // published links (null = not available)
        public string DocName = "", DocId = "", Version = "";
    }

    static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    // ---------------- texts that are not in the template ----------------
    static readonly Dictionary<string, (string rel, string pub, string details, string open, string note)> T = new(StringComparer.OrdinalIgnoreCase)
    {
        ["EN"] = ("Document released", "Document published", "Document details", "Open document", "This message was sent by MS LDS."),
        ["DE"] = ("Dokument freigegeben", "Dokument veröffentlicht", "Dokumentdetails", "Dokument öffnen", "Diese Nachricht wurde von MS LDS gesendet."),
        ["PL"] = ("Dokument zwolniony", "Dokument opublikowany", "Szczegóły dokumentu", "Otwórz dokument", "Wiadomość wysłana przez MS LDS."),
    };
    static (string rel, string pub, string details, string open, string note) Tx(string lang) => T.TryGetValue(lang ?? "EN", out var t) ? t : T["EN"];

    // ---------------- helpers ----------------
    /// Replaces $Tag$ with the (optionally html encoded) value, longest tag first.
    public static string Apply(string text, IReadOnlyDictionary<string, string> tags, bool encode)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        foreach (var k in tags.Keys.Where(k => k.Length > 1).OrderByDescending(k => k.Length))
            text = Replace(text, k, encode ? E(tags[k]) : tags[k]);
        return text;
    }
    static string Replace(string text, string find, string value)
    {
        var i = text.IndexOf(find, StringComparison.OrdinalIgnoreCase);
        if (i < 0) return text;
        var sb = new StringBuilder(); var last = 0;
        while (i >= 0) { sb.Append(text, last, i - last).Append(value); last = i + find.Length; i = text.IndexOf(find, last, StringComparison.OrdinalIgnoreCase); }
        return sb.Append(text, last, text.Length - last).ToString();
    }

    [GeneratedRegex(@"<tr[^>]*>\s*<td[^>]*>(?<l>[^<]*)</td>\s*<td[^>]*>(?<v>[^<]*)</td>\s*</tr>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex RowRx();
    [GeneratedRegex(@"<tr[^>]*>\s*<td[^>]*>(?<t>[^<]*<em>.*?)</td>\s*</tr>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex IntroRx();
    [GeneratedRegex(@"\$[^$<>]{1,60}\$")]
    private static partial Regex LeftTag();
    [GeneratedRegex(@"<body[^>]*>(?<b>.*)</body>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex BodyRx();

    static string First(IReadOnlyDictionary<string, string> t, params string[] keys)
    {
        foreach (var k in keys) if (t.TryGetValue(k, out var v) && !string.IsNullOrWhiteSpace(v)) return v;
        return "";
    }

    static IReadOnlyDictionary<string, string> WithLinks(Model m)
    {
        var d = new Dictionary<string, string>(m.Tags, StringComparer.OrdinalIgnoreCase)
        {
            ["#webHtmlurl#"] = m.WebHtml ?? "", ["#webHtmlurlRef#"] = m.WebHtml ?? "",
            ["#webPdfurlRef#"] = m.WebPdf ?? "", ["#webOriginalurlRef#"] = m.WebOriginal ?? ""
        };
        return d;
    }

    // ---------------- modern layout ----------------
    public static string Modern(Model m)
    {
        var tags = WithLinks(m);
        var tx = Tx(m.Lang);
        var publish = m.Stage == "publish";
        var a1 = publish ? "#0f9d6b" : "#2f6df6"; var a2 = publish ? "#087f5b" : "#1d4ed8";
        var ff = $"{m.FontFamily.Replace("\"", "")}, 'Segoe UI', Helvetica, Arial, sans-serif";

        var name = m.DocName; var ver = m.Version; var id = m.DocId;
        var status = First(m.Tags, "$StatusLong$", "$StatusLang$", "$StatusDługi$");
        var title = publish ? tx.pub : tx.rel;

        // intro: the template's first sentence (<em>…</em> becomes bold)
        var intro = "";
        var im = IntroRx().Match(m.Template);
        if (im.Success)
        {
            var raw = Apply(im.Groups["t"].Value, m.Tags, true);
            intro = Regex.Replace(raw, "<\\s*(/?)em\\s*>", "<${1}strong>", RegexOptions.IgnoreCase);
        }
        if (intro.Length == 0) intro = $"<strong>{E(name)}</strong> (ID {E(id)})";

        // detail rows from the template, in the template's order
        var rows = new List<(string l, string v)>();
        foreach (Match r in RowRx().Matches(m.Template))
        {
            var rawV = r.Groups["v"].Value;
            if (!LeftTag().IsMatch(rawV)) continue;
            var v = Apply(rawV, m.Tags, false).Trim();
            if (v.Length == 0 || LeftTag().IsMatch(v)) continue;                  // empty, or a tag that does not exist in this context (workflow tags)
            var l = WebUtility.HtmlDecode(r.Groups["l"].Value).Trim().TrimEnd(':').Trim();
            if (l.Length > 0) rows.Add((l, v));
        }

        var sb = new StringBuilder();
        sb.Append($"<div data-pl=\"mail\" style=\"background:#eef2f7;padding:28px 12px;font-family:{ff};\">");
        sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td align=\"center\">");
        sb.Append("<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e7ec;\">");

        // banner
        sb.Append($"<tr><td bgcolor=\"{a2}\" style=\"background-color:{a2};background-image:linear-gradient(135deg,{a1},{a2});padding:28px 32px;color:#ffffff;\">");
        sb.Append($"<div style=\"font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#dbe6ff;\">MS LDS{(m.Brand.Length > 0 ? " · " + E(m.Brand) : "")}</div>");
        sb.Append($"<div style=\"font-size:26px;font-weight:700;line-height:1.25;margin-top:10px;color:#ffffff;\">{E(title)}</div>");
        if (status.Length > 0)
            sb.Append($"<div style=\"margin-top:14px;\"><span style=\"display:inline-block;background-color:#ffffff;color:{a2};border-radius:999px;padding:5px 14px;font-size:12px;font-weight:700;\">{E(status)}</span></div>");
        sb.Append("</td></tr>");

        // editable header text
        sb.Append($"<tr><td style=\"padding:26px 32px 0 32px;\"><div data-pl=\"header\" data-ph=\"Add a personal message here (optional)\" style=\"font-size:15px;line-height:1.65;color:#344054;\">{m.HeaderHtml}</div></td></tr>");

        // intro sentence
        sb.Append($"<tr><td style=\"padding:16px 32px 0 32px;\"><div style=\"font-size:15px;line-height:1.65;color:#101828;\">{intro}</div></td></tr>");

        // document card
        sb.Append("<tr><td style=\"padding:20px 32px 0 32px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#f8fafc;border:1px solid #e4e7ec;border-radius:12px;\">");
        sb.Append($"<tr><td style=\"padding:16px 18px 10px 18px;\"><div style=\"font-size:12px;color:#667085;\">{E(tx.details)} · ID {E(id)}{(ver.Length > 0 ? " · v" + E(ver) : "")}</div>");
        sb.Append($"<div style=\"font-size:19px;font-weight:700;color:#101828;margin-top:4px;line-height:1.3;\">{E(name)}</div></td></tr>");
        if (rows.Count > 0)
        {
            sb.Append("<tr><td style=\"padding:0 18px 14px 18px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">");
            var i = 0;
            foreach (var (l, v) in rows)
            {
                var bg = i++ % 2 == 0 ? "#ffffff" : "#f2f5f9";
                sb.Append($"<tr><td width=\"38%\" valign=\"top\" style=\"background-color:{bg};padding:8px 12px;font-size:13px;color:#667085;border-top:1px solid #e4e7ec;\">{E(l)}</td>");
                sb.Append($"<td valign=\"top\" style=\"background-color:{bg};padding:8px 12px;font-size:13px;color:#101828;font-weight:600;border-top:1px solid #e4e7ec;\">{E(v)}</td></tr>");
            }
            sb.Append("</table></td></tr>");
        }
        sb.Append("</table></td></tr>");

        // buttons (publish)
        var btn = new List<string>();
        string Btn(string url, string text, bool primary) => primary
            ? $"<a href=\"{E(url)}\" style=\"display:inline-block;background-color:{a1};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;margin:0 8px 8px 0;\">{E(text)}</a>"
            : $"<a href=\"{E(url)}\" style=\"display:inline-block;background-color:#ffffff;color:{a1};text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border:1px solid {a1};border-radius:10px;margin:0 8px 8px 0;\">{E(text)}</a>";
        if (publish)
        {
            var anchors = AnchorTexts(m.Template);
            if (!string.IsNullOrEmpty(m.WebHtml)) btn.Add(Btn(m.WebHtml, tx.open, true));
            if (!string.IsNullOrEmpty(m.WebPdf)) btn.Add(Btn(m.WebPdf, anchors.GetValueOrDefault("#webPdfurlRef#", "PDF"), false));
            if (!string.IsNullOrEmpty(m.WebOriginal)) btn.Add(Btn(m.WebOriginal, anchors.GetValueOrDefault("#webOriginalurlRef#", "Original"), false));
        }
        if (btn.Count > 0) sb.Append($"<tr><td style=\"padding:22px 32px 0 32px;\">{string.Concat(btn)}</td></tr>");

        // editable footer text
        sb.Append($"<tr><td style=\"padding:22px 32px 0 32px;\"><div data-pl=\"footer\" data-ph=\"Add a closing text here (optional)\" style=\"font-size:14px;line-height:1.6;color:#475467;\">{m.FooterHtml}</div></td></tr>");
        sb.Append($"<tr><td style=\"padding:22px 32px 26px 32px;\"><div style=\"border-top:1px solid #e4e7ec;padding-top:14px;font-size:12px;color:#98a2b3;line-height:1.5;\">{E(tx.note)}</div></td></tr>");
        sb.Append("</table></td></tr></table></div>");
        return sb.ToString();
    }

    static Dictionary<string, string> AnchorTexts(string template)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match a in Regex.Matches(template, @"<a[^>]*href\s*=\s*['""]*(?<r>#\w+#)['""]*[^>]*>(?<t>.*?)</a>", RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            var t = WebUtility.HtmlDecode(Regex.Replace(a.Groups["t"].Value, "<[^>]+>", "")).Trim();
            if (t.Length > 0 && !t.StartsWith('#')) d[a.Groups["r"].Value] = t;
        }
        return d;
    }

    // ---------------- classic layout (the template as it is stored) ----------------
    public static string Classic(Model m)
    {
        var tags = WithLinks(m);
        var body = BodyRx().Match(m.Template) is { Success: true } b ? b.Groups["b"].Value : m.Template;
        // remove rows whose tag does not exist in this context (workflow tags) or whose value is empty
        body = RowRx().Replace(body, r =>
        {
            var v = r.Groups["v"].Value;
            if (!LeftTag().IsMatch(v)) return r.Value;
            var val = Apply(v, m.Tags, false).Trim();
            return val.Length == 0 || LeftTag().IsMatch(val) ? "" : r.Value;
        });
        body = Apply(body, tags, true);
        body = body.Replace("''", "'");
        if (m.Stage == "release" || string.IsNullOrEmpty(m.WebHtml))   // no links known: drop the link table
            body = Regex.Replace(body, @"<table[^>]*id=['""]?links['""]?[^>]*>.*?</table>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        body = body.Replace("#header#", $"<div data-pl=\"header\" data-ph=\"Add a personal message here (optional)\">{m.HeaderHtml}</div>")
                   .Replace("#footer#", $"<div data-pl=\"footer\" data-ph=\"Add a closing text here (optional)\">{m.FooterHtml}</div>");
        return $"<div style=\"font-family:{m.FontFamily.Replace("\"", "")}, Arial, sans-serif;font-size:14px;color:#101828;padding:12px;background:#ffffff;\">{body}</div>";
    }

    /// Plain text (as stored in Config EmailHeader / DocEmail.Header) to html.
    public static string TextToHtml(string? text) => string.IsNullOrWhiteSpace(text) ? "" : E(text).Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "<br>");
}
