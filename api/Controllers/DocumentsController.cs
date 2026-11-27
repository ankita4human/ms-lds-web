using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

// Typed rows so JSON property names (idDoc, docName, ...) are camel-cased reliably.
public class DocumentRow
{
    public int IDDoc { get; set; }
    public string? DocName { get; set; }
    public string? Lang { get; set; }
    public string? LangStandard { get; set; }
    public int? Status { get; set; }
    public string? StatusName { get; set; }
    public int? Type { get; set; }
    public string? TypeName { get; set; }
    public int? V1 { get; set; }
    public int? V2 { get; set; }
    public int? V3 { get; set; }
    public string? Extension { get; set; }
    public DateTime? DateCre { get; set; }
    public DateTime? DateMod { get; set; }
    public DateTime? DateExp { get; set; }
    public DateTime? DatePub { get; set; }
    public DateTime? DateRel { get; set; }
    public bool DoNotExpire { get; set; }
    public bool IsCycle { get; set; }
    public bool DoNotPublish { get; set; }
    public string? Creator { get; set; }
    public string? Publisher { get; set; }
    public string? Releaser { get; set; }
    public List<string>? Paths { get; set; }   // folder paths (only filled when withPaths=true)
}
public class DocGrpLink { public int? IdDoc { get; set; } public int? IdGroup { get; set; } }
public record HistoryRow(int? V1, int? V2, int? V3, string? User, DateTime? ModDate, string? ModDesc);

[ApiController, Route("api/lds/documents"), Authorize]
public class DocumentsController(IConfiguration cfg) : ControllerBase
{
    private static readonly Dictionary<string, string> SortColumns = new(StringComparer.OrdinalIgnoreCase)
    {
        ["id"] = "d.IDDoc", ["name"] = "d.DocName", ["type"] = "TypeName", ["status"] = "StatusName", ["lang"] = "d.Lang",
        ["created"] = "d.DateCre", ["modified"] = "d.DateMod", ["expires"] = "d.DateExp",
        ["published"] = "d.DatePub", ["released"] = "d.DateRel", ["creator"] = "Creator"
    };

    // Document visibility, ported from legacy DocumentFactory.documentIsAccessible + GroupFactory:
    //  - Rights come from AccountsRights, granted to the account directly (IDAccount) or through an
    //    account group (IDAccGroup -> AccountAccGrp).
    //  - RCod 1 (Admin) or 20 (All Groups): full access to every document group.
    //  - RCod 21 (Single group): full access to the group named in RValue AND all its sub-groups.
    //  - A document is visible when it is linked (DocGrp) to at least one accessible group.
    // UNVERIFIED against the live desktop client. Deny-by-default, stricter than the legacy web listing.
    // Kept as an empty prefix so existing "{AccessCte} SELECT ..." statements still work.
    internal const string AccessCte = "";

    // @visAll = 1 -> every group; otherwise the document must be linked to one of @visGids (see Access.Scope).
    // Visibility SQL is built per request by Access.VisibleSql (see Services/Access.cs).

    internal const string ExpiredPredicate =
        "(d.[Status] = 6 OR (d.DateExp IS NOT NULL AND d.DateExp < GETDATE() AND ISNULL(d.DoNotExpire, 0) = 0))";

    internal const string SelectColumns = @"
SELECT d.IDDoc, d.DocName, d.Lang, d.LangStandard, d.[Status],
       ISNULL(s.StatusDesc, CASE d.[Status] WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', d.[Status]) END) AS StatusName, d.[Type],
       REPLACE(ISNULL(t.TypeDesc, CONCAT('Type ', d.[Type])), '<DE>', '') AS TypeName,
       d.V1, d.V2, d.V3, d.Extension, d.DateCre, d.DateMod, d.DateExp, d.DatePub, d.DateRel, CAST(ISNULL(d.DoNotExpire, 0) AS bit) AS DoNotExpire, CAST(ISNULL(d.IsCycle, 0) AS bit) AS IsCycle, CAST(ISNULL(d.DoNotPublish, 0) AS bit) AS DoNotPublish,
       cre.AccShort AS Creator, pub.AccShort AS Publisher, rel.AccShort AS Releaser
FROM Documents d
OUTER APPLY (SELECT TOP 1 StatusDesc FROM [Status] WHERE IDStatus = d.[Status] AND Lang = d.Lang) s
OUTER APPLY (SELECT TOP 1 TypeDesc FROM DocTypes WHERE IDType = d.[Type] AND Lang = d.Lang) t
LEFT JOIN Accounts cre ON cre.IdAcc = d.IdCre
LEFT JOIN Accounts pub ON pub.IdAcc = d.IdPub
LEFT JOIN Accounts rel ON rel.IdAcc = d.IdRel";

    static string? Like(string? v) => string.IsNullOrWhiteSpace(v) ? null : "%" + v.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? lang, [FromQuery] string? text,
        [FromQuery] int? type, [FromQuery] int? status, [FromQuery] int? groupId, [FromQuery] bool direct = false, [FromQuery] bool expired = false,
        [FromQuery] string? creator = null, [FromQuery] string? publisher = null, [FromQuery] string? releaser = null, [FromQuery] bool withPaths = false, [FromQuery] int? filterId = null,
        [FromQuery] int page = 1, [FromQuery] int pageSize = 25,
        [FromQuery] string sort = "modified", [FromQuery] bool desc = true)
    {
        page = Math.Max(1, page); pageSize = Math.Clamp(pageSize, 1, 200);
        var col = sort == "manual" && groupId is int og     // order chosen with "Change order" in the group's right-click menu
            ? $"(SELECT MIN(ISNULL(o.SortD, 0)) FROM DocGrp o WHERE o.IdDoc = d.IDDoc AND o.IdGroup = {og})"
            : SortColumns.GetValueOrDefault(sort, "d.DateMod");
        var acc = int.Parse(User.FindFirstValue("idAcc")!);

        var sw = System.Diagnostics.Stopwatch.StartNew(); long tScope = 0, tRows = 0, tCount = 0;
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));

        // Group filter: selected group plus all sub-groups, limited to groups this user may access.
        int[]? gids = null;
        if (groupId is not null)
        {
            var effLang = string.IsNullOrWhiteSpace(lang) ? "EN" : lang;
            var all = await Access.Groups(con, effLang);
            var set = direct ? new HashSet<int> { groupId.Value } : Access.Descendants(all, new[] { groupId.Value });   // direct = only the documents of this folder
            var accessible = Access.AccessibleGroups(all, await Access.Rights(con, acc));
            if (accessible is not null) set.IntersectWith(accessible);
            gids = set.ToArray();
        }

        // With a folder selected the group list was already cut down to the groups this user may see, so the second
        // visibility test (another huge IN list for non-admins) is redundant and is left out.
        var vis = gids is not null ? "(1 = 1)" : await Access.VisibleSql(con, acc, lang);
        tScope = sw.ElapsedMilliseconds;
        var where = "WHERE ISNULL(d.LAIgnore, 0) = 0 AND " + vis
            + (string.IsNullOrWhiteSpace(lang) ? "" : " AND d.Lang = @lang")
            + (string.IsNullOrWhiteSpace(text) ? "" : " AND (d.DocName LIKE @text ESCAPE '\\' OR CAST(d.IDDoc AS nvarchar(20)) = @raw)")
            + (type is null ? "" : " AND d.[Type] = @type")
            + (status is null ? "" : " AND d.[Status] = @status")
            + (expired ? " AND " + ExpiredPredicate : "")
            + (string.IsNullOrWhiteSpace(creator) ? "" : " AND cre.AccShort LIKE @creator ESCAPE '\\'")
            + (string.IsNullOrWhiteSpace(publisher) ? "" : " AND pub.AccShort LIKE @publisher ESCAPE '\\'")
            + (string.IsNullOrWhiteSpace(releaser) ? "" : " AND rel.AccShort LIKE @releaser ESCAPE '\\'")
            + (gids is null ? "" : $" AND EXISTS (SELECT 1 FROM DocGrp g WHERE g.IdDoc = d.IDDoc AND g.IdGroup IN ({(gids.Length == 0 ? "NULL" : string.Join(",", gids))}))");
        // Saved filter (Options > Filter management): criteria from Filter/FilterValue become extra WHERE conditions.
        var dp = new DynamicParameters();
        if (filterId is not null)
        {
            var fvals = (await con.QueryAsync<FilterValueRow>(
                @"SELECT v.IDFilterType, v.fValue AS FValue FROM FilterValue v JOIN Filter f ON f.IDFilter = v.IDFilter
                  WHERE v.IDFilter = @fid AND (f.IDAccount = @acc OR ISNULL(f.isPublish, 0) = 1)", new { fid = filterId, acc })).ToList();
            var (fsql, fp) = await FilterSql.Build(con, FilterSql.FromRows(fvals), lang);
            where += fsql; dp = fp;
        }
        var p0 = new
        {
            acc, lang, type, status, raw = text?.Trim(),
            creator = Like(creator), publisher = Like(publisher), releaser = Like(releaser),
            text = text is null ? null : "%" + text.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%",
            skip = (page - 1) * pageSize, take = pageSize
        };
        dp.AddDynamicParams(p0);
        var p = dp;

        var countJoins = (string.IsNullOrWhiteSpace(creator) ? "" : " LEFT JOIN Accounts cre ON cre.IdAcc = d.IdCre")
            + (string.IsNullOrWhiteSpace(publisher) ? "" : " LEFT JOIN Accounts pub ON pub.IdAcc = d.IdPub")
            + (string.IsNullOrWhiteSpace(releaser) ? "" : " LEFT JOIN Accounts rel ON rel.IdAcc = d.IdRel");
        var dir = desc ? "DESC" : "ASC"; sw.Restart();
        // Fast path: sort and filter on the Documents table alone, cut the page FIRST, and only then look up status, type and
        // account names for those (at most 200) rows. The old statement joined and sorted everything before taking the page.
        var simple = filterId is null && countJoins.Length == 0 && sort is not ("type" or "status" or "creator");
        IEnumerable<DocumentRow> items;
        if (simple)
        {
            items = await con.QueryAsync<DocumentRow>($@"
SELECT d.IDDoc, d.DocName, d.Lang, d.LangStandard, d.[Status],
       ISNULL(s.StatusDesc, CASE d.[Status] WHEN 11 THEN 'Frozen' ELSE CONCAT('Status ', d.[Status]) END) AS StatusName, d.[Type],
       REPLACE(ISNULL(t.TypeDesc, CONCAT('Type ', d.[Type])), '<DE>', '') AS TypeName,
       d.V1, d.V2, d.V3, d.Extension, d.DateCre, d.DateMod, d.DateExp, d.DatePub, d.DateRel, CAST(ISNULL(d.DoNotExpire, 0) AS bit) AS DoNotExpire, CAST(ISNULL(d.IsCycle, 0) AS bit) AS IsCycle, CAST(ISNULL(d.DoNotPublish, 0) AS bit) AS DoNotPublish,
       cre.AccShort AS Creator, pub.AccShort AS Publisher, rel.AccShort AS Releaser
FROM (SELECT d.IDDoc, d.DocName, d.Lang, d.LangStandard, d.[Status], d.[Type], d.V1, d.V2, d.V3, d.Extension, d.DateCre, d.DateMod, d.DateExp, d.DatePub, d.DateRel,
             d.DoNotExpire, d.IsCycle, d.DoNotPublish, d.IdCre, d.IdPub, d.IdRel
      FROM Documents d {where}
      ORDER BY {col} {dir}, d.IDDoc
      OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY) d
OUTER APPLY (SELECT TOP 1 StatusDesc FROM [Status] WHERE IDStatus = d.[Status] AND Lang = d.Lang) s
OUTER APPLY (SELECT TOP 1 TypeDesc FROM DocTypes WHERE IDType = d.[Type] AND Lang = d.Lang) t
LEFT JOIN Accounts cre ON cre.IdAcc = d.IdCre
LEFT JOIN Accounts pub ON pub.IdAcc = d.IdPub
LEFT JOIN Accounts rel ON rel.IdAcc = d.IdRel
ORDER BY {col} {dir}, d.IDDoc
OPTION (MAXRECURSION 100)", p);
        }
        else
        {
            items = await con.QueryAsync<DocumentRow>($@"{AccessCte}
            {SelectColumns} {where}
            ORDER BY {col} {dir}, d.IDDoc
            OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY
            OPTION (MAXRECURSION 100)", p);
        }
        var rows = items.ToList(); tRows = sw.ElapsedMilliseconds; sw.Restart();
        // The count is only needed when the page is full (or empty beyond page 1): a short page tells the total by itself.
        int total;
        if (rows.Count < pageSize && (rows.Count > 0 || page == 1)) total = (page - 1) * pageSize + rows.Count;
        else
        {
            var countSql = $"{AccessCte} SELECT COUNT(*) FROM Documents d {countJoins} {where} OPTION (MAXRECURSION 100)";
            // The same question is asked again for every page and every revisit: remember the answer for a short time.
            // (Not for saved filters: their parameters are not part of the key.)
            total = filterId is not null ? await con.ExecuteScalarAsync<int>(countSql, p)
                : await Access.Cached($"cnt:{GroupCache.TreeKey(0, "")}:{countSql.GetHashCode()}:{lang}:{type}:{status}:{p0.raw}:{creator}:{publisher}:{releaser}", TimeSpan.FromSeconds(20),
                    () => con.ExecuteScalarAsync<int>(countSql, p));
        }
        tCount = sw.ElapsedMilliseconds;
        var totalMs = tScope + tRows + tCount;
        Response.Headers["Server-Timing"] = $"scope;dur={tScope}, rows;dur={tRows}, count;dur={tCount}";
        if (totalMs > 700) HttpContext.RequestServices.GetService<ILoggerFactory>()?.CreateLogger("DocList")
            .LogWarning("Slow document list {Ms} ms (scope {S}, rows {R}, count {C}); lang={Lang} group={G} direct={D} filter={F} sort={Sort}; groups in filter={N}", totalMs, tScope, tRows, tCount, lang, groupId, direct, filterId, sort, gids?.Length);
        if (withPaths && rows.Count > 0)
        {
            var all = await Access.Groups(con, string.IsNullOrWhiteSpace(lang) ? "EN" : lang);
            var accessible = Access.AccessibleGroups(all, await Access.Rights(con, acc));
            var byId = all.ToDictionary(g => g.IDGroup);
            var links = (await con.QueryAsync<DocGrpLink>(
                "SELECT IdDoc, IdGroup FROM DocGrp WHERE IdDoc IN @ids", new { ids = rows.Select(r => r.IDDoc).ToArray() })).ToList();
            foreach (var r in rows)
            {
                r.Paths = new List<string>();
                foreach (var l in links.Where(x => x.IdDoc == r.IDDoc && x.IdGroup is int gid0 && byId.ContainsKey(gid0) && (accessible is null || accessible.Contains(gid0))))
                {
                    var parts = new List<string>(); var cur = l.IdGroup!.Value; var guard = 0;
                    while (byId.TryGetValue(cur, out var g) && guard++ < 50) { parts.Insert(0, g.GroupDesc ?? $"Group {g.IDGroup}"); cur = g.IDParent; }
                    r.Paths.Add(string.Join(" / ", parts));
                }
            }
        }
        return Ok(new { total, page, pageSize, items = rows, ms = totalMs });
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Detail(int id, [FromQuery] string lang = "EN")
    {
        var acc = int.Parse(User.FindFirstValue("idAcc")!);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var vis = await Access.VisibleSql(con, acc, lang);
        var p = new { acc, id, lang };
        var doc = await con.QueryFirstOrDefaultAsync<DocumentRow>($@"{AccessCte}
            {SelectColumns} WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", p);
        if (doc is null) return NotFound();

        var extra = await con.QueryFirstOrDefaultAsync<(string? Notes, string? Owner)>(@"
            SELECT CAST(d.LANotes AS nvarchar(max)) AS Notes, o.AccShort AS Owner
            FROM Documents d LEFT JOIN Accounts o ON o.IdAcc = d.IdProcessOwner
            WHERE d.IDDoc = @id AND d.Lang = @lang", p);
        var history = await con.QueryAsync<HistoryRow>(@"
            SELECT m.V1, m.V2, m.V3, a.AccShort AS [User], m.ModDate, m.ModDesc
            FROM Mods m LEFT JOIN Accounts a ON a.IdAcc = m.IdAcc
            WHERE m.IdDoc = @id AND m.Lang = @lang ORDER BY m.ModDate DESC", p);

        // Where the document lives in the group tree (only groups this user may see).
        var all = await Access.Groups(con, lang);
        var accessible = Access.AccessibleGroups(all, await Access.Rights(con, acc));
        var linked = (await con.QueryAsync<int>("SELECT IdGroup FROM DocGrp WHERE IdDoc = @id", p)).ToList();
        var byId = all.ToDictionary(g => g.IDGroup);
        var paths = new List<string>();
        var groupIds = linked.Where(g => byId.ContainsKey(g) && (accessible is null || accessible.Contains(g))).ToList();
        foreach (var gid in groupIds)
        {
            var parts = new List<string>(); var cur = gid; var guard = 0;
            while (byId.TryGetValue(cur, out var g) && guard++ < 50) { parts.Insert(0, g.GroupDesc ?? $"Group {g.IDGroup}"); cur = g.IDParent; }
            paths.Add(string.Join(" / ", parts));
        }
        return Ok(new { doc, notes = extra.Notes, processOwner = extra.Owner, paths, groupIds, history });
    }
}
