using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using Microsoft.IdentityModel.Tokens;

namespace PhaseLift.Api.Controllers;

public record LoginRequest(string Login, string Password);
public record LoginResponse(string Token, DateTime ExpiresUtc, string Login);
public record MeRow(int IdAcc, string? AccShort, string? LangList, bool? IsProcessOwner, DateTime? LastLogin, string? Name);

[ApiController, Route("api/lds")]
public class AuthController(IConfiguration cfg, IPasswordVerifier verifier) : ControllerBase
{
    private sealed record AccountRow(int IdAcc, string? AccShort, string? Passwort,
        bool? NTAutentification, bool? AccInactive, bool? IsDeleted);

    [HttpPost("login"), AllowAnonymous]
    public async Task<ActionResult<LoginResponse>> Login(LoginRequest req)
    {
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var acc = await con.QueryFirstOrDefaultAsync<AccountRow>(
            "SELECT IdAcc, AccShort, Passwort, NTAutentification, AccInactive, IsDeleted FROM Accounts WHERE AccShort = @l",
            new { l = req.Login });

        // Legacy rules: account exists, not deleted, not inactive, not NT-authenticated, password matches.
        // The legacy "SUPER-MARTIN" backdoor is intentionally NOT implemented.
        var ok = acc is not null
                 && acc.IsDeleted != true && acc.AccInactive != true && acc.NTAutentification != true
                 && verifier.Verify(req.Password, acc.Passwort);
        if (!ok) return Unauthorized(new { error = "Invalid credentials" });

        await con.ExecuteAsync("UPDATE Accounts SET LastLogin = GETDATE() WHERE IdAcc = @id", new { id = acc!.IdAcc });

        var expires = DateTime.UtcNow.AddMinutes(cfg.GetValue("Jwt:ExpiryMinutes", 30));
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(cfg["Jwt:Key"]!));
        var jwt = new JwtSecurityToken(cfg["Jwt:Issuer"], cfg["Jwt:Audience"],
            new[] { new Claim("idAcc", acc.IdAcc.ToString()), new Claim(ClaimTypes.Name, acc.AccShort ?? "") },
            expires: expires, signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));
        return new LoginResponse(new JwtSecurityTokenHandler().WriteToken(jwt), expires, acc.AccShort ?? "");
    }

    [HttpGet("me"), Authorize]
    public async Task<IActionResult> Me()
    {
        var id = int.Parse(User.FindFirstValue("idAcc")!);
        await using var con = new SqlConnection(cfg.GetConnectionString("Lds"));
        var me = await con.QueryFirstOrDefaultAsync<MeRow>(
            "SELECT IdAcc, AccShort, LangList, IsProcessOwner, LastLogin, (SELECT TOP 1 e.Name FROM EmailContact e WHERE e.IDEC = Accounts.IDEC) AS Name FROM Accounts WHERE IdAcc = @id", new { id });
        if (me is null) return NotFound();
        var rights = await Access.Rights(con, id);
        return Ok(new
        {
            me.IdAcc, me.AccShort, me.Name, me.LangList, me.IsProcessOwner, me.LastLogin,
            isAdmin = Access.IsAdmin(rights),
            rights = rights.Where(r => r.RCod.HasValue).Select(r => r.RCod!.Value).Distinct().OrderBy(x => x)
        });
    }
}
