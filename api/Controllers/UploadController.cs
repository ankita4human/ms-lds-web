using System.Data;
using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class UploadForm
{
    public IFormFile? File { get; set; }
    public string? Name { get; set; }
    public int? Type { get; set; }
    public int GroupId { get; set; }
    /// "ALL" or one active language code (DE, EN, PL ...). Decides which language folders receive the file.
    public string? Lang { get; set; }
    /// Language the user is currently working in; becomes the standard language when Lang = ALL.
    public string? UiLang { get; set; }
    /// Three-digit version (manual: default 0.0.1, maximum 999.999.999).
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
}

public record DocTypeRow(int IdType, string? Name);
public class ConfigRow { public string? FName { get; set; } public string? FValue { get; set; } }
public class GroupOwnerRow { public int Id { get; set; } public int Parent { get; set; } public int Owner { get; set; } }

/// Creates a new document (legacy LDSClientSession.createDocument): rows in Documents for every active language,
/// the link in DocGrp, the file in <DocPath>\<LANG><DBId>\D<id><ext>, plus a Mods history line.
[ApiController, Route("api/lds"), Authorize]
public class UploadController(IConfiguration cfg, IMemoryCache cache, ILogger<UploadController> log, DocIndexWorker indexer) : ControllerBase
{
    const long MaxBytes = 100L * 1024 * 1024;
    const int RightNewDoc = 34;
    static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
        { ".doc", ".docx", ".dot", ".dotx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".pdf", ".vsd", ".vsdx", ".txt" };

    /// Document types for the upload dialog (the "<DE>" marker in English names is removed) and the configured default.
    [HttpGet("doctypes")]
    public async Task<IActionResult> DocTypes([FromQuery] string lang = "EN")
    {
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var types = (await con.QueryAsync<DocTypeRow>(
            "SELECT IDType AS IdType, REPLACE(TypeDesc, '<DE>', '') AS Name FROM DocTypes WHERE Lang = @lang AND IDType IS NOT NULL ORDER BY TypeDesc", new { lang })).ToList();
        var std = await con.QueryFirstOrDefaultAsync<string>("SELECT FValue FROM Config WHERE FName = 'StandardType'");
        return Ok(new { types, defaultType = int.TryParse(std, out var t) ? t : (int?)null });
    }

    [HttpPost("documents/upload")]
    [RequestSizeLimit(MaxBytes), RequestFormLimits(MultipartBodyLengthLimit = MaxBytes)]
    public async Task<IActionResult> Upload([FromForm] UploadForm f)
    {
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        await con.OpenAsync();

        // 1. Right "New document" (34); administrators have every right.
        var rights = await Access.Rights(con, acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightNewDoc))
            return StatusCode(403, new { error = "You do not have the right to create documents." });

        // 2. File checks.
        if (f.File is null || f.File.Length == 0) return BadRequest(new { error = "Please choose a file." });
        if (f.File.Length > MaxBytes) return StatusCode(413, new { error = "The file is larger than 100 MB." });
        var ext = Path.GetExtension(f.File.FileName).ToLowerInvariant();
        if (!Allowed.Contains(ext)) return BadRequest(new { error = $"File type '{ext}' is not allowed. Allowed: {string.Join(", ", Allowed.Order())}" });
        var name = new string((f.Name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (name.Length == 0) name = Path.GetFileNameWithoutExtension(f.File.FileName).Trim();
        if (name.Length > 80) name = name[..80];
        if (name.Length == 0) return BadRequest(new { error = "Please enter a document name." });

        var (v1, v2, v3) = (f.V1 ?? 0, f.V2 ?? 0, f.V3 ?? (f.V1 is null && f.V2 is null ? 1 : 0));
        if (v1 is < 0 or > 999 || v2 is < 0 or > 999 || v3 is < 0 or > 999 || (v1 == 0 && v2 == 0 && v3 == 0))
            return BadRequest(new { error = "The version must be between 0.0.1 and 999.999.999." });

        // 3. Languages: documents exist once per active language; the chosen language(s) get the file.
        var active = (await con.QueryAsync<string>("SELECT Lang FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang")).ToList();
        var all = string.Equals(f.Lang, "ALL", StringComparison.OrdinalIgnoreCase);
        var chosen = all ? null : active.FirstOrDefault(l => string.Equals(l, f.Lang, StringComparison.OrdinalIgnoreCase));
        if (!all && chosen is null) return BadRequest(new { error = "Please choose a valid language." });
        var std = all ? (active.FirstOrDefault(l => string.Equals(l, f.UiLang, StringComparison.OrdinalIgnoreCase)) ?? active[0]) : chosen!;
        var withFile = all ? active : new List<string> { chosen! };

        // 4. Target folder: must exist and be accessible to this user.
        var groups = await Access.Groups(con, std);
        if (!groups.Any(g => g.IDGroup == f.GroupId)) return BadRequest(new { error = "The target folder does not exist." });
        var accessible = Access.AccessibleGroups(groups, rights);
        if (accessible is not null && !accessible.Contains(f.GroupId)) return StatusCode(403, new { error = "You have no access to that folder." });

        // 5. Server configuration (same Config table the legacy service uses).
        var conf = (await con.QueryAsync<ConfigRow>(
            "SELECT FName, FValue FROM Config WHERE FName IN ('DocPath','DBId','StandardType','StandardWebPath')"))
            .Where(x => x.FName != null).GroupBy(x => x.FName!).ToDictionary(x => x.Key, x => x.First().FValue);
        var docPath = cfg["Storage:DocPath"] ?? conf.GetValueOrDefault("DocPath");
        var dbId = conf.GetValueOrDefault("DBId");
        if (string.IsNullOrWhiteSpace(docPath) || string.IsNullOrWhiteSpace(dbId))
            return StatusCode(500, new { error = "DocPath/DBId are not configured in the Config table." });
        var root = Path.GetFullPath(docPath);
        var type = f.Type ?? (int.TryParse(conf.GetValueOrDefault("StandardType"), out var st) ? st : 0);
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocTypes WHERE IDType = @type", new { type }) == 0)
            return BadRequest(new { error = "Unknown document type." });
        var webPath = int.TryParse(conf.GetValueOrDefault("StandardWebPath"), out var wp) ? wp : 1;

        // 6. Process owner: the nearest folder (this one or a parent) that defines one (legacy LDS-198).
        var owners = (await con.QueryAsync<GroupOwnerRow>(
            "SELECT IDGroup AS Id, ISNULL(IDParent,0) AS Parent, ISNULL(IDProcessOwner,0) AS Owner FROM Groups WHERE Lang = @std AND IDGroup IS NOT NULL", new { std }))
            .GroupBy(x => x.Id).ToDictionary(x => x.Key, x => x.First());
        int owner = 0, cur = f.GroupId, guard = 0;
        while (cur != 0 && owners.TryGetValue(cur, out var og) && guard++ < 50) { if (og.Owner > 0) { owner = og.Owner; break; } cur = og.Parent; }

        byte[] content;
        await using (var ms = new MemoryStream()) { await f.File.CopyToAsync(ms); content = ms.ToArray(); }

        var written = new List<string>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
            // 7. New id = highest id in Documents/DocumentsArchives + 1 (legacy getNewId); locked so two uploads cannot collide.
            var id = await con.ExecuteScalarAsync<int>(@"
                SELECT ISNULL(MAX(m), 0) + 1 FROM (
                    SELECT MAX(IDDoc) AS m FROM Documents WITH (UPDLOCK, HOLDLOCK)
                    UNION ALL SELECT MAX(IDDoc) FROM DocumentsArchives WITH (UPDLOCK, HOLDLOCK)) x", transaction: tx);

            var now = DateTime.Now;
            foreach (var lang in active)
            {
                await con.ExecuteAsync(@"
                    INSERT INTO Documents (IDDoc, Lang, DocName, Status, [Type], V1, V2, V3, Extension, IDWebPath, IsCycle, LangStandard,
                        DateCre, IdCre, DatePub, IdPub, DateMod, IdMod, DatePrv, IdPrv, DateExp, DoNotPublish, IDLck, LANotes, Translated,
                        LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner, DateFrozen, IdFrozen, DoNotExpire)
                    VALUES (@id, @lang, @name, 1, @type, @v1, @v2, @v3, @ext, @webPath, 0, @std,
                        @now, @acc, NULL, 0, @now, @acc, NULL, 0, NULL, 0, NULL, N'', 0,
                        @ignore, 0, NULL, @name, @owner, NULL, 0, 0)",
                    new { id, lang, name, type, v1, v2, v3, ext, webPath, std, now, acc, ignore = withFile.Contains(lang) ? 0 : 1, owner }, tx);
            }
            await con.ExecuteAsync("INSERT INTO DocGrp (IdDoc, IdGroup, SortD) VALUES (@id, @g, @id)", new { id, g = f.GroupId }, tx);
            var desc = "Document created (web upload: " + Path.GetFileName(f.File.FileName) + ")";
            if (desc.Length > 1000) desc = desc[..1000];
            foreach (var lang in withFile)
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@id, @lang, @v1, @v2, @v3, @acc, @now, @desc)",
                    new { id, lang, v1, v2, v3, acc, now, desc }, tx);

            // 8. Files: <DocPath>\<LANG><DBId>\D<id><ext>; the file name is built from the id, never from user input.
            foreach (var lang in withFile)
            {
                var dir = Path.GetFullPath(Path.Combine(root, lang + dbId));
                if (!dir.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Invalid target folder.");
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, $"D{id}{ext}");
                await System.IO.File.WriteAllBytesAsync(file, content);
                written.Add(file);
            }
            await tx.CommitAsync();

            GroupCache.Bump();   // every cached tree level is rebuilt (document counts changed)
            foreach (var l in active) cache.Remove($"stats:{acc}:{l}");
            log.LogInformation("Uploaded document {Id} '{Name}' to {Files}", id, name, string.Join("; ", written));
            indexer.Request(false);   // index the new file right away
            return Ok(new
            {
                idDoc = id, lang = std, languages = withFile, name, version = $"{v1}.{v2}.{v3}",
                folders = written.Select(w => Path.GetRelativePath(root, w)).ToList()
            });
        }
        catch (SqlException ex) when (ex.Number == 229 || ex.Number == 262)
        {
            await SafeRollback(tx); Cleanup(written);
            return StatusCode(403, new { error = "The database login used by the API may not insert documents (needs INSERT on Documents, DocGrp and Mods). " + ex.Message });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            await SafeRollback(tx); Cleanup(written);
            return StatusCode(500, new { error = $"The file could not be written to the document folder ({root}). Check that the API has write permission there. {ex.Message}" });
        }
        catch
        {
            await SafeRollback(tx); Cleanup(written);
            throw;
        }
    }

    static async Task SafeRollback(SqlTransaction tx) { try { await tx.RollbackAsync(); } catch { /* already closed */ } }
    static void Cleanup(IEnumerable<string> files) { foreach (var p in files) { try { System.IO.File.Delete(p); } catch { /* best effort */ } } }
}
