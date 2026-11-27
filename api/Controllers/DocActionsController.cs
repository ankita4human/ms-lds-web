using System.Data;
using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

public class CopyBody
{
    public string? Lang { get; set; }
    public int GroupId { get; set; }
    public string? Name { get; set; }
    public string? NewName { get; set; }
    public int V1 { get; set; }
    public int V2 { get; set; }
    public int V3 { get; set; }
}
public class RenameBody { public string? Lang { get; set; } public string? Name { get; set; } public string? NewName { get; set; } }
public class AssignBody { public string? Lang { get; set; } public int GroupId { get; set; } }

public class DocLangRow
{
    public string Lang { get; set; } = "";
    public string? LangStandard { get; set; }
    public string? DocName { get; set; }
    public string? DocNewName { get; set; }
    public int Status { get; set; }
    public int Type { get; set; }
    public int V1 { get; set; }
    public int V2 { get; set; }
    public int V3 { get; set; }
    public string? Extension { get; set; }
    public int IDWebPath { get; set; }
    public bool DoNotPublish { get; set; }
    public string? LANotes { get; set; }
    public bool LAIgnore { get; set; }
    public int IdProcessOwner { get; set; }
    public bool IsCycle { get; set; }
}
public class LinkRow { public int IdGroup { get; set; } }

/// Right-click menu of a document: Copy, Assignment, Rename and Delete (manual pp. 103-108), written from
/// LDSClientSession.copyDocument / addLink / removeLink / renameDocument / deleteDocument and DocumentFactory.
[ApiController, Route("api/lds/documents"), Authorize]
public class DocActionsController(IConfiguration cfg, IMemoryCache cache, PublishQueue queue, ILogger<DocActionsController> log) : ControllerBase
{
    const int RightNewDoc = 34, RightEdit = 38, RightDelete = 33, RightAdminDoc = 37;
    const int StDraft = 1, StEdit = 2, StPublished = 3, StExpired = 6;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static string L(string? lang) => (lang ?? "").Trim().ToUpperInvariant();
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    static IActionResult? SqlErr(SqlException e) => e.Number switch
    {
        229 or 262 or 230 => Err(403, "The database account used by the API may not change this. Run the document section of sql/grant-pl_app.sql. " + e.Message),
        547 => Err(409, "The database refused the change because other data still refers to this document. " + e.Message),
        _ => null
    };

    /// The user must be able to see the document (linked to an accessible folder).
    async Task<bool> CanSee(SqlConnection con, int id, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        return await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang }) > 0;
    }

    async Task<List<DocLangRow>> Rows(SqlConnection con, int id, SqlTransaction? tx = null) => (await con.QueryAsync<DocLangRow>(@"
        SELECT Lang, LangStandard, DocName, DocNewName, ISNULL(Status, 0) AS Status, ISNULL([Type], 0) AS [Type], ISNULL(V1, 0) AS V1, ISNULL(V2, 0) AS V2, ISNULL(V3, 0) AS V3,
               Extension, ISNULL(IDWebPath, 0) AS IDWebPath, ISNULL(DoNotPublish, 0) AS DoNotPublish, CAST(LANotes AS nvarchar(max)) AS LANotes,
               ISNULL(LAIgnore, 0) AS LAIgnore, ISNULL(IdProcessOwner, 0) AS IdProcessOwner, ISNULL(IsCycle, 0) AS IsCycle
        FROM Documents WHERE IDDoc = @id", new { id }, tx)).ToList();

    async Task<string?> Cfg(SqlConnection con, string name) => await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name });

    // ------------------------------------------------------------------ COPY
    /// Copy document (manual p. 103): a new draft with its own id, the file of every language, linked to the chosen folder.
    [HttpPost("{id:int}/copy")]
    public async Task<IActionResult> Copy(int id, [FromBody] CopyBody b)
    {
        var lang = L(b.Lang);
        var name = new string((b.Name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        var newName = new string((b.NewName ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (name.Length == 0) return Err(400, "Please enter a name for the copy.");
        if (name.Length > 70) return Err(400, "The name is too long (70 characters at most).");
        if (newName.Length > 70) return Err(400, "The secondary name is too long (70 characters at most).");
        if (b.V1 is < 0 or > 999 || b.V2 is < 0 or > 999 || b.V3 is < 0 or > 999 || (b.V1 == 0 && b.V2 == 0 && b.V3 == 0))
            return Err(400, "The version must be between 0.0.1 and 999.999.999.");
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightNewDoc)) return Err(403, "You do not have the right to create documents.");
        if (!await CanSee(con, id, lang)) return Err(404, "Document not found.");

        var groups = await Access.Groups(con, lang);
        if (!groups.Any(g => g.IDGroup == b.GroupId)) return Err(400, "The target folder does not exist.");
        var accessible = Access.AccessibleGroups(groups, rights);
        if (accessible is not null && !accessible.Contains(b.GroupId)) return Err(403, "You have no full access to that folder.");

        var rows = await Rows(con, id);
        var src = rows.FirstOrDefault(r => r.Lang == lang);
        if (src is null) return Err(404, "Document not found.");
        var active = (await con.QueryAsync<string>("SELECT Lang FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang")).ToList();
        var (dp, _, dbId) = await DocFiles.Paths(con);
        dp = cfg["Storage:DocPath"] ?? dp;
        if (string.IsNullOrWhiteSpace(dp) || string.IsNullOrWhiteSpace(dbId)) return Err(500, "DocPath/DBId are not configured in the Config table.");
        var copyMail = await Cfg(con, "QDSCopyDistributionList");   // DB Tool setting; when it is not set the distribution list is copied (manual p. 104)

        var written = new List<string>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
            var newId = await con.ExecuteScalarAsync<int>(@"
                SELECT ISNULL(MAX(m), 0) + 1 FROM (
                    SELECT MAX(IDDoc) AS m FROM Documents WITH (UPDLOCK, HOLDLOCK)
                    UNION ALL SELECT MAX(IDDoc) FROM DocumentsArchives WITH (UPDLOCK, HOLDLOCK)) x", transaction: tx);
            var now = DateTime.Now;
            var ext = DocFiles.Ext(src.Extension);
            foreach (var l in active)
            {
                var r = rows.FirstOrDefault(x => x.Lang == l) ?? src;
                var dn = l == lang ? name : $"<{lang}>{name}";
                var nn = l == lang ? newName : (newName.Length == 0 ? "" : $"<{lang}>{newName}");
                await con.ExecuteAsync(@"
                    INSERT INTO Documents (IDDoc, Lang, DocName, Status, [Type], V1, V2, V3, Extension, IDWebPath, IsCycle, LangStandard,
                        DateCre, IdCre, DatePub, IdPub, DateMod, IdMod, DatePrv, IdPrv, DateExp, DoNotPublish, IDLck, LANotes, Translated,
                        LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner, DateFrozen, IdFrozen, DoNotExpire)
                    VALUES (@newId, @l, @dn, 1, @type, @v1, @v2, @v3, @ext, @web, 0, @std,
                        @now, @acc, NULL, 0, @now, @acc, NULL, 0, NULL, @dnp, NULL, @notes, 0,
                        @ignore, 0, NULL, @nn, @owner, NULL, 0, 0)",
                    new { newId, l, dn, type = src.Type, v1 = b.V1, v2 = b.V2, v3 = b.V3, ext = src.Extension, web = src.IDWebPath, std = src.LangStandard, now, acc = Acc,
                          dnp = src.DoNotPublish, notes = r.LANotes ?? "", ignore = r.LAIgnore, nn, owner = src.IdProcessOwner }, tx);
            }
            await con.ExecuteAsync("INSERT INTO DocGrp (IdDoc, IdGroup, SortD) VALUES (@newId, @g, @newId)", new { newId, g = b.GroupId }, tx);
            var langsWithFile = new List<string>();
            foreach (var l in active)
            {
                var from = DocFiles.Live(dp, dbId, l, id, DocFiles.Ext((rows.FirstOrDefault(x => x.Lang == l) ?? src).Extension));
                if (!System.IO.File.Exists(from)) continue;
                var to = DocFiles.Live(dp, dbId, l, newId, ext);
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                System.IO.File.Copy(from, to, false);
                written.Add(to); langsWithFile.Add(l);
            }
            foreach (var l in langsWithFile)
                await con.ExecuteAsync("INSERT INTO Mods (IdDoc, Lang, V1, V2, V3, IdAcc, ModDate, ModDesc) VALUES (@newId, @l, @v1, @v2, @v3, @acc, @now, @desc)",
                    new { newId, l, v1 = b.V1, v2 = b.V2, v3 = b.V3, acc = Acc, now, desc = $"Document created (copy of document {id})" }, tx);
            if (copyMail != "0")
                await con.ExecuteAsync("INSERT INTO DocMailList (IDML, IDDoc) SELECT IDML, @newId FROM DocMailList WHERE IDDoc = @id", new { id, newId }, tx);
            await tx.CommitAsync();
            GroupCache.Bump();
            foreach (var l in active) cache.Remove($"stats:{Acc}:{l}");
            log.LogInformation("Copied document {Id} to {New} ({Name})", id, newId, name);
            return Ok(new { idDoc = newId, lang, name, version = $"{b.V1}.{b.V2}.{b.V3}", files = langsWithFile });
        }
        catch (SqlException e) when (SqlErr(e) is { } r) { await tx.RollbackAsync(); foreach (var w in written) try { System.IO.File.Delete(w); } catch { } return r; }
        catch { await tx.RollbackAsync(); foreach (var w in written) try { System.IO.File.Delete(w); } catch { } throw; }
    }

    // ------------------------------------------------------------------ ASSIGNMENT
    /// Folders the document is assigned to (Properties > Assignments).
    [HttpGet("{id:int}/assignments")]
    public async Task<IActionResult> Assignments(int id, [FromQuery] string? lang)
    {
        var lg = L(lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await CanSee(con, id, lg)) return Err(404, "Document not found.");
        var all = await Access.Groups(con, lg);
        var rights = await Access.Rights(con, Acc);
        var accessible = Access.AccessibleGroups(all, rights);
        var byId = all.ToDictionary(g => g.IDGroup, g => g, EqualityComparer<int>.Default);
        var linked = (await con.QueryAsync<LinkRow>("SELECT DISTINCT IdGroup FROM DocGrp WHERE IdDoc = @id AND IdGroup IS NOT NULL", new { id })).Select(x => x.IdGroup).ToList();
        var items = new List<object>(); var hidden = 0;
        foreach (var g in linked)
        {
            if (!byId.ContainsKey(g)) continue;
            if (accessible is not null && !accessible.Contains(g)) { hidden++; continue; }
            var parts = new List<string>(); var cur = g; var guard = 0; string main = "";
            while (byId.TryGetValue(cur, out var n) && guard++ < 50) { parts.Insert(0, n.GroupDesc ?? $"Group {n.IDGroup}"); main = n.GroupDesc ?? ""; cur = n.IDParent; }
            items.Add(new { idGroup = g, name = byId[g].GroupDesc, path = string.Join(" / ", parts), main, canRemove = true });
        }
        return Ok(new { items, hidden });
    }

    /// Add link (LDSClientSession.addLink): the document gets one more folder; needs full access to that folder.
    [HttpPost("{id:int}/assignments")]
    public async Task<IActionResult> AddLink(int id, [FromBody] AssignBody b)
    {
        var lg = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightEdit)) return Err(403, "You do not have the right to change documents.");
        if (!await CanSee(con, id, lg)) return Err(404, "Document not found.");
        var all = await Access.Groups(con, lg);
        if (!all.Any(g => g.IDGroup == b.GroupId)) return Err(404, "That folder does not exist.");
        var accessible = Access.AccessibleGroups(all, rights);
        if (accessible is not null && !accessible.Contains(b.GroupId)) return Err(403, "You have no full access to that folder.");
        try
        {
            var n = await con.ExecuteAsync(@"IF NOT EXISTS (SELECT 1 FROM DocGrp WHERE IdDoc = @id AND IdGroup = @g)
                    INSERT INTO DocGrp (IdDoc, IdGroup, SortD) SELECT @id, @g, ISNULL(MAX(SortD), 0) + 1 FROM DocGrp WHERE IdGroup = @g", new { id, g = b.GroupId });
            GroupCache.Bump();
            return Ok(new { idDoc = id, idGroup = b.GroupId, added = n > 0 });
        }
        catch (SqlException e) when (SqlErr(e) is { } r) { return r; }
    }

    /// Remove link (LDSClientSession.removeLink).
    [HttpDelete("{id:int}/assignments/{groupId:int}")]
    public async Task<IActionResult> RemoveLink(int id, int groupId, [FromQuery] string? lang)
    {
        var lg = L(lang);
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightEdit)) return Err(403, "You do not have the right to change documents.");
        if (!await CanSee(con, id, lg)) return Err(404, "Document not found.");
        var all = await Access.Groups(con, lg);
        var accessible = Access.AccessibleGroups(all, rights);
        if (accessible is not null && !accessible.Contains(groupId)) return Err(403, "You have no full access to that folder.");
        try
        {
            await con.ExecuteAsync("DELETE FROM DocGrp WHERE IdDoc = @id AND IdGroup = @groupId", new { id, groupId });
            GroupCache.Bump();
            return Ok(new { idDoc = id, idGroup = groupId });
        }
        catch (SqlException e) when (SqlErr(e) is { } r) { return r; }
    }

    // ------------------------------------------------------------------ RENAME
    /// Rename (manual p. 106): Draft / Edit documents; every status when Config LDSIsAllowToRenameDoc = 1 (DB Tool "Rename Document").
    /// A published document is published again automatically.
    [HttpPut("{id:int}/rename")]
    public async Task<IActionResult> Rename(int id, [FromBody] RenameBody b)
    {
        var lg = L(b.Lang);
        var name = new string((b.Name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (name.Length == 0) return Err(400, "Please enter a document name.");
        if (name.Length > 80) return Err(400, "The name is too long (80 characters at most).");
        string? nn = b.NewName is null ? null : new string(b.NewName.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (nn is { Length: > 80 }) return Err(400, "The secondary name is too long (80 characters at most).");
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        if (!Access.IsAdmin(rights) && !rights.Any(r => r.RCod == RightEdit)) return Err(403, "You do not have the right to change documents.");
        if (!await CanSee(con, id, lg)) return Err(404, "Document not found.");
        var row = (await Rows(con, id)).FirstOrDefault(r => r.Lang == lg);
        if (row is null) return Err(404, "Document not found.");
        var any = await Cfg(con, "LDSIsAllowToRenameDoc") == "1";
        if (!any && row.Status != StDraft && row.Status != StEdit)
            return Err(409, "Only documents in Draft or Edit status can be renamed. Documents in Verify, Release or Publish status cannot be renamed.");
        var checkedOutByOther = await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND checkedOut = 1 AND accountId <> @acc", new { id, acc = Acc });
        if (checkedOutByOther > 0) return Err(409, "The document is checked out by another user.");
        try
        {
            await con.ExecuteAsync("UPDATE Documents SET DocName = @name" + (nn is null ? "" : ", DocNewName = @nn") + " WHERE IDDoc = @id AND Lang = @lg", new { id, lg, name, nn });
            if (!string.Equals(row.DocName, name, StringComparison.Ordinal))
                await PropMods.Log(con, null, id, lg, row.V1, row.V2, row.V3, Acc, "Name", row.DocName, name, "Document renamed (web)", log);
        }
        catch (SqlException e) when (SqlErr(e) is { } r) { return r; }
        object? job = null;
        if (row.Status == StPublished)
        {
            var j = queue.Enqueue(id, lg, name, $"{row.V1}.{row.V2}.{row.V3}", Acc, "publish");
            job = new { jobId = j.Id };
        }
        return Ok(new { idDoc = id, lang = lg, name, republish = job is not null, job });
    }

    // ------------------------------------------------------------------ DELETE
    /// Delete (manual p. 107, LDSClientSession.deleteDocument): every language goes to the archive (marked as deleted, so it shows in the
    /// deleted-documents list), then the document, its folder links, collections, catch links, links and distribution lists are removed.
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] string? lang)
    {
        var lg = L(lang);
        await using var con = Con(); await con.OpenAsync();
        var rights = await Access.Rights(con, Acc);
        var admin = Access.IsAdmin(rights);
        if (!admin && !rights.Any(r => r.RCod == RightDelete)) return Err(403, "You do not have the right to delete documents.");
        if (!await CanSee(con, id, lg)) return Err(404, "Document not found.");
        var rows = await Rows(con, id);
        var cur = rows.FirstOrDefault(r => r.Lang == lg);
        if (cur is null) return Err(404, "Document not found.");
        if (!string.Equals(cur.LangStandard, lg, StringComparison.OrdinalIgnoreCase))
            return Err(409, $"Delete the document in its main language ({cur.LangStandard}).");
        var main = rows.FirstOrDefault(r => r.Lang == cur.LangStandard) ?? cur;
        if (!admin && main.Status != StExpired && !rights.Any(r => r.RCod == RightAdminDoc))
            return Err(403, "A document can only be deleted after it has expired, unless you have the 'Admin documents' right.");
        if (rows.Any(r => r.IsCycle)) return Err(409, "The document is in a workflow and cannot be deleted.");
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCheckout WHERE idDoc = @id AND checkedOut = 1", new { id }) > 0)
            return Err(409, "The document is checked out. Check it in first.");

        var (dp, ap, dbId) = await DocFiles.Paths(con);
        dp = cfg["Storage:DocPath"] ?? dp;
        // published copies: default web path (Documents.IDWebPath / StandardWebPath) and the AD publish paths
        var webIds = rows.Select(r => r.IDWebPath).Where(x => x > 0).Distinct().ToList();
        if (webIds.Count == 0 && int.TryParse(await Cfg(con, "StandardWebPath"), out var sw)) webIds.Add(sw);
        var webRoots = (await con.QueryAsync<string>("SELECT Path FROM WebPathes WHERE IdWebPath IN @webIds", new { webIds })).ToList();
        webRoots.AddRange(await con.QueryAsync<string>(@"SELECT p.ADPublishPath FROM DocPublishADGroup g JOIN DocADGroupPath p ON p.IDADGroup = g.IDADGroup
            WHERE g.IDDoc = @id AND ISNULL(p.ADPublishPath, '') <> ''", new { id }));

        var archived = new List<string>();
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync(IsolationLevel.ReadCommitted);
        try
        {
            var now = DateTime.Now;
            foreach (var r in rows)
            {
                await con.ExecuteAsync(@"
                    INSERT INTO DocumentsArchives (IDDoc, Lang, DocName, Status, Type, V1, V2, V3, Extension, LangStandard, DateCre, IdCre, DatePub, IdPub,
                        DateMod, IdMod, DateDel, IdDel, DatePrv, IdPrv, DateExp, DoNotPublish, LANotes, Translated, LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner,
                        DateFrozen, IdFrozen, DoNotExpire)
                    SELECT IDDoc, Lang, DocName, Status, Type, V1, V2, V3, Extension, LangStandard, DateCre, IdCre,
                        CASE WHEN Status = 8 THEN NULL ELSE DatePub END, CASE WHEN Status = 8 THEN 0 ELSE IdPub END,
                        DateMod, IdMod, @now, @acc, DatePrv, IdPrv, DateExp, DoNotPublish, LANotes, Translated, LAIgnore, IdRel, DateRel, DocNewName, IdProcessOwner,
                        DateFrozen, IdFrozen, DoNotExpire
                    FROM Documents WHERE IDDoc = @id AND Lang = @l", new { id, l = r.Lang, now, acc = Acc }, tx);
                if (!string.IsNullOrWhiteSpace(ap))
                {
                    var ext = DocFiles.Ext(r.Extension);
                    var src = DocFiles.Live(dp, dbId, r.Lang, id, ext);
                    var dst = DocFiles.Archived(ap, dbId, r.Lang, id, r.V1, r.V2, r.V3, ext);
                    if (System.IO.File.Exists(src) && !System.IO.File.Exists(dst)) { Directory.CreateDirectory(Path.GetDirectoryName(dst)!); System.IO.File.Copy(src, dst, false); archived.Add(dst); }
                }
            }
            await con.ExecuteAsync("DELETE FROM DocGrp WHERE IdDoc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM DocCollect WHERE IDDoc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM DocCatch WHERE IdDoc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM Links WHERE IDDoc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM DocMailList WHERE IDDoc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM Documents WHERE IDDoc = @id", new { id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (SqlErr(e) is { } r) { await tx.RollbackAsync(); foreach (var a in archived) try { System.IO.File.Delete(a); } catch { } return r; }
        catch { await tx.RollbackAsync(); foreach (var a in archived) try { System.IO.File.Delete(a); } catch { } throw; }

        // After the commit: remove the live files and the published copies (the archive keeps the files).
        var warnings = new List<string>();
        foreach (var r in rows)
        {
            try { var f = DocFiles.Live(dp, dbId, r.Lang, id, DocFiles.Ext(r.Extension)); if (System.IO.File.Exists(f)) System.IO.File.Delete(f); }
            catch (Exception ex) { warnings.Add($"The file of {r.Lang} could not be removed: {ex.Message}"); }
            foreach (var root in webRoots.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct(StringComparer.OrdinalIgnoreCase))
                try { var d = Path.Combine(root, r.Lang, $"D{id}"); if (Directory.Exists(d)) Directory.Delete(d, true); }
                catch (Exception ex) { warnings.Add($"The published copy ({r.Lang}) could not be removed: {ex.Message}"); }
        }
        GroupCache.Bump();
        foreach (var r in rows) cache.Remove($"stats:{Acc}:{r.Lang}");
        log.LogInformation("Deleted document {Id} by account {Acc}", id, Acc);
        return Ok(new { deleted = id, languages = rows.Select(r => r.Lang), warnings });
    }
}
