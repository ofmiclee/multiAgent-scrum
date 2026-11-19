import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  Artifact,
  CodeChanges,
  RepositorySnapshot,
} from "../../packages/domain/contracts.ts";
import {
  assertSafeCodeContent,
  codeManifest,
  validateCodeManifestBytes,
  validateCodeBundle,
  type CodeBundle,
} from "../../packages/domain/code-transfer.ts";
import {
  PORTABLE_ARTIFACT_MAX_BYTES,
  codeManifestRefSchema,
  repositoryArchiveRefSchema,
  validateRepositoryArchiveBytes,
  type CodeManifestRef,
  type RepositoryArchiveRef,
} from "../../packages/domain/code-artifacts.ts";

export type PreparedWorkspace = {
  cwd: string;
  repositorySnapshotId: string;
  inputSnapshotId: string;
};

const MAX_FILES = 2000,
  MAX_FILE = 2 * 1024 * 1024,
  MAX_TOTAL = 32 * 1024 * 1024;
const MAX_MANIFEST = 48 * 1024 * 1024;
const MAX_DIRECTORIES = 2000;
// Capture's ancestor chain also contains the managed parent and workspace root.
const MAX_DIRECTORY_DEPTH = 62;
const excluded = new Set([
  ".git",
  "node_modules",
  ".runtime",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
]);
type Entry = {
  path: string;
  content: string;
  executable: boolean;
  hash: string;
};
type Tree = { schema: 1; kind: "tree"; entries: Entry[] };
type Repository = {
  schema: 1;
  kind: "repository";
  commit: string;
  createdAt: string;
  treeId: string;
  fileCount: number;
};
type RepositoryArchive = {
  schema: 1;
  kind: "repository-snapshot";
  repository: Repository;
  tree: Tree;
};
type Change = { path: string; before: string | null; after: Entry | null };
type Changes = {
  schema: 1;
  kind: "changes";
  repositorySnapshotId: string;
  changes: Change[];
};
type Identity = { dev: number; ino: number };
type PreparedRecord = { metadata: PreparedWorkspace; identity: Identity };
class StoreError extends Error {}
function fail(message: string): never {
  throw new StoreError(message);
}
function check(signal: AbortSignal) {
  if (signal.aborted) fail("Snapshot operation cancelled");
}
function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function id(value: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    fail("Invalid snapshot identity");
  return value;
}
function sensitive(path: string) {
  return path.split("/").some((part) => {
    const p = part.toLowerCase();
    if (p === ".env.example" || p === ".env.sample") return false;
    return (
      p === ".env" ||
      p.startsWith(".env.") ||
      p.endsWith(".env") ||
      /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.test(p) ||
      /\.(pem|key|p12|pfx|keystore)$/.test(p) ||
      [
        ".npmrc",
        ".netrc",
        ".pypirc",
        ".aws",
        ".ssh",
        ".gnupg",
        "credentials",
        "credentials.json",
        "service-account.json",
      ].includes(p)
    );
  });
}
function ignored(path: string) {
  return path.split("/").some((p) => excluded.has(p.toLowerCase()));
}
function validPath(path: string) {
  if (
    typeof path !== "string" ||
    !path ||
    Buffer.byteLength(path) > 512 ||
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))
  )
    fail("Unsafe repository path");
  if (path.normalize("NFC") !== path)
    fail("Unsafe repository path normalization");
}
function entry(path: string, bytes: Buffer, executable: boolean): Entry {
  return {
    path,
    content: bytes.toString("base64"),
    executable,
    hash: digest(
      Buffer.concat([Buffer.from(executable ? "x\0" : "-\0"), bytes]),
    ),
  };
}
function validateEntries(entries: Entry[]) {
  if (!Array.isArray(entries) || entries.length > MAX_FILES)
    fail("Snapshot file count limit exceeded");
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (
      !e ||
      typeof e.content !== "string" ||
      typeof e.executable !== "boolean"
    )
      fail("Snapshot integrity invalid");
    validPath(e.path);
    if (sensitive(e.path) || ignored(e.path))
      fail("Snapshot integrity contains excluded files");
    const canonical = e.path.toLowerCase();
    if (seen.has(canonical)) fail("Snapshot integrity duplicate path");
    seen.add(canonical);
    if (e.content.length > Math.ceil(MAX_FILE / 3) * 4)
      fail("Snapshot file size limit exceeded");
    const bytes = Buffer.from(e.content, "base64");
    if (
      bytes.toString("base64") !== e.content ||
      entry(e.path, bytes, e.executable).hash !== e.hash
    )
      fail("Snapshot integrity invalid");
    if (bytes.length > MAX_FILE || (total += bytes.length) > MAX_TOTAL)
      fail("Snapshot size limit exceeded");
  }
  for (const path of seen) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/"))) fail("Snapshot integrity path conflict");
      parts.pop();
    }
  }
  // Different spelling of a shared directory also aliases on common local filesystems.
  const prefixes = new Map<string, string>();
  const directories = new Set([""]);
  for (const e of entries) {
    const parts = e.path.split("/");
    if (parts.length - 1 > MAX_DIRECTORY_DEPTH)
      fail("Snapshot directory depth limit exceeded");
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join("/"),
        key = prefix.toLowerCase();
      if (prefixes.has(key) && prefixes.get(key) !== prefix)
        fail("Snapshot integrity case conflict");
      prefixes.set(key, prefix);
      if (n < parts.length) directories.add(key);
      if (directories.size > MAX_DIRECTORIES)
        fail("Snapshot directory count limit exceeded");
    }
  }
}
function validatePortableEntries(entries: Entry[]) {
  validateEntries(entries);
  for (const value of entries) {
    if (
      Object.keys(value).length !== 4 ||
      Object.keys(value).some(
        (key) => !["path", "content", "executable", "hash"].includes(key),
      )
    )
      fail("Repository archive entry schema invalid");
    assertSafeCodeContent(Buffer.from(value.content, "base64"));
  }
}
// Resolve existing ancestors without mkdir: aliases must not hide overlap even
// when the final managed directory does not exist yet. Dangling links fail closed.
async function prospectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existing = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existing || dirname(path) === path) fail("Unsafe managed store path");
    return join(await prospectivePath(dirname(path)), basename(path));
  }
}
function overlaps(a: string, b: string) {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  };
  return inside(a, b) || inside(b, a);
}
function same(a: Identity, b: Identity) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function directory(path: string, expected?: Identity) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (expected && !same(stat, expected))
  )
    fail("Unsafe workspace directory");
  return stat;
}
async function regular(path: string, limit: number, signal: AbortSignal) {
  check(signal);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1) fail("Unsafe file or symlink");
  if (before.size > limit) fail("Snapshot file size limit exceeded");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !same(before, stat))
      fail("Unsafe file changed during capture");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      check(signal);
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) fail("Snapshot file size limit exceeded");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      !same(after, await lstat(path))
    )
      fail("Unsafe file changed during capture");
    check(signal);
    return { bytes: Buffer.concat(chunks), executable: !!(stat.mode & 0o111) };
  } finally {
    await handle.close();
  }
}

/** Local snapshot isolation, not an OS-user security sandbox.
 * collect requires the executor AND its children to have stopped: no concurrent writers.
 * Node lacks portable openat: identity checks reject observed swaps, but do not promise
 * atomic protection against adversarial ancestor ABA rename races. Never trust native artifacts.
 */
export class SnapshotStore {
  private root: string;
  private workRoot = "";
  private initialized?: Promise<void>;
  private prepared = new WeakMap<PreparedWorkspace, PreparedRecord>();
  constructor(managedStoreDirectory: string) {
    if (
      !isAbsolute(managedStoreDirectory) ||
      resolve(managedStoreDirectory) === "/"
    )
      fail("Store requires an absolute managed directory");
    this.root = resolve(managedStoreDirectory);
  }
  private async boundary<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      check(signal);
      const result = await operation();
      check(signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw new Error("Snapshot operation cancelled");
      if (error instanceof StoreError) throw new Error(error.message);
      throw new Error(
        "Snapshot operation failed: unavailable or corrupt local data",
      );
    }
  }
  private async init() {
    this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await directory(this.root);
      this.root = await realpath(this.root);
      this.workRoot = join(
        dirname(this.root),
        `.${basename(this.root)}-workspaces`,
      );
      await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
      await directory(this.workRoot);
    })();
    await this.initialized;
    await directory(this.root);
    await directory(this.workRoot);
  }
  private async git(
    cwd: string,
    args: string[],
    signal: AbortSignal,
    limit = MAX_FILE,
  ): Promise<Buffer> {
    check(signal);
    return await new Promise((yes, no) => {
      execFile(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=/dev/null",
          ...args,
        ],
        {
          cwd,
          signal,
          maxBuffer: limit,
          timeout: 30_000,
          encoding: "buffer",
          env: {
            PATH: process.env.PATH,
            HOME: this.root,
            XDG_CONFIG_HOME: this.root,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_NO_LAZY_FETCH: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_ALLOW_PROTOCOL: "",
            LC_ALL: "C",
          },
        },
        (error, stdout) =>
          error
            ? no(new StoreError("Git import failed or exceeded limit"))
            : yes(stdout),
      );
    });
  }
  private async save(object: Tree | Repository | Changes, signal: AbortSignal) {
    check(signal);
    const data = JSON.stringify(object),
      key = digest(data);
    if (Buffer.byteLength(data) > MAX_MANIFEST)
      fail("Snapshot manifest limit exceeded");
    const path = join(this.root, `${key}.json`);
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
        await handle.chmod(0o400);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await regular(path, MAX_MANIFEST, signal);
      if (existing.bytes.toString() !== data)
        fail("Snapshot integrity corruption");
    }
    check(signal);
    return key;
  }
  private async load(key: string, signal: AbortSignal): Promise<unknown> {
    const { bytes } = await regular(
      join(this.root, `${id(key)}.json`),
      MAX_MANIFEST,
      signal,
    );
    if (digest(bytes) !== key) fail("Snapshot integrity corruption");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("Snapshot integrity corruption");
    }
  }
  private async tree(key: string, signal: AbortSignal) {
    const value = (await this.load(key, signal)) as Tree;
    if (value?.schema !== 1 || value.kind !== "tree")
      fail("Snapshot integrity invalid schema");
    validateEntries(value.entries);
    return value.entries;
  }
  async importGit(
    sourcePath: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<RepositorySnapshot> {
    return this.boundary(signal, async () => {
      if (
        !isAbsolute(sourcePath) ||
        sourcePath.includes("\0") ||
        typeof ref !== "string" ||
        !/^[a-zA-Z0-9_][a-zA-Z0-9_./~^@{}+-]{0,199}$/.test(ref) ||
        ref.includes("..")
      )
        fail("Invalid repository source or ref");
      await directory(sourcePath);
      const source = await realpath(sourcePath);
      // A linked worktree uses a regular .git pointer; bare roots have no .git.
      // Inspect metadata before discovery, then require the selected source to be
      // the repository root so an arbitrary subdirectory cannot inherit a parent.
      const metadataPath = join(source, ".git");
      const metadata = await lstat(metadataPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (metadata) {
        if (metadata.isSymbolicLink()) fail("Unsafe Git metadata symlink");
        if (metadata.isFile()) {
          const pointer = (
            await regular(metadataPath, 8192, signal)
          ).bytes.toString("utf8");
          const target = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(pointer)?.[1];
          if (!target) fail("Unsafe Git metadata pointer");
          await directory(resolve(source, target));
        } else await directory(metadataPath);
      }
      const gitDirectory = (
        await this.git(
          source,
          ["rev-parse", "--absolute-git-dir"],
          signal,
          8192,
        )
      )
        .toString()
        .trim();
      await directory(gitDirectory);
      const bare = (
        await this.git(
          source,
          ["rev-parse", "--is-bare-repository"],
          signal,
          1024,
        )
      )
        .toString()
        .trim();
      if (bare !== "true" && bare !== "false") fail("Invalid Git repository");
      const discoveredRoot =
        bare === "true"
          ? gitDirectory
          : (
              await this.git(
                source,
                ["rev-parse", "--show-toplevel"],
                signal,
                8192,
              )
            )
              .toString()
              .trim();
      if ((await realpath(discoveredRoot)) !== source)
        fail("Repository source must be its root");
      const commonDirectory = (
        await this.git(
          source,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          signal,
          8192,
        )
      )
        .toString()
        .trim();
      await directory(commonDirectory);
      const store = await prospectivePath(this.root);
      const workspaces = await prospectivePath(
        join(dirname(store), `.${basename(store)}-workspaces`),
      );
      const protectedRoots = [
        source,
        await realpath(gitDirectory),
        await realpath(commonDirectory),
      ];
      if (
        overlaps(store, workspaces) ||
        protectedRoots.some(
          (root) => overlaps(root, store) || overlaps(root, workspaces),
        )
      )
        fail("Managed snapshot paths overlap the source repository");
      // No store/workspace creation may precede the complete read-only preflight.
      await this.init();
      const commit = (
        await this.git(
          source,
          ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
          signal,
          1024,
        )
      )
        .toString()
        .trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
        fail("Invalid resolved commit");
      const listing = (
        await this.git(
          source,
          ["ls-tree", "-r", "-z", "--full-tree", "-l", commit],
          signal,
          2 * 1024 * 1024,
        )
      ).toString("utf8");
      const records = listing.split("\0").filter(Boolean);
      if (records.length > MAX_FILES)
        fail("Snapshot file count limit exceeded");
      const entries: Entry[] = [];
      let total = 0;
      for (const record of records) {
        check(signal);
        const match = /^(\d{6}) (\w+) ([0-9a-f]+) +([0-9-]+)\t([\s\S]+)$/.exec(
          record,
        );
        if (!match) fail("Unsupported Git tree entry");
        const [, mode, type, hash, sizeText, path] = match;
        validPath(path);
        if (type !== "blob" || !["100644", "100755"].includes(mode))
          fail("Unsupported symlink or submodule");
        if (sensitive(path))
          fail("Repository contains sensitive credential files");
        if (ignored(path)) continue;
        const size = Number(sizeText);
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_FILE ||
          (total += size) > MAX_TOTAL
        )
          fail("Snapshot size limit exceeded");
        const bytes = await this.git(
          source,
          ["cat-file", "blob", hash],
          signal,
          MAX_FILE + 1,
        );
        if (bytes.length !== size) fail("Git blob integrity failure");
        entries.push(entry(path, bytes, mode === "100755"));
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      validateEntries(entries);
      const treeId = await this.save(
        { schema: 1, kind: "tree", entries },
        signal,
      );
      const createdAt = new Date().toISOString();
      const key = await this.save(
        {
          schema: 1,
          kind: "repository",
          commit,
          createdAt,
          treeId,
          fileCount: entries.length,
        },
        signal,
      );
      return { id: key, commit, fileCount: entries.length, createdAt };
    });
  }
  async prepare(
    snapshot: RepositorySnapshot,
    changes: CodeChanges[],
    attemptId: string,
    signal: AbortSignal,
  ): Promise<PreparedWorkspace> {
    return this.boundary(signal, async () => {
      id(snapshot.id);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(attemptId))
        fail("Invalid attempt identity");
      if (!Array.isArray(changes) || changes.length > MAX_FILES)
        fail("Change composition limit exceeded");
      await this.init();
      const repository = (await this.load(snapshot.id, signal)) as Repository;
      if (
        repository?.schema !== 1 ||
        repository.kind !== "repository" ||
        repository.commit !== snapshot.commit ||
        repository.createdAt !== snapshot.createdAt ||
        repository.fileCount !== snapshot.fileCount ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repository.commit) ||
        !Number.isFinite(Date.parse(repository.createdAt))
      )
        fail("Snapshot integrity metadata mismatch");
      const original = await this.tree(repository.treeId, signal);
      if (original.length !== snapshot.fileCount)
        fail("Snapshot integrity file count mismatch");
      const tree = new Map(original.map((e) => [e.path, e]));
      const applied = new Set<string>();
      for (const reference of changes) {
        check(signal);
        id(reference.id);
        if (reference.repositorySnapshotId !== snapshot.id)
          fail("Foreign repository changes");
        const manifest = (await this.load(reference.id, signal)) as Changes;
        if (
          manifest?.schema !== 1 ||
          manifest.kind !== "changes" ||
          manifest.repositorySnapshotId !== snapshot.id ||
          !Array.isArray(manifest.changes) ||
          manifest.changes.length !== reference.fileCount ||
          manifest.changes.length > MAX_FILES * 2
        )
          fail("Change integrity mismatch");
        const paths = new Set<string>();
        const after: Entry[] = [];
        for (const c of manifest.changes) {
          if (!c) fail("Change integrity invalid");
          validPath(c.path);
          if (paths.has(c.path) || sensitive(c.path) || ignored(c.path))
            fail("Change integrity invalid path");
          paths.add(c.path);
          if (c.before !== null) id(c.before);
          if (c.after !== null) {
            if (c.after.path !== c.path) fail("Change integrity invalid path");
            after.push(c.after);
          }
          if (c.before === (c.after?.hash ?? null))
            fail("Change integrity has no delta");
        }
        validateEntries(after);
        if (applied.has(reference.id)) continue;
        for (const c of manifest.changes) {
          const current = tree.get(c.path)?.hash ?? null;
          if (current === (c.after?.hash ?? null)) continue;
          if (current !== c.before) fail("Dependency code change conflict");
          if (c.after) tree.set(c.path, c.after);
          else tree.delete(c.path);
        }
        validateEntries([...tree.values()]);
        applied.add(reference.id);
      }
      const entries = [...tree.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      const inputSnapshotId = await this.save(
        { schema: 1, kind: "tree", entries },
        signal,
      );
      const cwd = join(this.workRoot, attemptId);
      await mkdir(cwd, { mode: 0o700 });
      for (const e of entries) {
        check(signal);
        const path = join(cwd, e.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, "wx", e.executable ? 0o755 : 0o644);
        try {
          await handle.writeFile(Buffer.from(e.content, "base64"));
          await handle.chmod(e.executable ? 0o755 : 0o644);
        } finally {
          await handle.close();
        }
      }
      await this.git(
        cwd,
        ["init", "--template=", "--initial-branch=main"],
        signal,
        64 * 1024,
      );
      const result = {
        cwd,
        repositorySnapshotId: snapshot.id,
        inputSnapshotId,
      };
      this.prepared.set(result, {
        metadata: { ...result },
        identity: await directory(cwd),
      });
      return result;
    });
  }
  async collect(
    prepared: PreparedWorkspace,
    signal: AbortSignal,
  ): Promise<{ changes: CodeChanges; artifacts: Artifact[] }> {
    return this.boundary(signal, async () => {
      const record = this.prepared.get(prepared);
      if (
        !record ||
        Object.keys(record.metadata).some(
          (key) =>
            record.metadata[key as keyof PreparedWorkspace] !==
            prepared[key as keyof PreparedWorkspace],
        )
      )
        fail("Unknown prepared workspace");
      await this.init();
      const original = await this.tree(prepared.inputSnapshotId, signal);
      await directory(prepared.cwd, record.identity);
      const entries: Entry[] = [];
      let total = 0,
        directoryCount = 0;
      const ancestors: { path: string; identity: Identity }[] = [
        { path: this.workRoot, identity: await directory(this.workRoot) },
        { path: prepared.cwd, identity: record.identity },
      ];
      const verify = async () => {
        for (const ancestor of ancestors)
          await directory(ancestor.path, ancestor.identity);
        check(signal);
      };
      const visit = async (path: string, prefix: string) => {
        await verify();
        if (++directoryCount > MAX_DIRECTORIES)
          fail("Snapshot directory count limit exceeded");
        const children = await opendir(path);
        let childCount = 0;
        for await (const child of children) {
          if (++childCount > MAX_FILES + excluded.size + 32)
            fail("Snapshot directory entry limit exceeded");
          const name = child.name;
          check(signal);
          const relative = prefix ? `${prefix}/${name}` : name;
          validPath(relative);
          if (sensitive(relative))
            fail("Workspace contains sensitive credential files");
          if (ignored(relative)) continue;
          await verify();
          const full = join(path, name),
            stat = await lstat(full);
          if (stat.isSymbolicLink()) fail("Unsafe source symlink");
          if (stat.isDirectory()) {
            ancestors.push({ path: full, identity: stat });
            if (ancestors.length - 2 > MAX_DIRECTORY_DEPTH)
              fail("Snapshot directory depth limit exceeded");
            await visit(full, relative);
            ancestors.pop();
          } else {
            if (entries.length >= MAX_FILES)
              fail("Snapshot file count limit exceeded");
            const file = await regular(full, MAX_FILE, signal);
            await verify();
            total += file.bytes.length;
            if (total > MAX_TOTAL) fail("Snapshot total size limit exceeded");
            entries.push(entry(relative, file.bytes, file.executable));
          }
        }
        await verify();
      };
      await visit(prepared.cwd, "");
      validateEntries(entries);
      const before = new Map(original.map((e) => [e.path, e]));
      const after = new Map(entries.map((e) => [e.path, e]));
      const delta: Change[] = [];
      for (const path of [
        ...new Set([...before.keys(), ...after.keys()]),
      ].sort()) {
        const old = before.get(path)?.hash ?? null,
          next = after.get(path) ?? null;
        if (old !== (next?.hash ?? null))
          delta.push({ path, before: old, after: next });
      }
      const key = await this.save(
        {
          schema: 1,
          kind: "changes",
          repositorySnapshotId: prepared.repositorySnapshotId,
          changes: delta,
        },
        signal,
      );
      const lines = delta.map(
        (c) =>
          `${c.before === null ? "added" : c.after === null ? "deleted" : "modified"} ${c.path}`,
      );
      let summary = `${delta.length} changed file(s)\n`;
      for (const line of lines) {
        if (
          Buffer.byteLength(summary) + Buffer.byteLength(line) >
          32 * 1024 - 64
        ) {
          summary += "Additional paths omitted from summary.\n";
          break;
        }
        summary += line + "\n";
      }
      return {
        changes: {
          id: key,
          repositorySnapshotId: prepared.repositorySnapshotId,
          fileCount: delta.length,
        },
        artifacts: [{ name: "code-changes.txt", content: summary }],
      };
    });
  }

  async exportCode(
    changes: CodeChanges,
    inputSnapshotId: string,
    signal: AbortSignal,
  ): Promise<CodeBundle> {
    return this.boundary(signal, async () => {
      id(changes.id);
      id(changes.repositorySnapshotId);
      id(inputSnapshotId);
      if (!Number.isInteger(changes.fileCount) || changes.fileCount < 0)
        fail("Invalid change metadata");
      await this.init();
      await this.tree(inputSnapshotId, signal);
      const manifest = (await this.load(changes.id, signal)) as Changes;
      if (
        manifest?.schema !== 1 ||
        manifest.kind !== "changes" ||
        manifest.repositorySnapshotId !== changes.repositorySnapshotId ||
        !Array.isArray(manifest.changes) ||
        manifest.changes.length !== changes.fileCount
      )
        fail("Change integrity mismatch");
      return validateCodeBundle({
        repositorySnapshotId: changes.repositorySnapshotId,
        inputSnapshotId,
        changesId: changes.id,
        manifest: JSON.stringify(manifest),
      });
    });
  }

  async importCode(
    bundle: CodeBundle,
    signal: AbortSignal,
  ): Promise<CodeChanges> {
    return this.boundary(signal, async () => {
      const verified = validateCodeBundle(bundle);
      const manifest = codeManifest(verified);
      await this.init();
      const key = await this.save(manifest, signal);
      if (key !== verified.changesId) fail("Code manifest integrity mismatch");
      return {
        id: key,
        repositorySnapshotId: verified.repositorySnapshotId,
        fileCount: manifest.changes.length,
      };
    });
  }

  async exportRepository(
    snapshot: RepositorySnapshot,
    signal: AbortSignal,
  ): Promise<{ ref: RepositoryArchiveRef; bytes: Buffer }> {
    return this.boundary(signal, async () => {
      id(snapshot.id);
      await this.init();
      const stored = (await this.load(snapshot.id, signal)) as Repository;
      const repository: Repository = {
        schema: 1,
        kind: "repository",
        commit: stored?.commit,
        createdAt: stored?.createdAt,
        treeId: stored?.treeId,
        fileCount: stored?.fileCount,
      };
      if (
        stored?.schema !== 1 ||
        stored.kind !== "repository" ||
        digest(JSON.stringify(repository)) !== snapshot.id ||
        repository.commit !== snapshot.commit ||
        repository.createdAt !== snapshot.createdAt ||
        repository.fileCount !== snapshot.fileCount
      )
        fail("Snapshot integrity metadata mismatch");
      const entries = await this.tree(repository.treeId, signal);
      validatePortableEntries(entries);
      if (entries.length !== repository.fileCount)
        fail("Snapshot integrity file count mismatch");
      const tree: Tree = { schema: 1, kind: "tree", entries };
      if (digest(JSON.stringify(tree)) !== repository.treeId)
        fail("Snapshot integrity tree mismatch");
      const archive: RepositoryArchive = {
        schema: 1,
        kind: "repository-snapshot",
        repository,
        tree,
      };
      const bytes = Buffer.from(JSON.stringify(archive), "utf8");
      if (bytes.length > PORTABLE_ARTIFACT_MAX_BYTES)
        fail("Repository archive size limit exceeded");
      return {
        ref: repositoryArchiveRefSchema.parse({
          schema: 1,
          kind: "repository-snapshot",
          repository: snapshot,
          object: { sha256: digest(bytes), sizeBytes: bytes.length },
        }),
        bytes,
      };
    });
  }

  async importRepository(
    rawRef: RepositoryArchiveRef,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<RepositorySnapshot> {
    return this.boundary(signal, async () => {
      let archive;
      try{archive=validateRepositoryArchiveBytes(rawRef,bytes);}
      catch(error){fail(error instanceof Error?error.message:"Repository archive invalid");}
      const ref = repositoryArchiveRefSchema.parse(rawRef);
      const canonicalTree:Tree=archive.tree;
      const canonicalRepository:Repository=archive.repository;
      await this.init();
      if ((await this.save(canonicalTree, signal)) !== canonicalRepository.treeId)
        fail("Repository archive tree identity mismatch");
      if ((await this.save(canonicalRepository, signal)) !== ref.repository.id)
        fail("Repository archive identity mismatch");
      return ref.repository;
    });
  }

  async exportCodeArtifact(
    changes: CodeChanges,
    inputSnapshotId: string,
    signal: AbortSignal,
  ): Promise<{ ref: CodeManifestRef; bytes: Buffer }> {
    return this.boundary(signal, async () => {
      id(changes.id);
      id(changes.repositorySnapshotId);
      id(inputSnapshotId);
      if (!Number.isInteger(changes.fileCount) || changes.fileCount < 0)
        fail("Invalid change metadata");
      await this.init();
      await this.tree(inputSnapshotId, signal);
      const manifest = await this.load(changes.id, signal);
      const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
      const parsed = validateCodeManifestBytes(
        bytes,
        changes.repositorySnapshotId,
        changes.id,
        PORTABLE_ARTIFACT_MAX_BYTES,
      );
      if (parsed.changes.length !== changes.fileCount)
        fail("Change integrity mismatch");
      return {
        ref: codeManifestRefSchema.parse({
          schema: 1,
          kind: "code-changes",
          repositorySnapshotId: changes.repositorySnapshotId,
          inputSnapshotId,
          changesId: changes.id,
          object: { sha256: changes.id, sizeBytes: bytes.length },
        }),
        bytes,
      };
    });
  }

  async importCodeArtifact(
    rawRef: CodeManifestRef,
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<CodeChanges> {
    return this.boundary(signal, async () => {
      const ref = codeManifestRefSchema.parse(rawRef);
      if (!Buffer.isBuffer(bytes) || bytes.length > PORTABLE_ARTIFACT_MAX_BYTES)
        fail("Code artifact size limit exceeded");
      if (bytes.length !== ref.object.sizeBytes || digest(bytes) !== ref.object.sha256)
        fail("Code artifact integrity mismatch");
      const manifest = validateCodeManifestBytes(
        bytes,
        ref.repositorySnapshotId,
        ref.changesId,
        PORTABLE_ARTIFACT_MAX_BYTES,
      );
      await this.init();
      const key = await this.save(manifest, signal);
      if (key !== ref.changesId) fail("Code artifact identity mismatch");
      return {
        id: key,
        repositorySnapshotId: ref.repositorySnapshotId,
        fileCount: manifest.changes.length,
      };
    });
  }
}
