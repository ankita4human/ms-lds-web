namespace PhaseLift.Api;

/// Interface language (the language of the web page: texts, status names, type names) is separate from the document language.
/// The page sends it with every request in the header X-UI-Lang (DE, EN, ZH, PL or ES).
public static class Ui
{
    public static readonly string[] Langs = { "DE", "EN", "ZH", "PL", "ES" };

    public static string Lang(HttpRequest r)
    {
        var v = r.Headers["X-UI-Lang"].ToString().Trim().ToUpperInvariant();
        return Array.IndexOf(Langs, v) >= 0 ? v : "EN";
    }

    /// Status 11 (Frozen) has no row in the Status table.
    public static string Frozen(string ui) => ui switch { "DE" => "Eingefroren", "ZH" => "已冻结", "PL" => "Zamrożony", "ES" => "Congelado", _ => "Frozen" };
}
