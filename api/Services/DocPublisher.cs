using System.Globalization;
using System.Text.RegularExpressions;
using Dapper;
using PhaseLift.Api.Controllers;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api;

public class PublishException(int code, string message) : Exception(message) { public int Code { get; } = code; }

public class PublishResult
{
    public int IdDoc { get; set; }
    public string Lang { get; set; } = "";
    public int Status { get; set; }
    public string Version { get; set; } = "";
    public DateTime PublishedOn { get; set; }
    public string Folder { get; set; } = "";
    public List<string> Files { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
    public int TagsReplaced { get; set; }
}

class PubDoc
{
    public string? Lang { get; set; } public string? LangStandard { get; set; } public string? DocName { get; set; }
    public int? Status { get; set; } public int? Type { get; set; }
    public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; }
    public string? Extension { get; set; } public int? IDWebPath { get; set; }
    public bool? PublishAsOriginal { get; set; }
}
class RepRow
{
    public string? NameFind { get; set; } public string? Tabelle { get; set; } public string? ColName { get; set; }
    public string? Quelle { get; set; } public string? IDQuelle { get; set; } public string? Ersetzung { get; set; }
}

/// Publish (manual p. 109, legacy Job/Worker + DocPublish): a Released (or already Published) document is copied to the web folder as
///   {WebPath}\{LANG}\D{id}\D{id}.{ext}   the original, with the tags replaced by the document properties
///   {WebPath}\{LANG}\D{id}\D{id}.pdf     PDF copy
///   {WebPath}\{LANG}\D{id}\D{id}.htm     HTML copy (+ support files such as D{id}_files / D{id}_sheet001.htm)
/// and the document goes to status Published (3) with DatePub / IdPub. "Publish as original" document types only get the original file.
/// The web path is WebPathes.Path of the document (IDWebPath, default Config StandardWebPath); a Document-to-AD-group link (DocPublishADGroup)
/// overrides it. Files are built in a temp folder first and swapped in only when everything worked, so a failed publish never leaves half a folder.
public class DocPublisher(IConfiguration cfg, DocConverter conv, ILogger<DocPublisher> log)
{
    const int StPublished = 3, StReleased = 8;
    // Publishing runs in parallel (PublishWorker, Publish:MaxParallel). The languages of ONE document are still published one after the other,
    // so the rule "the original language is published first" keeps working. Office conversions are limited inside DocConverter.
    static readonly System.Collections.Concurrent.ConcurrentDictionary<int, SemaphoreSlim> DocLocks = new();
    static readonly Regex Ident = new(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    public async Task<PublishResult> Publish(int id, string lang, int acc)
    {
        lang = (lang ?? "").Trim().ToUpperInvariant();
        var gate = DocLocks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        if (!await gate.WaitAsync(TimeSpan.FromMinutes(10))) throw new PublishException(503, "Another language of this document is still being published. Please try again in a minute.");
        try { return await Run(id, lang, acc); }
        finally { gate.Release(); }
    }

    async Task<PublishResult> Run(int id, string lang, int acc)
    {
        await using var con = Con(); await con.OpenAsync();
        var d = await con.QueryFirstOrDefaultAsync<PubDoc>(@"SELECT d.Lang, d.LangStandard, d.DocName, d.Status, d.Type, d.V1, d.V2, d.V3, d.Extension, d.IDWebPath,
                (SELECT TOP 1 t.isPublishAsOriginal FROM DocTypes t WHERE t.IDType = d.Type AND t.Lang = d.Lang) AS PublishAsOriginal
            FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang", new { id, lang })
            ?? throw new PublishException(404, "Document not found.");
        if (d.Status != StReleased && d.Status != StPublished && d.Status != 11)   // 11 = Frozen: republished with its status unchanged (manual p. 163)
            throw new PublishException(409, "Only released documents can be published. Release the document first.");

        // "Publish as original" on a group (right-click menu of the tree): documents linked to that group or to any group below it
        // are published as the original file only, without an HTML copy.
        var groupOriginal = await con.ExecuteScalarAsync<int>(@";WITH up AS (
                SELECT IdGroup AS Cur FROM DocGrp WHERE IdDoc = @id
                UNION ALL
                SELECT p.IDParent FROM up JOIN Groups p ON p.IDGroup = up.Cur AND p.Lang = @lang WHERE ISNULL(p.IDParent, 0) <> 0)
            SELECT COUNT(*) FROM up JOIN GroupProperties gp ON gp.IdGroup = up.Cur WHERE ISNULL(gp.isPubOriginal, 0) = 1 OPTION (MAXRECURSION 100)",
            new { id, lang }) > 0;

        // Manual p. 94: a translation can only be published once the original language is published (same version).
        if (!string.IsNullOrEmpty(d.LangStandard) && !string.Equals(d.LangStandard, d.Lang, StringComparison.OrdinalIgnoreCase))
        {
            var o = await con.QueryFirstOrDefaultAsync<PubDoc>("SELECT Status, V1, V2, V3 FROM Documents WHERE IDDoc = @id AND Lang = @l", new { id, l = d.LangStandard });
            if (o is not null && o.Status != StPublished && (o.V1, o.V2, o.V3) == (d.V1, d.V2, d.V3))
                throw new PublishException(409, $"The document in the original language ({d.LangStandard}) has to be published first.");
        }

        var ext = DocFiles.Ext(d.Extension);
        var (docPath, _, dbId) = await DocFiles.Paths(con);
        if (string.IsNullOrWhiteSpace(docPath)) throw new PublishException(500, "Config DocPath is not set.");
        var source = DocFiles.Live(docPath, dbId, lang, id, ext);
        if (!File.Exists(source)) throw new PublishException(500, $"The document file was not found on the server ({lang}{dbId}\\D{id}{ext}).");

        // ---- where to publish: AD-group path of the document, else WebPathes ----
        var (root, otherRoot) = await WebRoot(con, id, d.IDWebPath);
        var target = Path.Combine(root, lang, "D" + id);
        var tempRoot = (await Cfg(con, "DocTempPath")) is { Length: > 0 } t ? t : Path.GetTempPath();
        var work = Path.Combine(tempRoot, "pub_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);

        var now = DateTime.Now;
        var res = new PublishResult { IdDoc = id, Lang = lang, Version = $"{d.V1 ?? 0}.{d.V2 ?? 0}.{d.V3 ?? 0}", PublishedOn = now, Folder = target };
        string? backup = null; var swapped = false;
        try
        {
            var kind = DocConverter.KindOf(ext);
            var name = "D" + id;
            var file = Path.Combine(work, name + ext);
            File.Copy(source, file, true);

            // ---- tags: replace $...$ with the document properties ----
            if (TagReplacer.Supports(ext))
            {
                var tags = await BuildTags(con, id, lang, acc, now);
                res.TagsReplaced = TagReplacer.ReplaceInFile(file, tags);
            }
            else if (kind is DocKind.Word or DocKind.Excel or DocKind.PowerPoint)
                res.Warnings.Add($"{ext} is an old binary Office format: tags were not replaced. Save the document as {(kind == DocKind.Word ? ".docx" : kind == DocKind.Excel ? ".xlsx" : ".pptx")} to get them replaced.");

            var original = d.PublishAsOriginal == true || groupOriginal || kind == DocKind.Other;
            if (!original)
            {
                // PDF copy (also the source of the HTML for PowerPoint / PDF)
                var pdf = Path.Combine(work, name + ".pdf");
                if (kind != DocKind.Pdf) await conv.MakePdf(file, kind, pdf);
                else pdf = file;

                // HTML copy
                var htm = Path.Combine(work, name + ".htm");
                var okHtml = await conv.MakeHtml(file, kind, pdf, htm, n => Cfg(con, n));
                if (!okHtml)
                {
                    if (kind == DocKind.Pdf) res.Warnings.Add("No HTML copy was made for this PDF: pdf2htmlEX is not installed (Config Pathpdf2htmlEX).");
                    else throw new PublishException(501, "The HTML copy could not be made. Install Microsoft Office or pdf2htmlEX (Config Pathpdf2htmlEX) on the server.");
                }
            }
            else if (kind == DocKind.Other && d.PublishAsOriginal != true && !groupOriginal)
                res.Warnings.Add("Only the original file is published for this file type.");

            // ---- swap the finished folder into the web path ----
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (Directory.Exists(target)) { backup = target + ".old_" + Guid.NewGuid().ToString("N")[..8]; Directory.Move(target, backup); }
            swapped = true; CopyDir(work, target);

            // ---- document goes to Published ----
            int n = 1;
            try
            {
                if (d.Status != 11) n = await con.ExecuteAsync("UPDATE Documents SET Status = @st, DatePub = @now, IdPub = @acc WHERE IDDoc = @id AND Lang = @lang AND Status IN (3, 8)",
                    new { st = StPublished, now, acc, id, lang });
            }
            catch (SqlException ex) when (ex.Number is 229 or 262 or 230)
            { throw new PublishException(403, "The database login may not update Documents. " + ex.Message); }
            if (n == 0) throw new PublishException(409, "The document was changed by someone else. Please refresh the list.");

            res.Status = d.Status == 11 ? 11 : StPublished;
            res.Files = Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories).Select(f => Path.GetRelativePath(target, f).Replace('\\', '/')).OrderBy(f => f).ToList();
            if (backup is not null) TryDelete(backup);
            if (otherRoot is not null)
            {   // legacy DeletePreviouslyPublishedFiles: the document used to be published on another path
                var old = Path.Combine(otherRoot, lang, "D" + id);
                if (!string.Equals(Path.GetFullPath(old), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase) && Directory.Exists(old)) TryDelete(old);
            }
            return res;
        }
        catch
        {
            try
            {   // put the previous published folder back
                if (swapped && Directory.Exists(target)) Directory.Delete(target, true);
                if (backup is not null && Directory.Exists(backup)) Directory.Move(backup, target);
            }
            catch (Exception ex2) { log.LogError(ex2, "publish rollback failed for {Id}", id); }
            throw;
        }
        finally { TryDelete(work); }
    }

    // ---------------- web path ----------------
    async Task<(string root, string? otherRoot)> WebRoot(SqlConnection con, int id, int? idWebPath)
    {
        var def = idWebPath is > 0 ? idWebPath : int.TryParse(await Cfg(con, "StandardWebPath"), out var sw) ? sw : 0;
        var defPath = def is > 0 ? await con.ExecuteScalarAsync<string?>("SELECT TOP 1 Path FROM WebPathes WHERE IdWebPath = @def", new { def }) : null;
        var ad = await con.ExecuteScalarAsync<string?>(@"SELECT TOP 1 p.ADPublishPath FROM DocPublishADGroup g JOIN DocADGroupPath p ON p.IDADGroup = g.IDADGroup
            WHERE g.IDDoc = @id AND ISNULL(p.Status, 1) = 1 AND ISNULL(p.ADPublishPath, '') <> ''", new { id });
        if (!string.IsNullOrWhiteSpace(ad)) return (ad.Trim(), string.IsNullOrWhiteSpace(defPath) ? null : defPath.Trim());
        if (string.IsNullOrWhiteSpace(defPath))
            throw new PublishException(500, $"No web path found: WebPathes has no row with IdWebPath = {def} (Documents.IDWebPath / Config StandardWebPath).");
        return (defPath.Trim(), null);
    }

    async Task<string?> Cfg(SqlConnection con, string name) =>
        await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name });

    // ---------------- tags ----------------
    /// Table Replacements: NameFind = tag text, Tabelle/ColName = where the value is, Quelle = column of Documents that points to the row,
    /// IDQuelle = key column of Tabelle. Rows without Tabelle are application-level tags with a fixed Ersetzung. IdApp 0 = application tags, 1 = LDS tags.
    /// Tag values for e-mails ($DocumentName$, $RevisionNo$, ...): the same Replacements table, with the document data as it will be after the step
    /// (for example Status = Released, DateRel = now, IdRel = the releaser), given in `over`.
    public async Task<Dictionary<string, string>> MailTags(int id, string lang, IDictionary<string, object?> over)
    {
        await using var con = Con(); await con.OpenAsync();
        return await BuildTags(con, id, (lang ?? "").Trim().ToUpperInvariant(), 0, DateTime.Now, over);
    }

    async Task<Dictionary<string, string>> BuildTags(SqlConnection con, int id, string lang, int acc, DateTime now, IDictionary<string, object?>? over = null)
    {
        var row = (IDictionary<string, object>)(await con.QueryFirstAsync("SELECT * FROM Documents WHERE IDDoc = @id AND Lang = @lang", new { id, lang }));
        var doc = new Dictionary<string, object?>(row.ToDictionary(k => k.Key, k => (object?)k.Value), StringComparer.OrdinalIgnoreCase);
        if (over is null) { doc["Status"] = StPublished; doc["DatePub"] = now; doc["IdPub"] = acc; }      // the published copy already shows the publish data
        else foreach (var kv in over) doc[kv.Key] = kv.Value;

        var culture = Culture(lang);
        var reps = (await con.QueryAsync<RepRow>(@"SELECT NameFind, Tabelle, ColName, Quelle, IDQuelle, Ersetzung FROM Replacements
            WHERE Lang = @lang AND ISNULL(IdOp, 0) = 0 AND (IdApp = 0 OR IdApp = 1 OR IdApp IS NULL) AND ISNULL(NameFind, '') <> ''", new { lang })).ToList();

        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var names = new Dictionary<int, string>();
        foreach (var r in reps)
        {
            var key = r.NameFind!.Trim();
            if (key.Length < 2) continue;
            map[key] = await ValueOf(con, r, doc, lang, id, culture, names);
        }
        return map;
    }

    async Task<string> ValueOf(SqlConnection con, RepRow r, Dictionary<string, object?> doc, string lang, int id, CultureInfo c, Dictionary<int, string> names)
    {
        var table = (r.Tabelle ?? "").Trim(); var col = (r.ColName ?? "").Trim();
        if (table.Length == 0) return r.Ersetzung ?? "";
        try
        {
            if (table.Equals("Documents", StringComparison.OrdinalIgnoreCase))
            {
                if (col.Equals("Version", StringComparison.OrdinalIgnoreCase)) return $"{Num(doc, "V1")}.{Num(doc, "V2")}.{Num(doc, "V3")}";
                return Fmt(doc.GetValueOrDefault(col), c);
            }
            if (table.Equals("Accounts", StringComparison.OrdinalIgnoreCase))
            {
                if (!int.TryParse(Convert.ToString(doc.GetValueOrDefault(r.Quelle ?? ""), CultureInfo.InvariantCulture), out var acc) || acc <= 0) return "";
                if (!names.TryGetValue(acc, out var nm))
                    names[acc] = nm = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 e.Name FROM Accounts a JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = @acc", new { acc }) ?? "";
                return nm;
            }
            if (table.Equals("Mods", StringComparison.OrdinalIgnoreCase))
                return await con.ExecuteScalarAsync<string?>("SELECT TOP 1 ModDesc FROM Mods WHERE IdDoc = @id AND Lang = @lang ORDER BY ModDate DESC", new { id, lang }) ?? "";
            // DocTypes, Status and any other lookup table: value of ColName in the row whose IDQuelle equals Documents.Quelle
            if (!Ident.IsMatch(table) || !Ident.IsMatch(col) || !Ident.IsMatch(r.IDQuelle ?? "") || string.IsNullOrEmpty(r.Quelle)) return "";
            if (await con.ExecuteScalarAsync<int?>("SELECT OBJECT_ID(@t, 'U')", new { t = "dbo." + table }) is null) return "";
            var key = doc.GetValueOrDefault(r.Quelle);
            if (key is null) return "";
            var hasLang = await con.ExecuteScalarAsync<int?>("SELECT COL_LENGTH(@t, 'Lang')", new { t = "dbo." + table }) is not null;
            var v = await con.ExecuteScalarAsync<object?>($"SELECT TOP 1 [{col}] FROM [dbo].[{table}] WHERE [{r.IDQuelle}] = @k" + (hasLang ? " AND Lang = @lang" : ""), new { k = key, lang });
            return Fmt(v, c);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Tag {Tag} could not be resolved", r.NameFind);
            return "";
        }
    }

    static int Num(Dictionary<string, object?> d, string k) => int.TryParse(Convert.ToString(d.GetValueOrDefault(k), CultureInfo.InvariantCulture), out var i) ? i : 0;

    static string Fmt(object? v, CultureInfo c) => v switch
    {
        null or DBNull => "",
        DateTime dt => dt.Year <= 1901 ? "" : dt.ToString("d", c),
        bool b => b ? "Yes" : "No",
        IFormattable f => f.ToString(null, c),
        _ => Convert.ToString(v, c) ?? ""
    };

    static CultureInfo Culture(string lang)
    {
        try { return lang.ToUpperInvariant() == "EN" ? CultureInfo.GetCultureInfo("en-GB") : CultureInfo.GetCultureInfo(lang.ToLowerInvariant()); }
        catch (CultureNotFoundException) { return CultureInfo.InvariantCulture; }
    }

    // ---------------- files ----------------
    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)), true);
        foreach (var d in Directory.GetDirectories(from)) CopyDir(d, Path.Combine(to, Path.GetFileName(d)));
    }
    static void TryDelete(string dir) { try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { /* temp folder, cleaned up later */ } }
}
