using System.Globalization;
using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api.Controllers;

// ───────────────────────────── bodies ─────────────────────────────
public class WfStepBody
{
    public int Id { get; set; }                 // 0 = new step
    public string? Name { get; set; }
    public int Layer { get; set; }              // 1 Edit, 2 Verify, 3 Release, 4 Publish
    public int Editor { get; set; }             // Accounts.IdAcc
    public int UserGroup { get; set; }          // AccGroups.IdAccGroup, 0 = none
    public int Days { get; set; }               // processing time 0..100
    public string? Description { get; set; }
}
public class WfBody
{
    public string? Name { get; set; }
    public bool Active { get; set; } = true;
    public string? Description { get; set; }
    public List<int>? DocTypes { get; set; }
    public List<int>? UserGroups { get; set; }
    public List<int>? Groups { get; set; }
    public List<WfStepBody>? Steps { get; set; }
}
public class WfStartBody { public string? Lang { get; set; } public int CycleId { get; set; } public int NextMoveId { get; set; } public int EditorId { get; set; } public DateTime? Due { get; set; } public string? Remark { get; set; } }
public class WfAdvanceBody { public string? Lang { get; set; } public int TaskId { get; set; } public string? Action { get; set; } public int NextMoveId { get; set; } public int EditorId { get; set; } public DateTime? Due { get; set; } public string? Remark { get; set; } }
public class WfRemoveBody { public string? Lang { get; set; } public string? Reason { get; set; } }

// ───────────────────────────── rows ─────────────────────────────
public class CycRow { public int IdCycle { get; set; } public bool? IsActiv { get; set; } public string? CycleName { get; set; } public string? CycleDescription { get; set; } public int? IdCycMoveStart { get; set; } }
public class MoveRow
{
    public int IdCycle { get; set; } public int IdCycMove { get; set; } public int? IdAccount { get; set; } public string? CycMoveName { get; set; } public string? CycMoveDescription { get; set; }
    public bool? IsActiv { get; set; } public bool? IsStartPunkt { get; set; } public int? CycMoveLayer { get; set; } public int? NoOfDays { get; set; } public int? IdCycMoveNext { get; set; } public int? IdAccGroup { get; set; }
}
public class TaskRow
{
    public int IDTask { get; set; } public int IDCycle { get; set; } public int IDDoc { get; set; } public string? Lang { get; set; } public int? IDStart { get; set; } public DateTime? DateStart { get; set; }
    public int? IDCycMove { get; set; } public DateTime? DateEnd { get; set; } public int? IDExp { get; set; } public DateTime? DateExp { get; set; } public int? ProcentExp { get; set; } public string? Description { get; set; }
    public int? IdWF { get; set; }
}
public class WfPair { public int A { get; set; } public int B { get; set; } }
public class WfMyTask
{
    public int IDTask { get; set; } public int IDDoc { get; set; } public string Lang { get; set; } = ""; public DateTime? DateStart { get; set; } public DateTime? DateEnd { get; set; } public string? Description { get; set; }
    public string? CycleName { get; set; } public string? CycMoveName { get; set; } public int Layer { get; set; } public string? DocName { get; set; } public int Status { get; set; }
    public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } public string? StatusName { get; set; } public string? StartedBy { get; set; } public string? Extension { get; set; }
}
public class WfMailTestBody { public string? Lang { get; set; } }
public class WfName { public int Id { get; set; } public string? Name { get; set; } }
public class WfGroupRow { public int IDGroup { get; set; } public int IDParent { get; set; } public string? GroupDesc { get; set; } }
public class WfDocRow { public string? DocName { get; set; } public int Status { get; set; } public int? Type { get; set; } public bool? IsCycle { get; set; } public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } }

/// Options > Workflow management (manual p. 67-72) and the document workflow itself (right click > Workflow / Remove from workflow,
/// "My tasks"). Tables (all used as in the legacy product, no change to the schema):
///   Cycles(IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart)            the workflow
///   CycleMoves(IdCycle, IdCycMove, IdAccount, CycMoveName, CycMoveDescription, IsActiv, IsStartPunkt, CycMoveLayer, NoOfDays, IdCycMoveNext, IdAccGroup)   its steps
///   CycleGroup(IdCycle, IdGroup)                  folders the workflow is valid for
///   CycleMoveDocType(IdCycMove, IDType)           document types (IdCycMove holds the workflow id, as in the legacy getCycleDocType(IDC))
///   CycleMoveAccGrp(IdCycMove, IdAccGroup)        user groups (IdCycMove holds the workflow id, as in the legacy getCycleAccountGrp)
///   CycleTasks(...)                               the running tasks of a document (one row per step, ProcentExp 10 = done, 0 = open)
///   CycleTasksHistory(IdWF, ...)                  finished or removed runs
/// Step layers: 1 Edit, 2 Verify, 3 Release, 4 Publish. Rights: 23 Workflow Management (administer), 40 Use Workflow (document menu).
[ApiController, Route("api/lds"), Authorize]
public class WorkflowMgmtController(IConfiguration cfg, MailService mailSvc, DocPublisher publisher, ILogger<WorkflowMgmtController> log) : ControllerBase
{
    const int RightWfAdmin = 23, RightUseWf = 40;
    const int Done = 10;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    SqlConnection Con() => new(cfg.GetConnectionString("Lds"));
    static string L(string? l) => string.IsNullOrWhiteSpace(l) ? "EN" : l.Trim().ToUpperInvariant();
    static IActionResult Err(int code, string msg) => new ObjectResult(new { error = msg }) { StatusCode = code };
    static IActionResult Denied(SqlException e) => Err(403, "The database login may not write the workflow tables (needs INSERT, UPDATE, DELETE on Cycles, CycleMoves, CycleGroup, CycleMoveAccGrp, CycleMoveDocType, CycleTasks, CycleTasksHistory; see sql/grant-pl_app.sql). " + e.Message);
    static readonly string[] LayerEn = ["", "Edit", "Verify", "Release", "Publish"];
    static int StatusOfLayer(int layer) => layer switch { 1 => 2, 2 => 7, 3 => 8, 4 => 3, _ => 0 };   // Edit, Verified, Released, Published

    record Perm(bool Admin, bool WfAdmin, bool Use);
    async Task<Perm> Perms(SqlConnection con)
    {
        var r = await Access.Rights(con, Acc);
        var admin = Access.IsAdmin(r);
        return new Perm(admin, admin || r.Any(x => x.RCod == RightWfAdmin), admin || r.Any(x => x.RCod == RightUseWf));
    }
    static async Task<bool> Enabled(SqlConnection con) =>
        (await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = 'IsWorkflowEnabled'"))?.Trim() is not ("0" or "False" or "false");

    /// Switch for the whole feature (Config IsWorkflowEnabled; on when missing) and what the user may do.
    [HttpGet("workflow/config")]
    public async Task<IActionResult> GetConfig()
    {
        await using var con = Con();
        var p = await Perms(con);
        var on = await Enabled(con);
        return Ok(new { enabled = on, canManage = on && p.WfAdmin, canUse = on && p.Use });
    }

    string[] LayerNames(string lang, Dictionary<int, string> st) => Enumerable.Range(0, 5).Select(i => i == 0 ? "" : st.GetValueOrDefault(StatusOfLayer(i), LayerEn[i])).ToArray();
    async Task<string[]> Layers(SqlConnection con, string lang)
    {
        var rows = await con.QueryAsync<WfName>("SELECT IDStatus AS Id, StatusDesc AS Name FROM [Status] WHERE Lang = @lang AND IDStatus IN (2, 7, 8, 3)", new { lang });
        return LayerNames(lang, rows.ToDictionary(r => r.Id, r => r.Name ?? ""));
    }

    // ═════════════════════════ administration ═════════════════════════
    async Task<IActionResult?> NeedAdmin(SqlConnection con)
    {
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        return (await Perms(con)).WfAdmin ? null : Err(403, "You need the 'Workflow Management' right.");
    }

    [HttpGet("workflows")]
    public async Task<IActionResult> List()
    {
        await using var con = Con();
        if (await NeedAdmin(con) is { } e) return e;
        var cyc = (await con.QueryAsync<CycRow>("SELECT IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart FROM Cycles ORDER BY CycleName, IdCycle")).ToList();
        var steps = (await con.QueryAsync<WfPair>("SELECT IdCycle AS A, COUNT(*) AS B FROM CycleMoves GROUP BY IdCycle")).ToDictionary(x => x.A, x => x.B);
        var used = (await con.QueryAsync<WfPair>("SELECT IDCycle AS A, COUNT(DISTINCT CONCAT(IDDoc, Lang)) AS B FROM CycleTasks GROUP BY IDCycle")).ToDictionary(x => x.A, x => x.B);
        return Ok(new { items = cyc.Select(c => new { id = c.IdCycle, name = c.CycleName ?? "", active = c.IsActiv ?? false, steps = steps.GetValueOrDefault(c.IdCycle), documents = used.GetValueOrDefault(c.IdCycle) }) });
    }

    /// Values for the drop-downs of the Workflow Management screen.
    [HttpGet("workflows/options")]
    public async Task<IActionResult> Options([FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (await NeedAdmin(con) is { } e) return e;
        var types = await con.QueryAsync<WfName>("SELECT IDType AS Id, REPLACE(TypeDesc, '<DE>', '') AS Name FROM DocTypes WHERE Lang = @lang ORDER BY TypeDesc", new { lang });
        var ugroups = await con.QueryAsync<WfName>("SELECT IdAccGroup AS Id, AccGroup AS Name FROM AccGroups ORDER BY AccGroup");
        var users = await con.QueryAsync<WfName>(@"SELECT a.IdAcc AS Id, CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE CONCAT(e.Name, ' [', a.AccShort, ']') END AS Name
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE ISNULL(a.IsDeleted, 0) = 0 AND ISNULL(a.AccInactive, 0) = 0 ORDER BY 2");
        var groups = await FolderPaths(con, lang);
        return Ok(new
        {
            docTypes = types.Select(t => new { id = t.Id, name = t.Name }), userGroups = ugroups.Select(t => new { id = t.Id, name = t.Name }),
            users = users.Select(t => new { id = t.Id, name = t.Name }), groups = groups.Select(g => new { id = g.Key, name = g.Value }),
            layers = Enumerable.Range(1, 4).Select(i => new { id = i, name = LayerEn[i] })
        });
    }

    /// Folder id -> "Parent / Child" path (standards, GroupType 1, are not folders).
    static async Task<Dictionary<int, string>> FolderPaths(SqlConnection con, string lang)
    {
        var rows = (await con.QueryAsync<WfGroupRow>("SELECT IDGroup, ISNULL(IDParent, 0) AS IDParent, GroupDesc FROM Groups WHERE Lang = @lang AND ISNULL(GroupType, 0) <> 1", new { lang })).ToList();
        var by = rows.GroupBy(r => r.IDGroup).ToDictionary(g => g.Key, g => g.First());
        string Path(int id, int guard = 0)
        {
            if (!by.TryGetValue(id, out var r)) return "";
            var name = Plain(r.GroupDesc);
            return r.IDParent != 0 && guard < 30 && by.ContainsKey(r.IDParent) ? Path(r.IDParent, guard + 1) + " / " + name : name;
        }
        return by.Keys.ToDictionary(k => k, k => Path(k)).OrderBy(x => x.Value, StringComparer.CurrentCultureIgnoreCase).ToDictionary(x => x.Key, x => x.Value);
    }
    static string Plain(string? s) => s is { Length: > 4 } && s[0] == '<' && s[3] == '>' ? s[4..] : s ?? "";

    /// Steps in running order: the chain from the start step along IdCycMoveNext, any step not on the chain follows.
    static List<MoveRow> Ordered(CycRow c, List<MoveRow> moves)
    {
        var by = moves.ToDictionary(m => m.IdCycMove);
        var res = new List<MoveRow>(); var seen = new HashSet<int>();
        var cur = c.IdCycMoveStart is int s && by.ContainsKey(s) ? s : (moves.FirstOrDefault(m => m.IsStartPunkt == true)?.IdCycMove ?? 0);
        while (cur != 0 && by.TryGetValue(cur, out var m) && seen.Add(cur)) { res.Add(m); cur = m.IdCycMoveNext ?? 0; }
        res.AddRange(moves.Where(m => !seen.Contains(m.IdCycMove)).OrderBy(m => m.IdCycMove));
        return res;
    }

    [HttpGet("workflows/{id:int}")]
    public async Task<IActionResult> One(int id)
    {
        await using var con = Con();
        if (await NeedAdmin(con) is { } e) return e;
        var c = await con.QueryFirstOrDefaultAsync<CycRow>("SELECT IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart FROM Cycles WHERE IdCycle = @id", new { id });
        if (c is null) return Err(404, "This workflow no longer exists.");
        var moves = (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @id", new { id })).ToList();
        var inUse = (await con.QueryAsync<int>("SELECT DISTINCT IDCycMove FROM CycleTasks WHERE IDCycle = @id", new { id })).ToHashSet();
        return Ok(new
        {
            id = c.IdCycle, name = c.CycleName ?? "", active = c.IsActiv ?? false, description = c.CycleDescription ?? "",
            docTypes = await con.QueryAsync<int>("SELECT IDType FROM CycleMoveDocType WHERE IdCycMove = @id", new { id }),
            userGroups = await con.QueryAsync<int>("SELECT IdAccGroup FROM CycleMoveAccGrp WHERE IdCycMove = @id", new { id }),
            groups = await con.QueryAsync<int>("SELECT IdGroup FROM CycleGroup WHERE IdCycle = @id", new { id }),
            steps = Ordered(c, moves).Select(m => new
            {
                id = m.IdCycMove, name = m.CycMoveName ?? "", layer = m.CycMoveLayer ?? 1, editor = m.IdAccount ?? 0, userGroup = m.IdAccGroup ?? 0, days = m.NoOfDays ?? 0,
                description = m.CycMoveDescription ?? "", inUse = inUse.Contains(m.IdCycMove)
            })
        });
    }

    static string? Validate(WfBody b)
    {
        if (string.IsNullOrWhiteSpace(b.Name)) return "Please enter a name for the workflow.";
        if (b.Name.Trim().Length > 50) return "The workflow name can have 50 characters at most.";
        if ((b.Description ?? "").Length > 255) return "The workflow description can have 255 characters at most (the database field is limited).";
        if (b.Steps is null || b.Steps.Count == 0) return "Add at least one workflow step.";
        var n = 0;
        foreach (var s in b.Steps)
        {
            n++;
            if (string.IsNullOrWhiteSpace(s.Name)) return $"Step {n}: please enter a name.";
            if (s.Name.Trim().Length > 50) return $"Step {n}: the name can have 50 characters at most.";
            if (s.Layer is < 1 or > 4) return $"Step {n}: choose the task (Edit, Verify, Release or Publish).";
            if (s.Editor <= 0) return $"Step {n}: choose an editor.";
            if (s.Days is < 0 or > 100) return $"Step {n}: the processing time must be between 0 and 100 days.";
            if ((s.Description ?? "").Length > 255) return $"Step {n}: the description can have 255 characters at most (the database field is limited).";
        }
        return null;
    }

    static async Task<int> NextId(SqlConnection con, SqlTransaction tx, string table, string col) =>
        await con.ExecuteScalarAsync<int>($"SELECT ISNULL(MAX({col}), 0) + 1 FROM {table} WITH (UPDLOCK, HOLDLOCK)", transaction: tx);

    /// Creates (id = 0) or saves a workflow with everything on the screen in one transaction.
    async Task<IActionResult> Save(int id, WfBody b)
    {
        if (Validate(b) is { } bad) return Err(400, bad);
        await using var con = Con(); await con.OpenAsync();
        if (await NeedAdmin(con) is { } e) return e;
        var name = b.Name!.Trim();
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            if (id == 0) id = await NextId(con, tx, "Cycles", "IdCycle");
            else if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Cycles WITH (UPDLOCK) WHERE IdCycle = @id", new { id }, tx) == 0) return Err(404, "This workflow no longer exists.");
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Cycles WHERE CycleName = @name AND IdCycle <> @id", new { name, id }, tx) > 0) return Err(409, $"A workflow named '{name}' already exists.");

            var old = (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @id", new { id }, tx)).ToDictionary(m => m.IdCycMove);
            var keep = b.Steps!.Where(s => s.Id > 0 && old.ContainsKey(s.Id)).Select(s => s.Id).ToHashSet();
            if (keep.Count != b.Steps!.Count(s => s.Id > 0 && old.ContainsKey(s.Id))) return Err(400, "A step appears twice.");
            foreach (var gone in old.Keys.Where(k => !keep.Contains(k)))
                if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM CycleTasks WHERE IDCycle = @id AND IDCycMove = @gone", new { id, gone }, tx) > 0)
                    return Err(409, $"The step '{old[gone].CycMoveName}' cannot be removed: documents are in this workflow step.");

            // ids for the new steps
            var nextMove = await NextId(con, tx, "CycleMoves", "IdCycMove");
            var ids = new List<int>();
            foreach (var s in b.Steps!) ids.Add(s.Id > 0 && old.ContainsKey(s.Id) ? s.Id : nextMove++);

            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Cycles WHERE IdCycle = @id", new { id }, tx) == 0)
                await con.ExecuteAsync("INSERT INTO Cycles (IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart) VALUES (@id, @a, @name, @d, @s)", new { id, a = b.Active, name, d = (b.Description ?? "").Trim(), s = ids[0] }, tx);
            else
                await con.ExecuteAsync("UPDATE Cycles SET IsActiv = @a, CycleName = @name, CycleDescription = @d, IdCycMoveStart = @s WHERE IdCycle = @id", new { id, a = b.Active, name, d = (b.Description ?? "").Trim(), s = ids[0] }, tx);

            await con.ExecuteAsync("DELETE FROM CycleMoves WHERE IdCycle = @id AND IdCycMove NOT IN @keep", new { id, keep = keep.Count == 0 ? new List<int> { -1 } : keep.ToList() }, tx);
            for (var i = 0; i < b.Steps!.Count; i++)
            {
                var s = b.Steps[i]; var next = i + 1 < ids.Count ? ids[i + 1] : (int?)null;
                var p = new { id, mid = ids[i], acc = s.Editor, name = s.Name!.Trim(), d = (s.Description ?? "").Trim(), start = i == 0, layer = s.Layer, days = s.Days, next, grp = s.UserGroup > 0 ? s.UserGroup : 0 };
                if (old.ContainsKey(ids[i]))
                    await con.ExecuteAsync(@"UPDATE CycleMoves SET IdAccount = @acc, CycMoveName = @name, CycMoveDescription = @d, IsActiv = 1, IsStartPunkt = @start, CycMoveLayer = @layer, NoOfDays = @days, IdCycMoveNext = @next, IdAccGroup = @grp
                        WHERE IdCycle = @id AND IdCycMove = @mid", p, tx);
                else
                    await con.ExecuteAsync(@"INSERT INTO CycleMoves (IdCycle, IdCycMove, IdAccount, CycMoveName, CycMoveDescription, IsActiv, IsStartPunkt, CycMoveLayer, NoOfDays, IdCycMoveNext, IdAccGroup)
                        VALUES (@id, @mid, @acc, @name, @d, 1, @start, @layer, @days, @next, @grp)", p, tx);
            }
            await con.ExecuteAsync("DELETE FROM CycleMoveDocType WHERE IdCycMove = @id; DELETE FROM CycleMoveAccGrp WHERE IdCycMove = @id; DELETE FROM CycleGroup WHERE IdCycle = @id", new { id }, tx);
            foreach (var t in (b.DocTypes ?? []).Distinct()) await con.ExecuteAsync("INSERT INTO CycleMoveDocType (IdCycMove, IDType) VALUES (@id, @t)", new { id, t }, tx);
            foreach (var g in (b.UserGroups ?? []).Distinct()) await con.ExecuteAsync("INSERT INTO CycleMoveAccGrp (IdCycMove, IdAccGroup) VALUES (@id, @g)", new { id, g }, tx);
            foreach (var g in (b.Groups ?? []).Distinct()) await con.ExecuteAsync("INSERT INTO CycleGroup (IdCycle, IdGroup) VALUES (@id, @g)", new { id, g }, tx);
            await tx.CommitAsync();
            return Ok(new { id });
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
    }

    [HttpPost("workflows")] public Task<IActionResult> Create([FromBody] WfBody b) => Save(0, b);
    [HttpPut("workflows/{id:int}")] public Task<IActionResult> Update(int id, [FromBody] WfBody b) => Save(id, b);

    [HttpDelete("workflows/{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await using var con = Con(); await con.OpenAsync();
        if (await NeedAdmin(con) is { } e) return e;
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM CycleTasks WHERE IDCycle = @id", new { id }) > 0)
            return Err(409, "Documents are in this workflow. Remove them from the workflow first (document menu > Remove from workflow).");
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            await con.ExecuteAsync("DELETE FROM CycleMoveDocType WHERE IdCycMove = @id; DELETE FROM CycleMoveAccGrp WHERE IdCycMove = @id; DELETE FROM CycleGroup WHERE IdCycle = @id; DELETE FROM CycleMoves WHERE IdCycle = @id; DELETE FROM Cycles WHERE IdCycle = @id", new { id }, tx);
            await tx.CommitAsync();
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
        return Ok(new { removed = id });
    }

    // ═════════════════════════ running a workflow ═════════════════════════
    async Task<(WfDocRow? d, IActionResult? err)> LoadDoc(SqlConnection con, int id, string lang)
    {
        var vis = await Access.VisibleSql(con, Acc, lang);
        var d = await con.QueryFirstOrDefaultAsync<WfDocRow>($"SELECT d.DocName, d.[Status], d.[Type], d.IsCycle, d.V1, d.V2, d.V3 FROM Documents d WHERE d.IDDoc = @id AND d.Lang = @lang AND {vis}", new { id, lang });
        return d is null ? (null, Err(404, "Document not found.")) : (d, null);
    }

    static string Version(WfDocRow d) => $"{d.V1 ?? 0}.{d.V2 ?? 0}.{d.V3 ?? 0}";

    async Task<Dictionary<int, string>> Names(SqlConnection con, IEnumerable<int> ids, SqlTransaction? tx = null)
    {
        var list = ids.Where(i => i > 0).Distinct().ToList();
        if (list.Count == 0) return new();
        var rows = await con.QueryAsync<WfName>(@"SELECT a.IdAcc AS Id, CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE e.Name END AS Name
            FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc IN @list", new { list }, tx);
        return rows.ToDictionary(r => r.Id, r => r.Name ?? "");
    }

    /// People who can take a step: its editor and the members of its user group.
    async Task<Dictionary<int, List<WfName>>> Candidates(SqlConnection con, List<MoveRow> moves, SqlTransaction? tx = null)
    {
        var res = new Dictionary<int, List<WfName>>();
        if (moves.Count == 0) return res;
        var accs = moves.Where(m => (m.IdAccount ?? 0) > 0).Select(m => m.IdAccount!.Value).ToList();
        var grps = moves.Where(m => (m.IdAccGroup ?? 0) > 0).Select(m => m.IdAccGroup!.Value).Distinct().ToList();
        var members = grps.Count == 0 ? new List<WfPair>() : (await con.QueryAsync<WfPair>("SELECT IdAccGroup AS A, IdAcc AS B FROM AccountAccGrp WHERE IdAccGroup IN @grps", new { grps }, tx)).ToList();
        var names = await Names(con, accs.Concat(members.Select(x => x.B)), tx);
        var active = (await con.QueryAsync<int>("SELECT IdAcc FROM Accounts WHERE ISNULL(IsDeleted, 0) = 0 AND ISNULL(AccInactive, 0) = 0", transaction: tx)).ToHashSet();
        foreach (var m in moves)
        {
            var l = new List<WfName>();
            if ((m.IdAccount ?? 0) > 0 && active.Contains(m.IdAccount!.Value)) l.Add(new WfName { Id = m.IdAccount.Value, Name = names.GetValueOrDefault(m.IdAccount.Value, "") });
            foreach (var x in members.Where(x => x.A == (m.IdAccGroup ?? -1) && active.Contains(x.B) && l.All(y => y.Id != x.B))) l.Add(new WfName { Id = x.B, Name = names.GetValueOrDefault(x.B, "") });
            res[m.IdCycMove] = l;
        }
        return res;
    }

    /// Workflows this user may start for this document: active, with steps, and matching document type, user group and folders when those lists are filled in.
    async Task<List<CycRow>> EligibleCycles(SqlConnection con, int id, string lang, WfDocRow d, Perm p, SqlTransaction? tx = null)
    {
        var all = (await con.QueryAsync<CycRow>("SELECT IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart FROM Cycles WHERE ISNULL(IsActiv, 0) = 1 AND IdCycle IN (SELECT IdCycle FROM CycleMoves WHERE ISNULL(IsActiv, 1) = 1) ORDER BY CycleName", transaction: tx)).ToList();
        if (p.Admin) return all;     // administrators see every active workflow
        var myGroups = (await con.QueryAsync<int>("SELECT IdAccGroup FROM AccountAccGrp WHERE IdAcc = @a", new { a = Acc }, tx)).ToHashSet();
        var folders = (await con.QueryAsync<WfGroupRow>("SELECT DISTINCT IDGroup, ISNULL(IDParent, 0) AS IDParent FROM Groups WHERE ISNULL(GroupType, 0) <> 1", transaction: tx)).ToDictionary(g => g.IDGroup, g => g.IDParent);
        var docFolders = (await con.QueryAsync<int>("SELECT IdGroup FROM DocGrp WHERE IdDoc = @id", new { id }, tx)).Where(folders.ContainsKey).ToList();
        var dt = (await con.QueryAsync<WfPair>("SELECT IdCycMove AS A, IDType AS B FROM CycleMoveDocType", transaction: tx)).ToLookup(x => x.A, x => x.B);
        var ug = (await con.QueryAsync<WfPair>("SELECT IdCycMove AS A, IdAccGroup AS B FROM CycleMoveAccGrp", transaction: tx)).ToLookup(x => x.A, x => x.B);
        var cg = (await con.QueryAsync<WfPair>("SELECT IdCycle AS A, IdGroup AS B FROM CycleGroup", transaction: tx)).ToLookup(x => x.A, x => x.B);
        bool Inside(int g, HashSet<int> roots) { for (var n = 0; n < 40 && g != 0; n++) { if (roots.Contains(g)) return true; g = folders.GetValueOrDefault(g); } return false; }
        return all.Where(c =>
        {
            var t = dt[c.IdCycle].ToList(); if (t.Count > 0 && !t.Contains(d.Type ?? -1)) return false;
            var g = ug[c.IdCycle].ToList(); if (g.Count > 0 && !g.Any(myGroups.Contains)) return false;
            var f = cg[c.IdCycle].ToHashSet(); if (f.Count > 0 && (docFolders.Count == 0 || !docFolders.All(x => Inside(x, f)))) return false;
            return true;
        }).ToList();
    }

    async Task<List<TaskRow>> RunTasks(SqlConnection con, int id, string lang, SqlTransaction? tx = null) =>
        (await con.QueryAsync<TaskRow>("SELECT * FROM CycleTasks WHERE IDDoc = @id AND Lang = @lang ORDER BY IDTask", new { id, lang }, tx)).ToList();

    static TaskRow? Open(List<TaskRow> t) => t.LastOrDefault(x => (x.ProcentExp ?? 0) < Done);

    object StepDto(MoveRow m, Dictionary<int, List<WfName>> cand, string[] layers) => new
    {
        id = m.IdCycMove, name = m.CycMoveName ?? "", layer = m.CycMoveLayer ?? 1, layerName = layers[Math.Clamp(m.CycMoveLayer ?? 1, 1, 4)], days = m.NoOfDays ?? 0,
        description = m.CycMoveDescription ?? "", editor = m.IdAccount ?? 0, candidates = cand.GetValueOrDefault(m.IdCycMove)?.Select(c => new { id = c.Id, name = c.Name }) ?? []
    };

    /// Everything the workflow window needs for one document.
    [HttpGet("documents/{id:int}/workflow")]
    public async Task<IActionResult> State(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        var p = await Perms(con);
        if (!p.Use) return Err(403, "You need the 'Use Workflow' right.");
        var (d, err) = await LoadDoc(con, id, lang); if (err is not null) return err;
        var layers = await Layers(con, lang);
        var tasks = await RunTasks(con, id, lang);
        var doc = new { id, name = d!.DocName, status = d.Status, version = Version(d), type = d.Type };
        if (tasks.Count == 0)
        {
            var cycles = await EligibleCycles(con, id, lang, d, p);
            var moves = cycles.Count == 0 ? new List<MoveRow>() : (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle IN @ids AND ISNULL(IsActiv, 1) = 1", new { ids = cycles.Select(c => c.IdCycle).ToList() })).ToList();
            var cand = await Candidates(con, moves);
            // the "choose workflow" screen can be filtered by document type, user group and folder (manual p. 120-122)
            var cids = cycles.Select(c => c.IdCycle).ToList();
            var aDt = cids.Count == 0 ? new List<WfPair>() : (await con.QueryAsync<WfPair>("SELECT IdCycMove AS A, IDType AS B FROM CycleMoveDocType WHERE IdCycMove IN @cids", new { cids })).ToList();
            var aUg = cids.Count == 0 ? new List<WfPair>() : (await con.QueryAsync<WfPair>("SELECT IdCycMove AS A, IdAccGroup AS B FROM CycleMoveAccGrp WHERE IdCycMove IN @cids", new { cids })).ToList();
            var aGr = cids.Count == 0 ? new List<WfPair>() : (await con.QueryAsync<WfPair>("SELECT IdCycle AS A, IdGroup AS B FROM CycleGroup WHERE IdCycle IN @cids", new { cids })).ToList();
            var tIds = aDt.Select(x => x.B).Distinct().ToList(); var uIds = aUg.Select(x => x.B).Distinct().ToList(); var gIds = aGr.Select(x => x.B).Distinct().ToList();
            var tNames = tIds.Count == 0 ? new List<WfName>() : (await con.QueryAsync<WfName>("SELECT IDType AS Id, REPLACE(TypeDesc, '<DE>', '') AS Name FROM DocTypes WHERE Lang = @lang AND IDType IN @tIds ORDER BY TypeDesc", new { lang, tIds })).ToList();
            var uNames = uIds.Count == 0 ? new List<WfName>() : (await con.QueryAsync<WfName>("SELECT IdAccGroup AS Id, AccGroup AS Name FROM AccGroups WHERE IdAccGroup IN @uIds ORDER BY AccGroup", new { uIds })).ToList();
            var fAll = await FolderPaths(con, lang);
            return Ok(new
            {
                inWorkflow = false, doc, canStart = d.Status is not (9 or 11 or 5) && !(d.IsCycle ?? false),
                filters = new
                {
                    docTypes = tNames.Select(x => new { id = x.Id, name = x.Name }), userGroups = uNames.Select(x => new { id = x.Id, name = x.Name }),
                    groups = gIds.Where(fAll.ContainsKey).Select(g => new { id = g, name = fAll[g] }).OrderBy(x => x.name)
                },
                cycles = cycles.Select(c =>
                {
                    var ms = Ordered(c, moves.Where(m => m.IdCycle == c.IdCycle).ToList());
                    var start = ms.FirstOrDefault(m => m.IdCycMove == c.IdCycMoveStart && (m.IsStartPunkt ?? false));
                    var nextDef = start?.IdCycMove ?? ms.FirstOrDefault()?.IdCycMove ?? 0; // any step, the first one preselected
                    return new { id = c.IdCycle, name = c.CycleName ?? "", description = c.CycleDescription ?? "", startStep = start?.IdCycMove ?? 0, nextDefault = nextDef,
                        docTypes = aDt.Where(x => x.A == c.IdCycle).Select(x => x.B), userGroups = aUg.Where(x => x.A == c.IdCycle).Select(x => x.B), groups = aGr.Where(x => x.A == c.IdCycle).Select(x => x.B), steps = ms.Select(m => StepDto(m, cand, layers)) };
                })
            });
        }
        var cur = Open(tasks); var cycId = tasks[^1].IDCycle;
        var cyc = await con.QueryFirstOrDefaultAsync<CycRow>("SELECT IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart FROM Cycles WHERE IdCycle = @cycId", new { cycId });
        var all = (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @cycId", new { cycId })).ToList();
        var ordered = cyc is null ? all : Ordered(cyc, all);
        var cands = await Candidates(con, all.Where(m => m.IsActiv != false).ToList());
        var names = await Names(con, tasks.SelectMany(t => new[] { t.IDStart ?? 0, t.IDExp ?? 0 }));
        var curMove = cur is null ? null : all.FirstOrDefault(m => m.IdCycMove == cur.IDCycMove);
        var prev = cur is null ? null : tasks.LastOrDefault(t => t.IDTask < cur.IDTask && (t.ProcentExp ?? 0) >= Done);
        var canAct = cur is not null && (cur.IDExp == Acc || p.WfAdmin);
        var starter = tasks[0].IDStart ?? 0;
        var chainNext = curMove?.IdCycMoveNext ?? 0;
        return Ok(new
        {
            inWorkflow = true, doc, cycle = new { id = cycId, name = cyc?.CycleName ?? $"#{cycId}", description = cyc?.CycleDescription ?? "" },
            current = cur is null ? null : new
            {
                taskId = cur.IDTask, moveId = cur.IDCycMove ?? 0, step = curMove?.CycMoveName ?? "", layer = curMove?.CycMoveLayer ?? 1, layerName = layers[Math.Clamp(curMove?.CycMoveLayer ?? 1, 1, 4)],
                stepDescription = curMove?.CycMoveDescription ?? "", assigneeId = cur.IDExp ?? 0, assignee = names.GetValueOrDefault(cur.IDExp ?? 0, ""), startedById = cur.IDStart ?? 0,
                startedBy = names.GetValueOrDefault(cur.IDStart ?? 0, ""), dateStart = cur.DateStart, due = cur.DateEnd, remark = cur.Description ?? "", overdue = cur.DateEnd is { } de && de.Date < DateTime.Today,
                expectedStatus = StatusOfLayer(curMove?.CycMoveLayer ?? 1), isLast = chainNext == 0
            },
            canAct, canRemove = p.Use && (p.WfAdmin || starter == Acc || cur?.IDExp == Acc),
            next = new { nextDefault = chainNext, finish = chainNext == 0 },
            previous = prev is null ? null : new { moveId = prev.IDCycMove ?? 0, editorId = prev.IDExp ?? 0, editor = names.GetValueOrDefault(prev.IDExp ?? 0, ""), step = all.FirstOrDefault(m => m.IdCycMove == prev.IDCycMove)?.CycMoveName ?? "" },
            steps = ordered.Where(m => m.IsActiv != false).Select(m => StepDto(m, cands, layers)),
            history = HistoryDto(tasks, all, names, layers, 0)
        });
    }

    object HistoryDto(List<TaskRow> rows, List<MoveRow> moves, Dictionary<int, string> names, string[] layers, int wf)
    {
        var by = moves.ToDictionary(m => m.IdCycMove);
        var items = new List<object>();
        for (var i = 0; i < rows.Count; i++)
        {
            var r = rows[i]; by.TryGetValue(r.IDCycMove ?? 0, out var m);
            var open = (r.ProcentExp ?? 0) < Done;
            // a finished step followed by a step that was already visited = handed back (thumbs down)
            var returned = !open && i + 1 < rows.Count && rows.Take(i).Any(x => x.IDCycMove == rows[i + 1].IDCycMove);
            items.Add(new
            {
                taskId = r.IDTask, step = m?.CycMoveName ?? "(removed step)", layerName = layers[Math.Clamp(m?.CycMoveLayer ?? 1, 1, 4)], assignee = names.GetValueOrDefault(r.IDExp ?? 0, ""),
                assignedBy = names.GetValueOrDefault(r.IDStart ?? 0, ""), assigned = r.DateStart, due = r.DateEnd, finished = open ? (DateTime?)null : r.DateExp,
                outcome = open ? "open" : returned ? "returned" : "done", remark = r.Description ?? ""
            });
        }
        return new { run = wf, items };
    }

    /// Finished and removed runs of the document (CycleTasksHistory) plus the current one.
    [HttpGet("documents/{id:int}/workflow/history")]
    public async Task<IActionResult> History(int id, [FromQuery] string lang = "EN")
    {
        lang = L(lang);
        await using var con = Con();
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        var (d, err) = await LoadDoc(con, id, lang); if (err is not null) return err;
        var layers = await Layers(con, lang);
        var hist = (await con.QueryAsync<TaskRow>("SELECT * FROM CycleTasksHistory WHERE IDDoc = @id AND Lang = @lang ORDER BY IdWF, IDTask", new { id, lang })).ToList();
        var cur = await RunTasks(con, id, lang);
        var all = cur.Concat(hist).ToList();
        var cycIds = all.Select(t => t.IDCycle).Distinct().ToList();
        var moves = cycIds.Count == 0 ? new List<MoveRow>() : (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle IN @cycIds", new { cycIds })).ToList();
        var cycNames = cycIds.Count == 0 ? new() : (await con.QueryAsync<WfName>("SELECT IdCycle AS Id, CycleName AS Name FROM Cycles WHERE IdCycle IN @cycIds", new { cycIds })).ToDictionary(x => x.Id, x => x.Name ?? "");
        var names = await Names(con, all.SelectMany(t => new[] { t.IDStart ?? 0, t.IDExp ?? 0 }));
        var runs = new List<object>();
        if (cur.Count > 0) runs.Add(new { run = 0, current = true, workflow = cycNames.GetValueOrDefault(cur[0].IDCycle, ""), data = HistoryDto(cur, moves, names, layers, 0) });
        foreach (var g in hist.GroupBy(h => h.IdWF ?? 0).OrderByDescending(g => g.Key))
            runs.Add(new { run = g.Key, current = false, workflow = cycNames.GetValueOrDefault(g.First().IDCycle, ""), data = HistoryDto(g.ToList(), moves, names, layers, g.Key) });
        return Ok(new { runs });
    }

    static DateTime DueOrDefault(DateTime? due, MoveRow m) => (due?.Date ?? DateTime.Today.AddDays(m.NoOfDays ?? 0));

    async Task<int> NextTaskId(SqlConnection con, SqlTransaction tx) =>
        await con.ExecuteScalarAsync<int>(@"SELECT ISNULL(MAX(x), 0) + 1 FROM (SELECT IDTask AS x FROM CycleTasks WITH (UPDLOCK, HOLDLOCK) UNION ALL SELECT IDTask FROM CycleTasksHistory) q", transaction: tx);

    static async Task InsertTask(SqlConnection con, SqlTransaction tx, int taskId, int cycle, int doc, string lang, int start, DateTime dateStart, int move, DateTime due, int exp, int pct, string? desc)
    {
        await con.ExecuteAsync(@"INSERT INTO CycleTasks (IDTask, IDCycle, IDDoc, Lang, IDStart, DateStart, IDCycMove, DateEnd, IDExp, DateExp, ProcentExp, Description)
            VALUES (@taskId, @cycle, @doc, @lang, @start, @dateStart, @move, @due, @exp, @now, @pct, @desc)", new { taskId, cycle, doc, lang, start, dateStart, move, due, exp, now = DateTime.Now, pct, desc = desc ?? "" }, tx);
    }

    class TplRow { public string? Body { get; set; } public string? Subject { get; set; } }
    string AppUrl()
    {
        var b = cfg["App:BaseUrl"];
        if (string.IsNullOrWhiteSpace(b)) b = Request.Headers.Origin.ToString();
        if (string.IsNullOrWhiteSpace(b) && Uri.TryCreate(Request.Headers.Referer.ToString(), UriKind.Absolute, out var r)) b = r.GetLeftPart(UriPartial.Authority);
        return string.IsNullOrWhiteSpace(b) ? "" : b.TrimEnd('/') + "/tasks";
    }

    /// Sends the "task assignment" mail (template LDSWorkflow of the document language: subject, header, footer and the opening sentence come from it).
    /// Never throws; the result text goes back to the screen. Every outcome is also written to the API log.
    async Task<string> AssignMail(SqlConnection con, int doc, string lang, int cycle, MoveRow move, int toAcc, DateTime due, string remark, string[] layers, bool test = false)
    {
        try
        {
            var to = await con.QueryFirstOrDefaultAsync<string?>("SELECT TOP 1 e.Email FROM Accounts a JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = @toAcc", new { toAcc });
            if (!MailService.IsValid(to)) { log.LogWarning("Workflow mail D{Doc}: account {Acc} has no valid e-mail address ({Mail})", doc, toAcc, to); return "The editor has no valid e-mail address (EmailContact): no mail was sent."; }
            var st = await mailSvc.Settings(con);
            if (!st.Configured) { log.LogWarning("Workflow mail D{Doc}: e-mail not configured", doc); return "E-mail is not configured (Config smtpServer, smtpFrom, pop3login or Smtp__* settings): no mail was sent."; }
            async Task<TplRow?> Tpl(string where, object args) => await con.QueryFirstOrDefaultAsync<TplRow>("SELECT TOP 1 Body, Subject FROM ApplicationEmail WHERE MailType = 'LDSWorkflow'" + where, args);
            var tpl = await Tpl(" AND Lang = @lang", new { lang }); if (string.IsNullOrWhiteSpace(tpl?.Body)) tpl = await Tpl(" AND Lang = 'EN'", new { }); if (string.IsNullOrWhiteSpace(tpl?.Body)) tpl = await Tpl("", new { });

            var docName = await con.ExecuteScalarAsync<string?>("SELECT TOP 1 DocName FROM Documents WHERE IDDoc = @doc AND Lang = @lang", new { doc, lang }) ?? "";
            var cycName = await con.ExecuteScalarAsync<string?>("SELECT CycleName FROM Cycles WHERE IdCycle = @cycle", new { cycle }) ?? "";
            var me = (await Names(con, [Acc])).GetValueOrDefault(Acc, "");
            var my = await con.ExecuteScalarAsync<string?>("SELECT AccShort FROM Accounts WHERE IdAcc = @a", new { a = Acc });
            var layer = Math.Clamp(move.CycMoveLayer ?? 1, 1, 4);
            var step = $"{move.CycMoveName}[{layers[layer]}]";
            var tags = await publisher.MailTags(doc, lang, new Dictionary<string, object?>());
            void Tag(string k, string v) { if (!tags.ContainsKey(k)) tags[k] = v; }
            tags["$cycname$"] = cycName; tags["$stepName$"] = step; tags["$endDate$"] = due.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
            tags["$wfDesc$"] = remark; tags["$wfDescR$"] = move.CycMoveDescription ?? ""; tags["$accntname$"] = $"{me}[{my}]";
            Tag("$DocumentName$", docName); Tag("$Dokumentname$", docName); Tag("$ID$", doc.ToString());

            // the opening sentence of the template ("Document X with ID Y has been assigned to you."): first cell that mentions the document
            var filled = tpl?.Body is { Length: > 0 } tb ? MailLayout.Apply(tb, tags, true) : "";
            var intro = "";
            var m = Regex.Match(filled, @"<td>\s*([^<]*<em>.*?</em>[^<]*(?:<em>.*?</em>[^<]*)*)\s*</td>", RegexOptions.IgnoreCase | RegexOptions.Singleline, TimeSpan.FromSeconds(1));
            if (m.Success) intro = Regex.Replace(m.Groups[1].Value, "</?em>", m2 => m2.Value == "<em>" ? "<b>" : "</b>", RegexOptions.IgnoreCase);
            if (string.IsNullOrWhiteSpace(intro)) intro = WorkflowMail.DefaultIntro(lang, docName, doc.ToString());

            var lab = Labels(lang);
            var rows = new (string, string)[] { (lab[0], cycName), (lab[1], step), (lab[2], doc.ToString()), (lab[3], docName), (lab[7], tags["$accntname$"]) };
            var body = WorkflowMail.Html(lang, intro, docName, doc.ToString(), move.CycMoveName ?? "", layers[layer], layer, tags["$endDate$"], remark, move.CycMoveDescription ?? "", rows, AppUrl(),
                MailLayout.TextToHtml(await MailService.C(con, "EmailHeader")), MailLayout.TextToHtml(await MailService.C(con, "EmailFooter")));
            var subject = MailLayout.Apply(string.IsNullOrWhiteSpace(tpl?.Subject) ? "Task Assignment" : tpl!.Subject!, tags, false);
            if (test) subject = "[TEST] " + subject;
            await mailSvc.SendAsync([to!], [], subject, body, lang);
            log.LogInformation("Workflow mail sent: D{Doc} step {Step} to account {Acc} <{Mail}>", doc, move.CycMoveName, toAcc, to);
            return "Mail sent to the editor (" + to + ").";
        }
        catch (Exception ex) { log.LogWarning("Workflow mail for D{Doc} failed: {Msg}", doc, ex.Message); return "The mail to the editor could not be sent: " + (ex is MailException ? ex.Message : ex.GetBaseException().Message); }
    }

    /// Workflow administrators: sends a sample assignment mail to themselves to check the mail settings and the layout.
    [HttpPost("workflow/mail-test")]
    public async Task<IActionResult> MailTest([FromBody] WfMailTestBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (await NeedAdmin(con) is { } e) return e;
        var layers = await Layers(con, lang);
        var docId = await con.ExecuteScalarAsync<int?>("SELECT TOP 1 IDDoc FROM Documents WHERE Lang = @lang ORDER BY IDDoc", new { lang }) ?? 0;
        var move = new MoveRow { IdCycMove = 0, CycMoveName = "Review", CycMoveLayer = 2, CycMoveDescription = "Check the content and the formatting.", NoOfDays = 3 };
        var msg = await AssignMail(con, docId, lang, 0, move, Acc, DateTime.Today.AddDays(3), "This is a test of the workflow e-mail.", layers, true);
        return Ok(new { ok = msg.StartsWith("Mail sent"), message = msg });
    }
    static string WebUtilityEncode(string s) => System.Net.WebUtility.HtmlEncode(s ?? "");
    static string[] Labels(string lang) => lang switch
    {
        "DE" => new[] { "Prozessname", "Erforderliche Aktion", "Dokument-ID", "Dokumentname", "Fertigstellung bis", "Aufgabenbeschreibung", "Schrittbeschreibung", "Zugewiesen von" },
        "PL" => new[] { "Nazwa procesu", "Wymagana operacja", "ID dokumentu", "Nazwa dokumentu", "Termin realizacji", "Opis zadania", "Opis kroku", "Przypisane przez" },
        _ => new[] { "Process name", "Operation required", "Document ID", "Document name", "Date of completion", "Task description", "Step description", "Assigned by" }
    };

    async Task<(MoveRow? m, IActionResult? err)> PickMove(SqlConnection con, SqlTransaction tx, int cycle, int moveId)
    {
        var m = await con.QueryFirstOrDefaultAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @cycle AND IdCycMove = @moveId", new { cycle, moveId }, tx);
        if (m is null || m.IsActiv == false) return (null, Err(400, "The chosen workflow step does not exist (any more) or is not active."));
        return (m, null);
    }

    static string? CheckRemark(string? r) => (r ?? "").Length > 1000 ? "The text can have 1000 characters at most." : null;

    async Task<IActionResult?> CheckEditor(SqlConnection con, SqlTransaction tx, MoveRow m, int editor)
    {
        var c = await Candidates(con, [m], tx);
        return c.GetValueOrDefault(m.IdCycMove)?.Any(x => x.Id == editor) == true ? null : Err(400, "The chosen editor is not the editor of the step or a member of its user group.");
    }

    /// Adds the document to a workflow (the "Workflow" entry of the document menu).
    [HttpPost("documents/{id:int}/workflow/start")]
    public async Task<IActionResult> Start(int id, [FromBody] WfStartBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        var p = await Perms(con);
        if (!p.Use) return Err(403, "You need the 'Use Workflow' right.");
        var (d, err) = await LoadDoc(con, id, lang); if (err is not null) return err;
        if (d!.Status is 9 or 11 or 5) return Err(409, "A blocked, frozen or archived document cannot be added to a workflow.");
        if (CheckRemark(b.Remark) is { } rm) return Err(400, rm);
        var layers = await Layers(con, lang);
        var mail = "";
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            if ((await RunTasks(con, id, lang, tx)).Count > 0 || await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM Documents WHERE IDDoc = @id AND Lang = @lang AND ISNULL(IsCycle, 0) = 1", new { id, lang }, tx) > 0)
                return Err(409, "The document is already in a workflow.");
            var cyc = await con.QueryFirstOrDefaultAsync<CycRow>("SELECT IdCycle, IsActiv, CycleName, CycleDescription, IdCycMoveStart FROM Cycles WHERE IdCycle = @c", new { c = b.CycleId }, tx);
            if (cyc is null || cyc.IsActiv != true) return Err(409, "This workflow is not available (any more).");
            if (!(await EligibleCycles(con, id, lang, d, p, tx)).Any(c => c.IdCycle == cyc.IdCycle)) return Err(403, "This workflow is not valid for the document type, folder or your user group.");
            var moves = (await con.QueryAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @c", new { c = cyc.IdCycle }, tx)).ToList();
            var ordered = Ordered(cyc, moves).Where(m => m.IsActiv != false).ToList();
            var start = ordered.FirstOrDefault(m => m.IdCycMove == cyc.IdCycMoveStart && (m.IsStartPunkt ?? false));
            var nextId = b.NextMoveId > 0 ? b.NextMoveId : start?.IdCycMove ?? ordered.FirstOrDefault()?.IdCycMove ?? 0;
            if (nextId == 0) return Err(400, "The workflow has no steps.");
            var (nm, e2) = await PickMove(con, tx, cyc.IdCycle, nextId); if (e2 is not null) return e2;
            var next = nm!;
            var editor = b.EditorId > 0 ? b.EditorId : next.IdAccount ?? 0;
            if (await CheckEditor(con, tx, next, editor) is { } e3) return e3;
            var due = DueOrDefault(b.Due, next);
            if (due < DateTime.Today) return Err(400, "The date cannot be in the past.");
            var taskId = await NextTaskId(con, tx);
            var now = DateTime.Now;
            if (start is not null && start.IdCycMove != next.IdCycMove) await InsertTask(con, tx, taskId++, cyc.IdCycle, id, lang, Acc, now, start.IdCycMove, now, Acc, Done, "");
            await InsertTask(con, tx, taskId, cyc.IdCycle, id, lang, Acc, now, next.IdCycMove, due, editor, 0, (b.Remark ?? "").Trim());
            await con.ExecuteAsync("UPDATE Documents SET IsCycle = 1 WHERE IDDoc = @id AND Lang = @lang", new { id, lang }, tx);
            await tx.CommitAsync();
            mail = await AssignMail(con, id, lang, cyc.IdCycle, next, editor, due, (b.Remark ?? "").Trim(), layers);
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
        return Ok(new { started = true, mail });
    }

    /// Thumbs up (accept: pass on to the next step or finish) or thumbs down (reject: back to the previous user).
    [HttpPost("documents/{id:int}/workflow/advance")]
    public async Task<IActionResult> Advance(int id, [FromBody] WfAdvanceBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        var p = await Perms(con);
        if (!p.Use) return Err(403, "You need the 'Use Workflow' right.");
        var (d, err) = await LoadDoc(con, id, lang); if (err is not null) return err;
        var accept = string.Equals(b.Action, "accept", StringComparison.OrdinalIgnoreCase);
        if (!accept && !string.Equals(b.Action, "reject", StringComparison.OrdinalIgnoreCase)) return Err(400, "Unknown action.");
        if (CheckRemark(b.Remark) is { } rm) return Err(400, rm);
        var remark = (b.Remark ?? "").Trim();
        if (!accept && remark.Length == 0) return Err(400, "Please give a reason: the previous user sees it as the remark.");
        var layers = await Layers(con, lang);
        string mail = ""; bool finished = false; MoveRow? target = null; (int cycle, MoveRow move, int editor, DateTime due, string remark)? pending = null;
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            var tasks = await RunTasks(con, id, lang, tx);
            var cur = Open(tasks);
            if (cur is null) return Err(409, "The document has no open workflow task.");
            if (b.TaskId != 0 && b.TaskId != cur.IDTask) return Err(409, "The task has changed in the meantime. Reload the window.");
            if (cur.IDExp != Acc && !p.WfAdmin) return Err(403, "This task is assigned to someone else.");
            var cycle = cur.IDCycle;
            var curMove = await con.QueryFirstOrDefaultAsync<MoveRow>("SELECT * FROM CycleMoves WHERE IdCycle = @cycle AND IdCycMove = @m", new { cycle, m = cur.IDCycMove }, tx);
            var now = DateTime.Now;
            var newId = await NextTaskId(con, tx);

            if (accept)
            {
                var chain = curMove?.IdCycMoveNext ?? 0;
                var nextId = b.NextMoveId > 0 ? b.NextMoveId : chain;
                if (nextId == 0)
                {   // last step: the workflow is complete
                    var text = remark.Length == 0 ? cur.Description : $"{cur.Description}{(string.IsNullOrEmpty(cur.Description) ? "" : "\n")}↳ {remark}";
                    await con.ExecuteAsync("UPDATE CycleTasks SET ProcentExp = @d, DateExp = @now, Description = @text WHERE IDTask = @t AND IDDoc = @id AND Lang = @lang", new { d = Done, now, text = (text ?? "").Length > 1000 ? text![..1000] : text, t = cur.IDTask, id, lang }, tx);
                    await ArchiveRun(con, tx, id, lang);
                    finished = true;
                }
                else
                {
                    var (nm, e2) = await PickMove(con, tx, cycle, nextId); if (e2 is not null) return e2;
                    target = nm!;
                    var editor = b.EditorId > 0 ? b.EditorId : target.IdAccount ?? 0;
                    if (await CheckEditor(con, tx, target, editor) is { } e3) return e3;
                    var due = DueOrDefault(b.Due, target);
                    if (due < DateTime.Today) return Err(400, "The date cannot be in the past.");
                    await con.ExecuteAsync("UPDATE CycleTasks SET ProcentExp = @d, DateExp = @now WHERE IDTask = @t AND IDDoc = @id AND Lang = @lang", new { d = Done, now, t = cur.IDTask, id, lang }, tx);
                    await InsertTask(con, tx, newId, cycle, id, lang, Acc, now, target.IdCycMove, due, editor, 0, remark);
                    pending = (cycle, target, editor, due, remark);
                }
            }
            else
            {
                var prev = tasks.LastOrDefault(t => t.IDTask < cur.IDTask && (t.ProcentExp ?? 0) >= Done);
                if (prev is null) return Err(409, "There is no previous step to hand the document back to.");
                var backTo = b.NextMoveId > 0 ? b.NextMoveId : prev.IDCycMove ?? 0;
                var (nm, e2) = await PickMove(con, tx, cycle, backTo); if (e2 is not null) return e2;
                target = nm!;
                var editor = b.EditorId > 0 ? b.EditorId : (prev.IDCycMove == target.IdCycMove ? prev.IDExp ?? target.IdAccount ?? 0 : target.IdAccount ?? 0);
                if (await CheckEditor(con, tx, target, editor) is { } e3) { if (editor == prev.IDExp && prev.IDCycMove == target.IdCycMove) { /* the previous user may have left the group: keep him, he did the step */ } else return e3; }
                var due = DueOrDefault(b.Due, target);
                if (due < DateTime.Today) due = DateTime.Today.AddDays(target.NoOfDays ?? 0);
                await con.ExecuteAsync("UPDATE CycleTasks SET ProcentExp = @d, DateExp = @now WHERE IDTask = @t AND IDDoc = @id AND Lang = @lang", new { d = Done, now, t = cur.IDTask, id, lang }, tx);
                await InsertTask(con, tx, newId, cycle, id, lang, Acc, now, target.IdCycMove, due, editor, 0, remark);
                pending = (cycle, target, editor, due, remark);
            }
            await tx.CommitAsync();
            if (pending is { } pm) mail = await AssignMail(con, id, lang, pm.cycle, pm.move, pm.editor, pm.due, pm.remark, layers);
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
        return Ok(new { finished, rejected = !accept, mail });
    }

    /// Moves every task row of the document to CycleTasksHistory under a new IdWF and clears the workflow flag (legacy "history of the workflow").
    static async Task ArchiveRun(SqlConnection con, SqlTransaction tx, int id, string lang)
    {
        var wf = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IdWF), 0) + 1 FROM CycleTasksHistory WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
        await con.ExecuteAsync(@"INSERT INTO CycleTasksHistory (IdWF, IDTask, IDCycle, IDDoc, Lang, IDStart, DateStart, IDCycMove, DateEnd, IDExp, DateExp, ProcentExp, Description)
            SELECT @wf, IDTask, IDCycle, IDDoc, Lang, IDStart, DateStart, IDCycMove, DateEnd, IDExp, DateExp, ProcentExp, Description FROM CycleTasks WHERE IDDoc = @id AND Lang = @lang", new { wf, id, lang }, tx);
        await con.ExecuteAsync("DELETE FROM CycleTasks WHERE IDDoc = @id AND Lang = @lang; UPDATE Documents SET IsCycle = 0 WHERE IDDoc = @id AND Lang = @lang", new { id, lang }, tx);
    }

    /// "Workflow entfernen": takes the document out of the workflow at any stage.
    [HttpPost("documents/{id:int}/workflow/remove")]
    public async Task<IActionResult> Remove(int id, [FromBody] WfRemoveBody b)
    {
        var lang = L(b.Lang);
        await using var con = Con(); await con.OpenAsync();
        if (!await Enabled(con)) return Err(404, "Workflow is switched off (Config IsWorkflowEnabled).");
        var p = await Perms(con);
        if (!p.Use) return Err(403, "You need the 'Use Workflow' right.");
        var (d, err) = await LoadDoc(con, id, lang); if (err is not null) return err;
        if ((b.Reason ?? "").Length > 1000) return Err(400, "The text can have 1000 characters at most.");
        try
        {
            await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
            var tasks = await RunTasks(con, id, lang, tx);
            if (tasks.Count == 0)
            {   // a stale flag without tasks: just clear it
                await con.ExecuteAsync("UPDATE Documents SET IsCycle = 0 WHERE IDDoc = @id AND Lang = @lang", new { id, lang }, tx);
                await tx.CommitAsync(); return Ok(new { removed = true });
            }
            var cur = Open(tasks);
            if (!(p.WfAdmin || tasks[0].IDStart == Acc || cur?.IDExp == Acc)) return Err(403, "Only the user who started the workflow, the current editor or a workflow administrator can remove the document from the workflow.");
            if (cur is not null && !string.IsNullOrWhiteSpace(b.Reason))
            {
                var text = $"{cur.Description}{(string.IsNullOrEmpty(cur.Description) ? "" : "\n")}↳ removed: {b.Reason!.Trim()}";
                await con.ExecuteAsync("UPDATE CycleTasks SET Description = @text WHERE IDTask = @t AND IDDoc = @id AND Lang = @lang", new { text = text.Length > 1000 ? text[..1000] : text, t = cur.IDTask, id, lang }, tx);
            }
            await ArchiveRun(con, tx, id, lang);
            await tx.CommitAsync();
        }
        catch (SqlException ex) when (ex.Number is 229 or 262 or 297) { return Denied(ex); }
        return Ok(new { removed = true });
    }

    // ═════════════════════════ my tasks ═════════════════════════
    /// "My tasks" (Meine Aufgaben): the open tasks of the signed-in user, counted per task type; layer 5 = Edit/Verify, 6 = Release/Publish.
    [HttpGet("workflow/tasks")]
    public async Task<IActionResult> Tasks([FromQuery] string lang = "EN", [FromQuery] int layer = 0)
    {
        lang = L(lang);
        await using var con = Con();
        if (!await Enabled(con)) return Ok(new { enabled = false, counts = new int[7], items = Array.Empty<object>() });
        var layers = await Layers(con, lang);
        var rows = (await con.QueryAsync<WfMyTask>(@"SELECT t.IDTask, t.IDCycle, t.IDDoc, t.Lang, t.IDStart, t.DateStart, t.IDCycMove, t.DateEnd, t.Description, c.CycleName, m.CycMoveName, ISNULL(m.CycMoveLayer, 1) AS Layer,
                d.DocName, d.[Status], d.V1, d.V2, d.V3, d.Extension,
                ISNULL((SELECT TOP 1 StatusDesc FROM [Status] s WHERE s.IDStatus = d.[Status] AND s.Lang = d.Lang), '') AS StatusName,
                (SELECT TOP 1 CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE e.Name END FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = t.IDStart) AS StartedBy
            FROM CycleTasks t
            JOIN Documents d ON d.IDDoc = t.IDDoc AND d.Lang = t.Lang
            LEFT JOIN Cycles c ON c.IdCycle = t.IDCycle
            LEFT JOIN CycleMoves m ON m.IdCycle = t.IDCycle AND m.IdCycMove = t.IDCycMove
            WHERE t.IDExp = @acc AND ISNULL(t.ProcentExp, 0) < @done AND t.Lang = @lang
              AND t.IDTask = (SELECT MAX(x.IDTask) FROM CycleTasks x WHERE x.IDDoc = t.IDDoc AND x.Lang = t.Lang)
            ORDER BY t.DateEnd, d.DocName", new { acc = Acc, done = Done, lang })).ToList();
        var counts = new int[7];
        foreach (var r in rows) { var l = r.Layer; if (l is >= 1 and <= 4) { counts[l]++; if (l <= 2) counts[5]++; else counts[6]++; } }
        bool In(int l) => layer == 0 || layer == l || (layer == 5 && l <= 2) || (layer == 6 && l >= 3);
        return Ok(new
        {
            enabled = true, counts, layerNames = layers.Skip(1),
            items = rows.Where(r => In(r.Layer)).Select(r => new
            {
                taskId = r.IDTask, idDoc = r.IDDoc, lang = r.Lang, docName = r.DocName ?? "", ext = r.Extension ?? "", status = r.Status, statusName = r.StatusName ?? "",
                version = $"{r.V1 ?? 0}.{r.V2 ?? 0}.{r.V3 ?? 0}", workflow = r.CycleName ?? "", step = r.CycMoveName ?? "", layer = r.Layer,
                layerName = layers[Math.Clamp(r.Layer, 1, 4)], startedBy = r.StartedBy ?? "", assigned = r.DateStart, due = r.DateEnd,
                overdue = r.DateEnd is { } dd && dd.Date < DateTime.Today, remark = r.Description ?? ""
            })
        });
    }

    // ═════════════════════════ task summary (menu badge + notification bell) ═════════════════════════
    /// Open tasks of the signed-in user over ALL languages, counted per step type (1 Edit, 2 Verify, 3 Release, 4 Publish), with the newest ones.
    /// Only the latest task of a document counts (older rows of the same run are history).
    [HttpGet("workflow/tasks/summary")]
    public async Task<IActionResult> TaskSummary()
    {
        await using var con = Con();
        if (!await Enabled(con)) return Ok(new { enabled = false, total = 0, overdue = 0, counts = new int[5], items = Array.Empty<object>() });
        var rows = (await con.QueryAsync<WfMyTask>(@"SELECT t.IDTask, t.IDDoc, t.Lang, t.DateStart, t.DateEnd, c.CycleName, m.CycMoveName, ISNULL(m.CycMoveLayer, 1) AS Layer, d.DocName,
                (SELECT TOP 1 CASE WHEN ISNULL(e.Name, '') = '' THEN a.AccShort ELSE e.Name END FROM Accounts a LEFT JOIN EmailContact e ON e.IDEC = a.IDEC WHERE a.IdAcc = t.IDStart) AS StartedBy
            FROM CycleTasks t
            JOIN Documents d ON d.IDDoc = t.IDDoc AND d.Lang = t.Lang
            LEFT JOIN Cycles c ON c.IdCycle = t.IDCycle
            LEFT JOIN CycleMoves m ON m.IdCycle = t.IDCycle AND m.IdCycMove = t.IDCycMove
            WHERE t.IDExp = @acc AND ISNULL(t.ProcentExp, 0) < @done
              AND t.IDTask = (SELECT MAX(x.IDTask) FROM CycleTasks x WHERE x.IDDoc = t.IDDoc AND x.Lang = t.Lang)
            ORDER BY t.DateStart DESC, t.IDTask DESC", new { acc = Acc, done = Done })).ToList();
        var names = new[] { "", "Edit", "Verify", "Release", "Publish" };
        var counts = new int[5];
        foreach (var r in rows) if (r.Layer is >= 1 and <= 4) counts[r.Layer]++;
        return Ok(new
        {
            enabled = true, total = rows.Count, overdue = rows.Count(r => r.DateEnd is { } dd && dd.Date < DateTime.Today), counts,
            items = rows.Take(30).Select(r => new
            {
                taskId = r.IDTask, idDoc = r.IDDoc, lang = r.Lang, docName = r.DocName ?? "", workflow = r.CycleName ?? "", step = r.CycMoveName ?? "",
                layer = r.Layer, layerName = names[Math.Clamp(r.Layer, 1, 4)], startedBy = r.StartedBy ?? "", assigned = r.DateStart, due = r.DateEnd,
                overdue = r.DateEnd is { } dd && dd.Date < DateTime.Today
            })
        });
    }
}
