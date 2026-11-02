import { watch, promises as fs, type FSWatcher } from "node:fs";
import path from "node:path";

/** A journal plus before-read tokens fences a long sequential scan, including earlier files. */
export class SourceFence {
  private versions = new Map<string, string>();
  private watchers: FSWatcher[] = [];
  private filesByParent = new Map<string, Set<string>>();
  private changed = false;
  private failed = false;
  private closed = false;
  private valueChecks: Array<() => Promise<void>> = [];

  async version(file: string) {
    try {
      const stat = await fs.lstat(file, { bigint: true });
      return JSON.stringify([
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mode.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString(),
        stat.isSymbolicLink() ? await fs.readlink(file) : null,
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  async track(file: string, version?: string) {
    if (!this.versions.has(file))
      this.versions.set(file, version ?? (await this.version(file)));
  }
  watchTree(root: string, include: (relative: string) => boolean = () => true) {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (
        filename === null ||
        include(filename.toString().split(path.sep).join("/"))
      )
        this.changed = true;
    });
    watcher.on("error", () => {
      this.failed = true;
    });
    this.watchers.push(watcher);
  }
  /** Observe logical state whose on-disk representation can change without a value change. */
  async watchValue(
    root: string,
    include: (relative: string) => boolean,
    read: () => Promise<string>,
  ) {
    let baseline: string | undefined,
      pending: Promise<void> | undefined,
      dirty = false;
    const sample = async () => {
      try {
        if (baseline !== undefined && (await read()) !== baseline)
          this.changed = true;
      } catch {
        this.failed = true;
      }
    };
    const schedule = () => {
      if (this.closed) return;
      dirty = true;
      if (pending) return;
      pending = (async () => {
        while (dirty && !this.closed) {
          dirty = false;
          await sample();
        }
      })().finally(() => {
        pending = undefined;
        if (dirty && !this.closed) schedule();
      });
    };
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (
        filename === null ||
        include(filename.toString().split(path.sep).join("/"))
      )
        schedule();
    });
    watcher.on("error", () => {
      this.failed = true;
    });
    this.watchers.push(watcher);
    baseline = await read();
    this.valueChecks.push(async () => {
      while (pending) await pending;
      await sample();
      while (pending) await pending;
    });
    schedule();
    return baseline;
  }
  async watchFile(file: string, version?: string) {
    const parent = path.dirname(file);
    let names = this.filesByParent.get(parent);
    if (!names) {
      names = new Set();
      this.filesByParent.set(parent, names);
      const selected = names;
      const watcher = watch(parent, (_event, filename) => {
        if (filename === null || selected.has(filename.toString()))
          this.changed = true;
      });
      watcher.on("error", () => {
        this.failed = true;
      });
      this.watchers.push(watcher);
    }
    names.add(path.basename(file));
    await this.track(file, version);
  }
  async assertUnchanged() {
    if (this.closed)
      throw new Error("Source verification fence has been released.");
    // Drain events queued while the last file, native inventory or Git state was read.
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const check of this.valueChecks) await check();
    this.assertJournal();
    for (const [file, version] of this.versions)
      if ((await this.version(file)) !== version)
        throw new Error(`Source changed during transfer preparation: ${file}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const check of this.valueChecks) await check();
    this.assertJournal();
  }
  private assertJournal() {
    if (this.failed)
      throw new Error(
        "Source change monitoring became unavailable; transfer held.",
      );
    if (this.changed)
      throw new Error(
        "Source changed during transfer preparation; source has been kept open.",
      );
  }
  close() {
    this.closed = true;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
