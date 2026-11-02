import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { defaultLimits } from "../shared/limits";
import {
  allocateUpload,
  streamArchive,
  releaseArchive,
} from "../server/archive-stream";
import { copyArchive, invoke } from "../server/transport";
import { hashFile } from "../server/archive-format";
import { sshFixture } from "../scripts/ssh-fixture";

const sum = (data: Buffer) => createHash("sha256").update(data).digest("hex");
test("stream receiver checks byte count, checksum and policy before retaining an upload", async () => {
  const data = Buffer.from("small binary payload\0\xff");
  const request = {
    direction: "write" as const,
    wireBytes: data.length,
    checksum: sum(data),
  };
  const { file } = await allocateUpload(data.length, defaultLimits);
  const discard = new Writable({
    write(_data, _encoding, done) {
      done();
    },
  });
  try {
    await assert.rejects(
      streamArchive(
        { ...request, file },
        Readable.from([data.subarray(0, 3)]),
        discard,
      ),
      /Truncated/,
    );
    await assert.rejects(fs.access(file));
    await assert.rejects(
      streamArchive(
        { ...request, file, checksum: "0".repeat(64) },
        Readable.from([data]),
        discard,
      ),
      /checksum mismatch/,
    );
    await assert.rejects(fs.access(file));
    await assert.rejects(
      streamArchive(
        { ...request, file, wireBytes: 1 },
        Readable.from([data]),
        discard,
      ),
      /exceeds/,
    );
    await assert.rejects(fs.access(file));
    await assert.rejects(
      streamArchive(
        { ...request, file, limits: { maxBytes: 1 } },
        Readable.from([data]),
        discard,
      ),
      /configured transfer limit/,
    );
    await assert.rejects(fs.access(file));
    await streamArchive({ ...request, file }, Readable.from([data]), discard);
    assert.deepEqual(await fs.readFile(file), data);
    await assert.rejects(
      streamArchive({ ...request, file }, Readable.from([data]), discard),
      /EEXIST/,
    );
  } finally {
    await releaseArchive(file);
  }
});

test("raw streams exceed former daemon buffers over local/SSH and SSH/SSH with pinned keys", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "transfer-stream-test-"));
  const fixture = await sshFixture(root, { ...process.env });
  const local = { target: "" };
  const remote = {
    target: "127.0.0.1",
    port: fixture.port,
    identityFile: fixture.key,
    knownHostsFile: fixture.known,
  };
  const sourceDir = await fs.mkdtemp(
    path.join(tmpdir(), "paseo-transfer-export-"),
  );
  await fs.chmod(sourceDir, 0o700);
  const file = path.join(sourceDir, "archive.bin");
  const handle = await fs.open(file, "wx", 0o600);
  const wireBytes = 257 * 1024 * 1024;
  await handle.truncate(wireBytes);
  await handle.write(Buffer.from("binary\0archive"), 0, 14, 0);
  await handle.close();
  const archive = { file, wireBytes, checksum: await hashFile(file) };
  try {
    for (const [source, target] of [
      [local, remote],
      [remote, local],
      [remote, remote],
    ]) {
      const upload = await invoke<{ file: string }>(target, {
        action: "archive-upload",
        wireBytes,
      });
      try {
        await copyArchive(source, target, archive, upload.file);
        assert.equal((await fs.stat(upload.file)).size, wireBytes);
        assert.equal(await hashFile(upload.file), archive.checksum);
      } finally {
        await invoke(target, { action: "archive-release", file: upload.file });
      }
    }
    const upload = await invoke<{ file: string }>(remote, {
      action: "archive-upload",
      wireBytes,
    });
    try {
      await assert.rejects(
        copyArchive(
          local,
          remote,
          { ...archive, checksum: "0".repeat(64) },
          upload.file,
        ),
      );
      assert.equal(await hashFile(file), archive.checksum);
    } finally {
      await invoke(remote, { action: "archive-release", file: upload.file });
    }
    await assert.rejects(fs.access(upload.file));
    await assert.rejects(
      invoke(
        { ...remote, knownHostsFile: path.join(root, "missing-host-key") },
        { action: "info" },
      ),
      /Host key verification failed/,
    );
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
    await releaseArchive(file);
  }
});
