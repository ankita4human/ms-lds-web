using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class ChangeVersionBody
{
    public string? Lang { get; set; }
    public int V1 { get; set; }
    public int V2 { get; set; }
    public int V3 { get; set; }
    public string? Comment { get; set; }
}

public class VersionRow
{
    public string? Lang { get; set; }
    public string? DocName { get; set; }
    public int? Status { get; set; }
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
    public int? LAIgnore { get; set; }
}

/// "Change version" (manual: context menu > Upgrade Revision). Only a higher version may be chosen; not possible in Draft.
/// A middle/major change (0.1.0 / 1.0.0) also moves the other languages, a minor change (0.0.1) stays in this language.
[ApiController, Route("api/lds/documents"), Authorize]
public class VersionController(IConfiguration cfg, IMemoryCache cache, PublishQueue queue) : ControllerBase
{
    const int RightEdit = 38;

    [HttpPost("{id:int}/version")]
    public async Task<IActionResult> Change(int id, [FromBody] ChangeVersionBody b)
    {
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        var lang = (b.Lang ?? "").Trim().ToUpperInvariant();
        if (lang.Length != 2) return BadRequest(new { error = "Language is missing." });
        if (b.V1 is < 0 or > 999 || b.V2 is < 0 or > 999 || b.V3 is < 0 or > 999)
            return BadRequest(new { error = "Each version part must be between 0 and 999." });

        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();
        var rights = await Access.Rights(con, acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightEdit))
            return StatusCode(403, new { error = "You do not have the right to change documents." });

        // The user must be able to see the document (linked to an accessible folder).
        var vis = await Access.VisibleSql(con, acc, lang);
        var rows = (await con.QueryAsync<VersionRow>($@"
            SELECT d.Lang, d.DocName, d.Status, d.V1, d.V2, d.V3, ISNULL(d.LAIgnore, 0) AS LAIgnore
            FROM Documents d WHERE d.IDDoc = @id AND {vis}", new { id })).ToList();
        var cur = rows.FirstOrDefault(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase));
        if (cur is null) return NotFound(new { error = "Document not found." });
        if (cur.Status == 1) return BadRequest(new { error = "The version cannot be changed while the document is in Draft status." });

        var (c1, c2, c3) = (cur.V1 ?? 0, cur.V2 ?? 0, cur.V3 ?? 0);
        if ((b.V1, b.V2, b.V3).CompareTo((c1, c2, c3)) <= 0)
            return BadRequest(new { error = $"Please choose a version higher than the current {c1}.{c2}.{c3}." });

        var wide = b.V1 > c1 || b.V2 > c2;   // major or middle change
        var targets = rows.Where(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase)
            || (wide && r.LAIgnore == 0 && (r.V1 ?? 0, r.V2 ?? 0, r.V3 ?? 0).CompareTo((b.V1, b.V2, b.V3)) < 0 && r.Status != 1))
            .Select(r => r.Lang!).Distinct().ToList();

        var now = DateTime.Now;
        var version = $"{b.V1}.{b.V2}.{b.V3}";
        var comment = string.IsNullOrWhiteSpace(b.Comment) ? $"Property Changes: version changed from {c1}.{c2}.{c3} to {version} (web)" : b.Comment.Trim();
        if (comment.Length > 1000) comment = comment[..1000];

        var republish = false;
        var copied = new List<string>();
        var (dp, ap, dbId) = await DocFiles.Paths(con);   // before the transaction opens (a command on this connection needs the tx while it is pending)
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            foreach (var l in targets)
            {
                // "Property Changes": the old row (and its file) goes to the archive before the version moves (legacy archiveDocument).
                var old = rows.First(r => string.Equals(r.Lang, l, StringComparison.OrdinalIgnoreCase));
                if (old.Status != 1)
                {
                    await DocFiles.ArchiveRow(con, (SqlTransaction)tx, id, l);
                    if (!string.IsNullOrWhiteSpace(ap))
                    {
                        var ext = DocFiles.Ext(await con.QueryFirstOrDefaultAsync<string>("SELECT Extension FROM Documents WHERE IDDoc = @id AND Lang = @l", new { id, l }, tx));
                        var src = DocFiles.Live(dp, dbId, l, id, ext);
                        var dst = DocFiles.Archived(ap, dbId, l, id, old.V1 ?? 0, old.V2 ?? 0, old.V3 ?? 0, ext);
                        if (System.IO.File.Exists(src)) { Directory.CreateDirectory(Path.GetDirectoryName(dst)!); System.IO.File.Copy(src, dst, true); copied.Add(dst); }
                    }
                }
                await con.ExecuteAsync("UPDATE Documents SET V1 = @v1, V2 = @v2, V3 = @v3, DateMod = @now, IdMod = @acc WHERE IDDoc = @id AND Lang = @l",
                    new { v1 = b.V1, v2 = b.V2, v3 = b.V3, now, acc, id, l }, tx);
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @l, @v1, @v2, @v3, @acc, @now, @comment)",
                    new { id, l, v1 = b.V1, v2 = b.V2, v3 = b.V3, acc, now, comment }, tx);
            }
            await tx.CommitAsync();
            // manual p. 128: a published document is published again so the new version number shows on the intranet
            foreach (var l in targets)
            {
                var o = rows.First(r => string.Equals(r.Lang, l, StringComparison.OrdinalIgnoreCase));
                if (o.Status == 3) { queue.Enqueue(id, l, o.DocName ?? "", version, acc, "publish"); republish = true; }
            }
        }
        catch (SqlException ex) when (ex.Number is 229 or 262)
        {
            await tx.RollbackAsync();
            foreach (var c in copied) try { System.IO.File.Delete(c); } catch { /* ignore */ }
            return StatusCode(403, new { error = "The database login used by the API may not update documents (needs UPDATE on Documents and INSERT on Mods and DocumentsArchives). " + ex.Message });
        }
        catch { await tx.RollbackAsync(); foreach (var c in copied) try { System.IO.File.Delete(c); } catch { /* ignore */ } throw; }

        cache.Remove($"stats:{acc}:{lang}");
        return Ok(new { idDoc = id, lang, version, languages = targets, republish });
    }
}
