[CmdletBinding()]
param(
    [string] $DataDir = (Join-Path $env:APPDATA 'com.imagerelay.studio\data'),
    [string] $OutputDir = [Environment]::GetFolderPath('DesktopDirectory'),
    [string] $Title = '',
    [switch] $ExportBackup,
    [string] $RestoreFrom = ''
)

$ErrorActionPreference = 'Stop'

function Get-DatabaseFileState($directory, $names) {
    foreach ($name in $names) {
        $file = Get-Item -LiteralPath (Join-Path $directory $name) -ErrorAction SilentlyContinue
        if ($file) { '{0}:{1}:{2}' -f $name, $file.Length, $file.LastWriteTimeUtc.Ticks }
    }
}

function Resolve-DatabaseDirectory($directory) {
    if (-not (Test-Path -LiteralPath (Join-Path $directory 'app.db') -PathType Leaf)) {
        throw "在 $directory 找不到 app.db。请检查数据目录。"
    }
    (Get-Item -LiteralPath $directory).FullName
}

function Assert-ChatCanvasClosed($databaseDirectory) {
    $installedDir = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'com.imagerelay.studio\data'))
    if ($databaseDirectory -eq $installedDir -and (Get-Process -Name @('ChatCanvas', 'image_relay_studio', 'ezcanvas') -ErrorAction SilentlyContinue)) {
        throw '请先保留找回文件夹，再完全退出 ChatCanvas，然后运行恢复命令。'
    }
}

function Copy-DatabaseFiles($from, $to) {
    [IO.Directory]::CreateDirectory($to) | Out-Null
    $names = @('app.db', 'app.db-wal', 'app.db-shm')
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        # SHM is preserved alongside the database but is not needed to replay the WAL.
        $before = @(Get-DatabaseFileState $from $names[0..1]) -join '|'
        foreach ($name in $names) {
            $inputFile = Join-Path $from $name
            $outputFile = Join-Path $to $name
            if (Test-Path -LiteralPath $inputFile -PathType Leaf) {
                [IO.File]::Copy($inputFile, $outputFile, $true)
            } elseif (Test-Path -LiteralPath $outputFile -PathType Leaf) {
                [IO.File]::Delete($outputFile)
            }
        }
        $after = @(Get-DatabaseFileState $from $names[0..1]) -join '|'
        if ($before -eq $after) { return }
    }
    throw "文件在复制时发生变化。请暂停使用 ChatCanvas 后再试。副本目录 $to"
}

$target = ''
$sourceDir = $DataDir
if ($RestoreFrom) {
    $target = Resolve-DatabaseDirectory $DataDir
    Assert-ChatCanvasClosed $target
    $sourceDir = $RestoreFrom
    if (Test-Path -LiteralPath (Join-Path $RestoreFrom 'database-copy\app.db') -PathType Leaf) {
        $sourceDir = Join-Path $RestoreFrom 'database-copy'
    }
}
$source = Resolve-DatabaseDirectory $sourceDir
if ($target -and $source -eq $target) { throw '请用 -RestoreFrom 指定之前保存的找回文件夹。' }
$outputParent = [IO.Path]::GetFullPath($OutputDir)
$result = Join-Path $outputParent ('ChatCanvas-Recovery-{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), [guid]::NewGuid().ToString('N').Substring(0, 6))
$copy = Join-Path $result 'database-copy'
foreach ($directory in @($source, $target)) {
    if ($directory -and $result.StartsWith($directory.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '请将导出目录选在原始数据目录之外。'
    }
}
Copy-DatabaseFiles $source $copy
Write-Host "数据库副本已保存到 $copy"
Write-Host '正在检查副本，请等待。'

if (-not ('ChatCanvasRecovery' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

public static class ChatCanvasRecovery {
    private const string Sqlite = "winsqlite3.dll";
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_open_v2(byte[] name, out IntPtr db, int flags, IntPtr vfs);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_close(IntPtr db);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int bytes, out IntPtr statement, IntPtr tail);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_bind_text(IntPtr statement, int index, byte[] text, int bytes, IntPtr destructor);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_finalize(IntPtr statement);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_step(IntPtr statement);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_column_count(IntPtr statement);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_column_bytes(IntPtr statement, int column);
    [DllImport(Sqlite, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr sqlite3_errmsg(IntPtr db);

    private sealed class Database : IDisposable {
        private IntPtr handle;

        public Database(string path, bool writable = false) {
            if (sqlite3_open_v2(Encoding.UTF8.GetBytes(path + "\0"), out handle, writable ? 2 : 1, IntPtr.Zero) == 0) return;
            Dispose();
            throw new InvalidDataException("Cannot open the database snapshot.");
        }

        public List<string[]> Query(string sql, params string[] args) {
            IntPtr statement;
            if (sqlite3_prepare_v2(handle, Encoding.UTF8.GetBytes(sql + "\0"), -1, out statement, IntPtr.Zero) != 0) {
                throw new InvalidDataException(Marshal.PtrToStringAnsi(sqlite3_errmsg(handle)));
            }
            try {
                for (int index = 0; index < args.Length; index++) {
                    var bytes = Encoding.UTF8.GetBytes(args[index] + "\0");
                    if (sqlite3_bind_text(statement, index + 1, bytes, bytes.Length - 1, new IntPtr(-1)) != 0) {
                        throw new InvalidDataException(Marshal.PtrToStringAnsi(sqlite3_errmsg(handle)));
                    }
                }
                var rows = new List<string[]>();
                int status;
                while ((status = sqlite3_step(statement)) == 100) {
                    var row = new string[sqlite3_column_count(statement)];
                    for (int column = 0; column < row.Length; column++) {
                        IntPtr text = sqlite3_column_text(statement, column);
                        var bytes = new byte[sqlite3_column_bytes(statement, column)];
                        if (bytes.Length != 0) Marshal.Copy(text, bytes, 0, bytes.Length);
                        row[column] = Encoding.UTF8.GetString(bytes);
                    }
                    rows.Add(row);
                }
                if (status != 101) throw new InvalidDataException(Marshal.PtrToStringAnsi(sqlite3_errmsg(handle)));
                return rows;
            } finally { sqlite3_finalize(statement); }
        }

        public void Dispose() { if (handle != IntPtr.Zero) sqlite3_close(handle); }
    }

    private sealed class Frame {
        public uint Page, CommitPages;
        public long DataOffset;
    }

    internal sealed class Transcript {
        public string Title, Channel, Model, CreatedAt;
        public List<string[]> Messages;
    }

    public sealed class RecoveryResult {
        internal readonly Dictionary<Guid, Transcript> Chats = new Dictionary<Guid, Transcript>();
        public int Count { get { return Chats.Count; } }
    }

    private static uint Word(byte[] data, int i, bool bigEndian = true) {
        if (!bigEndian) return (uint)data[i] | (uint)data[i + 1] << 8 | (uint)data[i + 2] << 16 | (uint)data[i + 3] << 24;
        return (uint)data[i] << 24 | (uint)data[i + 1] << 16 | (uint)data[i + 2] << 8 | data[i + 3];
    }

    private static void Checksum(byte[] data, int count, bool bigEndian, ref uint first, ref uint second) {
        unchecked {
            for (int i = 0; i < count; i += 8) {
                first += Word(data, i, bigEndian) + second;
                second += Word(data, i + 4, bigEndian) + first;
            }
        }
    }

    private static void ReadExactly(Stream stream, byte[] bytes) {
        for (int offset = 0; offset < bytes.Length;) {
            int count = stream.Read(bytes, offset, bytes.Length - offset);
            if (count == 0) throw new EndOfStreamException();
            offset += count;
        }
    }

    private static List<Frame> CommittedFrames(FileStream wal, int pageSize) {
        var frames = new List<Frame>();
        if (wal == null || wal.Length < 32) return frames;
        var header = new byte[32];
        ReadExactly(wal, header);
        uint magic = Word(header, 0);
        if ((magic != 0x377f0682 && magic != 0x377f0683) || Word(header, 4) != 3007000 || Word(header, 8) != pageSize) {
            throw new InvalidDataException("The database and WAL header do not match.");
        }
        bool bigEndian = magic == 0x377f0683;
        uint first = 0, second = 0;
        Checksum(header, 24, bigEndian, ref first, ref second);
        if (first != Word(header, 24) || second != Word(header, 28)) throw new InvalidDataException("Invalid WAL header checksum.");

        var frame = new byte[24];
        var page = new byte[pageSize];
        int committed = 0;
        while (wal.Length - wal.Position >= frame.Length + page.Length) {
            ReadExactly(wal, frame);
            uint pageNumber = Word(frame, 0);
            if (pageNumber == 0 || Word(header, 16) != Word(frame, 8) || Word(header, 20) != Word(frame, 12)) break;
            long dataOffset = wal.Position;
            ReadExactly(wal, page);
            Checksum(frame, 8, bigEndian, ref first, ref second);
            Checksum(page, page.Length, bigEndian, ref first, ref second);
            if (first != Word(frame, 16) || second != Word(frame, 20)) break;
            uint commitPages = Word(frame, 4);
            frames.Add(new Frame { Page = pageNumber, CommitPages = commitPages, DataOffset = dataOffset });
            if (commitPages != 0) committed = frames.Count;
        }
        frames.RemoveRange(committed, frames.Count - committed);
        return frames;
    }

    private static void ApplyFrame(FileStream wal, FileStream snapshot, byte[] page, Frame frame) {
        wal.Position = frame.DataOffset;
        ReadExactly(wal, page);
        if (frame.Page == 1) page[18] = page[19] = 1;
        snapshot.Position = (frame.Page - 1L) * page.Length;
        snapshot.Write(page, 0, page.Length);
        if (frame.CommitPages != 0) snapshot.SetLength((long)frame.CommitPages * page.Length);
    }

    private static void InitSnapshot(string source, string snapshot) {
        File.Copy(source, snapshot, true);
        using (var writer = new FileStream(snapshot, FileMode.Open, FileAccess.Write)) {
            writer.Position = 18;
            writer.WriteByte(1);
            writer.WriteByte(1);
        }
    }

    private static List<string[]> Conversations(Database db) {
        return db.Query("SELECT id, title, brain_channel_id, brain_model, created_at FROM conversations WHERE kind = 'chat'");
    }

    private static void CollectSnapshot(string snapshot, string titleFilter, HashSet<string> liveIds,
        RecoveryResult recovered) {
        using (var db = new Database(snapshot)) {
            foreach (var chat in Conversations(db)) {
                Guid id;
                if (!Guid.TryParse(chat[0], out id) || liveIds.Contains(chat[0])) continue;
                if (titleFilter.Length != 0 && chat[1].IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var messages = db.Query("SELECT role, created_at, content FROM messages WHERE conversation_id = ?" +
                    " AND role IN ('user','assistant') AND length(trim(content)) > 0 ORDER BY seq, rowid", chat[0]);
                Transcript previous;
                if (messages.Count == 0 || (recovered.Chats.TryGetValue(id, out previous) && previous.Messages.Count > messages.Count)) continue;
                recovered.Chats[id] = new Transcript { Title = chat[1], Channel = chat[2], Model = chat[3], CreatedAt = chat[4], Messages = messages };
            }
        }
    }

    public static RecoveryResult Recover(string source, string output, string titleFilter, bool exportBackup) {
        var header = new byte[100];
        using (var db = File.OpenRead(Path.Combine(source, "app.db"))) ReadExactly(db, header);
        if (Encoding.ASCII.GetString(header, 0, 16) != "SQLite format 3\0") throw new InvalidDataException("Invalid SQLite database header.");
        int pageSize = header[16] * 256 + header[17];
        if (pageSize == 1) pageSize = 65536;
        if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) != 0) throw new InvalidDataException("Invalid SQLite page size.");

        string database = Path.Combine(source, "app.db");
        string walPath = database + "-wal";
        string snapshot = Path.Combine(output, "working.db");
        var live = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var recovered = new RecoveryResult();
        try {
            using (var wal = File.Exists(walPath) ? File.OpenRead(walPath) : null) {
                var frames = CommittedFrames(wal, pageSize);
                if (!exportBackup && frames.Count == 0) return recovered;
                var page = new byte[pageSize];
                InitSnapshot(database, snapshot);
                using (var writer = new FileStream(snapshot, FileMode.Open, FileAccess.Write)) {
                    foreach (var frame in frames) ApplyFrame(wal, writer, page, frame);
                }
                if (exportBackup) {
                    CollectSnapshot(snapshot, titleFilter, live, recovered);
                } else {
                    // The latest committed state identifies which conversations still exist.
                    using (var current = new Database(snapshot)) {
                        foreach (var chat in Conversations(current)) live.Add(chat[0]);
                    }
                    InitSnapshot(database, snapshot);
                    // If deletion was the first WAL transaction, the base file is the only pre-delete state.
                    try { CollectSnapshot(snapshot, titleFilter, live, recovered); }
                    catch (InvalidDataException) { /* Some base pages may need WAL frames. */ }
                    using (var writer = new FileStream(snapshot, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
                        for (int i = 0; i < frames.Count - 1; i++) {
                            var frame = frames[i];
                            ApplyFrame(wal, writer, page, frame);
                            if (frame.CommitPages == 0) continue;
                            writer.Flush();
                            try { CollectSnapshot(snapshot, titleFilter, live, recovered); }
                            catch (InvalidDataException) { /* The base file may already contain later pages. */ }
                        }
                    }
                }
            }
        } finally { File.Delete(snapshot); }
        foreach (var chat in recovered.Chats) {
            var text = new StringBuilder().AppendLine(chat.Value.Title).AppendLine(chat.Key.ToString("D")).AppendLine();
            foreach (var row in chat.Value.Messages) text.Append(row[1]).Append("  ").AppendLine(row[0] == "user" ? "用户" : "助手").AppendLine(row[2]).AppendLine();
            File.WriteAllText(Path.Combine(output, chat.Key.ToString("D") + ".txt"), text.ToString(), new UTF8Encoding(true));
        }
        return recovered;
    }

    private static string RestoredId(Guid original) {
        using (var hash = SHA256.Create()) {
            var bytes = hash.ComputeHash(Encoding.UTF8.GetBytes("chatcanvas-transcript-restore:" + original.ToString("D")));
            var uuid = new byte[16];
            Array.Copy(bytes, uuid, uuid.Length);
            uuid[7] = (byte)((uuid[7] & 0x0f) | 0x80);
            uuid[8] = (byte)((uuid[8] & 0x3f) | 0x80);
            return new Guid(uuid).ToString("D");
        }
    }

    public static int Restore(RecoveryResult recovered, string target) {
        int restored = 0;
        using (var db = new Database(target, true)) {
            db.Query("PRAGMA foreign_keys = ON");
            db.Query("BEGIN IMMEDIATE");
            try {
                foreach (var chat in recovered.Chats) {
                    var transcript = chat.Value;
                    string id = RestoredId(chat.Key);
                    if (db.Query("SELECT id FROM conversations WHERE id IN (?, ?)", chat.Key.ToString("D"), id).Count != 0) continue;
                    string now = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
                    db.Query("INSERT INTO conversations (id,title,kind,brain_channel_id,brain_model,canvas_asset_ids,status,created_at,updated_at)" +
                        " VALUES (?, ?, 'chat', ?, ?, '[]', 'idle', ?, ?)", id, "已恢复 · " + transcript.Title,
                        transcript.Channel, transcript.Model, transcript.CreatedAt, now);
                    for (int i = 0; i < transcript.Messages.Count; i++) {
                        var message = transcript.Messages[i];
                        db.Query("INSERT INTO messages (id, conversation_id, seq, role, created_at, content, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')",
                            Guid.NewGuid().ToString("D"), id, (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), message[0], message[1], message[2]);
                    }
                    restored++;
                }
                db.Query("COMMIT");
            } catch {
                try { db.Query("ROLLBACK"); } catch (InvalidDataException) { }
                throw;
            }
        }
        return restored;
    }
}
'@
}

$recovery = [ChatCanvasRecovery]::Recover($copy, $result, $Title, $ExportBackup.IsPresent)
if ($recovery.Count -gt 0) {
    Write-Host "已导出 $($recovery.Count) 个会话的文字。目录 $result"
    if ($target) {
        Assert-ChatCanvasClosed $target
        $beforeRestore = Join-Path $result 'before-restore'
        Copy-DatabaseFiles $target $beforeRestore
        Write-Host "写入前的数据库备份已保存到 $beforeRestore"
        Assert-ChatCanvasClosed $target
        $restored = [ChatCanvasRecovery]::Restore($recovery, (Join-Path $target 'app.db'))
        Write-Host "已写入 $restored 个会话。已存在的会话已跳过。"
        if ($restored -gt 0) { Write-Host '重新打开 ChatCanvas，即可在侧栏找到「已恢复 · 原标题」。' }
    }
    Write-Host '找回的文字可能不完整。附件和工具记录不包含在恢复结果中。'
} elseif ($ExportBackup) {
    Write-Host "备份中没有符合条件的会话文字。目录 $result"
} else {
    Write-Host "现有数据库副本和事务日志里未找到可导出的已删会话文字。目录 $result"
    Write-Host '若有删除前的备份，可用 -DataDir <备份目录> -ExportBackup 导出其中的聊天文字。'
}
