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

/// In-memory publish queue: the request only puts the document in line and returns; PublishWorker publishes up to Publish:MaxParallel documents at the same time.
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

    /// Jobs waiting / publishing right now (for the notification list).
    public (int queued, int running) Counts() { int q = 0, r = 0; foreach (var j in jobs.Values) { if (j.Status == "queued") q++; else if (j.Status == "running") r++; } return (q, r); }

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

/// Takes the jobs in the order they were queued and publishes up to `Publish:MaxParallel` (default 5) documents at the same time.
/// Every further request stays queued and starts as soon as one of the running publishes is finished (a rolling window, not batches of five).
public class PublishWorker(PublishQueue queue, DocPublisher publisher, MailService mail, IConfiguration cfg, ILogger<PublishWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var max = Math.Clamp(cfg.GetValue("Publish:MaxParallel", 5), 1, 20);
        var slots = new SemaphoreSlim(max, max);
        var inflight = new System.Collections.Concurrent.ConcurrentDictionary<Task, byte>();
        log.LogInformation("Publish queue: up to {Max} documents are published at the same time", max);
        try
        {
            await foreach (var job in queue.Reader.ReadAllAsync(stop))
            {
                await slots.WaitAsync(stop);                    // all slots busy: this job (and the ones behind it) wait here, still "queued"
                var t = Task.Run(async () => { try { await RunJob(job); } finally { slots.Release(); } }, CancellationToken.None);
                inflight[t] = 0; _ = t.ContinueWith(x => inflight.TryRemove(x, out _), TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
        try { await Task.WhenAll(inflight.Keys).WaitAsync(TimeSpan.FromSeconds(20)); } catch { /* give up waiting */ }
    }

    async Task RunJob(PubJob job)
    {
        job.Status = "running"; job.StartedAt = DateTime.Now;
        try
        {
            var r = await publisher.Publish(job.IdDoc, job.Lang, job.UserId);
            job.Files = r.Files.Count; job.TagsReplaced = r.TagsReplaced; job.Warnings = r.Warnings;
            job.Status = "done";
            if (job.Mail is { Send: true } m) { job.MailStatus = "sending"; _ = Task.Run(() => mail.SendForJob(job, m)); }   // does not hold up the queue
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
