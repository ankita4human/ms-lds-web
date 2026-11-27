using System.IO.Compression;
using System.Net;
using System.Text;
using System.Xml;

namespace PhaseLift.Api;

/// Builds a self-contained HTML version of a document (no Office, no external service): Word, Excel, PowerPoint, OpenDocument and text.
/// Everything that comes from the file is HTML-encoded; images are inlined as data URIs, so the page is one file that can be saved.
public static class HtmlPreview
{
    public static readonly string[] Convertible = { ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".txt", ".csv", ".md", ".log", ".xml", ".json", ".rtf", ".pdf", ".doc", ".xls", ".ppt" };
    const int MaxRows = 1000, MaxCols = 60, MaxImg = 3_000_000;
    static string E(string? s) => WebUtility.HtmlEncode(s ?? "");

    public static string Page(string title, string body, string? note = null) => $@"<!DOCTYPE html><html lang=""en""><head><meta charset=""utf-8""><meta name=""viewport"" content=""width=device-width,initial-scale=1"">
<meta http-equiv=""Content-Security-Policy"" content=""default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"">
<title>{E(title)}</title><style>
body{{font:15px/1.6 'Segoe UI',system-ui,sans-serif;color:#1e293b;background:#eef2f7;margin:0}}
.bar{{position:sticky;top:0;background:#1e3a8a;color:#fff;padding:10px 22px;font-weight:600;display:flex;gap:14px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.2)}}
.bar small{{opacity:.8;font-weight:400}} .bar button{{margin-left:auto;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-weight:600}}
.sheet{{max-width:920px;margin:22px auto;background:#fff;padding:44px 56px;border-radius:6px;box-shadow:0 4px 22px rgba(15,23,42,.14)}}
.sheet.wide{{max-width:none;margin:22px;padding:22px;overflow:auto}}
h1,h2,h3,h4,h5,h6{{line-height:1.25;color:#0f172a;margin:1.1em 0 .4em}} p{{margin:.45em 0}} p.li{{padding-left:1.4em;text-indent:-1em}}
table{{border-collapse:collapse;margin:12px 0;font-size:14px}} td,th{{border:1px solid #cbd5e1;padding:5px 9px;vertical-align:top}} th{{background:#e2e8f0}}
tr:nth-child(even) td{{background:#f8fafc}} img{{max-width:100%;height:auto}}
.slide{{border:1px solid #cbd5e1;border-radius:10px;padding:18px 24px;margin:16px 0;background:#f8fafc}} .slide h3{{margin-top:0;color:#1e3a8a}}
.sh{{margin:26px 0 6px;font-weight:700;color:#1e3a8a}} .note{{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;margin:0 0 14px;font-size:13px}}
pre{{white-space:pre-wrap;word-break:break-word;font:13.5px/1.55 Consolas,monospace}}
@media print{{.bar{{display:none}} body{{background:#fff}} .sheet{{box-shadow:none;margin:0}}}}
</style></head><body><div class=""bar"">{E(title)}<small>Web preview</small><button onclick=""window.print()"">Print</button></div>
<div class=""sheet{(body.StartsWith("<table") || body.Contains("class=\"sh\"") ? " wide" : "")}"">{(note is null ? "" : $"<div class=\"note\">{E(note)}</div>")}{body}</div></body></html>";

    public static string Convert(string path, string title)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        try
        {
            return ext switch
            {
                ".docx" => Page(title, Docx(path)),
                ".xlsx" => Page(title, Xlsx(path)),
                ".pptx" => Page(title, Pptx(path)),
                ".odt" or ".ods" or ".odp" => Page(title, Paragraphs(TextExtractor.Extract(path))),
                ".pdf" or ".doc" or ".xls" or ".ppt" or ".rtf" => Page(title, Paragraphs(TextExtractor.Extract(path)), "Text version only: the layout, pictures and formatting of the original file are not shown. Download the original to see everything."),
                ".html" or ".htm" => Page(title, "<pre>" + E(File.ReadAllText(path)) + "</pre>"),
                _ => Page(title, "<pre>" + E(TextExtractor.Extract(path)) + "</pre>"),
            };
        }
        catch (Exception ex) { return Page(title, "<p>This file could not be converted: " + E(ex.Message) + "</p>"); }
    }

    static string Paragraphs(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "<p><i>No readable text was found in this file (it may be a scanned image).</i></p>";
        var sb = new StringBuilder();
        foreach (var l in text.Split('\n')) { var t = l.Trim(); if (t.Length > 0) sb.Append("<p>").Append(E(t)).Append("</p>"); }
        return sb.ToString();
    }

    static XmlReader Open(ZipArchiveEntry e) => XmlReader.Create(e.Open(), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });

    // ---------------- Word ----------------
    static string Docx(string path)
    {
        using var z = ZipFile.OpenRead(path);
        var rels = new Dictionary<string, string>();
        var re = z.GetEntry("word/_rels/document.xml.rels");
        if (re is not null) using (var r = Open(re)) while (r.Read()) if (r.NodeType == XmlNodeType.Element && r.LocalName == "Relationship") rels[r.GetAttribute("Id") ?? ""] = r.GetAttribute("Target") ?? "";
        var doc = z.GetEntry("word/document.xml") ?? throw new InvalidDataException("word/document.xml is missing");
        var sb = new StringBuilder(); var p = new StringBuilder(); int tableDepth = 0;
        string? style = null; bool inRun = false, b = false, i = false, u = false, numbered = false, inPara = false; long imgBytes = 0;
        using var x = Open(doc); var again = false;
        while (again || x.Read())
        {
            again = false;
            if (x.NodeType == XmlNodeType.Element)
            {
                switch (x.LocalName)
                {
                    case "tbl": tableDepth++; sb.Append("<table>"); break;
                    case "tr": sb.Append("<tr>"); break;
                    case "tc": sb.Append("<td>"); break;
                    case "p": inPara = true; p.Clear(); style = null; numbered = false; break;
                    case "pStyle": style = x.GetAttribute("val", x.NamespaceURI); break;
                    case "numPr": numbered = true; break;
                    case "r": inRun = true; b = i = u = false; break;
                    case "b" when inRun: b = x.GetAttribute("val", x.NamespaceURI) is not ("0" or "false"); break;
                    case "i" when inRun: i = x.GetAttribute("val", x.NamespaceURI) is not ("0" or "false"); break;
                    case "u" when inRun: u = x.GetAttribute("val", x.NamespaceURI) is not ("none" or "0"); break;
                    case "tab": p.Append("&emsp;"); break;
                    case "br": p.Append("<br>"); break;
                    case "t" when !x.IsEmptyElement:
                        var t = E(x.ReadElementContentAsString());
                        if (b) t = "<b>" + t + "</b>"; if (i) t = "<i>" + t + "</i>"; if (u) t = "<u>" + t + "</u>";
                        p.Append(t);
                        again = true;   // the reader already moved past </w:t>: look at that node before reading on
                        break;
                    case "blip":
                        var rid = x.GetAttribute("embed", "http://schemas.openxmlformats.org/officeDocument/2006/relationships");
                        if (rid is not null && rels.TryGetValue(rid, out var target))
                        {
                            var en = z.GetEntry("word/" + target.TrimStart('/').Replace("word/", ""));
                            if (en is not null && en.Length < MaxImg && imgBytes + en.Length < 12_000_000)
                            {
                                imgBytes += en.Length; using var s = en.Open(); using var ms = new MemoryStream(); s.CopyTo(ms);
                                var ex = Path.GetExtension(en.Name).ToLowerInvariant().TrimStart('.');
                                var mime = ex is "png" ? "image/png" : ex is "gif" ? "image/gif" : ex is "jpg" or "jpeg" ? "image/jpeg" : ex is "svg" ? "image/svg+xml" : "";
                                if (mime.Length > 0) p.Append($"<img src=\"data:{mime};base64,{System.Convert.ToBase64String(ms.ToArray())}\" alt=\"\">");
                            }
                        }
                        break;
                }
            }
            else if (x.NodeType == XmlNodeType.EndElement)
            {
                switch (x.LocalName)
                {
                    case "r": inRun = false; break;
                    case "p" when inPara:
                        inPara = false;
                        var h = style is null ? 0 : style.StartsWith("Heading", StringComparison.OrdinalIgnoreCase) && int.TryParse(style[7..].Trim(), out var n) ? Math.Clamp(n, 1, 6) : style.Equals("Title", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
                        var html = p.ToString();
                        if (html.Length == 0 && tableDepth == 0) break;
                        if (h > 0) sb.Append($"<h{h}>{html}</h{h}>");
                        else if (numbered) sb.Append($"<p class=\"li\">• {html}</p>");
                        else sb.Append($"<p>{html}</p>");
                        break;
                    case "tc": sb.Append("</td>"); break;
                    case "tr": sb.Append("</tr>"); break;
                    case "tbl": tableDepth--; sb.Append("</table>"); break;
                }
            }
        }
        return sb.Length == 0 ? "<p><i>This document has no text.</i></p>" : sb.ToString();
    }

    // ---------------- Excel ----------------
    static int ColIndex(string cellRef) { int n = 0; foreach (var c in cellRef) { if (!char.IsLetter(c)) break; n = n * 26 + (char.ToUpperInvariant(c) - 'A' + 1); } return Math.Max(n - 1, 0); }

    static string Xlsx(string path)
    {
        using var z = ZipFile.OpenRead(path);
        var shared = new List<string>();
        var se = z.GetEntry("xl/sharedStrings.xml");
        if (se is not null) using (var r = Open(se))
        {
            var cur = new StringBuilder(); bool inSi = false, inPh = false, again = false;
            while (again || r.Read())
            {
                again = false;
                if (r.NodeType == XmlNodeType.Element)
                {
                    if (r.LocalName == "si") { if (r.IsEmptyElement) shared.Add(""); else { inSi = true; cur.Clear(); } }
                    else if (r.LocalName == "rPh") inPh = true;
                    else if (r.LocalName == "t" && inSi && !inPh && !r.IsEmptyElement) { cur.Append(r.ReadElementContentAsString()); again = true; }
                }
                else if (r.NodeType == XmlNodeType.EndElement)
                {
                    if (r.LocalName == "rPh") inPh = false;
                    else if (r.LocalName == "si" && inSi) { shared.Add(cur.ToString()); inSi = false; }
                }
            }
        }
        var names = new List<string>();
        var we = z.GetEntry("xl/workbook.xml");
        if (we is not null) using (var r = Open(we)) while (r.Read()) if (r.NodeType == XmlNodeType.Element && r.LocalName == "sheet") names.Add(r.GetAttribute("name") ?? "");
        var sheets = z.Entries.Where(e => e.FullName.StartsWith("xl/worksheets/sheet") && e.FullName.EndsWith(".xml"))
            .OrderBy(e => { var n = new string(e.Name.Where(char.IsDigit).ToArray()); return int.TryParse(n, out var v) ? v : 0; }).ToList();
        var sb = new StringBuilder(); int idx = 0;
        foreach (var sh in sheets)
        {
            sb.Append("<div class=\"sh\">").Append(E(idx < names.Count ? names[idx] : $"Sheet {idx + 1}")).Append("</div>"); idx++;
            var rows = new List<string[]>(); int maxCol = 0; bool cut = false;
            using (var r = Open(sh))
            {
                string[]? row = null; string t = "", cr = ""; bool inIs = false, has = false, again = false; var val = new StringBuilder();
                while (again || r.Read())
                {
                    again = false;
                    if (r.NodeType == XmlNodeType.Element)
                    {
                        if (r.LocalName == "row") { if (rows.Count >= MaxRows) { cut = true; break; } row = new string[MaxCols]; }
                        else if (r.LocalName == "c") { cr = r.GetAttribute("r") ?? ""; t = r.GetAttribute("t") ?? ""; val.Clear(); has = false; inIs = false; }
                        else if (r.LocalName == "is") inIs = true;
                        else if ((r.LocalName == "v" || (r.LocalName == "t" && inIs)) && !r.IsEmptyElement) { val.Append(r.ReadElementContentAsString()); has = true; again = true; }
                    }
                    else if (r.NodeType == XmlNodeType.EndElement)
                    {
                        if (r.LocalName == "c" && row is not null && has)
                        {
                            var c = ColIndex(cr); var s2 = val.ToString();
                            if (t == "s" && int.TryParse(s2, out var si) && si >= 0 && si < shared.Count) s2 = shared[si];
                            else if (t == "b") s2 = s2 == "1" ? "TRUE" : "FALSE";
                            if (c < MaxCols) { row[c] = s2; maxCol = Math.Max(maxCol, c + 1); }
                        }
                        else if (r.LocalName == "row" && row is not null) { rows.Add(row); row = null; }
                    }
                }
            }
            if (rows.Count == 0) { sb.Append("<p><i>Empty sheet.</i></p>"); continue; }
            sb.Append("<table>");
            foreach (var rw in rows) { sb.Append("<tr>"); for (int c = 0; c < maxCol; c++) sb.Append("<td>").Append(E(rw[c])).Append("</td>"); sb.Append("</tr>"); }
            sb.Append("</table>");
            if (cut) sb.Append($"<p><i>Only the first {MaxRows} rows are shown. Download the file to see the rest.</i></p>");
        }
        return sb.Length == 0 ? "<p><i>This workbook is empty.</i></p>" : sb.ToString();
    }

    // ---------------- PowerPoint ----------------
    static string Pptx(string path)
    {
        using var z = ZipFile.OpenRead(path);
        var slides = z.Entries.Where(e => e.FullName.StartsWith("ppt/slides/slide") && e.FullName.EndsWith(".xml"))
            .OrderBy(e => { var n = new string(e.Name.Where(char.IsDigit).ToArray()); return int.TryParse(n, out var v) ? v : 0; }).ToList();
        var sb = new StringBuilder(); int k = 0;
        foreach (var sl in slides)
        {
            sb.Append($"<div class=\"slide\"><h3>Slide {++k}</h3>");
            using var r = Open(sl); var para = new StringBuilder(); var again = false;
            while (again || r.Read())
            {
                again = false;
                if (r.NodeType == XmlNodeType.Element && r.LocalName == "t" && !r.IsEmptyElement) { para.Append(E(r.ReadElementContentAsString())); again = true; }
                else if (r.NodeType == XmlNodeType.EndElement && r.LocalName == "p") { if (para.Length > 0) sb.Append("<p>").Append(para).Append("</p>"); para.Clear(); }
            }
            sb.Append("</div>");
        }
        return sb.Length == 0 ? "<p><i>No slides found.</i></p>" : sb.ToString();
    }
}
