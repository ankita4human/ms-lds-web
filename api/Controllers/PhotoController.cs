using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace PhaseLift.Api.Controllers;

public class PhotoBody { public IFormFile? File { get; set; } }

/// Profile photos. The database has no photo column, so the files live in a folder of the API (Photos:Path, default App_Data/photos) as <IdAcc>.jpg.
/// The browser scales the picture to 256x256 JPEG before it is sent; the server accepts JPEG only and at most 300 KB.
[ApiController, Route("api/lds"), Authorize]
public class PhotoController(IConfiguration cfg, IWebHostEnvironment env) : ControllerBase
{
    const int MaxBytes = 300 * 1024;
    int Acc => int.Parse(User.FindFirstValue("idAcc")!);
    string Dir()
    {
        var d = cfg["Photos:Path"];
        if (string.IsNullOrWhiteSpace(d)) d = Path.Combine(env.ContentRootPath, "App_Data", "photos");
        Directory.CreateDirectory(d);
        return d;
    }
    string FileOf(int id) => Path.Combine(Dir(), $"{id}.jpg");

    /// 200 image/jpeg, or 204 when the user has no photo (so the browser shows the default silhouette).
    [HttpGet("users/{id:int}/photo")]
    public IActionResult Get(int id)
    {
        var f = FileOf(id);
        if (!System.IO.File.Exists(f)) return NoContent();
        Response.Headers.CacheControl = "private, no-cache";
        return PhysicalFile(f, "image/jpeg", enableRangeProcessing: false);
    }

    [HttpPut("me/photo"), RequestSizeLimit(MaxBytes + 64 * 1024), RequestFormLimits(MultipartBodyLengthLimit = MaxBytes + 64 * 1024)]
    public async Task<IActionResult> Put([FromForm] PhotoBody b)
    {
        var file = b.File;
        if (file is null || file.Length == 0) return BadRequest(new { error = "Choose a picture." });
        if (file.Length > MaxBytes) return BadRequest(new { error = "The picture is too large (300 KB at most)." });
        await using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var bytes = ms.ToArray();
        if (bytes.Length < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[2] != 0xFF) return BadRequest(new { error = "Only JPEG pictures are accepted." });
        try { await System.IO.File.WriteAllBytesAsync(FileOf(Acc), bytes); }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException) { return StatusCode(500, new { error = "The API may not write to the photo folder (Photos:Path). " + ex.Message }); }
        return Ok(new { saved = true });
    }

    [HttpDelete("me/photo")]
    public IActionResult Delete()
    {
        try { var f = FileOf(Acc); if (System.IO.File.Exists(f)) System.IO.File.Delete(f); }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException) { return StatusCode(500, new { error = ex.Message }); }
        return Ok(new { removed = true });
    }
}
