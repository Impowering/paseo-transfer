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
    this.assertJournal();
    for (const [file, version] of this.versions)
      if ((await this.version(file)) !== version)
        throw new Error(`Source changed during transfer preparation: ${file}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
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
