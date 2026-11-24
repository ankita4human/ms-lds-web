using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace PhaseLift.Api;

/// Replaces the document tags ($DocumentName$, $RevisionNo$, ... from table Replacements) inside Office Open XML files
/// (.docx/.xlsx/.pptx and their macro/template variants) without starting Office. Word, Excel and PowerPoint often split
/// a typed tag over several text runs, so the text of a whole paragraph / shared string is joined, searched, and the
/// replacement is written back into the run where the tag starts (the formatting of that first run is kept).
public static class TagReplacer
{
    static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    static readonly XNamespace A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    static readonly XNamespace X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    static readonly XNamespace Xml = "http://www.w3.org/XML/1998/namespace";

    public static bool Supports(string ext) => ext.ToLowerInvariant() is ".docx" or ".docm" or ".dotx" or ".dotm"
        or ".xlsx" or ".xlsm" or ".xltx" or ".xltm" or ".pptx" or ".pptm" or ".ppsx" or ".ppsm" or ".potx";

    /// Rewrites the package in place. Returns how many tags were replaced.
    public static int ReplaceInFile(string file, IReadOnlyDictionary<string, string> tags)
    {
        if (tags.Count == 0) return 0;
        var names = tags.Keys.Where(k => k.Length > 1).OrderByDescending(k => k.Length).ToArray();   // longest first: $$X$$ before $X$
        var total = 0;
        using var zip = ZipFile.Open(file, ZipArchiveMode.Update);
        foreach (var entry in zip.Entries.ToList())
        {
            var n = entry.FullName;
            if (!n.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) continue;
            var kind = PartKind(n);
            if (kind == Part.None) continue;

            XDocument doc;
            using (var s = entry.Open()) doc = XDocument.Load(s, LoadOptions.PreserveWhitespace);
            var count = kind switch
            {
                Part.Word => Units(doc, W + "p", W + "t", names, tags),
                Part.Drawing => Units(doc, A + "p", A + "t", names, tags),
                Part.SharedStrings => Units(doc, X + "si", X + "t", names, tags, skipInside: X + "rPh") + Units(doc, A + "p", A + "t", names, tags),
                Part.Sheet => Units(doc, X + "is", X + "t", names, tags, skipInside: X + "rPh") + HeaderFooter(doc, names, tags) + Units(doc, A + "p", A + "t", names, tags),
                _ => 0
            };
            if (count == 0) continue;
            total += count;
            var name = entry.FullName;
            entry.Delete();
            var fresh = zip.CreateEntry(name, CompressionLevel.Optimal);
            using var os = fresh.Open();
            using var xw = new StreamWriter(os, new UTF8Encoding(false));
            doc.Save(xw, SaveOptions.DisableFormatting);
        }
        return total;
    }

    enum Part { None, Word, Drawing, SharedStrings, Sheet }

    static Part PartKind(string n)
    {
        n = n.Replace('\\', '/');
        if (Regex.IsMatch(n, @"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$", RegexOptions.IgnoreCase)) return Part.Word;
        if (Regex.IsMatch(n, @"^ppt/(slides|notesSlides|slideMasters|slideLayouts|notesMasters|handoutMasters)/[^/]+\.xml$", RegexOptions.IgnoreCase)) return Part.Drawing;
        if (Regex.IsMatch(n, @"^xl/drawings/drawing\d+\.xml$", RegexOptions.IgnoreCase)) return Part.Drawing;
        if (n.Equals("xl/sharedStrings.xml", StringComparison.OrdinalIgnoreCase)) return Part.SharedStrings;
        if (Regex.IsMatch(n, @"^xl/worksheets/sheet\d+\.xml$", RegexOptions.IgnoreCase)) return Part.Sheet;
        return Part.None;
    }

    /// Replaces inside every "unit" (paragraph / shared string) over the text runs it owns.
    static int Units(XDocument doc, XName unit, XName text, string[] names, IReadOnlyDictionary<string, string> tags, XName? skipInside = null)
    {
        var done = 0;
        foreach (var u in doc.Descendants(unit).ToList())
        {
            var runs = u.Descendants(text)
                .Where(t => ReferenceEquals(t.Ancestors(unit).FirstOrDefault(), u) && (skipInside is null || !t.Ancestors(skipInside).Any()))
                .ToList();
            if (runs.Count == 0) continue;
            done += ReplaceAcross(runs, names, tags);
        }
        return done;
    }

    /// Page header/footer text of a worksheet (&L&"Arial"text&C...): plain string, tags may sit anywhere in it.
    static int HeaderFooter(XDocument doc, string[] names, IReadOnlyDictionary<string, string> tags)
    {
        var done = 0;
        foreach (var el in doc.Descendants().Where(e => e.Name.Namespace == X && e.Name.LocalName is "oddHeader" or "oddFooter" or "evenHeader" or "evenFooter" or "firstHeader" or "firstFooter").ToList())
            done += ReplaceAcross(new List<XElement> { el }, names, tags);
        return done;
    }

    static int ReplaceAcross(List<XElement> runs, string[] names, IReadOnlyDictionary<string, string> tags)
    {
        var sb = new StringBuilder();
        var owner = new List<int>();                       // which run every character belongs to
        for (var r = 0; r < runs.Count; r++) { var v = runs[r].Value; sb.Append(v); for (var i = 0; i < v.Length; i++) owner.Add(r); }
        var text = sb.ToString();
        if (text.IndexOf('$') < 0 && text.IndexOf('&') < 0 && !tags.Keys.Any(k => k.IndexOf('$') < 0 && text.Contains(k, StringComparison.OrdinalIgnoreCase))) return 0;

        var hits = new List<(int start, int len, string value)>();
        for (var i = 0; i < text.Length;)
        {
            string? found = null;
            foreach (var nm in names)
                if (string.CompareOrdinal(text, i, nm, 0, nm.Length) == 0 || string.Compare(text, i, nm, 0, nm.Length, StringComparison.OrdinalIgnoreCase) == 0) { found = nm; break; }
            if (found is null) { i++; continue; }
            hits.Add((i, found.Length, tags[found]));
            i += found.Length;
        }
        if (hits.Count == 0) return 0;

        var parts = Enumerable.Range(0, runs.Count).Select(_ => new StringBuilder()).ToArray();
        var h = 0;
        for (var i = 0; i < text.Length;)
        {
            if (h < hits.Count && hits[h].start == i)
            {
                parts[owner[i]].Append(Flat(hits[h].value));
                i += hits[h].len; h++;
            }
            else { parts[owner[i]].Append(text[i]); i++; }
        }
        for (var r = 0; r < runs.Count; r++)
        {
            var s = parts[r].ToString();
            runs[r].Value = s;
            if (s.Length > 0 && (s[0] == ' ' || s[^1] == ' ')) runs[r].SetAttributeValue(Xml + "space", "preserve");
        }
        return hits.Count;
    }

    static string Flat(string v) => v.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' ');
}
