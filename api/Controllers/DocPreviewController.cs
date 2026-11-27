using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

/// "View" and "Web preview" of a document (legacy: LDSClientSession.webPreview).
/// PDF and pictures are streamed as they are so the browser's own viewer shows them; Word, Excel, PowerPoint, OpenDocument,
/// text and legacy Office files are turned into one self-contained HTML page. ?download=true saves it instead of showing it.
[ApiController, Route("api/lds/documents"), Authorize]
public class DocPreviewController(IConfiguration cfg, DocConverter conv, DocPublisher publisher, ILogger<DocPreviewController> log) : ControllerBase
{
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);

    static readonly Dictionary<string, string> Native = new(StringComparer.OrdinalIgnoreCase)
    {   // opened by the browser itself; SVG and HTML are left out on purpose (they can carry scripts)
        [".pdf"] = "application/pdf", [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif", [".webp"] = "image/webp", [".bmp"] = "image/bmp",
    };

    class DocInfo { public int IDDoc { get; set; } public string? DocName { get; set; } public string? Extension { get; set; } }

    [HttpGet("{id:int}/preview")]
    public async Task<IActionResult> Preview(int id, [FromQuery] string lang, [FromQuery] bool html = false, [FromQuery] bool download = false)
    {
        lang = (lang ?? "").Trim().ToUpperInvariant();
        if (lang.Length == 0) return BadRequest(new { error = "Language is missing." });
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var doc = await con.QueryFirstOrDefaultAsync<DocInfo>(
            $"SELECT d.IDDoc, d.DocName, d.Extension FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        if (doc is null) return NotFound(new { error = "Document not found." });

        var (dp, _, dbId) = await DocFiles.Paths(con);
        if (string.IsNullOrWhiteSpace(dp)) return StatusCode(500, new { error = "Config DocPath is not set, the file cannot be found." });
        var ext = DocFiles.Ext(doc.Extension);
        var path = DocFiles.Live(dp, dbId, lang, id, ext);
        if (!System.IO.File.Exists(path) && ext.Length == 0)
        {
            var dir = Path.GetDirectoryName(path)!;
            var hit = Directory.Exists(dir) ? Directory.GetFiles(dir, $"D{id}.*").FirstOrDefault(f => !Path.GetFileName(f).Contains(".V")) : null;
            if (hit is not null) { path = hit; ext = Path.GetExtension(hit); }
        }
        if (!System.IO.File.Exists(path)) return NotFound(new { error = $"The file is not on the server ({lang}{dbId}\\D{id}{ext})." });

        var safe = new string((doc.DocName ?? $"D{id}").Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray()).Trim();
        if (safe.Length == 0) safe = $"D{id}";
        if (ext.Length > 0 && safe.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) safe = safe[..^ext.Length];
        Response.Headers["X-Content-Type-Options"] = "nosniff";

        if (!html && Native.TryGetValue(ext, out var mime))
        {
            var name = safe + ext; Response.Headers["X-File-Name"] = Uri.EscapeDataString(name);
            Response.Headers.ContentDisposition = $"{(download ? "attachment" : "inline")}; filename*=UTF-8''{Uri.EscapeDataString(name)}";
            return PhysicalFile(path, mime);
        }
        var lowered = ext.ToLowerInvariant();
        if (!HtmlPreview.Convertible.Contains(lowered) && lowered is not (".html" or ".htm"))
            return StatusCode(415, new { error = $"A {(ext.Length > 0 ? ext : "this")} file cannot be shown in the browser. Download it and open it with its program." });
        var title = doc.DocName ?? $"Document {id}";

        // Word / Excel / PowerPoint (and the legacy / OpenDocument formats): show the real layout, like the published copy does.
        // A temporary copy gets the tags ($Ausgabestand$ ...) replaced and is turned into a PDF by Office or LibreOffice; the browser's PDF viewer shows it.
        // The plain-text page below is only the fallback when neither is installed on the server.
        var work = path; string? tmpDir = null;
        try
        {
            var kind = DocConverter.KindOf(ext);
            if (!download && kind is DocKind.Word or DocKind.Excel or DocKind.PowerPoint || (!download && lowered is ".odt" or ".ods" or ".odp" or ".rtf"))
            {
                tmpDir = Path.Combine(Path.GetTempPath(), "pl-prev-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(tmpDir);
                work = Path.Combine(tmpDir, $"D{id}{ext}");
                System.IO.File.Copy(path, work, true);
                if (TagReplacer.Supports(ext))
                {
                    try { TagReplacer.ReplaceInFile(work, await publisher.MailTags(id, lang, new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase))); }
                    catch (Exception ex) { log.LogWarning(ex, "Tags of {Id} were not replaced in the preview", id); }
                }
                try
                {
                    var pdf = await conv.MakePdf(work, kind == DocKind.Other ? DocKind.Word : kind, Path.Combine(tmpDir, $"D{id}.pdf"));
                    var bytes = await System.IO.File.ReadAllBytesAsync(pdf);
                    var pdfName = safe + ".pdf"; Response.Headers["X-File-Name"] = Uri.EscapeDataString(pdfName);
                    Response.Headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(pdfName)}";
                    return File(bytes, "application/pdf");
                }
                catch (Exception ex) { log.LogWarning(ex, "PDF preview of D{Id} failed, the text preview is shown instead", id); }
            }
            var page = await Task.Run(() => HtmlPreview.Convert(work, title));
            var htmlName = safe + ".html"; Response.Headers["X-File-Name"] = Uri.EscapeDataString(htmlName);
            Response.Headers.ContentDisposition = $"{(download ? "attachment" : "inline")}; filename*=UTF-8''{Uri.EscapeDataString(htmlName)}";
            return Content(page, "text/html; charset=utf-8");
        }
        finally { if (tmpDir is not null) try { Directory.Delete(tmpDir, true); } catch { /* temp folder */ } }
    }
}
