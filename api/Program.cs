using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

// Secrets come from environment variables / user-secrets, never from files in the repo:
//   ConnectionStrings__Lds   = Server=...;Database=...;User Id=...;Password=...;TrustServerCertificate=True
//   Jwt__Key                 = at least 32 random characters
var jwtKey = builder.Configuration["Jwt:Key"]
    ?? throw new InvalidOperationException("Set Jwt__Key (>= 32 chars) via environment or user-secrets.");
if (jwtKey.Length < 32) throw new InvalidOperationException("Jwt:Key must be at least 32 characters.");
if (string.IsNullOrWhiteSpace(builder.Configuration.GetConnectionString("Lds")))
    throw new InvalidOperationException("Set ConnectionStrings__Lds via environment or user-secrets.");

// Dapper returns rows as dictionaries; camel-case their keys so the client sees idDoc, docName, etc.
builder.Services.AddControllers().AddJsonOptions(o =>
    o.JsonSerializerOptions.DictionaryKeyPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);
builder.Services.AddMemoryCache();
builder.Services.AddResponseCompression();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSingleton<PhaseLift.Api.IPasswordVerifier, PhaseLift.Api.LegacyPasswordVerifier>();
builder.Services.AddSingleton<PhaseLift.Api.DocConverter>();
builder.Services.AddSingleton<PhaseLift.Api.DocPublisher>();
builder.Services.AddSingleton<PhaseLift.Api.MailService>();
builder.Services.AddSingleton<PhaseLift.Api.PublishQueue>();
builder.Services.AddHostedService<PhaseLift.Api.PublishWorker>();
builder.Services.AddSingleton<PhaseLift.Api.DocTextIndex>();
builder.Services.AddSingleton<PhaseLift.Api.DocIndexWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<PhaseLift.Api.DocIndexWorker>());
builder.Services.AddHostedService<PhaseLift.Api.Controllers.ExpiryWorker>();
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true, ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidateAudience = true, ValidAudience = builder.Configuration["Jwt:Audience"],
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
        ClockSkew = TimeSpan.FromSeconds(30)
    };
});
builder.Services.AddAuthorization();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? Array.Empty<string>())
    .AllowAnyHeader().AllowAnyMethod().WithExposedHeaders("Content-Disposition", "X-File-Name")));

var app = builder.Build();
if (app.Environment.IsDevelopment()) { app.UseSwagger(); app.UseSwaggerUI(); }
app.UseResponseCompression();
app.UseCors();   // before the error handler so error responses still carry CORS headers
app.Use(async (ctx, next) =>
{   // Log slow requests so we can see exactly which call is slow.
    var sw = System.Diagnostics.Stopwatch.StartNew();
    try { await next(); }
    catch (Exception ex) when (ctx.Request.Path.StartsWithSegments("/api"))
    {   // One clear line in the console naming the failing call and the real cause.
        app.Logger.LogError(ex, "API ERROR {Method} {Path}{Query}: {Message}", ctx.Request.Method, ctx.Request.Path, ctx.Request.QueryString, ex.GetBaseException().Message);
        if (!ctx.Response.HasStarted)
        {
            ctx.Response.StatusCode = 500;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsJsonAsync(new { error = ex.GetBaseException().Message });
        }
    }
    if (sw.ElapsedMilliseconds > 300 && ctx.Request.Path.StartsWithSegments("/api"))
        app.Logger.LogWarning("SLOW {Method} {Path}{Query} {Ms} ms", ctx.Request.Method, ctx.Request.Path, ctx.Request.QueryString, sw.ElapsedMilliseconds);
});
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.Run();
