using System.Collections.Concurrent;
using System.Threading.Channels;

namespace PhaseLift.Api;

public class PubJob
{
    public string Id { get; init; } = Guid.NewGuid().ToString("N");
    public int IdDoc { get; init; }
    public string Lang { get; init; } = "";
    public string DocName { get; init; } = "";
    public string Version { get; init; } = "";
    public int UserId { get; init; }
    public string Kind { get; init; } = "publish";            // publish | relpub
    public volatile string Status = "queued";                  // queued | running | done | failed
    public DateTime QueuedAt { get; init; } = DateTime.Now;
    public DateTime? StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public string? Error { get; set; }
    public List<string> Warnings { get; set; } = new();
    public int Files { get; set; }
    public int TagsReplaced { get; set; }
    public bool Dismissed { get; set; }
    public MailPayload? Mail { get; set; }           // publish e-mail composed in the release/publish window; sent after the publish succeeded
    public volatile string? MailStatus;               // null | sending | waiting until HH:mm | sent | failed
    public string? MailError { get; set; }
}

/// In-memory publish queue: the request only puts the document in line and returns; PublishWorker publishes one document after the other.
/// (Jobs are lost when the API restarts - the published documents themselves are in the database, so the notification list survives.)
public class PublishQueue
{
    readonly Channel<PubJob> ch = Channel.CreateUnbounded<PubJob>();
    readonly ConcurrentDictionary<string, PubJob> jobs = new();
    public ChannelReader<PubJob> Reader => ch.Reader;

    public PubJob Enqueue(int idDoc, string lang, string name, string version, int user, string kind, MailPayload? mail = null)
    {
        // the same document/language is never queued twice
        var open = jobs.Values.FirstOrDefault(j => j.IdDoc == idDoc && j.Lang == lang && j.Status is "queued" or "running");
        if (open is not null) { open.Mail ??= mail; return open; }
        var job = new PubJob { IdDoc = idDoc, Lang = lang, DocName = name, Version = version, UserId = user, Kind = kind, Mail = mail };
        jobs[job.Id] = job;
        ch.Writer.TryWrite(job);
        return job;
    }

    public int Position(PubJob j) => j.Status == "queued" ? jobs.Values.Count(x => x.Status == "queued" && x.QueuedAt <= j.QueuedAt) : 0;

    public IEnumerable<PubJob> For(int user) => jobs.Values.Where(j => j.UserId == user && !j.Dismissed).OrderByDescending(j => j.QueuedAt);

    public bool Dismiss(int user, string id)
    {
        if (!jobs.TryGetValue(id, out var j) || j.UserId != user || j.Status is "queued" or "running") return false;
        j.Dismissed = true; return true;
    }
    public void DismissAll(int user) { foreach (var j in jobs.Values.Where(j => j.UserId == user && j.Status is "done" or "failed")) j.Dismissed = true; }

    public void Cleanup()
    {
        foreach (var j in jobs.Values.Where(j => j.FinishedAt is { } f && f < DateTime.Now.AddHours(-24)).ToList()) jobs.TryRemove(j.Id, out _);
    }
}

public class PublishWorker(PublishQueue queue, DocPublisher publisher, MailService mail, ILogger<PublishWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        try
        {
            await foreach (var job in queue.Reader.ReadAllAsync(stop))
            {
                job.Status = "running"; job.StartedAt = DateTime.Now;
                try
                {
                    var r = await publisher.Publish(job.IdDoc, job.Lang, job.UserId);
                    job.Files = r.Files.Count; job.TagsReplaced = r.TagsReplaced; job.Warnings = r.Warnings;
                    job.Status = "done";
                    if (job.Mail is { Send: true } m) { job.MailStatus = "sending"; var j2 = job; _ = Task.Run(() => mail.SendForJob(j2, m)); }   // does not hold up the queue
                    log.LogInformation("Published D{Id} ({Lang}) with {Files} files", job.IdDoc, job.Lang, job.Files);
                }
                catch (PublishException ex) { job.Error = ex.Message; job.Status = "failed"; log.LogWarning("Publish D{Id} ({Lang}) failed: {Msg}", job.IdDoc, job.Lang, ex.Message); }
                catch (Exception ex)
                {
                    job.Error = ex is IOException or UnauthorizedAccessException ? "A file could not be written on the server (web folder or temp folder): " + ex.Message : ex.GetBaseException().Message;
                    job.Status = "failed"; log.LogError(ex, "Publish D{Id} ({Lang}) failed", job.IdDoc, job.Lang);
                }
                job.FinishedAt = DateTime.Now;
                queue.Cleanup();
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }
}
