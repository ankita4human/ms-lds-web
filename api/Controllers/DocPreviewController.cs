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
public class DocPreviewController(IConfiguration cfg) : ControllerBase
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
        var page = await Task.Run(() => HtmlPreview.Convert(path, title));
        var htmlName = safe + ".html"; Response.Headers["X-File-Name"] = Uri.EscapeDataString(htmlName);
        Response.Headers.ContentDisposition = $"{(download ? "attachment" : "inline")}; filename*=UTF-8''{Uri.EscapeDataString(htmlName)}";
        return Content(page, "text/html; charset=utf-8");
    }
}
