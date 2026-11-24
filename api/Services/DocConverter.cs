using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PhaseLift.Api;

public enum DocKind { Word, Excel, PowerPoint, Pdf, Other }

/// Makes the PDF and HTML copies of a document. This is what the legacy publisher did with Word / Excel / PowerPoint automation
/// and the external tool pdf2htmlEX (Config "Pathpdf2htmlEX"). Order of preference:
///   1. Microsoft Office on the server (same output as the old publisher: Word "filtered HTML", Excel web page, PDF export),
///   2. LibreOffice (appsettings Publish:SofficePath) for the PDF when Office is not installed,
///   3. pdf2htmlEX for HTML from the PDF (always for PowerPoint, as the legacy EnablePPTXTOHTMLEXE setting does).
[System.Diagnostics.CodeAnalysis.SuppressMessage("Interoperability", "CA1416")]
public class DocConverter(IConfiguration cfg, ILogger<DocConverter> log)
{
    static readonly TimeSpan Timeout = TimeSpan.FromMinutes(4);

    public static DocKind KindOf(string ext) => ext.ToLowerInvariant() switch
    {
        ".doc" or ".docx" or ".docm" or ".dot" or ".dotx" or ".dotm" or ".rtf" => DocKind.Word,
        ".xls" or ".xlsx" or ".xlsm" or ".xlsb" or ".xlt" or ".xltx" or ".xltm" => DocKind.Excel,
        ".ppt" or ".pptx" or ".pptm" or ".pps" or ".ppsx" or ".ppsm" or ".pot" or ".potx" => DocKind.PowerPoint,
        ".pdf" => DocKind.Pdf,
        _ => DocKind.Other
    };

    static bool HasOffice(string progId) => OperatingSystem.IsWindows() && Type.GetTypeFromProgID(progId) is not null;
    public bool OfficeAvailable(DocKind k) => k switch
    {
        DocKind.Word => HasOffice("Word.Application"),
        DocKind.Excel => HasOffice("Excel.Application"),
        DocKind.PowerPoint => HasOffice("PowerPoint.Application"),
        _ => false
    };

    public string? Soffice()
    {
        var c = cfg["Publish:SofficePath"];
        var list = new List<string>();
        if (!string.IsNullOrWhiteSpace(c)) list.Add(c);
        list.AddRange(new[] { @"C:\Program Files\LibreOffice\program\soffice.exe", @"C:\Program Files (x86)\LibreOffice\program\soffice.exe", "/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice" });
        return list.FirstOrDefault(File.Exists);
    }

    // ---------------- PDF ----------------
    /// Makes dir\D{id}.pdf from the (tag-replaced) document file. Returns the PDF path.
    public async Task<string> MakePdf(string file, DocKind kind, string pdf)
    {
        if (kind == DocKind.Pdf) return file;
        if (OfficeAvailable(kind))
        {
            try { await Sta(() => OfficePdf(file, kind, pdf)); if (File.Exists(pdf)) return pdf; }
            catch (Exception ex) { log.LogWarning(ex, "Office PDF export failed for {File}", file); }
        }
        var so = Soffice();
        if (so is not null)
        {
            var dir = Path.GetDirectoryName(pdf)!;
            await Run(so, new[] { "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, file }, dir, LibreProfile());
            var made = Path.Combine(dir, Path.GetFileNameWithoutExtension(file) + ".pdf");
            if (File.Exists(made)) { if (!string.Equals(made, pdf, StringComparison.OrdinalIgnoreCase)) File.Move(made, pdf, true); return pdf; }
        }
        throw new PublishException(501, "The PDF copy could not be made: neither Microsoft " + kind + " nor LibreOffice is available on the server. " +
            "Install one of them (appsettings Publish:SofficePath points to soffice.exe).");
    }

    // ---------------- HTML ----------------
    /// Makes dir\D{id}.htm. Word / Excel use Office's own web export like the legacy publisher; everything else goes through pdf2htmlEX.
    public async Task<bool> MakeHtml(string file, DocKind kind, string pdf, string htm, Func<string, Task<string?>> cfgValue)
    {
        if (kind is DocKind.Word or DocKind.Excel && OfficeAvailable(kind))
        {
            try { await Sta(() => OfficeHtml(file, kind, htm)); if (File.Exists(htm)) return true; }
            catch (Exception ex) { log.LogWarning(ex, "Office HTML export failed for {File}", file); }
        }
        var exe = (await cfgValue("Pathpdf2htmlEX"))?.Trim();
        if (kind == DocKind.PowerPoint && (await cfgValue("EnablePPTXTOHTMLEXE"))?.Trim() == "0")
            throw new PublishException(501, "HTML for PowerPoint needs pdf2htmlEX, but the setting EnablePPTXTOHTMLEXE is 0.");
        if (!string.IsNullOrWhiteSpace(exe) && File.Exists(exe) && File.Exists(pdf))
        {
            var dir = Path.GetDirectoryName(htm)!;
            await Run(exe, new[] { "--dest-dir", dir, pdf, Path.GetFileName(htm) }, dir);
            if (File.Exists(htm)) return true;
        }
        if (kind is DocKind.Word or DocKind.Excel && Soffice() is { } so)
        {
            var dir = Path.GetDirectoryName(htm)!;
            await Run(so, new[] { "--headless", "--norestore", "--convert-to", "html", "--outdir", dir, file }, dir, LibreProfile());
            var made = Path.Combine(dir, Path.GetFileNameWithoutExtension(file) + ".html");
            if (File.Exists(made)) { File.Move(made, htm, true); return true; }
        }
        return false;
    }

    // ---------------- Office automation (late-bound COM, no interop assemblies needed) ----------------
    static dynamic NewApp(string progId) => Activator.CreateInstance(Type.GetTypeFromProgID(progId)!)!;
    static void Free(object? o) { try { if (o is not null && Marshal.IsComObject(o)) Marshal.FinalReleaseComObject(o); } catch { /* gone */ } }

    static void OfficePdf(string file, DocKind kind, string pdf)
    {
        switch (kind)
        {
            case DocKind.Word:
            {
                dynamic app = NewApp("Word.Application"); dynamic? doc = null;
                try { app.Visible = false; app.DisplayAlerts = 0; doc = app.Documents.Open(file, false, true, false); doc.ExportAsFixedFormat(pdf, 17); }
                finally { try { doc?.Close(0); } catch { } try { app.Quit(0); } catch { } Free(doc); Free(app); }
                break;
            }
            case DocKind.Excel:
            {
                dynamic app = NewApp("Excel.Application"); dynamic? wb = null;
                try { app.Visible = false; app.DisplayAlerts = false; wb = app.Workbooks.Open(file, 0, true); wb.ExportAsFixedFormat(0, pdf); }
                finally { try { wb?.Close(false); } catch { } try { app.Quit(); } catch { } Free(wb); Free(app); }
                break;
            }
            case DocKind.PowerPoint:
            {
                dynamic app = NewApp("PowerPoint.Application"); dynamic? pr = null;
                try { pr = app.Presentations.Open(file, -1, 0, 0); pr.SaveAs(pdf, 32); }
                finally { try { pr?.Close(); } catch { } try { app.Quit(); } catch { } Free(pr); Free(app); }
                break;
            }
        }
    }

    static void OfficeHtml(string file, DocKind kind, string htm)
    {
        if (kind == DocKind.Word)
        {
            dynamic app = NewApp("Word.Application"); dynamic? doc = null;
            try { app.Visible = false; app.DisplayAlerts = 0; doc = app.Documents.Open(file, false, true, false); doc.SaveAs2(htm, 10); /* wdFormatFilteredHTML */ }
            finally { try { doc?.Close(0); } catch { } try { app.Quit(0); } catch { } Free(doc); Free(app); }
        }
        else
        {
            dynamic app = NewApp("Excel.Application"); dynamic? wb = null;
            try { app.Visible = false; app.DisplayAlerts = false; wb = app.Workbooks.Open(file, 0, true); wb.SaveAs(htm, 44); /* xlHtml */ }
            finally { try { wb?.Close(false); } catch { } try { app.Quit(); } catch { } Free(wb); Free(app); }
        }
    }

    /// COM wants an STA thread. Only one Office conversion runs at a time (the publisher holds a global gate).
    static Task Sta(Action a)
    {
        var tcs = new TaskCompletionSource();
        var t = new Thread(() => { try { a(); tcs.SetResult(); } catch (Exception ex) { tcs.SetException(ex); } });
        if (OperatingSystem.IsWindows()) t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true; t.Start();
        return Task.WhenAny(tcs.Task, Task.Delay(Timeout)).ContinueWith(w =>
        {
            if (w.Result != tcs.Task) throw new PublishException(504, "Microsoft Office did not finish in " + Timeout.TotalMinutes + " minutes. Check for a dialog window on the server.");
            return tcs.Task;
        }).Unwrap();
    }

    string LibreProfile() => "-env:UserInstallation=file:///" + Path.Combine(Path.GetTempPath(), "phaselift-lo-profile").Replace('\\', '/');

    static async Task Run(string exe, string[] args, string workDir, string? extraFirstArg = null)
    {
        var psi = new ProcessStartInfo(exe) { WorkingDirectory = workDir, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (extraFirstArg is not null) psi.ArgumentList.Add(extraFirstArg);
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi) ?? throw new PublishException(500, "Could not start " + Path.GetFileName(exe));
        var so = p.StandardOutput.ReadToEndAsync(); var se = p.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(Timeout);
        try { await p.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException) { try { p.Kill(true); } catch { } throw new PublishException(504, Path.GetFileName(exe) + " did not finish in time."); }
        await Task.WhenAll(so, se);
    }
}
