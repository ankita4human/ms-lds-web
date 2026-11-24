using Dapper;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api;

public record RightRow(int? RCod, string? RValue);
public record GroupRow(int IDGroup, int IDParent, string? GroupDesc, int SortG, int GroupType);

public static class Access
{
    public const int RightAdmin = 1, RightAllGroups = 20, RightSingleGroup = 21;

    /// Rights granted to the account directly or through an account group (same source as legacy AccountFactory.hasRight).
    public static async Task<List<RightRow>> Rights(SqlConnection con, int acc) =>
        (await con.QueryAsync<RightRow>(@"SELECT RCod, RValue FROM AccountsRights
            WHERE IDAccount = @acc OR IDAccGroup IN (SELECT IdAccGroup FROM AccountAccGrp WHERE IdAcc = @acc)", new { acc })).ToList();

    /// Visibility scope for SQL: (1, none) = every group, otherwise (0, ids of accessible groups).
    /// Computed once in C# so SQL no longer re-evaluates a recursive group tree for every document row.
    public static async Task<(int All, int[] Gids)> Scope(SqlConnection con, int acc, string? lang)
    {
        var all = await Groups(con, string.IsNullOrWhiteSpace(lang) ? "EN" : lang);
        var accessible = AccessibleGroups(all, await Rights(con, acc));
        return accessible is null ? (1, Array.Empty<int>()) : (0, accessible.ToArray());
    }

    /// SQL condition "this document is in a group the user may access". Group ids are plain integers, so they are
    /// written into the statement directly (no list parameters): simple, fast and independent of Dapper list expansion.
    public static async Task<string> VisibleSql(SqlConnection con, int acc, string? lang)
    {
        var (all, gids) = await Scope(con, acc, lang);
        if (all == 1) return "(1 = 1)";
        if (gids.Length == 0) return "(1 = 0)";
        return $"EXISTS (SELECT 1 FROM DocGrp dg WHERE dg.IdDoc = d.IDDoc AND dg.IdGroup IN ({string.Join(",", gids)}))";
    }

    public static bool IsAdmin(IEnumerable<RightRow> r) => r.Any(x => x.RCod == RightAdmin);
    public static bool SeesAllGroups(IEnumerable<RightRow> r) => r.Any(x => x.RCod == RightAdmin || x.RCod == RightAllGroups);

    public static async Task<List<GroupRow>> Groups(SqlConnection con, string lang) =>
        (await con.QueryAsync<GroupRow>(@"SELECT IDGroup, ISNULL(IDParent, 0) AS IDParent, GroupDesc, ISNULL(SortG, 0) AS SortG, ISNULL(GroupType, 0) AS GroupType
            FROM Groups WHERE Lang = @lang AND IDGroup IS NOT NULL", new { lang })).ToList();

    public static HashSet<int> Descendants(List<GroupRow> all, IEnumerable<int> roots)
    {
        var kids = all.GroupBy(g => g.IDParent).ToDictionary(g => g.Key, g => g.Select(x => x.IDGroup).ToList());
        var seen = new HashSet<int>();
        var stack = new Stack<int>(roots);
        while (stack.Count > 0)
        {
            var id = stack.Pop();
            if (!seen.Add(id)) continue;
            if (kids.TryGetValue(id, out var c)) foreach (var k in c) stack.Push(k);
        }
        return seen;
    }

    /// Groups the user has full access to (granted group + all sub-groups). Null means every group.
    public static HashSet<int>? AccessibleGroups(List<GroupRow> all, List<RightRow> rights)
    {
        if (SeesAllGroups(rights)) return null;
        var granted = rights.Where(r => r.RCod == RightSingleGroup && int.TryParse(r.RValue, out _))
                            .Select(r => int.Parse(r.RValue!)).Where(id => all.Any(g => g.IDGroup == id));
        return Descendants(all, granted);
    }

    /// Accessible groups plus their ancestors, so the tree can be navigated down to them.
    public static HashSet<int> NavigableGroups(List<GroupRow> all, HashSet<int>? accessible)
    {
        if (accessible is null) return all.Select(g => g.IDGroup).ToHashSet();
        var byId = all.ToDictionary(g => g.IDGroup);
        var result = new HashSet<int>(accessible);
        foreach (var id in accessible)
        {
            var cur = id;
            while (byId.TryGetValue(cur, out var g) && g.IDParent != 0 && result.Add(g.IDParent)) cur = g.IDParent;
        }
        return result;
    }
}
