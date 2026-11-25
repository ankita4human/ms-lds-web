using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class CheckInForm
{
    public IFormFile? File { get; set; }
    public string? Lang { get; set; }
    public string? Comment { get; set; }
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
}

public class EditDocRow
{
    public string? Lang { get; set; }
    public int? Status { get; set; }
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
    public string? Extension { get; set; }
    public string? DocName { get; set; }
    public int? LAIgnore { get; set; }
}

public class LockRow { public string? Lang { get; set; } public int AccountId { get; set; } }

/// Shared file/archive helpers (legacy DocumentFactory.archiveDocument + file layout).
public static class DocFiles
{
    public static async Task<(string docPath, string archPath, string dbId)> Paths(SqlConnection con)
    {
        var cfg = (await con.QueryAsync<ConfigRow>("SELECT FName, FValue FROM Config WHERE FName IN ('DocPath','DocArchivPath','DBId')"))
            .ToDictionary(r => r.FName!, r => r.FValue ?? "", StringComparer.OrdinalIgnoreCase);
        return (cfg.GetValueOrDefault("DocPath", ""), cfg.GetValueOrDefault("DocArchivPath", ""), cfg.GetValueOrDefault("DBId", ""));
    }
    public static string Ext(string? e) { e = (e ?? "").Trim(); return e.Length == 0 ? "" : e.StartsWith('.') ? e : "." + e; }
    public static string Live(string docPath, string dbId, string lang, int id, string ext) => Path.Combine(docPath, lang + dbId, $"D{id}{ext}");
    public static string Archived(string archPath, string dbId, string lang, int id, int v1, int v2, int v3, string ext) =>
        Path.Combine(archPath, lang + dbId, $"D{id}.V{v1}.{v2}.{v3}{ext}");

    /// Copies the current Documents row to DocumentsArchives (status/version as they are now).
    public static Task ArchiveRow(SqlConnection con, SqlTransaction tx, int id, string lang) => con.ExecuteAsync(@"
        INSERT INTO DocumentsArchives (IDDoc, Lang, DocName, Status, Type, V1, V2, V3, Extension, LangStandard, DateCre, IdCre, DatePub, IdPub,
            DateMod, IdMod, DatePrv, IdPrv, DateExp, DoNotPublish, LANotes, Translated, LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner,
            DateFrozen, IdFrozen, DoNotExpire)
        SELECT IDDoc, Lang, DocName, Status, Type, V1, V2, V3, Extension, LangStandard, DateCre, IdCre,
            CASE WHEN Status = 8 THEN NULL ELSE DatePub END, CASE WHEN Status = 8 THEN 0 ELSE IdPub END,
            DateMod, IdMod, DatePrv, IdPrv, DateExp, DoNotPublish, LANotes, Translated, LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner,
            DateFrozen, IdFrozen, DoNotExpire
        FROM Documents WHERE IDDoc = @id AND Lang = @lang", new { id, lang }, tx);
}

/// Edit flow (manual: Edit document): check out -> work on the file -> check in with comment / version.
[ApiController, Route("api/lds/documents"), Authorize]
public class EditController(IConfiguration cfg, IMemoryCache cache, ILogger<EditController> log, DocIndexWorker indexer) : ControllerBase
{
    const int RightEdit = 38;
    const long MaxBytes = 100L * 1024 * 1024;
    static readonly int[] VersionStatus = { 3, 6, 8, 9 };   // Published, Expired, Released, Blocked: new file => archive + version window

    int Acc => int.Parse(User.FindFirstValue("idAcc")!);

    async Task<(SqlConnection con, bool ok)> Open()
    {
        var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        return (con, Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightEdit));
    }

    async Task<List<EditDocRow>> Rows(SqlConnection con, int id, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        return (await con.QueryAsync<EditDocRow>($@"SELECT d.Lang, d.Status, d.V1, d.V2, d.V3, d.Extension, d.DocName, ISNULL(d.LAIgnore, 0) AS LAIgnore
            FROM Documents d WHERE d.IDDoc = @id AND {vis}", new { id })).ToList();
    }

    [HttpGet("{id:int}/lock")]
    public async Task<IActionResult> LockInfo(int id)
    {
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var l = await con.QueryFirstOrDefaultAsync<LockRow>("SELECT TOP 1 lang AS Lang, accountId AS AccountId FROM DocCheckout WHERE idDoc = @id AND checkedOut = 1", new { id });
        return Ok(new { locked = l is not null, mine = l?.AccountId == Acc });
    }

    [HttpPost("{id:int}/checkout")]
    public async Task<IActionResult> CheckOut(int id, [FromQuery] string lang)
    {
        lang = (lang ?? "").Trim().ToUpperInvariant();
        var (con, ok) = await Open();
        await using var _ = con;
        if (!ok) return StatusCode(403, new { error = "You do not have the right to edit documents." });
        var rows = await Rows(con, id, lang);
        var cur = rows.FirstOrDefault(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        if (cur.Status is 5 or 11) return BadRequest(new { error = "Archived or frozen documents cannot be edited." });
        var other = await con.QueryFirstOrDefaultAsync<LockRow>("SELECT TOP 1 lang AS Lang, accountId AS AccountId FROM DocCheckout WHERE idDoc = @id AND checkedOut = 1 AND accountId <> @acc", new { id, acc = Acc });
        if (other is not null) return Conflict(new { error = "The document is checked out by another user." });
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM DocCheckout WHERE idDoc = @id AND accountId = @acc", new { id, acc = Acc }, tx);
            foreach (var r in rows) // legacy locks every language of the document
                await con.ExecuteAsync("INSERT INTO DocCheckout (idDoc, lang, accountId, client, path, checkoutDate, checkedOut) VALUES (@id, @l, @acc, 'web', '', @now, 1)",
                    new { id, l = r.Lang, acc = Acc, now = DateTime.Now }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230)
        { return StatusCode(403, new { error = "The database login may not write DocCheckout (needs INSERT/DELETE). " + ex.Message }); }
        return Ok(new { idDoc = id, lang, checkedOut = true });
    }

    [HttpGet("{id:int}/file")]
    public async Task<IActionResult> Download(int id, [FromQuery] string lang)
    {
        lang = (lang ?? "").Trim().ToUpperInvariant();
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var cur = (await Rows(con, id, lang)).FirstOrDefault(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        var (dp, _, dbId) = await DocFiles.Paths(con);
        var ext = DocFiles.Ext(cur.Extension);
        var path = DocFiles.Live(dp, dbId, lang, id, ext);
        if (!System.IO.File.Exists(path) && ext.Length == 0)
        {
            // Extension missing in the database: take it from the file that is really on disk (D<id>.<ext>).
            var dir = Path.GetDirectoryName(path)!;
            var hit = Directory.Exists(dir) ? Directory.GetFiles(dir, $"D{id}.*").FirstOrDefault(f => !Path.GetFileName(f).Contains(".V")) : null;
            if (hit is not null) { path = hit; ext = Path.GetExtension(hit); }
        }
        if (!System.IO.File.Exists(path)) return NotFound(new { error = $"File not found on the server ({lang}{dbId}\\D{id}{ext})." });
        var safe = new string((cur.DocName ?? $"D{id}").Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray()).Trim();
        if (safe.Length == 0) safe = $"D{id}";
        if (ext.Length > 0 && safe.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) safe = safe[..^ext.Length];
        var fileName = safe + ext;
        Response.Headers["X-File-Name"] = Uri.EscapeDataString(fileName);
        return PhysicalFile(path, "application/octet-stream", fileName);
    }

    [HttpPost("{id:int}/unlock")]
    public async Task<IActionResult> Unlock(int id)
    {
        var (con, ok) = await Open();
        await using var _ = con;
        if (!ok) return StatusCode(403, new { error = "You do not have the right to edit documents." });
        var rights = await Access.Rights(con, Acc);
        var n = await con.ExecuteAsync(Access.IsAdmin(rights) ? "DELETE FROM DocCheckout WHERE idDoc = @id" : "DELETE FROM DocCheckout WHERE idDoc = @id AND accountId = @acc", new { id, acc = Acc });
        return Ok(new { idDoc = id, unlocked = n > 0 });
    }

    [HttpPost("{id:int}/checkin")]
    [RequestSizeLimit(MaxBytes), RequestFormLimits(MultipartBodyLengthLimit = MaxBytes)]
    public async Task<IActionResult> CheckIn(int id, [FromForm] CheckInForm f)
    {
        var lang = (f.Lang ?? "").Trim().ToUpperInvariant();
        var (con, ok) = await Open();
        await using var _ = con;
        if (!ok) return StatusCode(403, new { error = "You do not have the right to edit documents." });
        if (f.File is null || f.File.Length == 0) return BadRequest(new { error = "Please choose the edited file." });
        if (f.File.Length > MaxBytes) return BadRequest(new { error = "The file is larger than 100 MB." });

        var rows = await Rows(con, id, lang);
        var cur = rows.FirstOrDefault(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        var mine = await con.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND accountId = @acc AND checkedOut = 1", new { id, acc = Acc });
        if (mine == 0) return Conflict(new { error = "Please check the document out first." });

        var ext = DocFiles.Ext(cur.Extension);
        if (!string.Equals(Path.GetExtension(f.File.FileName), ext, StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = $"The file must keep its type ({ext})." });

        var status = cur.Status ?? 2;
        var (c1, c2, c3) = (cur.V1 ?? 0, cur.V2 ?? 0, cur.V3 ?? 0);
        var versioned = VersionStatus.Contains(status);
        var draft = status == 1;
        var comment = (f.Comment ?? "").Trim();
        if (!draft && comment.Length == 0) return BadRequest(new { error = "Please enter a modification comment." });
        if (comment.Length > 900) comment = comment[..900];
        int n1 = c1, n2 = c2, n3 = c3;
        if (versioned)
        {
            if (f.V1 is null || f.V2 is null || f.V3 is null) return BadRequest(new { error = "Please choose the new version." });
            (n1, n2, n3) = (f.V1.Value, f.V2.Value, f.V3.Value);
            if (n1 is < 0 or > 999 || n2 is < 0 or > 999 || n3 is < 0 or > 999) return BadRequest(new { error = "Each version part must be between 0 and 999." });
            if ((n1, n2, n3).CompareTo((c1, c2, c3)) <= 0) return BadRequest(new { error = $"Please choose a version higher than the current {c1}.{c2}.{c3}." });
        }
        var wide = versioned && (n1 > c1 || n2 > c2);
        var (dp, ap, dbId) = await DocFiles.Paths(con);
        if (string.IsNullOrWhiteSpace(dp)) return StatusCode(500, new { error = "Config DocPath is not set." });
        var live = DocFiles.Live(dp, dbId, lang, id, ext);
        var backup = live + ".webbak";
        string? archFile = null;
        var now = DateTime.Now;
        var newStatus = draft ? 1 : 2;
        var targets = new List<string> { lang };
        if (wide) targets.AddRange(rows.Where(r => !string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase) && r.LAIgnore == 0 && r.Status != 1
            && (r.V1 ?? 0, r.V2 ?? 0, r.V3 ?? 0).CompareTo((n1, n2, n3)) < 0).Select(r => r.Lang!));

        await using var tx = await con.BeginTransactionAsync();
        var replaced = false;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(live)!);
            if (versioned)
            {
                await DocFiles.ArchiveRow(con, (SqlTransaction)tx, id, lang);
                if (!string.IsNullOrWhiteSpace(ap) && System.IO.File.Exists(live))
                {
                    archFile = DocFiles.Archived(ap, dbId, lang, id, c1, c2, c3, ext);
                    Directory.CreateDirectory(Path.GetDirectoryName(archFile)!);
                    System.IO.File.Copy(live, archFile, true);
                }
            }
            if (System.IO.File.Exists(live)) System.IO.File.Copy(live, backup, true);
            await using (var fs = new FileStream(live, FileMode.Create, FileAccess.Write)) await f.File.CopyToAsync(fs);
            replaced = true;

            foreach (var l in targets)
            {
                if (string.Equals(l, lang, StringComparison.OrdinalIgnoreCase))
                    await con.ExecuteAsync("UPDATE Documents SET V1 = @n1, V2 = @n2, V3 = @n3, Status = @st, DateMod = @now, IdMod = @acc WHERE IDDoc = @id AND Lang = @l",
                        new { n1, n2, n3, st = newStatus, now, acc = Acc, id, l }, tx);
                else
                    await con.ExecuteAsync("UPDATE Documents SET V1 = @n1, V2 = @n2, V3 = @n3, DateMod = @now, IdMod = @acc WHERE IDDoc = @id AND Lang = @l",
                        new { n1, n2, n3, now, acc = Acc, id, l }, tx);
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @l, @n1, @n2, @n3, @acc, @now, @d)",
                    new { id, l, n1, n2, n3, acc = Acc, now, d = draft && comment.Length == 0 ? "Document checked in (web)" : comment }, tx);
            }
            await con.ExecuteAsync("DELETE FROM DocCheckout WHERE idDoc = @id AND accountId = @acc", new { id, acc = Acc }, tx);
            await tx.CommitAsync();
            if (System.IO.File.Exists(backup)) System.IO.File.Delete(backup);
        }
        catch (Exception ex)
        {
            try { await tx.RollbackAsync(); } catch { /* already gone */ }
            try
            {
                if (replaced && System.IO.File.Exists(backup)) System.IO.File.Copy(backup, live, true);
                if (System.IO.File.Exists(backup)) System.IO.File.Delete(backup);
                if (archFile is not null && System.IO.File.Exists(archFile)) System.IO.File.Delete(archFile);
            }
            catch (Exception ex2) { log.LogError(ex2, "check-in cleanup failed for {Id}", id); }
            log.LogError(ex, "check-in failed for {Id}", id);
            if (ex is SqlException { Number: 229 or 262 or 230 })
                return StatusCode(403, new { error = "The database login may not write here (needs UPDATE Documents, INSERT Mods/DocumentsArchives, DELETE DocCheckout). " + ex.Message });
            if (ex is IOException or UnauthorizedAccessException)
                return StatusCode(500, new { error = "The file could not be written on the server: " + ex.Message });
            throw;
        }
        cache.Remove($"stats:{Acc}:{lang}");
        indexer.Request(false);   // index the new version right away
        return Ok(new { idDoc = id, lang, version = $"{n1}.{n2}.{n3}", status = newStatus, languages = targets, archived = versioned });
    }
}
