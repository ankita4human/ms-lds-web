using System.Globalization;
using System.Security.Claims;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

public class DateRangeDto { public bool Active { get; set; } public string? From { get; set; } public string? To { get; set; } }

/// Filter criteria exactly as on the manual's Filter Management screen (Document / Control / Other / Date Range tabs).
public class FilterCriteria
{
    public string? DocName { get; set; }
    public string? DocId { get; set; }                 // one or several ids separated by ; or ,
    public List<int>? Statuses { get; set; }
    public List<int>? Types { get; set; }
    public string? SearchText { get; set; }
    public int? Special { get; set; }                  // 1 = No filter
    public int? Author { get; set; }
    public int? Editor { get; set; }
    public int? Verifier { get; set; }
    public int? Releaser { get; set; }
    public int? Publisher { get; set; }
    public int? Distributor { get; set; }              // mail list
    public int? ProcessOwner { get; set; }
    public string? Application { get; set; }           // extension, e.g. .docx
    public string? Language { get; set; }
    public int? Group { get; set; }
    public bool IncludeSubgroups { get; set; }
    public bool Unlinked { get; set; }
    public string? GroupNumber { get; set; }           // e.g. G45
    public DateRangeDto? Created { get; set; }
    public DateRangeDto? Edited { get; set; }
    public DateRangeDto? Released { get; set; }
    public DateRangeDto? Published { get; set; }
    public DateRangeDto? Expired { get; set; }
}

public class FilterBody { public string? Name { get; set; } public bool General { get; set; } public bool Web { get; set; } public FilterCriteria? Criteria { get; set; } public string? Lang { get; set; } }
public class FilterHead { public int IDFilter { get; set; } public string? FilterName { get; set; } public int? IDAccount { get; set; } public bool? IsPublish { get; set; } public bool? IsWeb { get; set; } }
public class FilterValueRow { public int IDFilterType { get; set; } public string? FValue { get; set; } }
public class IdName { public int Id { get; set; } public string? Name { get; set; } }
public class StrName { public string? Id { get; set; } public string? Name { get; set; } }

/// Filter type codes stored in FilterValue.IDFilterType.
/// CONFIRMED by the data of this database: 1 name, 2 id, 3 status, 4 type, 10 extension, 16 special filter, 17 text, 19 edit-date range.
/// NOT CONFIRMED (legacy constants live in a compiled DLL that is not in the source): all others, assigned by the order of the
/// legacy DocumentFactory.getDocumentsFromFilter switch. Verify against a filter saved by the desktop client before sharing data with it.
public static class FT
{
    public const int Name = 1, Id = 2, Status = 3, Type = 4, Author = 5, Editor = 6, Verifier = 7, Publisher = 8, Distributor = 9,
        Extension = 10, Language = 11, Group = 12, GroupTree = 13, NotLinked = 15, Special = 16, Text = 17,
        Created = 18, Edited = 19, Released = 20, Published = 21, Expired = 22, GroupNo = 23, Releaser = 24, ProcessOwner = 25;
}

public static class FilterSql
{
    public static readonly (int Id, string Name)[] Specials =
    {
        (1, "No filter"), (2, "Edited after publishing"), (3, "Edited after verification"), (4, "Not published"), (5, "Not released"),
        (6, "Released but not published"), (7, "Verified but not released"), (8, "Expired documents"), (9, "Checked out documents"),
        (10, "Documents not completely translated"), (11, "Bound to workflow process"), (12, "No process owner"), (13, "Never edited"), (14, "Never verified"),
    };

    static string SpecialSql(int id) => id switch
    {
        2 => "(d.DatePub IS NOT NULL AND d.DateMod IS NOT NULL AND d.DatePub < d.DateMod)",
        3 => "(d.DatePrv IS NOT NULL AND d.DateMod IS NOT NULL AND d.DatePrv < d.DateMod AND (d.DateRel IS NULL OR d.DateRel < d.DatePrv))",
        4 => "(d.DatePub IS NULL)",
        5 => "(d.DateRel IS NULL)",
        6 => "(d.DateRel IS NOT NULL AND d.DatePub IS NULL)",
        7 => "(d.DatePrv IS NOT NULL AND d.DateRel IS NULL)",
        8 => "(d.DateExp IS NOT NULL AND d.DateExp < GETDATE())",
        9 => "EXISTS (SELECT 1 FROM DocCheckout dc WHERE dc.idDoc = d.IDDoc AND dc.lang = d.Lang)",
        10 => "EXISTS (SELECT 1 FROM Documents o WHERE o.IDDoc = d.IDDoc AND o.Lang <> d.Lang AND ISNULL(o.LAIgnore, 0) = 0 AND (ISNULL(o.V1,0) <> ISNULL(d.V1,0) OR ISNULL(o.V2,0) <> ISNULL(d.V2,0) OR ISNULL(o.V3,0) <> ISNULL(d.V3,0)))",
        11 => "EXISTS (SELECT 1 FROM CycleTasks ct WHERE ct.IDDoc = d.IDDoc)",
        12 => "(ISNULL(d.IDProcessOwner, 0) = 0)",
        13 => "(d.DateMod = d.DateCre AND d.[Status] <> 1)",
        14 => "(d.DatePrv IS NULL)",
        _ => "(1 = 1)",
    };

    // ---- criteria <-> FilterValue rows ----
    static string D(DateRangeDto r) => $"{r.From};{r.To};1";
    public static List<(int type, string value)> ToRows(FilterCriteria c)
    {
        var l = new List<(int, string)>();
        void S(int t, string? v) { if (!string.IsNullOrWhiteSpace(v)) l.Add((t, v.Trim())); }
        void N(int t, int? v) { if (v is > 0) l.Add((t, v.Value.ToString())); }
        void Dt(int t, DateRangeDto? r) { if (r is { Active: true } && DateTime.TryParse(r.From, CultureInfo.InvariantCulture, DateTimeStyles.None, out _) && DateTime.TryParse(r.To, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) l.Add((t, D(r))); }
        S(FT.Name, c.DocName);
        if (!string.IsNullOrWhiteSpace(c.DocId)) { var ids = c.DocId.Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries).Where(x => int.TryParse(x, out _)); var j = string.Join(";", ids); if (j.Length > 0) l.Add((FT.Id, j)); }
        if (c.Statuses is { Count: > 0 }) l.Add((FT.Status, string.Join(";", c.Statuses) + ";"));
        if (c.Types is { Count: > 0 }) l.Add((FT.Type, string.Join(";", c.Types) + ";"));
        S(FT.Text, c.SearchText);
        N(FT.Author, c.Author); N(FT.Editor, c.Editor); N(FT.Verifier, c.Verifier); N(FT.Releaser, c.Releaser); N(FT.Publisher, c.Publisher);
        N(FT.Distributor, c.Distributor); N(FT.ProcessOwner, c.ProcessOwner);
        S(FT.Extension, c.Application); S(FT.Language, c.Language);
        if (c.Group is > 0) { if (c.Unlinked) l.Add((FT.NotLinked, c.Group.Value + ";")); else l.Add((c.IncludeSubgroups ? FT.GroupTree : FT.Group, c.Group.Value + ";")); }
        S(FT.GroupNo, c.GroupNumber);
        Dt(FT.Created, c.Created); Dt(FT.Edited, c.Edited); Dt(FT.Released, c.Released); Dt(FT.Published, c.Published); Dt(FT.Expired, c.Expired);
        l.Add((FT.Special, (c.Special is > 0 ? c.Special.Value : 1).ToString()));   // the desktop client always writes the special filter row
        return l;
    }

    public static FilterCriteria FromRows(IEnumerable<FilterValueRow> rows)
    {
        var c = new FilterCriteria();
        static List<int> Ints(string? v) => (v ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries).Select(x => int.TryParse(x, out var n) ? n : (int?)null).Where(x => x.HasValue).Select(x => x!.Value).ToList();
        static int? One(string? v) => Ints(v).Cast<int?>().FirstOrDefault();
        static DateRangeDto? Dr(string? v) { var p = (v ?? "").Split(';'); return p.Length >= 2 ? new DateRangeDto { From = p[0], To = p[1], Active = p.Length < 3 || p[2] == "1" } : null; }
        foreach (var r in rows)
            switch (r.IDFilterType)
            {
                case FT.Name: c.DocName = r.FValue; break;
                case FT.Id: c.DocId = r.FValue; break;
                case FT.Status: c.Statuses = Ints(r.FValue); break;
                case FT.Type: c.Types = Ints(r.FValue); break;
                case FT.Text: c.SearchText = r.FValue; break;
                case FT.Author: c.Author = One(r.FValue); break;
                case FT.Editor: c.Editor = One(r.FValue); break;
                case FT.Verifier: c.Verifier = One(r.FValue); break;
                case FT.Releaser: c.Releaser = One(r.FValue); break;
                case FT.Publisher: c.Publisher = One(r.FValue); break;
                case FT.Distributor: c.Distributor = One(r.FValue); break;
                case FT.ProcessOwner: c.ProcessOwner = One(r.FValue); break;
                case FT.Extension: c.Application = r.FValue; break;
                case FT.Language: c.Language = r.FValue; break;
                case FT.Group: c.Group = One(r.FValue); break;
                case FT.GroupTree: c.Group = One(r.FValue); c.IncludeSubgroups = true; break;
                case FT.NotLinked: c.Group = One(r.FValue); c.Unlinked = true; break;
                case FT.GroupNo: c.GroupNumber = r.FValue; break;
                case FT.Special: c.Special = One(r.FValue); break;
                case FT.Created: c.Created = Dr(r.FValue); break;
                case FT.Edited: c.Edited = Dr(r.FValue); break;
                case FT.Released: c.Released = Dr(r.FValue); break;
                case FT.Published: c.Published = Dr(r.FValue); break;
                case FT.Expired: c.Expired = Dr(r.FValue); break;
            }
        return c;
    }

    /// WHERE fragment (starts with " AND ") for Documents d, plus its parameters. Numbers are inserted as validated integers.
    public static async Task<(string sql, DynamicParameters p)> Build(SqlConnection con, FilterCriteria c, string? lang)
    {
        var sb = new StringBuilder(); var p = new DynamicParameters(); var n = 0;
        string Prm(object v) { var k = "f" + n++; p.Add(k, v); return "@" + k; }
        static string In(IEnumerable<int> ids) { var a = ids.Distinct().ToArray(); return a.Length == 0 ? "(NULL)" : "(" + string.Join(",", a) + ")"; }
        string? Like(string? v) => string.IsNullOrWhiteSpace(v) ? null : "%" + v.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

        if (Like(c.DocName) is { } nm) sb.Append($" AND d.DocName LIKE {Prm(nm)} ESCAPE '\\'");
        if (!string.IsNullOrWhiteSpace(c.DocId))
        {
            var ids = c.DocId.Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries).Select(x => int.TryParse(x, out var i) ? (int?)i : null).Where(x => x.HasValue).Select(x => x!.Value).ToList();
            sb.Append($" AND d.IDDoc IN {In(ids)}");
        }
        if (c.Statuses is { Count: > 0 }) sb.Append($" AND d.[Status] IN {In(c.Statuses)}");
        if (c.Types is { Count: > 0 }) sb.Append($" AND d.[Type] IN {In(c.Types)}");
        if (!string.IsNullOrWhiteSpace(c.SearchText))
            foreach (var w in c.SearchText.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                sb.Append($" AND d.DocName LIKE {Prm(Like(w)!)} ESCAPE '\\'");     // text inside the files is not searchable in the web app: name only
        if (c.Author is > 0) sb.Append($" AND d.IdCre = {c.Author}");
        if (c.Editor is > 0) sb.Append($" AND d.IdMod = {c.Editor}");
        if (c.Verifier is > 0) sb.Append($" AND d.IdPrv = {c.Verifier}");
        if (c.Releaser is > 0) sb.Append($" AND d.IdRel = {c.Releaser}");
        if (c.Publisher is > 0) sb.Append($" AND d.IdPub = {c.Publisher}");
        if (c.Distributor is > 0) sb.Append($" AND EXISTS (SELECT 1 FROM DocMailList ml WHERE ml.IDDoc = d.IDDoc AND ml.IDML = {c.Distributor})");
        if (c.ProcessOwner is > 0) sb.Append($" AND (d.IDProcessOwner = {c.ProcessOwner} OR EXISTS (SELECT 1 FROM DocGrp dg JOIN Groups g ON g.IDGroup = dg.IdGroup AND g.Lang = d.Lang WHERE dg.IdDoc = d.IDDoc AND g.IDProcessOwner = {c.ProcessOwner}))");
        if (!string.IsNullOrWhiteSpace(c.Application))
        { var e = c.Application.Trim().TrimStart('.'); sb.Append($" AND d.Extension IN ({Prm("." + e)}, {Prm(e)})"); }
        if (!string.IsNullOrWhiteSpace(c.Language)) sb.Append($" AND d.LangStandard = {Prm(c.Language.Trim().ToUpperInvariant())}");
        if (c.Group is > 0)
        {
            var all = await Access.Groups(con, string.IsNullOrWhiteSpace(lang) ? "EN" : lang);
            var set = c.IncludeSubgroups || c.Unlinked ? Access.Descendants(all, new[] { c.Group.Value }) : new HashSet<int> { c.Group.Value };
            var ex = $"EXISTS (SELECT 1 FROM DocGrp g WHERE g.IdDoc = d.IDDoc AND g.IdGroup IN {In(set)})";
            sb.Append(c.Unlinked ? $" AND NOT {ex}" : $" AND {ex}");
        }
        if (!string.IsNullOrWhiteSpace(c.GroupNumber))
        {
            var digits = new string(c.GroupNumber.Where(char.IsDigit).ToArray());
            if (int.TryParse(digits, out var gno)) sb.Append($" AND EXISTS (SELECT 1 FROM DocGrp g2 WHERE g2.IdDoc = d.IDDoc AND g2.IdGroup = {gno})");
        }
        if (c.Special is > 1) sb.Append(" AND " + SpecialSql(c.Special.Value));
        void Dt(DateRangeDto? r, string col, string extra = "")
        {
            if (r is not { Active: true }) return;
            if (!DateTime.TryParse(r.From, CultureInfo.InvariantCulture, DateTimeStyles.None, out var f) || !DateTime.TryParse(r.To, CultureInfo.InvariantCulture, DateTimeStyles.None, out var t)) return;
            sb.Append($" AND {col} >= {Prm(f.Date)} AND {col} < {Prm(t.Date.AddDays(1))}{extra}");
        }
        Dt(c.Created, "d.DateCre"); Dt(c.Edited, "d.DateMod", " AND d.[Status] <> 1 AND d.DateMod <> d.DateCre");   // same rule as the legacy edit-date filter
        Dt(c.Released, "d.DateRel"); Dt(c.Published, "d.DatePub"); Dt(c.Expired, "d.DateExp");
        return (sb.ToString(), p);
    }
}

[ApiController, Route("api/lds/filters"), Authorize]
public class FiltersController(IConfiguration cfg) : ControllerBase
{
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));

    static object Head(FilterHead f, int acc) => new { idFilter = f.IDFilter, name = f.FilterName, general = f.IsPublish ?? false, web = f.IsWeb ?? false, mine = f.IDAccount == acc };

    /// Own filters plus general filters, sorted alphabetically (manual: filter names are sorted alphabetically).
    [HttpGet]
    public async Task<IActionResult> List()
    {
        await using var con = Con();
        var rows = await con.QueryAsync<FilterHead>("SELECT IDFilter, FilterName, IDAccount, isPublish AS IsPublish, isWeb AS IsWeb FROM Filter WHERE IDAccount = @acc OR ISNULL(isPublish, 0) = 1 ORDER BY FilterName", new { acc = Acc });
        return Ok(rows.OrderBy(r => r.FilterName, StringComparer.CurrentCultureIgnoreCase).Select(r => Head(r, Acc)));
    }

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Get(int id)
    {
        await using var con = Con();
        var f = await con.QueryFirstOrDefaultAsync<FilterHead>("SELECT IDFilter, FilterName, IDAccount, isPublish AS IsPublish, isWeb AS IsWeb FROM Filter WHERE IDFilter = @id AND (IDAccount = @acc OR ISNULL(isPublish, 0) = 1)", new { id, acc = Acc });
        if (f is null) return NotFound(new { error = "Filter not found." });
        var vals = await con.QueryAsync<FilterValueRow>("SELECT IDFilterType, fValue AS FValue FROM FilterValue WHERE IDFilter = @id", new { id });
        return Ok(new { head = Head(f, Acc), criteria = FilterSql.FromRows(vals) });
    }

    [HttpGet("options")]
    public async Task<IActionResult> Options([FromQuery] string lang = "EN")
    {
        await using var con = Con();
        var ui = Ui.Lang(Request);   // status and type names follow the interface language, the rest (accounts, folders) the document language
        var statuses = (await con.QueryAsync<IdName>("SELECT IDStatus AS Id, StatusDesc AS Name FROM [Status] WHERE Lang = @ui ORDER BY IDStatus", new { ui })).ToList();
        if (statuses.Count == 0) statuses = (await con.QueryAsync<IdName>("SELECT IDStatus AS Id, StatusDesc AS Name FROM [Status] WHERE Lang = @lang ORDER BY IDStatus", new { lang })).ToList();
        if (!statuses.Any(x => x.Id == 11)) statuses.Add(new IdName { Id = 11, Name = Ui.Frozen(ui) });   // Frozen has no row in the Status table (manual p. 163: filter for Frozen)
        var types = (await con.QueryAsync<IdName>(@"SELECT t.IDType AS Id, REPLACE(COALESCE(CASE WHEN LEFT(u.TypeDesc, 1) <> '<' THEN u.TypeDesc END, t.TypeDesc), '<DE>', '') AS Name
            FROM DocTypes t OUTER APPLY (SELECT TOP 1 TypeDesc FROM DocTypes WHERE IDType = t.IDType AND Lang = @ui) u
            WHERE t.Lang = @lang AND t.IDType IS NOT NULL", new { lang, ui })).OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        var accounts = await con.QueryAsync<IdName>("SELECT IdAcc AS Id, AccShort AS Name FROM Accounts WHERE ISNULL(IsDeleted, 0) = 0 AND AccShort IS NOT NULL ORDER BY AccShort");
        var owners = await con.QueryAsync<IdName>("SELECT IdAcc AS Id, AccShort AS Name FROM Accounts WHERE ISNULL(IsDeleted, 0) = 0 AND ISNULL(IsProcessOwner, 0) = 1 AND AccShort IS NOT NULL ORDER BY AccShort");
        var lists = await con.QueryAsync<IdName>("SELECT IDML AS Id, Name FROM MailList WHERE IDML IS NOT NULL ORDER BY Name");
        var exts = await con.QueryAsync<string>("SELECT DISTINCT Extension FROM Documents WHERE Extension IS NOT NULL AND Extension <> '' ORDER BY Extension");
        var langs = await con.QueryAsync<StrName>("SELECT Lang AS Id, Languags AS Name FROM Lang WHERE ISNULL(isactive, 0) = 1 ORDER BY Lang");
        var groups = (await Access.Groups(con, lang)).Select(g => new { id = g.IDGroup, parent = g.IDParent, name = g.GroupDesc });
        return Ok(new { statuses, types, accounts, owners, mailLists = lists, extensions = exts, languages = langs, groups, specials = FilterSql.Specials.Select(s => new { id = s.Id, name = s.Name }) });
    }

    static string? Validate(FilterBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) return "Please enter a filter name.";
        if (b.Name.Trim().Length > 100) return "The filter name may have at most 100 characters.";
        if (b.Web && !b.General) return "Only a general filter can be set as web publishing filter.";
        return null;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] FilterBody b)
    {
        if (Validate(b) is { } e) return BadRequest(new { error = e });
        await using var con = Con(); await con.OpenAsync();
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Filter WITH (UPDLOCK, HOLDLOCK) WHERE UPPER(LTRIM(RTRIM(FilterName))) = UPPER(@n) AND (IDAccount = @acc OR ISNULL(isPublish,0) = 1)", new { n = b.Name!.Trim(), acc = Acc }, tx) > 0)
            { await tx.RollbackAsync(); return Conflict(new { error = "A filter with this name already exists." }); }
            var id = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDFilter), 0) + 1 FROM Filter WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
            await con.ExecuteAsync("INSERT INTO Filter (IDFilter, FilterName, IDAccount, isPublish, isWeb) VALUES (@id, @n, @acc, @g, @w)", new { id, n = b.Name!.Trim(), acc = Acc, g = b.General, w = b.Web && b.General }, tx);
            await Rows(con, tx, id, b.Criteria ?? new());
            await tx.CommitAsync();
            return Ok(new { idFilter = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return StatusCode(403, new { error = "The database login may not write Filter/FilterValue (needs INSERT, UPDATE, DELETE). " + ex.Message }); }
        catch { await tx.RollbackAsync(); throw; }
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, [FromBody] FilterBody b)
    {
        if (Validate(b) is { } e) return BadRequest(new { error = e });
        await using var con = Con(); await con.OpenAsync();
        var f = await con.QueryFirstOrDefaultAsync<FilterHead>("SELECT IDFilter, IDAccount, isPublish AS IsPublish FROM Filter WHERE IDFilter = @id", new { id });
        if (f is null) return NotFound(new { error = "Filter not found." });
        if (f.IDAccount != Acc && f.IsPublish != true) return StatusCode(403, new { error = "This filter belongs to another user." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Filter WHERE IDFilter <> @id AND UPPER(LTRIM(RTRIM(FilterName))) = UPPER(@n) AND (IDAccount = @acc OR ISNULL(isPublish,0) = 1)", new { id, n = b.Name!.Trim(), acc = Acc }, tx) > 0)
            { await tx.RollbackAsync(); return Conflict(new { error = "A filter with this name already exists." }); }
            await con.ExecuteAsync("UPDATE Filter SET FilterName = @n, isPublish = @g, isWeb = @w WHERE IDFilter = @id", new { id, n = b.Name!.Trim(), g = b.General, w = b.Web && b.General }, tx);
            await con.ExecuteAsync("DELETE FROM FilterValue WHERE IDFilter = @id", new { id }, tx);
            await Rows(con, tx, id, b.Criteria ?? new());
            await tx.CommitAsync();
            return Ok(new { idFilter = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return StatusCode(403, new { error = "The database login may not write Filter/FilterValue (needs INSERT, UPDATE, DELETE). " + ex.Message }); }
        catch { await tx.RollbackAsync(); throw; }
    }

    static async Task Rows(SqlConnection con, System.Data.Common.DbTransaction tx, int id, FilterCriteria c)
    {
        foreach (var (type, value) in FilterSql.ToRows(c))
            await con.ExecuteAsync("INSERT INTO FilterValue (IDFilter, IDFilterType, fValue) VALUES (@id, @type, @value)", new { id, type, value }, tx);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        var f = await con.QueryFirstOrDefaultAsync<FilterHead>("SELECT IDFilter, IDAccount, isPublish AS IsPublish FROM Filter WHERE IDFilter = @id", new { id });
        if (f is null) return NotFound(new { error = "Filter not found." });
        if (f.IDAccount != Acc && f.IsPublish != true) return StatusCode(403, new { error = "This filter belongs to another user." });
        await using var tx = await con.BeginTransactionAsync();
        try
        {
            await con.ExecuteAsync("DELETE FROM FilterValue WHERE IDFilter = @id", new { id }, tx);
            await con.ExecuteAsync("DELETE FROM Filter WHERE IDFilter = @id", new { id }, tx);
            await tx.CommitAsync();
            return Ok(new { deleted = id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 230) { await tx.RollbackAsync(); return StatusCode(403, new { error = "The database login may not delete from Filter/FilterValue. " + ex.Message }); }
        catch { await tx.RollbackAsync(); throw; }
    }

    /// "Verify" button: how many documents (visible to this user) match the criteria on the screen.
    [HttpPost("verify")]
    public async Task<IActionResult> Verify([FromBody] FilterBody b)
    {
        var lang = string.IsNullOrWhiteSpace(b.Lang) ? "EN" : b.Lang!;
        await using var con = Con();
        var vis = await Access.VisibleSql(con, Acc, lang);
        var (sql, p) = await FilterSql.Build(con, b.Criteria ?? new(), lang);
        var n = await con.ExecuteScalarAsync<int>($"SELECT COUNT(*) FROM Documents d WHERE ISNULL(d.LAIgnore, 0) = 0 AND d.Lang = @lang AND {vis}{sql}", AddLang(p, lang));
        return Ok(new { count = n });
    }
    static DynamicParameters AddLang(DynamicParameters p, string lang) { p.Add("lang", lang); return p; }
}
