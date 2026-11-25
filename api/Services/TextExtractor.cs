using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace PhaseLift.Api;

/// Pulls the plain text out of a document file without any external service: Office Open XML (docx, xlsx, pptx), OpenDocument, PDF (PdfPig),
/// text-like files and, approximately, the old binary Office formats (doc, xls, ppt: readable text runs only).
public static class TextExtractor
{
    public const int MaxChars = 2_000_000;
    public const long MaxBytes = 60L * 1024 * 1024;
    public static readonly string[] Supported = { ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".pdf", ".txt", ".csv", ".md", ".log", ".xml", ".json", ".htm", ".html", ".rtf", ".doc", ".xls", ".ppt" };

    public static bool CanRead(string? ext) => Supported.Contains((ext ?? "").ToLowerInvariant());

    public static string Extract(string path)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        string text;
        try
        {
            text = ext switch
            {
                ".docx" => Zip(path, n => n == "word/document.xml" || n.StartsWith("word/header") || n.StartsWith("word/footer") || n == "word/footnotes.xml" || n == "word/endnotes.xml", "t", "p"),
                ".pptx" => Zip(path, n => n.StartsWith("ppt/slides/slide") && n.EndsWith(".xml") || n.StartsWith("ppt/notesSlides/") && n.EndsWith(".xml"), "t", "p"),
                ".xlsx" => Zip(path, n => n == "xl/sharedStrings.xml" || n.StartsWith("xl/worksheets/sheet") && n.EndsWith(".xml"), "t", "si", "row"),
                ".odt" or ".ods" or ".odp" => Zip(path, n => n == "content.xml", null, "p", "h"),
                ".pdf" => Pdf(path),
                ".htm" or ".html" => Html(File.ReadAllText(path, Encoding.UTF8)),
                ".rtf" => Rtf(File.ReadAllText(path, Encoding.Latin1)),
                ".txt" or ".csv" or ".md" or ".log" or ".xml" or ".json" => ReadText(path),
                ".doc" or ".xls" or ".ppt" => Binary(path),
                _ => "",
            };
        }
        catch { text = ""; }
        text = Regex.Replace(text, @"[ \t\u00A0]+", " ");
        text = Regex.Replace(text, @"\s*\n\s*(\n\s*)+", "\n");
        return text.Length > MaxChars ? text[..MaxChars] : text.Trim();
    }

    static string ReadText(string path)
    {
        var b = File.ReadAllBytes(path);
        if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return Encoding.Unicode.GetString(b);
        if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(b);
        var s = Encoding.UTF8.GetString(b);
        return s.Contains('\uFFFD') ? Encoding.Latin1.GetString(b) : s;
    }

    /// Reads every matching XML part of a zip package: text of <textEl> elements (all text nodes when textEl is null), a line break after each break element.
    static string Zip(string path, Func<string, bool> pick, string? textEl, params string[] breakEls)
    {
        var sb = new StringBuilder();
        using var z = ZipFile.OpenRead(path);
        foreach (var e in z.Entries.Where(e => pick(e.FullName)).OrderBy(e => e.FullName, StringComparer.Ordinal))
        {
            using var st = e.Open();
            using var r = XmlReader.Create(st, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            while (r.Read())
            {
                if (r.NodeType == XmlNodeType.Element && textEl is not null && r.LocalName == textEl && !r.IsEmptyElement) { sb.Append(r.ReadElementContentAsString()); sb.Append(' '); if (sb.Length > MaxChars) return sb.ToString(); }
                else if (r.NodeType == XmlNodeType.Text && textEl is null) sb.Append(r.Value);
                else if (r.NodeType == XmlNodeType.EndElement && breakEls.Contains(r.LocalName)) sb.Append('\n');
                else if (r.NodeType == XmlNodeType.Element && (r.LocalName == "tab" || r.LocalName == "br")) sb.Append(' ');
            }
            sb.Append('\n');
        }
        return sb.ToString();
    }

    static string Pdf(string path)
    {
        var sb = new StringBuilder();
        using var doc = UglyToad.PdfPig.PdfDocument.Open(path);
        var n = 0;
        foreach (var page in doc.GetPages()) { sb.AppendLine(page.Text); if (++n >= 800 || sb.Length > MaxChars) break; }
        return sb.ToString();
    }

    static string Html(string h)
    {
        h = Regex.Replace(h, @"<(script|style)[^>]*>.*?</\1>", " ", RegexOptions.Singleline | RegexOptions.IgnoreCase);
        h = Regex.Replace(h, @"<(br|/p|/div|/li|/tr|/h\d)[^>]*>", "\n", RegexOptions.IgnoreCase);
        return System.Net.WebUtility.HtmlDecode(Regex.Replace(h, "<[^>]+>", " "));
    }

    static string Rtf(string r)
    {
        r = Regex.Replace(r, @"\\par[d]?", "\n");
        r = Regex.Replace(r, @"\\'([0-9a-fA-F]{2})", m => ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString());
        r = Regex.Replace(r, @"\\[a-zA-Z]+-?\d* ?|[{}]", "");
        return r;
    }

    /// Old binary Office files: keep the readable text runs (8-bit and UTF-16). Approximate, but good enough to find words.
    static string Binary(string path)
    {
        var b = File.ReadAllBytes(path);
        var sb = new StringBuilder(); var run = new StringBuilder();
        void Flush() { if (run.Length >= 6 && Regex.IsMatch(run.ToString(), @"[A-Za-zÄÖÜäöüß]{3,}") && run.ToString().Count(char.IsLetter) * 10 >= run.Length * 5) sb.Append(run).Append('\n'); run.Clear(); }
        for (var i = 0; i < b.Length; i++)
        {
            var c = b[i];
            if ((c >= 0x20 && c < 0x7F) || c == 0x09 || c >= 0xC0) run.Append(c >= 0xC0 ? Encoding.Latin1.GetString(new[] { c }) : ((char)c).ToString());
            else if (c == 0x0D || c == 0x0A || c == 0x07) { run.Append(' '); }
            else Flush();
        }
        Flush();
        var u = new StringBuilder();
        for (var i = 0; i + 1 < b.Length; i += 2)
        {
            var ch = (char)(b[i] | b[i + 1] << 8);
            if (char.IsLetterOrDigit(ch) || ch == ' ' || ".,;:-()/".Contains(ch)) u.Append(ch);
            else { if (u.Length >= 6) sb.Append(u).Append('\n'); u.Clear(); }
        }
        if (u.Length >= 6) sb.Append(u);
        return sb.ToString();
    }
}
