using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;

namespace PhaseLift.Api.Controllers;

/// Version stamp for the cached group tree: any change to groups bumps it, so every user's tree is rebuilt on the next call.
public static class GroupCache
{
    static int v;
    public static void Bump() => Interlocked.Increment(ref v);
    public static string TreeKey(int acc, string lang) => $"tree:{acc}:{lang}:{Volatile.Read(ref v)}";
}

public record GroupCreate(string? Lang, int IdParent, string? Name);
public record GroupRename(string? Lang, string? Name);
public record GroupOwner(int IdOwner);
public record GroupFlag(bool Value);
public record GroupOrder(string? Lang, int[]? Groups, int[]? Docs);
public class OrderItem { public int Id { get; set; } public string? Name { get; set; } public int Sort { get; set; } public int? Status { get; set; } }
public class ReportDoc
{
    public int IdGroup { get; set; }
    public int IdDoc { get; set; }
    public string? Name { get; set; }
    public string? Type { get; set; }
    public string? Version { get; set; }
    public string? Author { get; set; }
    public DateTime? Created { get; set; }
    public string? Editor { get; set; }
    public DateTime? Modified { get; set; }
    public string? Releaser { get; set; }
    public DateTime? Published { get; set; }
    public string? Publisher { get; set; }
}

/// Groups right-click menu of the left tree (manual p. 12-14): new group, rename, delete, change order, do not view in web,
/// set as template, publish as original, assign process owner, print report. Mirrors LDSClientSession / GroupFactory.
[ApiController, Route("api/lds/groups"), Authorize]
public class GroupAdminController(IConfiguration cfg, IMemoryCache cache) : ControllerBase
{
    const int ProcessGroup = 0, StandardGroup = 1;
    int Me => int.Parse(User.FindFirstValue("idAcc")!);

    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? lang) => string.IsNullOrWhiteSpace(lang) ? "EN" : lang.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };

    static async Task<List<string>> ActiveLangs(SqlConnection con) =>
        (await con.QueryAsync<string>("SELECT Lang FROM Lang WHERE ISNULL(isactive, 1) = 1 ORDER BY Lang")).ToList();

    sealed record Ctx(List<GroupRow> All, HashSet<int>? Accessible, bool Admin, bool AllGroups);

    async Task<Ctx> Load(SqlConnection con, string lang)
    {
        var all = await Access.Groups(con, lang);
        var rights = await Access.Rights(con, Me);
        return new Ctx(all, Access.AccessibleGroups(all, rights), Access.IsAdmin(rights), Access.SeesAllGroups(rights));
    }

    /// Legacy hasFullAccess check: null = OK, otherwise the error to return.
    static IActionResult? Guard(Ctx c, int id)
    {
        if (!c.All.Any(g => g.IDGroup == id)) return Err(404, "This group no longer exists. Reload the page.");
        if (c.Accessible is not null && !c.Accessible.Contains(id)) return Err(403, "You do not have full access to this group.");
        return null;
    }

    static IActionResult? Sql(SqlException e) => e.Number switch
    {
        229 or 262 or 230 => Err(403, "The database account used by the API is not allowed to change groups. Run the group section of sql/grant-pl_app.sql."),
        _ => null
    };

    /// New group / sub-group (createGroup): one row per active language, the typed language holds the plain name, the others
    /// "&lt;LANG&gt;name". The group starts with the owner and web visibility of its parent.
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] GroupCreate b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return Err(400, "Please enter a group name.");
        if (name.Length > 240) return Err(400, "The group name is too long (240 characters at most).");
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, lang);
        int owner = 0; bool dnp = false;
        if (b.IdParent == 0)
        {
            if (!c.AllGroups) return Err(403, "Creating a main group needs the 'All groups' right.");
        }
        else
        {
            var g = Guard(c, b.IdParent); if (g is not null) return g;
            var parent = await con.QueryFirstAsync<(int Type, int Owner, bool Dnp)>(
                "SELECT ISNULL(GroupType, 0), ISNULL(IDProcessOwner, 0), ISNULL(DoNotPublish, 0) FROM Groups WHERE IDGroup = @id AND Lang = @lang", new { id = b.IdParent, lang });
            if (parent.Type == StandardGroup) return Err(400, "Standards are created in Standard management, not in the document tree.");
            owner = parent.Owner; dnp = parent.Dnp;
        }
        if (c.All.Any(x => x.IDParent == b.IdParent && string.Equals(x.GroupDesc?.Trim(), name, StringComparison.OrdinalIgnoreCase)))
            return Err(409, "A group with this name already exists here.");
        try
        {
            var langs = await ActiveLangs(con);   // read before the transaction starts: every command inside it must use tx
            await using var tx = await con.BeginTransactionAsync();
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDGroup), 0) + 1 FROM Groups WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            foreach (var l in langs)
                await con.ExecuteAsync(@"INSERT INTO Groups (IDGroup, Lang, GroupDesc, IDParent, SortG, SpecialType, DoNotPublish, IDProcessOwner, GroupType)
                    VALUES (@id, @l, @d, @p, @id, 0, @dnp, @owner, @t)",
                    new { id, l, d = l == lang ? name : $"<{lang}>{name}", p = b.IdParent, dnp, owner, t = ProcessGroup }, tx);
            await tx.CommitAsync();
            GroupCache.Bump();
            return Ok(new { idGroup = id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
    }

    /// Rename (renameGroup): the name in this language, and the "&lt;LANG&gt;" placeholder in the languages that have not been translated yet.
    [HttpPut("{id:int}/rename")]
    public async Task<IActionResult> Rename(int id, [FromBody] GroupRename b)
    {
        var name = (b.Name ?? "").Trim();
        if (name.Length == 0) return Err(400, "Please enter a group name.");
        if (name.Length > 240) return Err(400, "The group name is too long (240 characters at most).");
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, lang);
        var g = Guard(c, id); if (g is not null) return g;
        var me = c.All.First(x => x.IDGroup == id);
        if (me.GroupType == StandardGroup) return Err(400, "Standards are renamed in Standard management.");
        if (c.All.Any(x => x.IDGroup != id && x.IDParent == me.IDParent && string.Equals(x.GroupDesc?.Trim(), name, StringComparison.OrdinalIgnoreCase)))
            return Err(409, "A group with this name already exists here.");
        try
        {
            var prefix = $"<{lang}>";
            await con.ExecuteAsync(@"UPDATE Groups SET GroupDesc = @name WHERE IDGroup = @id AND Lang = @lang;
                UPDATE Groups SET GroupDesc = @prefix + @name WHERE IDGroup = @id AND Lang <> @lang AND LEFT(GroupDesc, 4) = @prefix", new { id, lang, name, prefix });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { idGroup = id });
    }

    /// Delete (removeGroup): refused while the group has sub-groups or documents linked to it.
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(lang));
        var g = Guard(c, id); if (g is not null) return g;
        var me = c.All.First(x => x.IDGroup == id);
        if (me.GroupType == StandardGroup) return Err(400, "Standards are deleted in Standard management.");
        var kids = await con.ExecuteScalarAsync<int>("SELECT COUNT(DISTINCT IDGroup) FROM Groups WHERE IDParent = @id", new { id });
        if (kids > 0) return Err(409, $"The group contains {kids} sub-group(s). Delete or move them first.");
        var docs = await con.ExecuteScalarAsync<int>("SELECT COUNT(DISTINCT IdDoc) FROM DocGrp WHERE IdGroup = @id", new { id });
        if (docs > 0) return Err(409, $"{docs} document(s) are still linked to this group. Remove the links first.");
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM Groups WHERE IDGroup = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM GroupProperties WHERE IdGroup = @id", new { id }, tx);
            // rights that pointed at this single group (RCod 21 = right on a single group)
            await con.ExecuteAsync("DELETE FROM AccountsRights WHERE RCod = @rc AND RValue = CAST(@id AS nvarchar(20))", new { id, rc = Access.RightSingleGroup }, tx);
            await con.ExecuteAsync("UPDATE Config SET FValue = '0' WHERE FName = 'GroupTemplate' AND FValue = CAST(@id AS nvarchar(20))", new { id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { deleted = id });
    }

    /// Process owners that can be assigned (Accounts.IsProcessOwner, user management).
    [HttpGet("process-owners")]
    public async Task<IActionResult> Owners()
    {
        await using var con = Con();
        var rows = await con.QueryAsync<OrderItem>(@"SELECT a.IdAcc AS Id, ISNULL(NULLIF(e.Name, ''), a.AccShort) AS Name
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC
            WHERE ISNULL(a.IsProcessOwner, 0) = 1 AND ISNULL(a.IsDeleted, 0) = 0 AND ISNULL(a.AccInactive, 0) = 0 ORDER BY 2");
        return Ok(rows.Select(r => new { id = r.Id, name = r.Name }));
    }

    /// Assign process owner (changeGroupProcessOwner): the owner is stored for every language and copied to the
    /// documents of the group that are still in Draft / Edit status.
    [HttpPut("{id:int}/owner")]
    public async Task<IActionResult> Owner(int id, [FromBody] GroupOwner b, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(lang));
        var g = Guard(c, id); if (g is not null) return g;
        if (b.IdOwner > 0 && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Accounts WHERE IdAcc = @o AND ISNULL(IsProcessOwner, 0) = 1 AND ISNULL(IsDeleted, 0) = 0", new { o = b.IdOwner }) == 0)
            return Err(400, "This user is not a process owner. Tick 'Process owner' in User management first.");
        int docs;
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            await con.ExecuteAsync("UPDATE Groups SET IDProcessOwner = @o WHERE IDGroup = @id", new { id, o = b.IdOwner }, tx);
            docs = await con.ExecuteAsync(@"UPDATE d SET IdProcessOwner = @o FROM Documents d
                WHERE d.Status IN (1, 2) AND d.IDDoc IN (SELECT IdDoc FROM DocGrp WHERE IdGroup = @id)", new { id, o = b.IdOwner }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { idGroup = id, owner = b.IdOwner, documentsUpdated = docs });
    }

    /// Do not view group in the web (changeGroupDoNotShowOnWeb): applies to the group and all its sub-groups.
    [HttpPut("{id:int}/web")]
    public async Task<IActionResult> Web(int id, [FromBody] GroupFlag b, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(lang));
        var g = Guard(c, id); if (g is not null) return g;
        var ids = Access.Descendants(c.All, new[] { id });
        try { await con.ExecuteAsync($"UPDATE Groups SET DoNotPublish = @v WHERE IDGroup IN ({string.Join(",", ids)})", new { v = b.Value }); }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { idGroup = id, doNotPublish = b.Value, groups = ids.Count });
    }

    /// Publish as original (changeGroupPublishAsOrginal): admin only. Documents of such groups are published without HTML.
    [HttpPut("{id:int}/pub-original")]
    public async Task<IActionResult> PubOriginal(int id, [FromBody] GroupFlag b, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(lang));
        if (!c.Admin) return Err(403, "Only administrators can change 'Publish as original'.");
        var g = Guard(c, id); if (g is not null) return g;
        try
        {
            if (b.Value)
                await con.ExecuteAsync(@"IF EXISTS (SELECT 1 FROM GroupProperties WHERE IdGroup = @id) UPDATE GroupProperties SET isPubOriginal = 1 WHERE IdGroup = @id
                    ELSE INSERT INTO GroupProperties (IdGroup, isPubOriginal) VALUES (@id, 1)", new { id });
            else await con.ExecuteAsync("DELETE FROM GroupProperties WHERE IdGroup = @id", new { id });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { idGroup = id, pubOriginal = b.Value });
    }

    /// Set as template (admin, process groups only, only one group at a time): stored in Config 'GroupTemplate'.
    [HttpPut("{id:int}/template")]
    public async Task<IActionResult> Template(int id, [FromBody] GroupFlag b, [FromQuery] string? lang)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(lang));
        if (!c.Admin) return Err(403, "Only administrators can set the template folder.");
        var g = Guard(c, id); if (g is not null) return g;
        if (c.All.First(x => x.IDGroup == id).GroupType != ProcessGroup) return Err(400, "Only process groups can be the template folder.");
        var value = b.Value ? id.ToString() : "0";
        try
        {
            var n = await con.ExecuteAsync("UPDATE Config SET FValue = @value WHERE FName = 'GroupTemplate'", new { value });
            if (n == 0) await con.ExecuteAsync("INSERT INTO Config (FName, FType, FValue) VALUES ('GroupTemplate', 'Int32', @value)", new { value });
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { idGroup = id, template = b.Value });
    }

    /// Change order, step 1: sub-groups (and documents) of a group in their current order. id 0 = main groups.
    [HttpGet("{id:int}/order")]
    public async Task<IActionResult> OrderGet(int id, [FromQuery] string? lang)
    {
        var lg = L(lang);
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, lg);
        if (id != 0) { var g = Guard(c, id); if (g is not null) return g; }
        var nav = Access.NavigableGroups(c.All, c.Accessible);
        var groups = c.All.Where(x => x.IDParent == id && nav.Contains(x.IDGroup)).OrderBy(x => x.SortG).ThenBy(x => x.GroupDesc)
            .Select(x => new { id = x.IDGroup, name = x.GroupDesc ?? $"Group {x.IDGroup}", canMove = c.Accessible is null || c.Accessible.Contains(x.IDGroup) }).ToList();
        var docs = new List<OrderItem>();
        if (id != 0)
        {
            var vis = await Access.VisibleSql(con, Me, lg);
            docs = (await con.QueryAsync<OrderItem>($@"SELECT d.IDDoc AS Id, d.DocName AS Name, d.Status AS Status, ISNULL(dg.SortD, 0) AS Sort
                FROM DocGrp dg JOIN Documents d ON d.IDDoc = dg.IdDoc AND d.Lang = @lg
                WHERE dg.IdGroup = @id AND ISNULL(d.LAIgnore, 0) = 0 AND {vis}
                ORDER BY ISNULL(dg.SortD, 0), d.DocName, d.IDDoc", new { id, lg })).ToList();
        }
        return Ok(new { groups, docs = docs.Select(d => new { id = d.Id, name = d.Name, status = d.Status }) });
    }

    /// Change order, step 2 (resortGroups / resortDocs): positions 1..n in the order the user chose. The group order is
    /// written to every language so the tree looks the same everywhere.
    [HttpPut("{id:int}/order")]
    public async Task<IActionResult> OrderSet(int id, [FromBody] GroupOrder b)
    {
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, L(b.Lang));
        if (id != 0) { var g = Guard(c, id); if (g is not null) return g; }
        try
        {
            await using var tx = await con.BeginTransactionAsync();
            var n = 0;
            foreach (var gid in b.Groups ?? [])
            {
                n++;
                if (c.Accessible is not null && !c.Accessible.Contains(gid)) continue;   // skip groups the user may not change
                await con.ExecuteAsync("UPDATE Groups SET SortG = @s WHERE IDGroup = @g AND ISNULL(IDParent, 0) = @id", new { s = n, g = gid, id }, tx);
            }
            n = 0;
            if (id != 0)
                foreach (var did in b.Docs ?? [])
                    await con.ExecuteAsync("UPDATE DocGrp SET SortD = @s WHERE IdDoc = @d AND IdGroup = @id", new { s = ++n, d = did, id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException e) when (Sql(e) is { } r) { return r; }
        GroupCache.Bump();
        return Ok(new { ok = true });
    }

    /// Print report (createPrintListFromFolder): every document of the group and of its sub-groups, group by group.
    /// The browser turns it into a printout / PDF.
    [HttpGet("{id:int}/report")]
    public async Task<IActionResult> Report(int id, [FromQuery] string? lang)
    {
        var lg = L(lang);
        await using var con = Con(); await con.OpenAsync();
        var c = await Load(con, lg);
        var nav = Access.NavigableGroups(c.All, c.Accessible);
        if (!c.All.Any(x => x.IDGroup == id) || !nav.Contains(id)) return Err(404, "This group no longer exists. Reload the page.");
        var set = Access.Descendants(c.All, new[] { id });
        set.IntersectWith(nav);
        var vis = await Access.VisibleSql(con, Me, lg);
        var rows = (await con.QueryAsync<ReportDoc>($@"SELECT dg.IdGroup, d.IDDoc AS IdDoc, d.DocName AS Name,
                REPLACE(ISNULL(t.TypeDesc, CONCAT('Type ', d.[Type])), '<DE>', '') AS [Type],
                CONCAT(d.V1, '.', d.V2, '.', d.V3) AS Version,
                cr.AccShort AS Author, d.DateCre AS Created, md.AccShort AS Editor, d.DateMod AS Modified,
                pb.AccShort AS Publisher, d.DatePub AS Published
            FROM DocGrp dg
            JOIN Documents d ON d.IDDoc = dg.IdDoc AND d.Lang = @lg
            OUTER APPLY (SELECT TOP 1 TypeDesc FROM DocTypes WHERE IDType = d.[Type] AND Lang = d.Lang) t
            LEFT JOIN Accounts cr ON cr.IdAcc = d.IdCre
            LEFT JOIN Accounts md ON md.IdAcc = d.IdMod
            LEFT JOIN Accounts pb ON pb.IdAcc = d.IdPub
            WHERE dg.IdGroup IN ({string.Join(",", set)}) AND ISNULL(d.LAIgnore, 0) = 0 AND {vis}
            ORDER BY ISNULL(dg.SortD, 0), d.DocName, d.IDDoc", new { lg })).ToList();
        var byParent = c.All.Where(x => set.Contains(x.IDGroup)).GroupBy(x => x.IDParent).ToDictionary(x => x.Key, x => x.OrderBy(y => y.SortG).ThenBy(y => y.GroupDesc).ToList());
        var sections = new List<object>();
        void Walk(GroupRow g, string path)
        {
            var p = path.Length == 0 ? (g.GroupDesc ?? "") : path + " / " + (g.GroupDesc ?? "");
            var mine = rows.Where(r => r.IdGroup == g.IDGroup).ToList();
            if (mine.Count > 0 || g.IDGroup == id)
                sections.Add(new
                {
                    idGroup = g.IDGroup, name = g.GroupDesc, path = p,
                    docs = mine.Select(r => new { r.IdDoc, r.Name, r.Type, r.Version, r.Author, r.Created, r.Editor, r.Modified, r.Publisher, r.Published })
                });
            if (byParent.TryGetValue(g.IDGroup, out var kids)) foreach (var k in kids) Walk(k, p);
        }
        Walk(c.All.First(x => x.IDGroup == id), "");
        return Ok(new { title = c.All.First(x => x.IDGroup == id).GroupDesc, lang = lg, generated = DateTime.Now, documents = rows.Select(r => r.IdDoc).Distinct().Count(), sections });
    }
}
