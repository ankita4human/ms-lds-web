using System.Globalization;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.Data.SqlClient;

namespace PhaseLift.Api;

/// Automatic catchwords. When a document is published, its text is read and every word that is repeated more than 3 times
/// becomes a catchword of the document (tables Catch + DocCatch, isManual = 0). Words added by hand (isManual = 1) are never touched.
/// Config (table Config, all optional):  AutoCatchEnabled (default 1) · AutoCatchMinCount (default 4 = "more than 3 times") ·
/// AutoCatchMax (default 20 words per document) · CatchMinLength (default 4, shared with the manual Add) · IsCatchWordEnabled.
/// A word the administrator deactivated in Catch management stays deactivated; a word switched off for one document stays off after the next publish.
public static class AutoCatch
{
    const int MaxWord = 30;
    static readonly Regex Token = new(@"\p{L}[\p{L}\p{M}\p{N}_'’-]*", RegexOptions.Compiled);

    // Words that say nothing about the content (English, German, Polish, Spanish).
    static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
    {
        "that","this","with","from","have","will","been","were","they","their","there","which","would","could","should","about","into","than","then","them","these","those","when","what","where","while","also","only","such","each","other","some","more","most","must","shall","does","your","very","over","under","after","before","between","being","both","because","through","during","using","used","upon","within","without","again","document","documents",
        "dass","eine","einer","einem","einen","eines","oder","aber","auch","nach","über","wird","werden","wurde","wurden","sind","sein","ihre","ihrer","ihren","dieser","diese","dieses","diesem","diesen","nicht","noch","nur","wenn","dann","dort","durch","sowie","sich","bei","mit","von","vom","zum","zur","für","als","wie","aus","sehr","kann","können","muss","müssen","soll","sollen","alle","jede","jeder","jedes","unter","zwischen","gemäß","dokument","dokumente",
        "oraz","jest","jako","który","która","które","których","tego","tych","tej","dla","przez","przy","nad","pod","lub","albo","tylko","także","także","może","muszą","musi","były","była","było","będzie","będą","gdy","gdzie","jeśli","oraz","dokument","dokumenty","jego","jej","ich","się",
        "para","como","pero","porque","cuando","donde","este","esta","estos","estas","ese","esa","esos","esas","entre","sobre","desde","hasta","sin","con","por","las","los","del","una","uno","unos","unas","también","solo","sólo","puede","pueden","debe","deben","será","serán","fue","fueron","ser","están","está","documento","documentos"
    };

    static async Task<string?> Cfg(SqlConnection con, SqlTransaction? tx, string name) =>
        await con.ExecuteScalarAsync<string?>("SELECT TOP 1 FValue FROM Config WHERE FName = @name", new { name }, tx);

    /// Words (lower case) that occur at least `minCount` times, most frequent first.
    public static List<(string Word, int Count)> Frequent(string text, int minLen, int minCount, int max)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match m in Token.Matches(text))
        {
            var w = m.Value.Trim('-', '\'', '’').ToLower(CultureInfo.InvariantCulture);
            if (w.Length < minLen || w.Length > MaxWord || Stop.Contains(w)) continue;
            counts[w] = counts.GetValueOrDefault(w) + 1;
        }
        return counts.Where(kv => kv.Value >= minCount).OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Take(max).Select(kv => (kv.Key, kv.Value)).ToList();
    }

    /// Reads the document file and refreshes the automatic catchwords of this document and language. Returns the number of words (-1 = switched off or no text).
    public static async Task<int> Apply(SqlConnection con, int id, string lang, string path, ILogger log)
    {
        if (await Cfg(con, null, "AutoCatchEnabled") is "0" or "False" or "false") return -1;
        if (await Cfg(con, null, "IsCatchWordEnabled") is "0" or "False" or "false") return -1;
        var ext = Path.GetExtension(path);
        if (!TextExtractor.CanRead(ext)) return -1;
        var text = await Task.Run(() => TextExtractor.Extract(path));
        if (string.IsNullOrWhiteSpace(text)) return -1;

        int minLen = int.TryParse(await Cfg(con, null, "CatchMinLength"), out var ml) && ml is >= 1 and <= MaxWord ? ml : 4;
        int minCount = int.TryParse(await Cfg(con, null, "AutoCatchMinCount"), out var mc) && mc >= 2 ? mc : 4;
        int max = int.TryParse(await Cfg(con, null, "AutoCatchMax"), out var mx) && mx is >= 1 and <= 200 ? mx : 20;
        var words = Frequent(text, minLen, minCount, max);

        for (var attempt = 1; ; attempt++)
        {
            try { return await Save(con, id, lang, words); }
            catch (SqlException ex) when (ex.Number is 1205 && attempt < 3) { await Task.Delay(150 * attempt); }   // deadlock with another publish: try again
        }
    }

    static async Task<int> Save(SqlConnection con, int id, string lang, List<(string Word, int Count)> words)
    {
        await using var tx = (SqlTransaction)await con.BeginTransactionAsync();
        var docLevel = await Cfg(con, tx, "EnableDocLevelCatchword") == "1";
        var wanted = words.Select(w => w.Word).ToHashSet(StringComparer.CurrentCultureIgnoreCase);

        // automatic links of this document that exist already: id -> word
        var old = (await con.QueryAsync<(int IdCatch, string? Word)>(@"SELECT dc.IdCatch, c.CatchLong FROM DocCatch dc JOIN Catch c ON c.IDCatch = dc.IdCatch AND c.Lang = @lang
            WHERE dc.IdDoc = @id AND ISNULL(dc.isManual, 0) = 0", new { id, lang }, tx)).ToList();
        var gone = old.Where(o => !wanted.Contains(o.Word ?? "")).Select(o => o.IdCatch).ToList();
        if (gone.Count > 0) await con.ExecuteAsync("DELETE FROM DocCatch WHERE IdDoc = @id AND IdCatch IN @gone AND ISNULL(isManual, 0) = 0", new { id, gone }, tx);
        var have = old.Where(o => wanted.Contains(o.Word ?? "")).Select(o => o.Word!).ToHashSet(StringComparer.CurrentCultureIgnoreCase);

        foreach (var (w, _) in words)
        {
            if (have.Contains(w)) continue;
            var cid = await con.QueryFirstOrDefaultAsync<int?>("SELECT TOP 1 IDCatch FROM Catch WITH (UPDLOCK, HOLDLOCK) WHERE Lang = @lang AND CatchLong = @w", new { lang, w }, tx);
            if (cid is null)
            {
                var n = await con.ExecuteScalarAsync<int>("SELECT ISNULL(MAX(IDCatch), 0) + 1 FROM Catch WITH (UPDLOCK, HOLDLOCK)", transaction: tx);
                await con.ExecuteAsync("INSERT INTO Catch (IDCatch, Lang, CatchShort, CatchLong, CatchShow, IsActiv, IsNew) VALUES (@n, @lang, @s, @w, @w, 1, 0)", new { n, lang, s = w[..1], w }, tx);
                cid = n;
            }
            // a link that exists already (also a manual one) is left as it is
            if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM DocCatch WITH (UPDLOCK, HOLDLOCK) WHERE IdDoc = @id AND IdCatch = @cid", new { id, cid }, tx) == 0)
                await con.ExecuteAsync("INSERT INTO DocCatch (IdDoc, IdCatch, isManual, isActiv) VALUES (@id, @cid, 0, 1)", new { id, cid }, tx);
        }
        await tx.CommitAsync();
        return words.Count;
    }

    /// SQL predicate: the document `alias` has an ACTIVE catchword that equals the term in parameter `param` (the word is active on the word level,
    /// or on the document level when Config EnableDocLevelCatchword = 1). Always false when catchwords are switched off.
    public static string MatchSql(string alias, string param, string langParam) => $@"(EXISTS (SELECT 1 FROM DocCatch dcx JOIN Catch cx ON cx.IDCatch = dcx.IdCatch AND cx.Lang = {langParam}
        WHERE dcx.IdDoc = {alias}.IDDoc AND cx.CatchLong = {param} AND ISNULL(cx.IsNew, 0) <> 2
          AND (CASE WHEN EXISTS (SELECT 1 FROM Config WHERE FName = 'EnableDocLevelCatchword' AND FValue = '1') THEN ISNULL(dcx.isActiv, 0) ELSE ISNULL(cx.IsActiv, 0) END) = 1)
        AND NOT EXISTS (SELECT 1 FROM Config WHERE FName = 'IsCatchWordEnabled' AND FValue IN ('0', 'False', 'false')))";
}
