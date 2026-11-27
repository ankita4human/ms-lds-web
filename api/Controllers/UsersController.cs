using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class UserBody
{
    public string? Name { get; set; }
    public string? Login { get; set; }
    public string? Email { get; set; }
    public bool Active { get; set; }
    public bool NtAuth { get; set; }
    public bool ProcessOwner { get; set; }
}
public class PasswordBody { public string? Password { get; set; } }
public class RightBody { public int RCod { get; set; } public string? RValue { get; set; } }
public class IdBody { public int Id { get; set; } }
public class GroupNameBody { public string? Name { get; set; } }

public class UserDbRow
{
    public int IdAcc { get; set; }
    public string? AccShort { get; set; }
    public int? IDEC { get; set; }
    public bool? NTAutentification { get; set; }
    public bool? AccInactive { get; set; }
    public bool? IsDeleted { get; set; }
    public bool? IsProcessOwner { get; set; }
    public bool? ChangePwd { get; set; }
    public DateTime? LastLogin { get; set; }
    public string? Name { get; set; }
    public string? Email { get; set; }
}
public class UserRightRow { public int IdAccRights { get; set; } public int RCod { get; set; } public string? RValue { get; set; } public int? IDAccGroup { get; set; } public int? IDAccount { get; set; } }
public class RightDto { public int Id { get; set; } public int Rcod { get; set; } public string Rvalue { get; set; } = ""; public string Name { get; set; } = ""; public int GroupId { get; set; } }
public class MemberRow { public int IdAcc { get; set; } public string? AccGroup { get; set; } }
public class UGroupRow { public int IdAccGroup { get; set; } public string? AccGroup { get; set; } }

/// Options > User management (manual p. 41-55). Tables: Accounts (+EmailContact for name/e-mail), AccountsRights, AccGroups, AccountAccGrp.
/// Passwords are stored exactly as the legacy system does (plain text) - encryption is a planned follow-up.
[ApiController, Route("api/lds"), Authorize]
public class UsersController(IConfiguration cfg) : ControllerBase
{
    const int RightAdmin = 1, RightUsers = 2, RightSimulation = 41, RightSingleGroup = 21, AppLds = 1, SyncUser = 1;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    async Task<bool> CanManage(SqlConnection con)
    {
        var r = await Access.Rights(con, Acc);
        return Access.IsAdmin(r) || r.Any(x => x.RCod == RightUsers);
    }
    IActionResult Denied() => StatusCode(403, new { error = "You do not have the right to manage users (User Management)." });
    static IActionResult DbDenied(SqlException ex) => new ObjectResult(new { error = "The database login may not write this table (needs INSERT, UPDATE, DELETE on Accounts, EmailContact, AccountsRights, AccGroups, AccountAccGrp). " + ex.Message }) { StatusCode = 403 };

    // ---------- helpers ----------
    static string? PasswordProblem(string? p)
    {
        p ??= "";
        if (p.Length < 8) return "The password must have at least 8 characters.";
        if (!p.Any(char.IsLetter) || !p.Any(char.IsDigit) || !p.Any(c => !char.IsLetterOrDigit(c)))
            return "The password must combine letters, numbers and special characters.";
        if (p.Length > 128) return "The password may have at most 128 characters.";
        return null;
    }

    /// Number of active, not deleted accounts that still have the Admin right (directly or through a group).
    static Task<int> ActiveAdmins(SqlConnection con, System.Data.Common.DbTransaction? tx = null) => con.ExecuteScalarAsync<int>(@"
        SELECT COUNT(DISTINCT a.IdAcc) FROM Accounts a
        WHERE ISNULL(a.IsDeleted, 0) = 0 AND ISNULL(a.AccInactive, 0) = 0 AND (
              EXISTS (SELECT 1 FROM AccountsRights r WHERE r.IDAccount = a.IdAcc AND r.RCod = 1)
           OR EXISTS (SELECT 1 FROM AccountsRights r JOIN AccountAccGrp g ON g.IdAccGroup = r.IDAccGroup WHERE g.IdAcc = a.IdAcc AND r.RCod = 1))", transaction: tx);

    static async Task<UserDbRow?> Load(SqlConnection con, int id, System.Data.Common.DbTransaction? tx = null) => await con.QueryFirstOrDefaultAsync<UserDbRow>(@"
        SELECT a.IdAcc, a.AccShort, a.IDEC, a.NTAutentification, a.AccInactive, a.IsDeleted, a.IsProcessOwner, a.ChangePwd, a.LastLogin, e.Name, e.Email
        FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = @id", new { id }, tx);

    static object Head(UserDbRow u) => new
    {
        idAcc = u.IdAcc, name = u.Name ?? u.AccShort, login = u.AccShort, email = u.Email ?? "", active = u.AccInactive != true,
        ntAuth = u.NTAutentification ?? false, processOwner = u.IsProcessOwner ?? false, changePwd = u.ChangePwd ?? false,
        lastLogin = u.LastLogin, isSync = u.IdAcc == SyncUser,
    };


    // ---------- rights catalogue (Choose Rights window) ----------
    [HttpGet("users/rights-catalog")]
    public async Task<IActionResult> Catalog([FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var rows = (await con.QueryAsync<IdName>("SELECT IDRight AS Id, [Description] AS Name FROM Rights WHERE IDApplication = @app AND Lang = @lang", new { app = AppLds, lang })).ToList();
        if (rows.Count == 0) rows = (await con.QueryAsync<IdName>("SELECT IDRight AS Id, [Description] AS Name FROM Rights WHERE IDApplication = @app AND Lang = 'EN'", new { app = AppLds })).ToList();
        var groups = (await Access.Groups(con, lang)).Select(g => new { id = g.IDGroup, parent = g.IDParent, name = g.GroupDesc });
        return Ok(new { rights = rows.OrderBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase), groups, singleGroupCode = RightSingleGroup });
    }

    // ---------- users ----------
    [HttpGet("users")]
    public async Task<IActionResult> List([FromQuery] string status = "all")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var rows = (await con.QueryAsync<UserDbRow>(@"
            SELECT a.IdAcc, a.AccShort, a.IDEC, a.NTAutentification, a.AccInactive, a.IsDeleted, a.IsProcessOwner, a.ChangePwd, a.LastLogin, e.Name, e.Email
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE ISNULL(a.IsDeleted, 0) = 0 AND a.AccShort IS NOT NULL")).ToList();
        var active = rows.Count(r => r.AccInactive != true);
        var shown = status switch { "active" => rows.Where(r => r.AccInactive != true), "inactive" => rows.Where(r => r.AccInactive == true), _ => rows };
        return Ok(new { items = shown.OrderBy(r => r.Name ?? r.AccShort, StringComparer.CurrentCultureIgnoreCase).Select(Head), activeCount = active, total = rows.Count });
    }

    [HttpGet("users/{id:int}")]
    public async Task<IActionResult> Get(int id, [FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var u = await Load(con, id);
        if (u is null || u.IsDeleted == true) return NotFound(new { error = "User not found." });
        var rights = (await con.QueryAsync<UserRightRow>("SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights WHERE IDAccount = @id", new { id })).ToList();
        var groups = (await con.QueryAsync<UGroupRow>("SELECT g.IdAccGroup, g.AccGroup FROM AccountAccGrp m JOIN AccGroups g ON g.IdAccGroup = m.IdAccGroup WHERE m.IdAcc = @id ORDER BY g.AccGroup", new { id })).ToList();
        return Ok(new { head = Head(u), rights = await DescribeRights(con, rights, lang), groups = groups.Select(g => new { id = g.IdAccGroup, name = g.AccGroup }) });
    }

    /// Rights as shown in the lists: description plus, for "Single group", the folder name.
    async Task<List<RightDto>> DescribeRights(SqlConnection con, List<UserRightRow> rights, string lang)
    {
        var names = (await con.QueryAsync<IdName>("SELECT IDRight AS Id, [Description] AS Name FROM Rights WHERE IDApplication = @app AND Lang = @lang", new { app = AppLds, lang })).ToDictionary(x => x.Id, x => x.Name);
        if (names.Count == 0) names = (await con.QueryAsync<IdName>("SELECT IDRight AS Id, [Description] AS Name FROM Rights WHERE IDApplication = @app AND Lang = 'EN'", new { app = AppLds })).ToDictionary(x => x.Id, x => x.Name);
        var groups = (await Access.Groups(con, lang)).ToDictionary(g => g.IDGroup, g => g.GroupDesc);
        return rights.Select(r =>
        {
            var n = names.GetValueOrDefault(r.RCod) ?? $"Right {r.RCod}";
            if (r.RCod == RightSingleGroup && int.TryParse(r.RValue, out var gid) && groups.TryGetValue(gid, out var gn)) n += $" ({gn})";
            return new RightDto { Id = r.IdAccRights, Rcod = r.RCod, Rvalue = r.RValue ?? "", Name = n, GroupId = r.IDAccGroup ?? 0 };
        }).OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    /// "All rights": own rights plus the rights of all groups the user belongs to.
    [HttpGet("users/{id:int}/all-rights")]
    public async Task<IActionResult> AllRights(int id, [FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var rights = (await con.QueryAsync<UserRightRow>(@"SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights
            WHERE IDAccount = @id OR IDAccGroup IN (SELECT IdAccGroup FROM AccountAccGrp WHERE IdAcc = @id)", new { id })).ToList();
        var distinct = rights.GroupBy(r => (r.RCod, r.RValue ?? "")).Select(g => g.First()).ToList();
        return Ok(new { rights = await DescribeRights(con, distinct, lang) });
    }

    static string? Validate(UserBody b)
    {
        var name = (b.Name ?? "").Trim(); var login = (b.Login ?? "").Trim(); var mail = (b.Email ?? "").Trim();
        if (name.Length == 0) return "Please enter the user name.";
        if (name.Length > 50) return "The user name may have at most 50 characters.";
        if (login.Length == 0) return "Please enter the login name.";
        if (login.Length > 30) return "The login name may have at most 30 characters.";
        if (mail.Length > 100) return "The e-mail address may have at most 100 characters.";
        if (mail.Length > 0 && !System.Text.RegularExpressions.Regex.IsMatch(mail, @"^[^@\s]+@[^@\s]+\.[^@\s]+$")) return "Please enter a valid e-mail address.";
        return null;
    }

    [HttpPost("users")]
    public async Task<IActionResult> Create([FromBody] UserBody b)
    {
        if (Validate(b) is { } e) return BadRequest(new { error = e });
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        var login = b.Login!.Trim();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(AccShort) = UPPER(@l) AND ISNULL(IsDeleted, 0) = 0", new { l = login }, tx) > 0)
            { await tx.RollbackAsync(); return Conflict(new { error = "A user with this login name already exists." }); }
            var idEc = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDEC), 0) + 1 FROM EmailContact WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            await con.ExecuteAsync("INSERT INTO EmailContact (IDEC, Name, Email) VALUES (@idEc, @n, @m)", new { idEc, n = b.Name!.Trim(), m = (b.Email ?? "").Trim() }, tx);
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdAcc), 0) + 1 FROM Accounts WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            // Manual: a new user is always created inactive.
            await con.ExecuteAsync(@"INSERT INTO Accounts (IdAcc, AccShort, IDEC, Passwort, ChangePwd, NTAutentification, AccInactive, LangList, IsDeleted, IsProcessOwner)
                VALUES (@id, @l, @idEc, '', 0, @nt, 1, '', 0, @po)", new { id, l = login, idEc, nt = b.NtAuth, po = b.ProcessOwner }, tx);
            await tx.CommitAsync();
            return Ok(new { idAcc = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("users/{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] UserBody b)
    {
        if (Validate(b) is { } e) return BadRequest(new { error = e });
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        var u = await Load(con, id);
        if (u is null || u.IsDeleted == true) return NotFound(new { error = "User not found." });
        var login = b.Login!.Trim();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc <> @id AND UPPER(AccShort) = UPPER(@l) AND ISNULL(IsDeleted, 0) = 0", new { id, l = login }) > 0)
            return Conflict(new { error = "A user with this login name already exists." });
        if (u.IsProcessOwner == true && !b.ProcessOwner)
        {
            var used = await con.ExecuteScalarAsync<int>("SELECT (SELECT COUNT(*) FROM Documents WHERE IDProcessOwner = @id) + (SELECT COUNT(*) FROM Groups WHERE IDProcessOwner = @id)", new { id });
            if (used > 0) return Conflict(new { error = "This user is process owner of documents or groups. Assign another process owner first." });
        }
        var wasActive = u.AccInactive != true;
        if (wasActive && !b.Active)
        {
            if (id == Acc) return Conflict(new { error = "You cannot deactivate your own account." });
            if (id == SyncUser) return Conflict(new { error = "The administrator [Sync] must stay active." });
        }
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("UPDATE Accounts SET AccShort = @l, NTAutentification = @nt, AccInactive = @ina, IsProcessOwner = @po WHERE IdAcc = @id",
                new { id, l = login, nt = b.NtAuth, ina = !b.Active, po = b.ProcessOwner }, tx);
            if (u.IDEC is int ec && ec > 0)
                await con.ExecuteAsync("UPDATE EmailContact SET Name = @n, Email = @m WHERE IDEC = @ec", new { ec, n = b.Name!.Trim(), m = (b.Email ?? "").Trim() }, tx);
            else
            {
                var idEc = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDEC), 0) + 1 FROM EmailContact WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
                await con.ExecuteAsync("INSERT INTO EmailContact (IDEC, Name, Email) VALUES (@idEc, @n, @m)", new { idEc, n = b.Name!.Trim(), m = (b.Email ?? "").Trim() }, tx);
                await con.ExecuteAsync("UPDATE Accounts SET IDEC = @idEc WHERE IdAcc = @id", new { idEc, id }, tx);
            }
            if (wasActive && !b.Active && await ActiveAdmins(con, tx) == 0) { await tx.RollbackAsync(); return Conflict(new { error = "At least one active administrator must remain." }); }
            await tx.CommitAsync();
            return Ok(new { idAcc = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    /// Change Pwd button. Policy from the manual; stored as plain text like the legacy system (encryption is planned).
    [HttpPost("users/{id:int}/password")]
    public async Task<IActionResult> Password(int id, [FromBody] PasswordBody b)
    {
        if (PasswordProblem(b.Password) is { } e) return BadRequest(new { error = e });
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var u = await Load(con, id);
        if (u is null || u.IsDeleted == true) return NotFound(new { error = "User not found." });
        try { await con.ExecuteAsync("UPDATE Accounts SET Passwort = @p WHERE IdAcc = @id", new { p = b.Password, id }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { idAcc = id });
    }

    /// Delete = legacy "deleteAccount": the row stays (history shows the name), but the user is inactive + deleted,
    /// loses rights and group memberships and is removed from the mailing lists.
    [HttpDelete("users/{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (id == SyncUser) return Conflict(new { error = "The administrator [Sync] cannot be deleted." });
        if (id == Acc) return Conflict(new { error = "You cannot delete your own account." });
        var u = await Load(con, id);
        if (u is null || u.IsDeleted == true) return NotFound(new { error = "User not found." });
        var owner = await con.ExecuteScalarAsync<int>("SELECT (SELECT COUNT(*) FROM Documents WHERE IDProcessOwner = @id) + (SELECT COUNT(*) FROM Groups WHERE IDProcessOwner = @id)", new { id });
        if (owner > 0) return Conflict(new { error = "This user is process owner of documents or groups. Assign another process owner first." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM AccountAccGrp WHERE IdAcc = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM AccountsRights WHERE IDAccount = @id", new { id }, tx);
            if (u.IDEC is int ec && ec > 0) await con.ExecuteAsync("DELETE FROM MailListEmailContact WHERE IDEC = @ec", new { ec }, tx);
            await con.ExecuteAsync("UPDATE Accounts SET AccInactive = 1, IsProcessOwner = 0, IsDeleted = 1 WHERE IdAcc = @id", new { id }, tx);
            if (await ActiveAdmins(con, tx) == 0) { await tx.RollbackAsync(); return Conflict(new { error = "At least one active administrator must remain." }); }
            await tx.CommitAsync();
            return Ok(new { deleted = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    // ---------- rights of a user or of a user group ----------
    async Task<IActionResult> AddRight(int? userId, int? groupId, RightBody b)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Rights WHERE IDApplication = @app AND IDRight = @r", new { app = AppLds, r = b.RCod }) == 0) return BadRequest(new { error = "Unknown right." });
        var rv = b.RValue ?? "";
        if (b.RCod == RightSingleGroup && !int.TryParse(rv, out _)) return BadRequest(new { error = "Please choose the group for the right \"Single group\"." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var dup = await con.ExecuteScalarAsync<int>(userId is not null
                ? "SELECT COUNT(*) FROM AccountsRights WITH (UPDLOCK, HOLDLOCK) WHERE IDAccount = @o AND RCod = @r AND ISNULL(RValue, '') = @v"
                : "SELECT COUNT(*) FROM AccountsRights WITH (UPDLOCK, HOLDLOCK) WHERE IDAccGroup = @o AND RCod = @r AND ISNULL(RValue, '') = @v", new { o = userId ?? groupId, r = b.RCod, v = rv }, tx);
            if (dup > 0) { await tx.RollbackAsync(); return Conflict(new { error = "This right is already assigned." }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdAccRights), 0) + 1 FROM AccountsRights", transaction: tx);
            await con.ExecuteAsync("INSERT INTO AccountsRights (IdAccRights, IDAccGroup, IDAccount, RCod, RValue) VALUES (@id, @g, @u, @r, @v)",
                new { id, g = groupId ?? 0, u = userId ?? 0, r = b.RCod, v = rv }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    async Task<IActionResult> RemoveRight(int? userId, int? groupId, int rightId)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        var r = await con.QueryFirstOrDefaultAsync<UserRightRow>("SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights WHERE IdAccRights = @rightId", new { rightId });
        if (r is null || (userId is not null && r.IDAccount != userId) || (groupId is not null && r.IDAccGroup != groupId)) return NotFound(new { error = "Right not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM AccountsRights WHERE IdAccRights = @rightId", new { rightId }, tx);
            if (r.RCod == RightAdmin && await ActiveAdmins(con, tx) == 0) { await tx.RollbackAsync(); return Conflict(new { error = "At least one active administrator must remain." }); }
            await tx.CommitAsync();
            return Ok(new { deleted = rightId });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPost("users/{id:int}/rights")] public Task<IActionResult> AddUserRight(int id, [FromBody] RightBody b) => AddRight(id, null, b);
    [HttpDelete("users/{id:int}/rights/{rightId:int}")] public Task<IActionResult> DelUserRight(int id, int rightId) => RemoveRight(id, null, rightId);

    // ---------- user <-> group membership ----------
    async Task<IActionResult> Member(int userId, int groupId, bool add)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc = @userId AND ISNULL(IsDeleted, 0) = 0", new { userId }) == 0) return NotFound(new { error = "User not found." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccGroups WHERE IdAccGroup = @groupId", new { groupId }) == 0) return NotFound(new { error = "User group not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (add)
            {
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccountAccGrp WHERE IdAcc = @userId AND IdAccGroup = @groupId", new { userId, groupId }, tx) == 0)
                    await con.ExecuteAsync("INSERT INTO AccountAccGrp (IdAcc, IdAccGroup) VALUES (@userId, @groupId)", new { userId, groupId }, tx);
            }
            else
            {
                await con.ExecuteAsync("DELETE FROM AccountAccGrp WHERE IdAcc = @userId AND IdAccGroup = @groupId", new { userId, groupId }, tx);
                if (await ActiveAdmins(con, tx) == 0) { await tx.RollbackAsync(); return Conflict(new { error = "At least one active administrator must remain." }); }
            }
            await tx.CommitAsync();
            return Ok(new { userId, groupId });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }
    [HttpPost("users/{id:int}/groups")] public Task<IActionResult> AddToGroup(int id, [FromBody] IdBody b) => Member(id, b.Id, true);
    [HttpDelete("users/{id:int}/groups/{groupId:int}")] public Task<IActionResult> RemoveFromGroup(int id, int groupId) => Member(id, groupId, false);

    /// Copy From: adds the other user's own rights and group memberships to this user.
    [HttpPost("users/{id:int}/copy-from")]
    public async Task<IActionResult> CopyFrom(int id, [FromBody] IdBody b)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (id == b.Id) return BadRequest(new { error = "Choose another user." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc IN (@a, @b) AND ISNULL(IsDeleted, 0) = 0", new { a = id, b = b.Id }) < 2) return NotFound(new { error = "User not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            var rights = (await con.QueryAsync<UserRightRow>("SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights WHERE IDAccount = @s", new { s = b.Id }, tx)).ToList();
            var next = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdAccRights), 0) + 1 FROM AccountsRights WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            var added = 0;
            foreach (var r in rights)
            {
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccountsRights WHERE IDAccount = @id AND RCod = @c AND ISNULL(RValue, '') = @v", new { id, c = r.RCod, v = r.RValue ?? "" }, tx) > 0) continue;
                await con.ExecuteAsync("INSERT INTO AccountsRights (IdAccRights, IDAccGroup, IDAccount, RCod, RValue) VALUES (@n, 0, @id, @c, @v)", new { n = next++, id, c = r.RCod, v = r.RValue ?? "" }, tx); added++;
            }
            var grp = await con.ExecuteAsync(@"INSERT INTO AccountAccGrp (IdAcc, IdAccGroup) SELECT @id, m.IdAccGroup FROM AccountAccGrp m
                WHERE m.IdAcc = @s AND NOT EXISTS (SELECT 1 FROM AccountAccGrp x WHERE x.IdAcc = @id AND x.IdAccGroup = m.IdAccGroup)", new { id, s = b.Id }, tx);
            await tx.CommitAsync();
            return Ok(new { rightsAdded = added, groupsAdded = grp });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }


    // ---------- Export Rights (legacy getAccRights: overview of all users with data, rights and groups, opened in Excel) ----------
    static string Csv(string? v) => "\"" + (v ?? "").Replace("\"", "\"\"") + "\"";

    [HttpGet("users/export-rights")]
    public async Task<IActionResult> ExportRights([FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var users = (await con.QueryAsync<UserDbRow>(@"
            SELECT a.IdAcc, a.AccShort, a.IDEC, a.NTAutentification, a.AccInactive, a.IsDeleted, a.IsProcessOwner, a.ChangePwd, a.LastLogin, e.Name, e.Email
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE ISNULL(a.IsDeleted, 0) = 0 AND a.AccShort IS NOT NULL")).OrderBy(u => u.Name ?? u.AccShort, StringComparer.CurrentCultureIgnoreCase).ToList();
        var rights = (await con.QueryAsync<UserRightRow>("SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights WHERE ISNULL(IDAccount, 0) > 0")).ToList();
        var memb = (await con.QueryAsync<MemberRow>("SELECT m.IdAcc, g.AccGroup FROM AccountAccGrp m JOIN AccGroups g ON g.IdAccGroup = m.IdAccGroup")).ToList();
        var sb = new StringBuilder("User name,Login,E-mail,Active,NT authentication,Process owner,Rights,User groups\r\n");
        foreach (var u in users)
        {
            var rr = await DescribeRights(con, rights.Where(r => r.IDAccount == u.IdAcc).ToList(), lang);
            sb.Append(string.Join(",", Csv(u.Name ?? u.AccShort), Csv(u.AccShort), Csv(u.Email), Csv(u.AccInactive == true ? "No" : "Yes"), Csv(u.NTAutentification == true ? "Yes" : "No"),
                Csv(u.IsProcessOwner == true ? "Yes" : "No"), Csv(string.Join("; ", rr.Select(x => x.Name))),
                Csv(string.Join("; ", memb.Where(m => m.IdAcc == u.IdAcc).Select(m => m.AccGroup))))).Append("\r\n");
        }
        return File(Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(sb.ToString())).ToArray(), "text/csv; charset=utf-8", "MS-LDS-User-Rights.csv");
    }

    // ---------- list of users that can be simulated (sidebar "Simulate profile"; needs the right 41 "Simulation" or Admin) ----------
    [HttpGet("users/simulatable")]
    public async Task<IActionResult> Simulatable()
    {
        await using var con = Con();
        var mine = await Access.Rights(con, Acc);
        if (!(Access.IsAdmin(mine) || mine.Any(x => x.RCod == RightSimulation))) return StatusCode(403, new { error = "You do not have the right to simulate users (Simulation)." });
        var rows = await con.QueryAsync<UserDbRow>(@"SELECT a.IdAcc, a.AccShort, e.Name FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC
            WHERE ISNULL(a.IsDeleted, 0) = 0 AND ISNULL(a.AccInactive, 0) = 0 AND a.IdAcc <> @me", new { me = Acc });
        return Ok(rows.OrderBy(r => r.Name ?? r.AccShort, StringComparer.CurrentCultureIgnoreCase).Select(r => new { id = r.IdAcc, login = r.AccShort, name = r.Name ?? r.AccShort }));
    }

    // ---------- Simulate (button "Simulate", needs the right 41 "Simulation" or Admin) ----------
    [HttpPost("users/{id:int}/simulate")]
    public async Task<IActionResult> Simulate(int id)
    {
        await using var con = Con();
        var mine = await Access.Rights(con, Acc);
        if (!(Access.IsAdmin(mine) || mine.Any(x => x.RCod == RightSimulation))) return StatusCode(403, new { error = "You do not have the right to simulate users (Simulation)." });
        if (User.FindFirstValue("simBy") is not null) return Conflict(new { error = "You are already simulating a user. Return to your own account first." });
        var u = await Load(con, id);
        if (u is null || u.IsDeleted == true) return NotFound(new { error = "User not found." });
        if (u.AccInactive == true) return Conflict(new { error = "An inactive user cannot be simulated." });
        var expires = DateTime.UtcNow.AddMinutes(cfg.GetValue("Jwt:ExpiryMinutes", 30));
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(cfg["Jwt:Key"]!));
        var jwt = new JwtSecurityToken(cfg["Jwt:Issuer"], cfg["Jwt:Audience"],
            new[] { new Claim("idAcc", id.ToString()), new Claim(ClaimTypes.Name, u.AccShort ?? ""), new Claim("simBy", Acc.ToString()) },
            expires: expires, signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return Ok(new { token = new JwtSecurityTokenHandler().WriteToken(jwt), expiresUtc = expires, login = u.AccShort, name = u.Name ?? u.AccShort });
    }

    // ---------- user groups (tab "User Groups") ----------
    [HttpGet("usergroups")]
    public async Task<IActionResult> Groups()
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var rows = await con.QueryAsync<UGroupRow>("SELECT IdAccGroup, AccGroup FROM AccGroups WHERE IdAccGroup IS NOT NULL");
        return Ok(rows.OrderBy(r => r.AccGroup, StringComparer.CurrentCultureIgnoreCase).Select(r => new { id = r.IdAccGroup, name = r.AccGroup }));
    }

    [HttpGet("usergroups/{id:int}")]
    public async Task<IActionResult> Group(int id, [FromQuery] string lang = "EN")
    {
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        var g = await con.QueryFirstOrDefaultAsync<UGroupRow>("SELECT IdAccGroup, AccGroup FROM AccGroups WHERE IdAccGroup = @id", new { id });
        if (g is null) return NotFound(new { error = "User group not found." });
        var rights = (await con.QueryAsync<UserRightRow>("SELECT IdAccRights, RCod, RValue, IDAccGroup, IDAccount FROM AccountsRights WHERE IDAccGroup = @id", new { id })).ToList();
        var users = (await con.QueryAsync<UserDbRow>(@"SELECT a.IdAcc, a.AccShort, e.Name FROM AccountAccGrp m JOIN Accounts a ON a.IdAcc = m.IdAcc
            LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE m.IdAccGroup = @id AND ISNULL(a.IsDeleted, 0) = 0", new { id })).ToList();
        return Ok(new { id = g.IdAccGroup, name = g.AccGroup, rights = await DescribeRights(con, rights, lang),
            users = users.OrderBy(u => u.Name ?? u.AccShort, StringComparer.CurrentCultureIgnoreCase).Select(u => new { id = u.IdAcc, name = $"{u.Name ?? u.AccShort}[{u.AccShort}]" }) });
    }

    [HttpPost("usergroups")]
    public async Task<IActionResult> CreateGroup([FromBody] GroupNameBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return BadRequest(new { error = "Please enter the group name." });
        if (name.Length > 50) return BadRequest(new { error = "The group name may have at most 50 characters." });
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccGroups WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(AccGroup) = UPPER(@n)", new { n = name }, tx) > 0) { await tx.RollbackAsync(); return Conflict(new { error = "A user group with this name already exists." }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdAccGroup), 0) + 1 FROM AccGroups", transaction: tx);
            await con.ExecuteAsync("INSERT INTO AccGroups (IdAccGroup, AccGroup) VALUES (@id, @n)", new { id, n = name }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("usergroups/{id:int}")]
    public async Task<IActionResult> RenameGroup(int id, [FromBody] GroupNameBody b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return BadRequest(new { error = "Please enter the group name." });
        if (name.Length > 50) return BadRequest(new { error = "The group name may have at most 50 characters." });
        await using var con = Con();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccGroups WHERE IdAccGroup = @id", new { id }) == 0) return NotFound(new { error = "User group not found." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccGroups WHERE IdAccGroup <> @id AND UPPER(AccGroup) = UPPER(@n)", new { id, n = name }) > 0) return Conflict(new { error = "A user group with this name already exists." });
        try { await con.ExecuteAsync("UPDATE AccGroups SET AccGroup = @n WHERE IdAccGroup = @id", new { id, n = name }); }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { return DbDenied(ex); }
        return Ok(new { id });
    }

    /// Removes the group together with its rights and memberships (legacy removeUserGroup).
    [HttpDelete("usergroups/{id:int}")]
    public async Task<IActionResult> DeleteGroup(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (!await CanManage(con)) return Denied();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM AccGroups WHERE IdAccGroup = @id", new { id }) == 0) return NotFound(new { error = "User group not found." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM AccountAccGrp WHERE IdAccGroup = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM AccountsRights WHERE IDAccGroup = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM AccGroups WHERE IdAccGroup = @id", new { id }, tx);
            if (await ActiveAdmins(con, tx) == 0) { await tx.RollbackAsync(); return Conflict(new { error = "At least one active administrator must remain." }); }
            await tx.CommitAsync();
            return Ok(new { deleted = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return DbDenied(ex); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPost("usergroups/{id:int}/rights")] public Task<IActionResult> AddGroupRight(int id, [FromBody] RightBody b) => AddRight(null, id, b);
    [HttpDelete("usergroups/{id:int}/rights/{rightId:int}")] public Task<IActionResult> DelGroupRight(int id, int rightId) => RemoveRight(null, id, rightId);
    [HttpPost("usergroups/{id:int}/users")] public Task<IActionResult> AddGroupUser(int id, [FromBody] IdBody b) => Member(b.Id, id, true);
    [HttpDelete("usergroups/{id:int}/users/{userId:int}")] public Task<IActionResult> RemoveGroupUser(int id, int userId) => Member(userId, id, false);
}
