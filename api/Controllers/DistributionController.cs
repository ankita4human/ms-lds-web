using System.Security.Claims;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class MlBody { public string? Name { get; set; } }
public class ContactBody { public string? Name { get; set; } public string? Email { get; set; } }
public class IdsBody { public List<int>? Ids { get; set; } }
public class MlRow { public int IDML { get; set; } public string? Name { get; set; } public int Members { get; set; } public int Docs { get; set; } }
public class ContactRow { public int IDEC { get; set; } public string? Name { get; set; } public string? Email { get; set; } public int IsAccount { get; set; } }
public class UsageRow { public int Docs { get; set; } public int Audits { get; set; } public int Matrix { get; set; } public int Apps { get; set; } }

/// Options > E-mail distribution (manual p. 55-62) and the "Distribution" tab of a document.
/// Tables: MailList (lists), MailListEmailContact (members), EmailContact (address book), DocMailList (list <-> document).
/// Legacy methods: getMaillists/addMaillist/changeMaillist/delMailList, getMailContacts(FromML)/addMailContact/changeMailContact/delMailContact,
/// addMCtoML/removeMCfromML, addMLtoDoc/removeMLfromDoc/getEmailListByDocs. All need the right "e-Mail distribution List Management" (4).
[ApiController, Route("api/lds"), Authorize]
public class DistributionController(IConfiguration cfg) : ControllerBase
{
    const int RightMailList = 4;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static readonly Regex MailRx = new(@"^[^@\s]+@[^@\s]+\.[^@\s]+$", RegexOptions.Compiled);

    async Task<bool> CanManage(SqlConnection con)
    {
        var r = await Access.Rights(con, Acc);
        return Access.IsAdmin(r) || r.Any(x => x.RCod == RightMailList);
    }
    IActionResult Denied() => StatusCode(403, new { error = "You do not have the right to manage e-mail distribution lists." });
    static IActionResult DbDenied(SqlException ex) => new ObjectResult(new { error = "The database login may not write these tables (needs INSERT, UPDATE, DELETE on MailList, MailListEmailContact, EmailContact, DocMailList). " + ex.Message }) { StatusCode = 403 };

    static object Member(ContactRow c) => new { idec = c.IDEC, name = c.Name ?? c.Email, email = c.Email ?? "", isAccount = c.IsAccount == 1 };

    const string ContactSql = @"SELECT e.IDEC, e.Name, e.Email,
        CASE WHEN EXISTS (SELECT 1 FROM Accounts a WHERE a.IDEC = e.IDEC AND ISNULL(a.IsDeleted, 0) = 0) THEN 1 ELSE 0 END AS IsAccount FROM EmailContact e";

    static Task<List<ContactRow>> Members(SqlConnection con, int idml) => con.QueryAsync<ContactRow>(ContactSql +
        " JOIN MailListEmailContact x ON x.IDEC = e.IDEC WHERE x.IDML = @idml AND ISNULL(e.Email, '') <> ''", new { idml }).ContinueWith(t => t.Result.OrderBy(c => c.Name ?? c.Email, StringComparer.CurrentCultureIgnoreCase).ToList());

    static Task<UsageRow> Usage(SqlConnection con, int idml, System.Data.Common.DbTransaction? tx = null) => con.QueryFirstAsync<UsageRow>(@"
        SELECT (SELECT COUNT(*) FROM DocMailList WHERE IDML = @idml) AS Docs, (SELECT COUNT(*) FROM ADS_AuditMailList WHERE IDML = @idml) AS Audits,
               (SELECT COUNT(*) FROM MDS_MatrixMailList WHERE IDML = @idml) AS Matrix, (SELECT COUNT(*) FROM QDS_MailList WHERE IDML = @idml) AS Apps", new { idml }, tx);

    // ---------- distribution lists ("All distributors") ----------
    [HttpGet("distribution")]
    public async Task<IActionResult> Lists()
    {
        await using var con = Con();
        var can = await CanManage(con);
        if (!can) return Denied();
        var rows = await con.QueryAsync<MlRow>(@"SELECT m.IDML, m.Name,
            (SELECT COUNT(*) FROM MailListEmailContact x JOIN EmailContact e ON e.IDEC = x.IDEC WHERE x.IDML = m.IDML AND ISNULL(e.Email, '') <> '') AS Members,
            (SELECT COUNT(*) FROM DocMailList d WHERE d.IDML = m.IDML) AS Docs FROM MailList m WHERE m.IDML IS NOT NULL");
        return Ok(new { items = rows.OrderBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase).Select(r => new { id = r.IDML, name = r.Name, members = r.Members, documents = r.Docs }) });
    }

    [HttpGet("distribution/{id:int}")]
    public async Task<IActionResult> List(int id)
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var ml = await con.QueryFirstOrDefaultAsync<MlRow>("SELECT IDML, Name FROM MailList WHERE IDML = @id", new { id });
        if (ml is null) return NotFound(new { error = "Distribution list not found." });
        var u = await Usage(con, id);
        return Ok(new { id = ml.IDML, name = ml.Name, members = (await Members(con, id)).Select(Member), usage = new { documents = u.Docs, audits = u.Audits, matrix = u.Matrix, other = u.Apps } });
    }

    [HttpPost("distribution")]
    public async Task<IActionResult> Create([FromBody] MlBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return BadRequest(new { error = "Please enter a name for the distribution list." });
        if (name.Length > 50) return BadRequest(new { error = "The name may have at most 50 characters." });
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailList WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(LTRIM(RTRIM(Name))) = UPPER(@n)", new { n = name }, tx) > 0)
            { await tx.RollbackAsync(); return Conflict(new { error = "A distribution list with this name already exists." }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDML), 0) + 1 FROM MailList", transaction: tx);
            await con.ExecuteAsync("INSERT INTO MailList (IDML, Name) VALUES (@id, @n)", new { id, n = name }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("distribution/{id:int}")]
    public async Task<IActionResult> Rename(int id, [FromBody] MlBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return BadRequest(new { error = "Please enter a name for the distribution list." });
        if (name.Length > 50) return BadRequest(new { error = "The name may have at most 50 characters." });
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailList WHERE IDML = @id", new { id }) == 0) return NotFound(new { error = "Distribution list not found." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailList WHERE IDML <> @id AND UPPER(LTRIM(RTRIM(Name))) = UPPER(@n)", new { id, n = name }) > 0)
            return Conflict(new { error = "A distribution list with this name already exists." });
        try { await con.ExecuteAsync("UPDATE MailList SET Name = @n WHERE IDML = @id", new { id, n = name }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { id });
    }

    /// Reference check (manual p. 57): a list that is still mapped to documents/audits/... cannot be deleted.
    [HttpDelete("distribution/{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        var name = await con.ExecuteScalarAsync<string?>("SELECT Name FROM MailList WHERE IDML = @id", new { id });
        if (name is null) return NotFound(new { error = "Distribution list not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var u = await Usage(con, id, tx);
            var used = new List<string>();
            if (u.Docs > 0) used.Add($"Documents ({u.Docs})");
            if (u.Audits > 0) used.Add($"Audits ({u.Audits})");
            if (u.Matrix > 0) used.Add($"Process instructions / matrix ({u.Matrix})");
            if (u.Apps > 0) used.Add($"Other applications ({u.Apps})");
            if (used.Count > 0)
            { await tx.RollbackAsync(); return Conflict(new { error = $"The distribution list \"{name}\" is still mapped in: {string.Join(", ", used)}. Remove the mapping first (for documents: Distribution tab of the document)." }); }
            await con.ExecuteAsync("DELETE FROM MailListEmailContact WHERE IDML = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM MailList WHERE IDML = @id", new { id }, tx);
            await tx.CommitAsync();
            return Ok(new { deleted = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    // ---------- members of a list ----------
    [HttpPost("distribution/{id:int}/members")]
    public async Task<IActionResult> AddMembers(int id, [FromBody] IdsBody b)
    {
        var ids = (b.Ids ?? []).Distinct().Where(x => x > 0).ToList();
        if (ids.Count == 0) return BadRequest(new { error = "Please select at least one e-mail address." });
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailList WHERE IDML = @id", new { id }) == 0) return NotFound(new { error = "Distribution list not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var added = 0;
            foreach (var ec in ids)
            {
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM EmailContact WHERE IDEC = @ec AND ISNULL(Email, '') <> ''", new { ec }, tx) == 0) continue;
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailListEmailContact WITH (UPDLOCK, HOLDLOCK) WHERE IDML = @id AND IDEC = @ec", new { id, ec }, tx) > 0) continue;
                await con.ExecuteAsync("INSERT INTO MailListEmailContact (IDML, IDEC) VALUES (@id, @ec)", new { id, ec }, tx); added++;
            }
            await tx.CommitAsync();
            return Ok(new { added });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpDelete("distribution/{id:int}/members/{idec:int}")]
    public async Task<IActionResult> RemoveMember(int id, int idec)
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        try { await con.ExecuteAsync("DELETE FROM MailListEmailContact WHERE IDML = @id AND IDEC = @idec", new { id, idec }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { removed = idec });
    }

    // ---------- address book (EmailContact) ----------
    [HttpGet("distribution/contacts")]
    public async Task<IActionResult> Contacts()
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var rows = (await con.QueryAsync<ContactRow>(ContactSql + " WHERE ISNULL(e.Email, '') <> ''")).OrderBy(c => c.Name ?? c.Email, StringComparer.CurrentCultureIgnoreCase);
        return Ok(rows.Select(Member));
    }

    static string? ValidateContact(ContactBody b)
    {
        var mail = (b.Email ?? "").Trim(); var name = (b.Name ?? "").Trim();
        if (mail.Length == 0) return "Please enter the e-mail address.";
        if (mail.Length > 100 || !MailRx.IsMatch(mail)) return "Please enter a valid e-mail address.";
        if (name.Length > 50) return "The name may have at most 50 characters.";
        return null;
    }

    /// Legacy addMailContact: an address that already exists is not duplicated - the existing contact is returned.
    [HttpPost("distribution/contacts")]
    public async Task<IActionResult> AddContact([FromBody] ContactBody b)
    {
        if (ValidateContact(b) is { } e) return BadRequest(new { error = e });
        var mail = b.Email!.Trim(); var name = (b.Name ?? "").Trim(); if (name.Length == 0) name = mail;
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var existing = await con.ExecuteScalarAsync<int?>("SELECT TOP 1 IDEC FROM EmailContact WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(LTRIM(RTRIM(Email))) = UPPER(@m)", new { m = mail }, tx);
            if (existing is int ex) { await tx.RollbackAsync(); return Ok(new { idec = ex, existed = true }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDEC), 0) + 1 FROM EmailContact", transaction: tx);
            await con.ExecuteAsync("INSERT INTO EmailContact (IDEC, Name, Email) VALUES (@id, @n, @m)", new { id, n = name, m = mail }, tx);
            await tx.CommitAsync();
            return Ok(new { idec = id, existed = false });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("distribution/contacts/{idec:int}")]
    public async Task<IActionResult> ChangeContact(int idec, [FromBody] ContactBody b)
    {
        if (ValidateContact(b) is { } e) return BadRequest(new { error = e });
        var mail = b.Email!.Trim(); var name = (b.Name ?? "").Trim(); if (name.Length == 0) name = mail;
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var c = await con.QueryFirstOrDefaultAsync<ContactRow>(ContactSql + " WHERE e.IDEC = @idec", new { idec });
        if (c is null) return NotFound(new { error = "Address not found." });
        if (c.IsAccount == 1) return Conflict(new { error = "This address belongs to a user. Change it in User management." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM EmailContact WHERE IDEC <> @idec AND UPPER(LTRIM(RTRIM(Email))) = UPPER(@m)", new { idec, m = mail }) > 0)
            return Conflict(new { error = "This e-mail address already exists in the address book." });
        try { await con.ExecuteAsync("UPDATE EmailContact SET Name = @n, Email = @m WHERE IDEC = @idec", new { idec, n = name, m = mail }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { idec });
    }

    /// Legacy delMailContact: addresses of users cannot be deleted; list memberships are removed with the address.
    [HttpDelete("distribution/contacts/{idec:int}")]
    public async Task<IActionResult> DeleteContact(int idec)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        var c = await con.QueryFirstOrDefaultAsync<ContactRow>(ContactSql + " WHERE e.IDEC = @idec", new { idec });
        if (c is null) return NotFound(new { error = "Address not found." });
        if (c.IsAccount == 1) return Conflict(new { error = "This address belongs to a user and cannot be deleted here." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM MailListEmailContact WHERE IDEC = @idec", new { idec }, tx);
            await con.ExecuteAsync("DELETE FROM EmailContact WHERE IDEC = @idec", new { idec }, tx);
            await tx.CommitAsync();
            return Ok(new { deleted = idec });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    // ---------- Distribution tab of a document ----------
    async Task<bool> CanSeeDoc(SqlConnection con, int docId, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        return await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE d.IDDoc = @docId AND d.Lang = @lang AND {vis}", new { docId, lang }) > 0;
    }

    [HttpGet("documents/{docId:int}/distribution")]
    public async Task<IActionResult> DocLists(int docId, [FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanSeeDoc(con, docId, lang)) return NotFound(new { error = "Document not found." });
        var can = await CanManage(con);
        var lists = (await con.QueryAsync<MlRow>("SELECT m.IDML, m.Name FROM DocMailList d JOIN MailList m ON m.IDML = d.IDML WHERE d.IDDoc = @docId", new { docId }))
            .OrderBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        var result = new List<object>();
        foreach (var l in lists) result.Add(new { id = l.IDML, name = l.Name, members = (await Members(con, l.IDML)).Select(Member) });
        object available = Array.Empty<object>();
        if (can)
            available = (await con.QueryAsync<MlRow>("SELECT IDML, Name FROM MailList WHERE IDML IS NOT NULL AND IDML NOT IN (SELECT IDML FROM DocMailList WHERE IDDoc = @docId)", new { docId }))
                .OrderBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase).Select(l => new { id = l.IDML, name = l.Name }).ToList();
        return Ok(new { canManage = can, lists = result, available });
    }

    [HttpPost("documents/{docId:int}/distribution")]
    public async Task<IActionResult> AddDocList(int docId, [FromBody] IdBody b, [FromQuery] string lang = "EN")
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (!await CanSeeDoc(con, docId, lang)) return NotFound(new { error = "Document not found." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM MailList WHERE IDML = @id", new { id = b.Id }) == 0) return NotFound(new { error = "Distribution list not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocMailList WITH (UPDLOCK, HOLDLOCK) WHERE IDML = @id AND IDDoc = @docId", new { id = b.Id, docId }, tx) == 0)
                await con.ExecuteAsync("INSERT INTO DocMailList (IDML, IDDoc) VALUES (@id, @docId)", new { id = b.Id, docId }, tx);
            await tx.CommitAsync();
            return Ok(new { id = b.Id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpDelete("documents/{docId:int}/distribution/{mlId:int}")]
    public async Task<IActionResult> RemoveDocList(int docId, int mlId, [FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        if (!await CanSeeDoc(con, docId, lang)) return NotFound(new { error = "Document not found." });
        try { await con.ExecuteAsync("DELETE FROM DocMailList WHERE IDML = @mlId AND IDDoc = @docId", new { mlId, docId }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { removed = mlId });
    }
}
