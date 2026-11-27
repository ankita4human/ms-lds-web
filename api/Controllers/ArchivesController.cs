using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class ArchiveItem
{
    public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; }
    public string? DocName { get; set; }
    public int Status { get; set; }
    public string? StatusName { get; set; }
    public DateTime? DateEdited { get; set; }
    public string? Editor { get; set; }
    public string? Reason { get; set; }
    public string? Extension { get; set; }
    public bool Deleted { get; set; }
    public bool PropChanges { get; set; }
    public bool HasFile { get; set; }
}
public class ArchiveModRow { public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; } public string? User { get; set; } public DateTime? ModDate { get; set; } public string? ModDesc { get; set; } }
public class PropModRow
{
    public int V1 { get; set; } public int V2 { get; set; } public int V3 { get; set; }
    public string? User { get; set; } public DateTime? ModDate { get; set; } public string? ModDesc { get; set; }
    public string? PropertyType { get; set; } public string? OldValue { get; set; } public string? NewValue { get; set; }
}

/// "Property Changes" log (legacy table PropertyMods): who changed Name / Type / Author / Process owner / Version of a document, from what to what, and why.
public static class PropMods
{
    public static async Task Log(SqlConnection con, SqlTransaction? tx, int id, string lang, int v1, int v2, int v3, int acc, string type, string? oldVal, string? newVal, string? reason, ILogger? log = null)
    {
        try
        {
            await con.ExecuteAsync(@"INSERT INTO PropertyMods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc, OldPropertyVal, NewPropertyVal, PropertyType)
                VALUES (@id, @lang, @v1, @v2, @v3, @acc, @now, @reason, @o, @n, @type)",
                new { id, lang, v1, v2, v3, acc, now = DateTime.Now, reason = Cut(reason, 1056), o = Cut(oldVal, 200), n = Cut(newVal, 200), type }, tx);
        }
        // the log must never block the change itself (e.g. before sql/grant-pl_app.sql has been run for PropertyMods)
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230 or 208) { log?.LogWarning("PropertyMods not written: {Msg}", ex.Message); }
    }
    static string? Cut(string? s, int n) => s is null ? null : s.Length <= n ? s : s[..n];
}

/// Archives tab of the document properties (manual p. 21): every version that was replaced by an edit / version change.
///   list              - Version, Document, Status, Date edited, Reason for edit
///   Show (PDF/Original) - the archived file of one version, tags replaced with the values of that time (right Archive 35 or Admin)
///   History           - modification comments of that version
///   Property Changes  - PropertyMods rows of that version
[ApiController, Route("api/lds/documents/{id:int}/archives"), Authorize]
public class ArchivesController(IConfiguration cfg, DocConverter conv, DocPublisher publisher, ILogger<ArchivesController> log) : ControllerBase
{
    const int RightArchive = 35;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    static string L(string? l) => (l ?? "").Trim().ToUpperInvariant();

    async Task<(SqlConnection con, bool visible, bool canView)> Open(int id, string lang)
    {
        var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var ok = await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang }) > 0;
        var rights = await Access.Rights(con, Acc);
        return (con, ok, Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightArchive));
    }

    [HttpGet]
    public async Task<IActionResult> List(int id, [FromQuery] string lang)
    {
        lang = L(lang);
        var (con, visible, canView) = await Open(id, lang);
        await using var _ = con;
        if (!visible) return NotFound(new { error = "Document not found." });
        var rows = (await con.QueryAsync<ArchiveItem>(@"
            SELECT a.V1, a.V2, a.V3, a.DocName, ISNULL(a.[Status], 0) AS [Status],
                   ISNULL(s.StatusDesc, CASE a.[Status] WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', a.[Status]) END) AS StatusName,
                   ISNULL(a.DateMod, a.DateCre) AS DateEdited, ed.AccShort AS Editor, r.ModDesc AS Reason, a.Extension,
                   CAST(CASE WHEN a.DateDel IS NOT NULL THEN 1 ELSE 0 END AS bit) AS Deleted,
                   CAST(CASE WHEN EXISTS (SELECT 1 FROM PropertyMods p WHERE p.IdDoc = a.IDDoc AND p.Lang = a.Lang AND p.V1 = a.V1 AND p.V2 = a.V2 AND p.V3 = a.V3) THEN 1 ELSE 0 END AS bit) AS PropChanges
            FROM DocumentsArchives a
            OUTER APPLY (SELECT TOP 1 StatusDesc FROM [Status] WHERE IDStatus = a.[Status] AND Lang = a.Lang) s
            OUTER APPLY (SELECT TOP 1 m.ModDesc FROM Mods m WHERE m.IdDoc = a.IDDoc AND m.Lang = a.Lang AND m.V1 = a.V1 AND m.V2 = a.V2 AND m.V3 = a.V3 ORDER BY m.ModDate DESC) r
            LEFT JOIN Accounts ed ON ed.IdAcc = a.IdMod
            WHERE a.IDDoc = @id AND a.Lang = @lang
            ORDER BY a.V1 DESC, a.V2 DESC, a.V3 DESC, a.DateMod DESC", new { id, lang })).ToList();
        var (_, ap, dbId) = await DocFiles.Paths(con);
        foreach (var r in rows)
        {
            var ext = DocFiles.Ext(r.Extension);
            r.HasFile = !string.IsNullOrWhiteSpace(ap) && System.IO.File.Exists(DocFiles.Archived(ap, dbId, lang, id, r.V1, r.V2, r.V3, ext));
        }
        return Ok(new { canView, items = rows });
    }

    [HttpGet("history")]
    public async Task<IActionResult> History(int id, [FromQuery] string lang, [FromQuery] int v1, [FromQuery] int v2, [FromQuery] int v3)
    {
        lang = L(lang);
        var (con, visible, canView) = await Open(id, lang);
        await using var _ = con;
        if (!visible) return NotFound(new { error = "Document not found." });
        if (!canView) return StatusCode(403, new { error = "You need the Archive right (or Admin rights) to see the history of a version." });
        var rows = await con.QueryAsync<ArchiveModRow>(@"
            SELECT m.V1, m.V2, m.V3, a.AccShort AS [User], m.ModDate, m.ModDesc
            FROM Mods m LEFT JOIN Accounts a ON a.IdAcc = m.IdAcc
            WHERE m.IdDoc = @id AND m.Lang = @lang AND m.V1 = @v1 AND m.V2 = @v2 AND m.V3 = @v3 ORDER BY m.ModDate DESC", new { id, lang, v1, v2, v3 });
        return Ok(new { items = rows });
    }

    [HttpGet("property-changes")]
    public async Task<IActionResult> PropertyChanges(int id, [FromQuery] string lang, [FromQuery] int v1, [FromQuery] int v2, [FromQuery] int v3)
    {
        lang = L(lang);
        var (con, visible, canView) = await Open(id, lang);
        await using var _ = con;
        if (!visible) return NotFound(new { error = "Document not found." });
        if (!canView) return StatusCode(403, new { error = "You need the Archive right (or Admin rights) to see the property changes." });
        var rows = await con.QueryAsync<PropModRow>(@"
            SELECT p.V1, p.V2, p.V3, a.AccShort AS [User], p.ModDate, p.ModDesc, p.PropertyType, p.OldPropertyVal AS OldValue, p.NewPropertyVal AS NewValue
            FROM PropertyMods p LEFT JOIN Accounts a ON a.IdAcc = p.IdAcc
            WHERE p.IdDoc = @id AND p.Lang = @lang AND p.V1 = @v1 AND p.V2 = @v2 AND p.V3 = @v3 ORDER BY p.ModDate DESC", new { id, lang, v1, v2, v3 });
        return Ok(new { items = rows });
    }

    class ArchInfo { public string? DocName { get; set; } public string? Extension { get; set; } }

    /// Show: view=original (the archived file itself) or view=pdf (PDF made from it). The tags in the file get the values of that version.
    [HttpGet("show")]
    public async Task<IActionResult> Show(int id, [FromQuery] string lang, [FromQuery] int v1, [FromQuery] int v2, [FromQuery] int v3,
        [FromQuery] string view = "original", [FromQuery] bool download = false)
    {
        lang = L(lang);
        var (con, visible, canView) = await Open(id, lang);
        await using var _ = con;
        if (!visible) return NotFound(new { error = "Document not found." });
        if (!canView) return StatusCode(403, new { error = "You need the Archive right (or Admin rights) to show an archived version." });
        var row = (IDictionary<string, object>?)await con.QueryFirstOrDefaultAsync(@"SELECT TOP 1 * FROM DocumentsArchives
            WHERE IDDoc = @id AND Lang = @lang AND V1 = @v1 AND V2 = @v2 AND V3 = @v3 ORDER BY DateMod DESC", new { id, lang, v1, v2, v3 });
        if (row is null) return NotFound(new { error = $"Version {v1}.{v2}.{v3} is not in the archive." });
        var info = new ArchInfo { DocName = row["DocName"] as string, Extension = row["Extension"] as string };

        var (_, ap, dbId) = await DocFiles.Paths(con);
        if (string.IsNullOrWhiteSpace(ap)) return StatusCode(500, new { error = "Config DocArchivPath is not set, the archive cannot be found." });
        var ext = DocFiles.Ext(info.Extension);
        var src = DocFiles.Archived(ap, dbId, lang, id, v1, v2, v3, ext);
        if (!System.IO.File.Exists(src)) return NotFound(new { error = $"The archived file is not on the server ({lang}{dbId}\\D{id}.V{v1}.{v2}.{v3}{ext}). It was probably archived before the file was kept." });

        // work on a temporary copy: the archive stays untouched while the tags are replaced
        var tmpDir = Path.Combine(Path.GetTempPath(), "pl-arch-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmpDir);
        try
        {
            var work = Path.Combine(tmpDir, $"D{id}{ext}");
            System.IO.File.Copy(src, work, true);
            if (TagReplacer.Supports(ext))
            {
                try
                {
                    var over = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                    foreach (var kv in row) if (kv.Key is not ("IDDoc" or "Lang")) over[kv.Key] = kv.Value is DBNull ? null : kv.Value;
                    var tags = await publisher.MailTags(id, lang, over);
                    TagReplacer.ReplaceInFile(work, tags);
                }
                catch (Exception ex) { log.LogWarning(ex, "Tags of the archived version {V} of {Id} were not replaced", $"{v1}.{v2}.{v3}", id); }
            }

            var safe = new string((info.DocName ?? $"D{id}").Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray()).Trim();
            if (safe.Length == 0) safe = $"D{id}";
            if (ext.Length > 0 && safe.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) safe = safe[..^ext.Length];
            var vtxt = $"V{v1}.{v2}.{v3}";
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            string disp(string n) { Response.Headers["X-File-Name"] = Uri.EscapeDataString(n); return $"{(download ? "attachment" : "inline")}; filename*=UTF-8''{Uri.EscapeDataString(n)}"; }

            if (string.Equals(view, "pdf", StringComparison.OrdinalIgnoreCase))
            {
                var kind = DocConverter.KindOf(ext);
                string pdfPath;
                if (kind == DocKind.Pdf) pdfPath = work;
                else
                {
                    if (kind == DocKind.Other) return StatusCode(415, new { error = $"A {(ext.Length > 0 ? ext : "this")} file cannot be turned into a PDF. Use the Original view." });
                    try { pdfPath = await conv.MakePdf(work, kind, Path.Combine(tmpDir, $"D{id}.pdf")); }
                    catch (PublishException ex) { return StatusCode(ex.Code, new { error = ex.Message + " Use the Original view instead." }); }
                }
                var bytes = await System.IO.File.ReadAllBytesAsync(pdfPath);
                Response.Headers.ContentDisposition = disp($"{safe}_{vtxt}.pdf");
                return File(bytes, "application/pdf");
            }

            var native = ext.ToLowerInvariant() switch
            {
                ".pdf" => "application/pdf", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp", ".bmp" => "image/bmp", _ => null
            };
            if (download)
            {   // the original file (tags replaced) to save and open with its own program
                Response.Headers.ContentDisposition = disp($"{safe}_{vtxt}{ext}");
                return File(await System.IO.File.ReadAllBytesAsync(work), native ?? "application/octet-stream");
            }
            if (native is not null)
            {
                Response.Headers.ContentDisposition = disp($"{safe}_{vtxt}{ext}");
                return File(await System.IO.File.ReadAllBytesAsync(work), native);
            }
            var lowered = ext.ToLowerInvariant();
            if (!HtmlPreview.Convertible.Contains(lowered) && lowered is not (".html" or ".htm"))
                return StatusCode(415, new { error = $"A {(ext.Length > 0 ? ext : "this")} file cannot be shown in the browser. Save it and open it with its program." });
            var page = await Task.Run(() => HtmlPreview.Convert(work, $"{info.DocName} ({vtxt})"));
            Response.Headers.ContentDisposition = disp($"{safe}_{vtxt}.html");
            return Content(page, "text/html; charset=utf-8");
        }
        finally { try { Directory.Delete(tmpDir, true); } catch { /* temp folder, cleaned up later */ } }
    }
}
