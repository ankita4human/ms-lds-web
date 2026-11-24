using System.Net;
using System.Text;

namespace PhaseLift.Api;

/// The task-assignment e-mail of the workflow: a card layout built from inline styles only (mail clients ignore <style> blocks, and
/// MailService.Clean removes them). Table based so Outlook renders it; the gradient has a solid bgcolor fallback.
public static class WorkflowMail
{
    public sealed record Texts(string Title, string Open, string Remark, string StepDesc, string Due, string Sent);
    static Texts T(string lang) => lang switch
    {
        "DE" => new("Ein Dokument wartet auf Sie", "Meine Aufgaben öffnen", "Aufgabenbeschreibung", "Schrittbeschreibung", "Fertigstellung bis", "Diese Nachricht wurde automatisch von MS LDS® gesendet."),
        "PL" => new("Dokument czeka na Ciebie", "Otwórz moje zadania", "Opis zadania", "Opis kroku", "Termin realizacji", "Ta wiadomość została wysłana automatycznie przez MS LDS®."),
        _ => new("A document is waiting for you", "Open My tasks", "Task description", "Step description", "Due date", "This message was sent automatically by MS LDS®.")
    };
    public static string DefaultIntro(string lang, string docName, string id) => lang switch
    {
        "DE" => $"Das Dokument <b>{E(docName)}</b> mit der ID <b>{E(id)}</b> wurde Ihnen zugewiesen.",
        "PL" => $"Dokument <b>{E(docName)}</b> o identyfikatorze <b>{E(id)}</b> został Ci przypisany.",
        _ => $"The document <b>{E(docName)}</b> with ID <b>{E(id)}</b> has been assigned to you."
    };
    static string E(string? s) => WebUtility.HtmlEncode(s ?? "");
    static string Color(int layer) => layer switch { 1 => "#3b82f6", 2 => "#10b981", 3 => "#f59e0b", 4 => "#8b5cf6", _ => "#4f46e5" };
    static string Icon(int layer) => layer switch { 1 => "&#9999;&#65039;", 2 => "&#128269;", 3 => "&#9989;", 4 => "&#127760;", _ => "&#128196;" };

    /// rows = label/value pairs shown in the detail table (empty values are skipped). introHtml is trusted html (already encoded).
    public static string Html(string lang, string introHtml, string docName, string docId, string stepName, string layerName, int layer, string due,
        string remark, string stepDescription, IEnumerable<(string Label, string Value)> rows, string? url, string headerHtml, string footerHtml)
    {
        var t = T(lang); var c = Color(layer);
        var sb = new StringBuilder();
        sb.Append("<div style=\"background:#eef2f7;padding:28px 12px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.5\">");
        sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td align=\"center\">");
        sb.Append("<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e3e6ee\">");
        // banner
        sb.Append("<tr><td bgcolor=\"#4f46e5\" style=\"background:#4f46e5;background-image:linear-gradient(135deg,#4f46e5 0%,#7c3aed 60%,#06b6d4 100%);padding:28px 32px;color:#ffffff\">");
        sb.Append("<div style=\"font-size:12px;letter-spacing:2px;font-weight:700;opacity:.9\">MS LDS&reg; &nbsp;&bull;&nbsp; WORKFLOW</div>");
        sb.Append("<div style=\"font-size:26px;font-weight:800;margin-top:8px;line-height:1.25\">").Append(E(t.Title)).Append("</div></td></tr>");
        sb.Append("<tr><td style=\"padding:26px 32px 8px\">");
        if (!string.IsNullOrWhiteSpace(headerHtml)) sb.Append("<div style=\"font-size:13px;color:#667085;margin-bottom:14px\">").Append(headerHtml).Append("</div>");
        sb.Append("<div style=\"font-size:15px\">").Append(introHtml).Append("</div>");
        // document card
        sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:18px 0 6px\"><tr>");
        sb.Append("<td style=\"background:#f6f7ff;border-left:6px solid ").Append(c).Append(";border-radius:12px;padding:16px 18px\">");
        sb.Append("<div style=\"font-size:18px;font-weight:700;color:#111827\">").Append(E(docName)).Append("</div>");
        sb.Append("<div style=\"font-size:12px;color:#667085;margin:2px 0 10px\">ID #").Append(E(docId)).Append("</div>");
        sb.Append("<span style=\"display:inline-block;background:").Append(c).Append(";color:#ffffff;border-radius:999px;padding:4px 14px;font-size:12px;font-weight:700;margin-right:6px\">")
          .Append(Icon(layer)).Append(" ").Append(E(layerName)).Append("</span>");
        sb.Append("<span style=\"display:inline-block;background:#ffffff;color:#344054;border:1px solid #d0d5dd;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:600;margin-right:6px\">").Append(E(stepName)).Append("</span>");
        if (!string.IsNullOrWhiteSpace(due))
            sb.Append("<span style=\"display:inline-block;background:#fffaeb;color:#b54708;border:1px solid #fedf89;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:700\">&#9201; ").Append(E(t.Due)).Append(": ").Append(E(due)).Append("</span>");
        sb.Append("</td></tr></table>");
        // remark quote
        if (!string.IsNullOrWhiteSpace(remark))
            sb.Append("<div style=\"margin:14px 0 4px;padding:12px 16px;background:#fffbea;border-left:4px solid #f59e0b;border-radius:8px;font-size:14px\"><div style=\"font-size:11px;font-weight:700;letter-spacing:1px;color:#b54708;text-transform:uppercase;margin-bottom:4px\">")
              .Append(E(t.Remark)).Append("</div>").Append(E(remark).Replace("\n", "<br>")).Append("</div>");
        if (!string.IsNullOrWhiteSpace(stepDescription))
            sb.Append("<div style=\"margin:10px 0 4px;font-size:13px;color:#475467\"><b>").Append(E(t.StepDesc)).Append(":</b> ").Append(E(stepDescription)).Append("</div>");
        // details
        var list = rows.Where(r => !string.IsNullOrWhiteSpace(r.Value)).ToList();
        if (list.Count > 0)
        {
            sb.Append("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:16px 0 4px;border:1px solid #eaecf0;border-radius:12px;overflow:hidden;font-size:13px\">");
            for (var i = 0; i < list.Count; i++)
                sb.Append("<tr><td style=\"padding:9px 14px;background:").Append(i % 2 == 0 ? "#f9fafb" : "#ffffff").Append(";color:#667085;width:38%;vertical-align:top\">").Append(E(list[i].Label))
                  .Append("</td><td style=\"padding:9px 14px;background:").Append(i % 2 == 0 ? "#f9fafb" : "#ffffff").Append(";font-weight:600;color:#111827\">").Append(E(list[i].Value)).Append("</td></tr>");
            sb.Append("</table>");
        }
        // button
        if (!string.IsNullOrWhiteSpace(url))
            sb.Append("<div style=\"text-align:center;margin:24px 0 10px\"><a href=\"").Append(E(url)).Append("\" style=\"display:inline-block;background:#4f46e5;background-image:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 34px;border-radius:999px\">")
              .Append(E(t.Open)).Append(" &rarr;</a></div>");
        sb.Append("</td></tr>");
        // footer
        sb.Append("<tr><td style=\"padding:16px 32px 24px;border-top:1px solid #eaecf0;font-size:12px;color:#98a2b3;text-align:center\">");
        if (!string.IsNullOrWhiteSpace(footerHtml)) sb.Append("<div style=\"margin-bottom:6px\">").Append(footerHtml).Append("</div>");
        sb.Append(E(t.Sent)).Append("</td></tr></table></td></tr></table></div>");
        return sb.ToString();
    }
}
