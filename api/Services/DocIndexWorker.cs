using Dapper;
using Microsoft.Data.SqlClient;
using PhaseLift.Api.Controllers;

namespace PhaseLift.Api;

/// Keeps the full-text index up to date: scans the document files at start-up and then every Search:ScanMinutes (default 30);
/// a file is read again only when its version, size or date changed. An admin can ask for a full rebuild.
public sealed class DocIndexWorker(IConfiguration cfg, DocTextIndex index, ILogger<DocIndexWorker> log) : BackgroundService
{
    volatile bool _full; readonly SemaphoreSlim _wake = new(0);
    public void Request(bool full) { if (full) _full = true; _wake.Release(); }

    class Row { public int IDDoc { get; set; } public string Lang { get; set; } = ""; public string? DocName { get; set; } public string? Extension { get; set; } public int? V1 { get; set; } public int? V2 { get; set; } public int? V3 { get; set; } }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        if (cfg.GetValue("Search:Enabled", true) == false) { index.Status.Note = "Content search is switched off (Search:Enabled)."; return; }
        try { await Task.Delay(TimeSpan.FromSeconds(20), stop); } catch (OperationCanceledException) { return; }
        var every = TimeSpan.FromMinutes(Math.Clamp(cfg.GetValue("Search:ScanMinutes", 30), 5, 1440));
        while (!stop.IsCancellationRequested)
        {
            try { await Scan(stop); } catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Document index scan failed"); index.Status.Note = "The last scan failed: " + ex.Message; index.Status.Running = false; }
            try { await _wake.WaitAsync(every, stop); } catch (OperationCanceledException) { return; }
        }
    }

    async Task Scan(CancellationToken stop)
    {
        var st = index.Status; st.Running = true; st.LastStart = DateTime.Now; st.Indexed = st.Skipped = st.Failed = st.Missing = st.NoText = st.Unsupported = 0; st.Note = null; lock (st.Problems) st.Problems.Clear();
        if (_full) { index.Clear(); _full = false; }
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds")); await con.OpenAsync(stop);
        var (dp, _, dbId) = await DocFiles.Paths(con);
        if (string.IsNullOrWhiteSpace(dp)) { st.Note = "Config DocPath is not set, so no files can be read."; st.Running = false; st.LastEnd = DateTime.Now; return; }
        var rows = (await con.QueryAsync<Row>("SELECT IDDoc, Lang, DocName, Extension, V1, V2, V3 FROM Documents WHERE IDDoc IS NOT NULL")).ToList();
        var have = index.Signatures(); var seen = new HashSet<string>();
        st.Pending = rows.Count;
        foreach (var r in rows)
        {
            if (stop.IsCancellationRequested) break;
            st.Pending--;
            var key = $"{r.Lang}:{r.IDDoc}"; seen.Add(key);
            var ext = DocFiles.Ext(r.Extension);
            if (!TextExtractor.CanRead(ext)) { st.Skipped++; st.Unsupported++; continue; }
            var file = DocFiles.Live(dp, dbId, r.Lang, r.IDDoc, ext);
            FileInfo fi;
            try { fi = new FileInfo(file); if (!fi.Exists) { st.Skipped++; st.Missing++; st.Problem($"File not found on the server: {file}"); continue; } if (fi.Length > TextExtractor.MaxBytes) { st.Skipped++; st.Problem($"Too large to index: D{r.IDDoc}{ext}"); continue; } } catch (Exception ex) { st.Skipped++; st.Problem($"Cannot open {file}: {ex.Message}"); continue; }
            var sig = $"{r.V1}.{r.V2}.{r.V3}|{fi.Length}|{fi.LastWriteTimeUtc.Ticks}|{r.DocName}";
            if (have.TryGetValue(key, out var old) && old == sig) continue;
            try
            {
                var text = await Task.Run(() => TextExtractor.Extract(file), stop);
                if (string.IsNullOrWhiteSpace(text)) { st.NoText++; st.Problem($"No text found in D{r.IDDoc}{ext} ({r.DocName}); a scanned image PDF needs OCR."); }
                index.Upsert(r.IDDoc, r.Lang, r.DocName ?? "", text ?? "", sig); st.Indexed++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { st.Failed++; st.Problem($"Could not read {file}: {ex.Message}"); log.LogWarning(ex, "Could not index {File}", file); }
        }
        var gone = have.Keys.Where(k => !seen.Contains(k)).ToList();
        if (gone.Count > 0) index.Remove(gone);
        st.Documents = index.Count(); st.Running = false; st.LastEnd = DateTime.Now; st.Pending = 0;
        log.LogInformation("Document index: {New} new/changed, {Skip} skipped, {Fail} failed, {Total} in the index", st.Indexed, st.Skipped, st.Failed, st.Documents);
    }
}
