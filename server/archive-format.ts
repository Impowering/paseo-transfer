import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { enforceLimit, type TransferLimits } from "../shared/limits";

const MAGIC = Buffer.from("PASEO-TRANSFER-2\n");
const IO_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export interface BlobRef {
  id: number;
  bytes: number;
  sha256: string;
}

export async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: IO_BYTES }))
    hash.update(chunk);
  return hash.digest("hex");
}

/** Frames contain a small JSON header and a length-delimited raw body, never base64. */
export async function archiveWriter(file: string, limits: TransferLimits) {
  const output = await fs.open(file, "wx", 0o600);
  const wire = createHash("sha256");
  let wireBytes = 0,
    bytes = 0,
    sequence = 0;
  async function write(buffer: Buffer) {
    enforceLimit(wireBytes + buffer.length, limits.maxBytes, "Archive bytes");
    let offset = 0;
    while (offset < buffer.length)
      offset += (await output.write(buffer, offset)).bytesWritten;
    wire.update(buffer);
    wireBytes += buffer.length;
  }
  async function header(value: object) {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > MAX_HEADER_BYTES)
      throw new Error("Archive header is too large.");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    await write(size);
    await write(data);
  }
  try {
    await write(MAGIC);
  } catch (error) {
    await output.close();
    throw error;
  }
  return {
    async add(source: string): Promise<BlobRef> {
      const before = await fs.stat(source);
      enforceLimit(before.size, limits.maxFileBytes, "File bytes");
      enforceLimit(bytes + before.size, limits.maxBytes, "Workspace bytes");
      const ref = { id: sequence++, bytes: before.size, sha256: "" };
      await header({ type: "blob", id: ref.id, bytes: ref.bytes });
      const hash = createHash("sha256");
      let written = 0;
      for await (const chunk of createReadStream(source, {
        highWaterMark: IO_BYTES,
      })) {
        written += chunk.length;
        if (written > before.size)
          throw new Error("Source file changed during transfer preparation.");
        hash.update(chunk);
        await write(chunk);
      }
      const after = await fs.stat(source);
      if (
        written !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== after.ino
      )
        throw new Error("Source file changed during transfer preparation.");
      ref.sha256 = hash.digest("hex");
      bytes += written;
      await header({ type: "digest", ...ref });
      return ref;
    },
    async finish(manifest: object) {
      const data = Buffer.from(JSON.stringify(manifest));
      if (data.length > MAX_MANIFEST_BYTES)
        throw new Error("Archive metadata exceeds the bounded manifest size.");
      const fingerprint = createHash("sha256").update(data).digest("hex");
      await header({ type: "manifest", bytes: data.length });
      await write(data);
      await header({ type: "end", fingerprint });
      await output.close();
      return { fingerprint, checksum: wire.digest("hex"), wireBytes, bytes };
    },
    close: () => output.close(),
  };
}

async function exact(input: FileHandle, count: number) {
  const data = Buffer.alloc(count);
  let position = 0;
  while (position < count) {
    const read = await input.read(data, position, count - position);
    if (!read.bytesRead) throw new Error("Truncated transfer archive.");
    position += read.bytesRead;
  }
  return data;
}

/** Extract only numbered private blobs. Manifest paths never participate in spool extraction. */
export async function unpackArchive(
  file: string,
  directory: string,
  limits: TransferLimits,
) {
  const input = await fs.open(file, "r");
  const blobs = new Map<number, { file: string; ref: BlobRef }>();
  let pending: { file: string; ref: BlobRef } | null = null;
  let manifest: unknown,
    fingerprint = "",
    total = 0;
  try {
    if (!(await exact(input, MAGIC.length)).equals(MAGIC))
      throw new Error("Unsupported transfer archive.");
    while (true) {
      const length = (await exact(input, 4)).readUInt32BE();
      if (!length || length > MAX_HEADER_BYTES)
        throw new Error("Invalid archive header size.");
      const record = JSON.parse((await exact(input, length)).toString());
      if (record.type === "blob") {
        if (
          manifest ||
          pending ||
          record.id !== blobs.size ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 0
        )
          throw new Error("Invalid or duplicate archive blob.");
        enforceLimit(record.bytes, limits.maxFileBytes, "File bytes");
        enforceLimit(total + record.bytes, limits.maxBytes, "Workspace bytes");
        const target = path.join(directory, String(record.id));
        const output = await fs.open(target, "wx", 0o600);
        const hash = createHash("sha256");
        try {
          let remaining = record.bytes;
          while (remaining) {
            const data = await exact(input, Math.min(remaining, IO_BYTES));
            let offset = 0;
            while (offset < data.length)
              offset += (await output.write(data, offset)).bytesWritten;
            hash.update(data);
            remaining -= data.length;
          }
        } finally {
          await output.close();
        }
        total += record.bytes;
        pending = {
          file: target,
          ref: {
            id: record.id,
            bytes: record.bytes,
            sha256: hash.digest("hex"),
          },
        };
      } else if (record.type === "digest") {
        if (
          !pending ||
          record.id !== pending.ref.id ||
          record.bytes !== pending.ref.bytes ||
          record.sha256 !== pending.ref.sha256
        )
          throw new Error("Transfer blob checksum mismatch.");
        blobs.set(record.id, pending);
        pending = null;
      } else if (record.type === "manifest") {
        if (
          pending ||
          manifest ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 1 ||
          record.bytes > MAX_MANIFEST_BYTES
        )
          throw new Error("Invalid archive manifest.");
        const data = await exact(input, record.bytes);
        fingerprint = createHash("sha256").update(data).digest("hex");
        manifest = JSON.parse(data.toString());
      } else if (record.type === "end") {
        if (!manifest || pending || record.fingerprint !== fingerprint)
          throw new Error("Transfer manifest checksum mismatch.");
        if ((await input.read(Buffer.alloc(1))).bytesRead)
          throw new Error("Trailing data in transfer archive.");
        return { manifest, blobs, fingerprint, bytes: total };
      } else throw new Error("Unknown transfer archive frame.");
    }
  } finally {
    await input.close();
  }
}
