using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace PhaseLift.Api;

public class ContentHit { public int IdDoc { get; set; } public string Lang { get; set; } = ""; public string Snippet { get; set; } = ""; public double Score { get; set; } }
public class IndexStatus
{
    public int Documents { get; set; } public int Pending { get; set; } public bool Running { get; set; } public DateTime? LastStart { get; set; } public DateTime? LastEnd { get; set; }
    public int Indexed { get; set; } public int Skipped { get; set; } public int Failed { get; set; } public string? Note { get; set; }
    public int Missing { get; set; } public int NoText { get; set; } public int Unsupported { get; set; } public List<string> Problems { get; } = new();
    public void Problem(string m) { lock (Problems) { if (Problems.Count < 8) Problems.Add(m); } }
}

/// Full-text index of the document files. Lives in its own SQLite file (SQLite FTS5, BM25 ranking), the SQL Server database stays untouched.
/// No external service: everything runs inside the API.
public sealed class DocTextIndex
{
    readonly string _cs;
    readonly object _w = new();
    public IndexStatus Status { get; } = new();
    public string Path { get; }

    public DocTextIndex(IConfiguration cfg, IWebHostEnvironment env)
    {
        var dir = cfg["Search:IndexPath"];
        if (string.IsNullOrWhiteSpace(dir)) dir = System.IO.Path.Combine(env.ContentRootPath, "App_Data", "index");
        Directory.CreateDirectory(dir);
        Path = System.IO.Path.Combine(dir, "doctext.db");
        _cs = new SqliteConnectionStringBuilder { DataSource = Path, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared }.ToString();
        using var c = Open();
        Exec(c, "PRAGMA journal_mode=WAL;");
        Exec(c, "CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, idDoc INTEGER NOT NULL, lang TEXT NOT NULL, sig TEXT NOT NULL, indexedAt TEXT NOT NULL, fid INTEGER NOT NULL DEFAULT 0);");
        Exec(c, "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, content, key UNINDEXED, idDoc UNINDEXED, lang UNINDEXED, tokenize='unicode61 remove_diacritics 2');");
        Status.Documents = Count();
    }

    SqliteConnection Open() { var c = new SqliteConnection(_cs); c.Open(); return c; }
    static void Exec(SqliteConnection c, string sql, params (string, object?)[] p)
    {
        using var cmd = c.CreateCommand(); cmd.CommandText = sql;
        foreach (var (n, v) in p) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }
    static string Key(int id, string lang) => $"{lang}:{id}";

    public int Count() { using var c = Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM docs"; return Convert.ToInt32(cmd.ExecuteScalar()); }

    /// key -> signature of everything that is indexed.
    public Dictionary<string, string> Signatures()
    {
        var d = new Dictionary<string, string>();
        using var c = Open(); using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT key, sig FROM docs";
        using var r = cmd.ExecuteReader(); while (r.Read()) d[r.GetString(0)] = r.GetString(1);
        return d;
    }

    static long? Scalar(SqliteConnection c, string sql, params (string, object?)[] p)
    {
        using var cmd = c.CreateCommand(); cmd.CommandText = sql;
        foreach (var (n, v) in p) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        var o = cmd.ExecuteScalar(); return o is null or DBNull ? null : Convert.ToInt64(o);
    }

    public void Upsert(int id, string lang, string name, string content, string sig)
    {
        var key = Key(id, lang);
        lock (_w)
        {
            using var c = Open(); using var tx = c.BeginTransaction();
            var old = Scalar(c, "SELECT fid FROM docs WHERE key = $k", ("$k", key));
            if (old is > 0) Exec(c, "DELETE FROM fts WHERE rowid = $r", ("$r", old));
            Exec(c, "INSERT INTO fts (name, content, key, idDoc, lang) VALUES ($n, $c, $k, $i, $l)", ("$n", name), ("$c", content), ("$k", key), ("$i", id), ("$l", lang));
            var fid = Scalar(c, "SELECT last_insert_rowid()") ?? 0;
            Exec(c, "INSERT INTO docs (key, idDoc, lang, sig, indexedAt, fid) VALUES ($k, $i, $l, $s, $t, $f) ON CONFLICT(key) DO UPDATE SET sig = $s, indexedAt = $t, fid = $f",
                ("$k", key), ("$i", id), ("$l", lang), ("$s", sig), ("$t", DateTime.Now.ToString("s")), ("$f", fid));
            tx.Commit();
        }
    }

    public void Remove(IEnumerable<string> keys)
    {
        lock (_w)
        {
            using var c = Open(); using var tx = c.BeginTransaction();
            foreach (var k in keys)
            {
                var old = Scalar(c, "SELECT fid FROM docs WHERE key = $k", ("$k", k));
                if (old is > 0) Exec(c, "DELETE FROM fts WHERE rowid = $r", ("$r", old));
                Exec(c, "DELETE FROM docs WHERE key = $k", ("$k", k));
            }
            tx.Commit();
        }
    }

    public void Clear() { lock (_w) { using var c = Open(); Exec(c, "DELETE FROM fts"); Exec(c, "DELETE FROM docs"); } Status.Documents = 0; }

    /// "release e-mail" -> all words must occur (prefix match); a phrase in quotes stays a phrase; falls back to "any word" when nothing matches.
    public static (string all, string any) Query(string q)
    {
        var parts = new List<string>();
        foreach (Match m in Regex.Matches(q, "\"([^\"]+)\"|([\\p{L}\\p{N}][\\p{L}\\p{N}\\-_.]*)"))
        {
            if (m.Groups[1].Success) { var ph = Regex.Replace(m.Groups[1].Value, "[\"*]", " ").Trim(); if (ph.Length > 0) parts.Add("\"" + ph + "\""); }
            else { var w = m.Groups[2].Value.Trim('-', '_', '.'); if (w.Length >= 2) parts.Add("\"" + w.Replace("\"", "") + "\"" + (w.Length >= 3 ? "*" : "")); }
        }
        return (string.Join(" AND ", parts), string.Join(" OR ", parts));
    }

    public List<ContentHit> Search(string q, string? lang, int limit)
    {
        var (all, any) = Query(q);
        if (all.Length == 0) return new();
        var hits = Run(all, lang, limit);
        if (hits.Count == 0 && any != all) hits = Run(any, lang, limit);
        return hits;
    }

    List<ContentHit> Run(string match, string? lang, int limit)
    {
        var list = new List<ContentHit>();
        using var c = Open(); using var cmd = c.CreateCommand();
        cmd.CommandText = @"SELECT idDoc, lang, snippet(fts, 1, '[[', ']]', ' … ', 28), bm25(fts, 6.0, 1.0)
            FROM fts WHERE fts MATCH $m " + (lang is null ? "" : "AND lang = $l ") + "ORDER BY bm25(fts, 6.0, 1.0) LIMIT $n";
        cmd.Parameters.AddWithValue("$m", match); if (lang is not null) cmd.Parameters.AddWithValue("$l", lang); cmd.Parameters.AddWithValue("$n", limit);
        try
        {
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add(new ContentHit { IdDoc = r.GetInt32(0), Lang = r.GetString(1), Snippet = r.GetString(2), Score = -r.GetDouble(3) });
        }
        catch (SqliteException) { /* malformed query text: no hits */ }
        return list;
    }
}
