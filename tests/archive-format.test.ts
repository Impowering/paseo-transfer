import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archiveWriter,
  hashFile,
  unpackArchive,
} from "../server/archive-format";
import { defaultLimits, limitsSchema } from "../shared/limits";
import { assertIdleCheckout } from "../server/archive";

test("a raw archive larger than V8's single-string ceiling round trips with bounded memory", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "transfer-large-archive-"));
  try {
    const source = path.join(dir, "large.bin"),
      archive = path.join(dir, "archive.bin");
    const handle = await fs.open(source, "wx");
    await handle.truncate(540 * 1024 * 1024);
    await handle.close();
    const before = process.memoryUsage().rss;
    let peak = before;
    const monitor = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const writer = await archiveWriter(archive, defaultLimits);
      const ref = await writer.add(source);
      const manifest = { version: 2, refs: [ref] };
      const written = await writer.finish(manifest);
      assert.ok(written.wireBytes > 536_870_888);
      assert.equal(await hashFile(archive), written.checksum);
      const output = path.join(dir, "output");
      await fs.mkdir(output);
      const received = await unpackArchive(archive, output, defaultLimits);
      assert.deepEqual(received.manifest, manifest);
      assert.equal(received.fingerprint, written.fingerprint);
      assert.equal(
        received.blobs.get(ref.id)?.ref.sha256,
        await hashFile(source),
      );
      assert.ok(
        peak - before < 256 * 1024 * 1024,
        `RSS grew ${(peak - before) / 1024 / 1024} MiB`,
      );
    } finally {
      clearInterval(monitor);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("truncated, corrupted, trailing and malformed frames are refused", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "transfer-bad-archive-"));
  try {
    const source = path.join(dir, "file"),
      archive = path.join(dir, "archive.bin");
    await fs.writeFile(source, "integrity");
    const writer = await archiveWriter(archive, defaultLimits);
    const ref = await writer.add(source);
    await writer.finish({ refs: [ref] });
    const clean = await fs.readFile(archive);
    const cases = [
      {
        name: "truncated",
        data: clean.subarray(0, clean.length - 2),
        match: /Truncated/,
      },
      {
        name: "trailing",
        data: Buffer.concat([clean, Buffer.from("unexpected")]),
        match: /Trailing/,
      },
      {
        name: "checksum",
        data: Buffer.from(clean),
        match: /checksum mismatch/,
      },
      { name: "header", data: Buffer.from(clean), match: /header size/ },
    ];
    const offset = clean.indexOf(Buffer.from("integrity"));
    cases[2].data[offset] ^= 1;
    cases[3].data.writeUInt32BE(
      0x7fffffff,
      Buffer.byteLength("PASEO-TRANSFER-2\n"),
    );
    for (const fixture of cases) {
      const file = path.join(dir, fixture.name),
        output = path.join(dir, fixture.name + "-out");
      await fs.writeFile(file, fixture.data);
      await fs.mkdir(output);
      await assert.rejects(
        unpackArchive(file, output, defaultLimits),
        fixture.match,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("host byte/file settings validate values and reject oversized content before reading it", async () => {
  assert.equal(limitsSchema.parse({ maxFiles: 0 }).maxFiles, 0);
  assert.throws(() => limitsSchema.parse({ maxBytes: -1 }));
  const dir = await fs.mkdtemp(path.join(tmpdir(), "transfer-limit-"));
  try {
    const file = path.join(dir, "file"),
      archive = path.join(dir, "archive");
    await fs.writeFile(file, "four");
    const writer = await archiveWriter(archive, {
      ...defaultLimits,
      maxFileBytes: 3,
    });
    try {
      await assert.rejects(writer.add(file), /configured transfer limit/);
    } finally {
      await writer.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a running writer in another workspace sharing the same real checkout holds transfer", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "transfer-writer-"));
  try {
    const alias = dir + "-alias";
    await fs.symlink(dir, alias);
    try {
      await assert.rejects(
        assertIdleCheckout(undefined, dir, async () => [
          { status: "running", cwd: alias },
        ]),
        /every running agent sharing/,
      );
      await assertIdleCheckout(undefined, dir, async () => [
        { status: "idle", cwd: alias },
      ]);
      await assert.rejects(
        assertIdleCheckout(undefined, dir, async () => [{ status: "running" }]),
        /no verified checkout/,
      );
    } finally {
      await fs.rm(alias);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
