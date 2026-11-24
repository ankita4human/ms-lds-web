namespace PhaseLift.Api;

public interface IPasswordVerifier
{
    bool Verify(string typed, string? stored);
}

/// TEMPORARY. The legacy app compares the typed password with Accounts.Passwort directly.
/// This keeps existing users able to sign in. It must be replaced by a hash-upgrade flow
/// (side table + PasswordHasher) once the storage format and migration path are approved.
/// See docs/lds-findings.md S2. Do not extend this class.
public sealed class LegacyPasswordVerifier : IPasswordVerifier
{
    public bool Verify(string typed, string? stored)
    {
        if (string.IsNullOrEmpty(stored) || string.IsNullOrEmpty(typed)) return false;
        var a = System.Text.Encoding.UTF8.GetBytes(typed);
        var b = System.Text.Encoding.UTF8.GetBytes(stored);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(a, b);
    }
}
