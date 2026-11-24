using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class TypeBody
{
    public string? Lang { get; set; }
    public string? Name { get; set; }
    public string? ShortForm { get; set; }
    public int Life { get; set; } = 36;
    public bool IsTemplate { get; set; }
    public bool PublishAsOriginal { get; set; }
    public bool Is14DaysRelease { get; set; }
}
public class TypeRow
{
    public int IDType { get; set; }
    public string? Lang { get; set; }
    public string? TypeDesc { get; set; }
    public string? TypeDescShort { get; set; }
    public int? Life { get; set; }
    public bool? IsTemplate { get; set; }
    public bool? PublishAsOriginal { get; set; }
    public bool? Is14DaysRelease { get; set; }
}

/// Options > Type management (manual p. 39-41). One DocTypes row per active language; languages other than the one the user typed in
/// carry a "<XX>" marker in front of the text until somebody translates them (legacy LDSClientSession.addDocType/changeDocType).
[ApiController, Route("api/lds/types"), Authorize]
public class TypesController(IConfiguration cfg) : ControllerBase
{
    const int RightTypes = 30;     // "document types"
    const int MaxLife = 720;       // manual: maximum lifetime 720 months
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    async Task<bool> CanManage(SqlConnection con)
    {
        var rights = await Access.Rights(con, Acc);
        return Access.IsAdmin(rights) || rights.Any(r => r.RCod == RightTypes);
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string lang = "EN")
    {
        await using var con = Con();
        var rows = (await con.QueryAsync<TypeRow>("SELECT IDType, Lang, TypeDesc, TypeDescShort, Life, isTemplate AS IsTemplate, isPublishAsOriginal AS PublishAsOriginal, Is14DaysRelease AS Is14DaysRelease FROM DocTypes WHERE Lang = @lang AND IDType IS NOT NULL", new { lang })).ToList();
        var used = (await con.QueryAsync<(int Type, int N)>("SELECT [Type] AS [Type], COUNT(DISTINCT IDDoc) AS N FROM Documents WHERE [Type] IS NOT NULL GROUP BY [Type]")).ToDictionary(x => x.Type, x => x.N);
        var std = await con.QueryFirstOrDefaultAsync<string>("SELECT FValue FROM Config WHERE FName = 'StandardType'");
        int.TryParse(std, out var stdId);
        var items = rows.Select(r => new
        {
            idType = r.IDType, name = r.TypeDesc, shortForm = r.TypeDescShort, life = r.Life ?? 36, isTemplate = r.IsTemplate ?? false, publishAsOriginal = r.PublishAsOriginal ?? false, is14DaysRelease = r.Is14DaysRelease ?? false,
            untranslated = (r.TypeDesc ?? "").StartsWith("<") && (r.TypeDesc ?? "").IndexOf('>') == 3,
            documents = used.GetValueOrDefault(r.IDType), isDefault = r.IDType == stdId,
        }).OrderBy(r => r.name, StringComparer.CurrentCultureIgnoreCase);
        return Ok(new { items, canManage = await CanManage(con) });
    }

    static string? Validate(TypeBody b, int langCount)
    {
        var name = (b.Name ?? "").Trim(); var sf = (b.ShortForm ?? "").Trim();
        if (name.Length == 0) return "Please enter a name.";
        if (sf.Length == 0) return "Please enter a short form.";
        if (b.Life is < 1 or > MaxLife) return $"The lifetime must be between 1 and {MaxLife} months.";
        if (name.Length > 40) return "The name may have at most 40 characters.";
        if (sf.Length > 12) return "The short form may have at most 12 characters.";
        return null;
    }

    async Task<string?> Duplicate(SqlConnection con, string lang, int? exceptId, string name, string sf, System.Data.Common.DbTransaction? tx = null)
    {
        var rows = await con.QueryAsync<TypeRow>("SELECT IDType, TypeDesc, TypeDescShort FROM DocTypes WHERE Lang = @lang AND (@ex IS NULL OR IDType <> @ex)", new { lang, ex = exceptId }, tx);
        foreach (var r in rows)
        {
            if (string.Equals((r.TypeDesc ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase)) return "A document type with this name already exists.";
            if (string.Equals((r.TypeDescShort ?? "").Trim(), sf, StringComparison.OrdinalIgnoreCase)) return "A document type with this short form already exists.";
        }
        return null;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] TypeBody b)
    {
        var lang = (b.Lang ?? "").Trim().ToUpperInvariant();
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return StatusCode(403, new { error = "You do not have the right to manage document types." });
        var active = (await con.QueryAsync<string>("SELECT Lang FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang")).ToList();
        if (!active.Contains(lang)) return BadRequest(new { error = "Unknown language." });
        if (Validate(b, active.Count) is { } e) return BadRequest(new { error = e });
        var name = b.Name!.Trim(); var sf = b.ShortForm!.Trim();
        // The other languages store "<EN>" + text in nvarchar(40) / nvarchar(12).
        if (active.Count > 1 && (name.Length > 36 || sf.Length > 8)) return BadRequest(new { error = "With several languages the name may have at most 36 and the short form at most 8 characters (the other languages add a 4-character marker)." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await Duplicate(con, lang, null, name, sf, tx) is { } dup) { await tx.RollbackAsync(); return Conflict(new { error = dup }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDType), 0) + 1 FROM DocTypes WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            foreach (var l in active)
                await con.ExecuteAsync("INSERT INTO DocTypes (IDType, Life, Lang, TypeDesc, TypeDescShort, isTemplate, isPublishAsOriginal, Is14DaysRelease) VALUES (@id, @life, @l, @d, @s, @t, @po, @d14)",
                    new { id, life = b.Life, l, d = l == lang ? name : $"<{lang}>{name}", s = l == lang ? sf : $"<{lang}>{sf}", t = b.IsTemplate, po = b.PublishAsOriginal, d14 = b.Is14DaysRelease }, tx);
            await tx.CommitAsync();
            return Ok(new { idType = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return StatusCode(403, new { error = "The database login may not write DocTypes (needs INSERT, UPDATE, DELETE). " + ex.Message }); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] TypeBody b)
    {
        var lang = (b.Lang ?? "").Trim().ToUpperInvariant();
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return StatusCode(403, new { error = "You do not have the right to manage document types." });
        var rows = (await con.QueryAsync<TypeRow>("SELECT IDType, Lang, TypeDesc, TypeDescShort FROM DocTypes WHERE IDType = @id", new { id })).ToList();
        if (rows.Count == 0) return NotFound(new { error = "Document type not found." });
        if (!rows.Any(r => string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase))) return BadRequest(new { error = "Unknown language." });
        if (Validate(b, rows.Count) is { } e) return BadRequest(new { error = e });
        var name = b.Name!.Trim(); var sf = b.ShortForm!.Trim();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await Duplicate(con, lang, id, name, sf, tx) is { } dup) { await tx.RollbackAsync(); return Conflict(new { error = dup }); }
            foreach (var r in rows)
            {
                var d = r.TypeDesc; var s = r.TypeDescShort; var mark = $"<{lang}>";
                if (string.Equals(r.Lang, lang, StringComparison.OrdinalIgnoreCase)) { d = name; s = sf; }
                else { if ((d ?? "").StartsWith(mark)) d = mark + name; if ((s ?? "").StartsWith(mark)) s = mark + sf; }   // untranslated copies follow
                if ((d?.Length ?? 0) > 40 || (s?.Length ?? 0) > 12) { await tx.RollbackAsync(); return BadRequest(new { error = $"The text is too long for the untranslated copy in {r.Lang} (marker included): name up to 36, short form up to 8 characters." }); }
                await con.ExecuteAsync("UPDATE DocTypes SET TypeDesc = @d, TypeDescShort = @s, Life = @life, isTemplate = @t, isPublishAsOriginal = @po, Is14DaysRelease = @d14 WHERE IDType = @id AND Lang = @l",
                    new { d, s, life = b.Life, t = b.IsTemplate, po = b.PublishAsOriginal, d14 = b.Is14DaysRelease, id, l = r.Lang }, tx);
            }
            await tx.CommitAsync();
            return Ok(new { idType = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return StatusCode(403, new { error = "The database login may not update DocTypes. " + ex.Message }); }
        catch { await tx.RollbackAsync(); throw; }
    }

    /// Only a type that no document (current or archived) or workflow step uses, and that is not the default type, can be deleted.
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return StatusCode(403, new { error = "You do not have the right to manage document types." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocTypes WHERE IDType = @id", new { id }) == 0) return NotFound(new { error = "Document type not found." });
        var std = await con.QueryFirstOrDefaultAsync<string>("SELECT FValue FROM Config WHERE FName = 'StandardType'");
        if (int.TryParse(std, out var s) && s == id) return Conflict(new { error = "The default document type cannot be deleted. Choose another default type first." });
        var inDocs = await con.ExecuteScalarAsync<int>("SELECT (SELECT COUNT(*) FROM Documents WHERE [Type] = @id) + (SELECT COUNT(*) FROM DocumentsArchives WHERE [Type] = @id)", new { id });
        if (inDocs > 0) return Conflict(new { error = "This document type is used by documents and cannot be deleted." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM CycleMoveDocType WHERE IDType = @id", new { id }) > 0) return Conflict(new { error = "This document type is used in a workflow and cannot be deleted." });
        try
        {
            await con.ExecuteAsync("DELETE FROM DocTypes WHERE IDType = @id", new { id });
            return Ok(new { deleted = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return StatusCode(403, new { error = "The database login may not delete from DocTypes. " + ex.Message }); }
    }

    [HttpPost("{id:int}/default")]
    public async Task<IActionResult> SetDefault(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return StatusCode(403, new { error = "You do not have the right to manage document types." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocTypes WHERE IDType = @id", new { id }) == 0) return NotFound(new { error = "Document type not found." });
        try
        {
            var n = await con.ExecuteAsync("UPDATE Config SET FValue = @v WHERE FName = 'StandardType'", new { v = id.ToString() });
            if (n == 0) await con.ExecuteAsync("INSERT INTO Config (FName, FType, FValue) VALUES ('StandardType', 'int', @v)", new { v = id.ToString() });
            return Ok(new { idType = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return StatusCode(403, new { error = "The database login may not update Config. " + ex.Message }); }
    }
}
