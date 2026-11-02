import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  limitsSchema,
  enforceLimit,
  type TransferLimits,
} from "../shared/limits";

const IO_BYTES = 256 * 1024;
const PREFIXES = { read: "export", write: "upload" } as const;
export interface StreamRequest {
  direction: "read" | "write";
  file: string;
  wireBytes: number;
  checksum: string;
  limits?: Partial<TransferLimits>;
}

/** Only private, directly temporary, owned archive spools are transport handles. */
export async function archiveHandle(file: string, kind?: "export" | "upload") {
  const dir = path.dirname(file);
  const invalid = () =>
    new Error(
      "Transport requires this worker's private export archive or upload handle.",
    );
  if (
    path.basename(file) !== "archive.bin" ||
    !new RegExp(
      `^paseo-transfer-${kind ?? "(?:export|upload)"}-[A-Za-z0-9]{6}$`,
    ).test(path.basename(dir))
  )
    throw invalid();
  const stat = await fs.lstat(dir);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    path.dirname(await fs.realpath(dir)) !== (await fs.realpath(tmpdir()))
  )
    throw invalid();
  return dir;
}

export async function allocateUpload(
  wireBytes: number,
  limits: TransferLimits,
) {
  enforceLimit(wireBytes, limits.maxBytes, "Archive bytes");
  if (!wireBytes) throw new Error("Transfer archive must not be empty.");
  const disk = await fs.statfs(tmpdir());
  if (disk.bavail * disk.bsize < wireBytes * 3)
    throw new Error(
      "Not enough temporary disk space for archive, verification and destination.",
    );
  const dir = await fs.mkdtemp(path.join(tmpdir(), "paseo-transfer-upload-"));
  await fs.chmod(dir, 0o700);
  return { file: path.join(dir, "archive.bin") };
}

export async function releaseArchive(file: string) {
  const dir = await archiveHandle(file);
  await fs.rm(dir, { recursive: true, force: true });
  return { released: true };
}

/** Authenticated SSH stdin/stdout carries raw bytes. All buffering remains bounded. */
export async function streamArchive(
  request: StreamRequest,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
) {
  const limits = limitsSchema.parse(request.limits ?? {});
  if (!Object.hasOwn(PREFIXES, request.direction))
    throw new Error("Invalid archive stream direction.");
  enforceLimit(request.wireBytes, limits.maxBytes, "Archive bytes");
  if (!request.wireBytes || !/^[a-f0-9]{64}$/.test(request.checksum))
    throw new Error("Invalid archive stream metadata.");
  await archiveHandle(request.file, PREFIXES[request.direction]);
  const writing = request.direction === "write";
  const handle = await fs.open(
    request.file,
    writing
      ? constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW
      : constants.O_RDONLY | constants.O_NOFOLLOW,
    0o600,
  );
  let count = 0;
  const hash = createHash("sha256");
  const verify = new Transform({
    highWaterMark: IO_BYTES,
    transform(data: Buffer, _encoding, callback) {
      count += data.length;
      if (count > request.wireBytes)
        return callback(
          new Error("Archive stream exceeds its declared byte count."),
        );
      hash.update(data);
      callback(null, data);
    },
    flush(callback) {
      if (count !== request.wireBytes)
        return callback(new Error("Truncated archive stream."));
      if (hash.digest("hex") !== request.checksum)
        return callback(new Error("Archive stream checksum mismatch."));
      callback();
    },
  });
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (!writing && stat.size !== request.wireBytes)
    )
      throw new Error(
        "Archive spool is not a regular file of the declared size.",
      );
    if (writing) {
      // FileHandle streams close their own fd; close() below is safe and idempotent.
      await pipeline(
        input,
        verify,
        handle.createWriteStream({ highWaterMark: IO_BYTES }),
      );
    } else {
      await pipeline(
        handle.createReadStream({ highWaterMark: IO_BYTES }),
        verify,
        output,
      );
    }
    return { bytes: count, checksum: request.checksum };
  } catch (error) {
    if (writing) await fs.rm(request.file, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
