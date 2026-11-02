import { execFile, spawn, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { defaultLimits, type TransferLimits } from "../shared/limits";
import type { StreamRequest } from "./archive-stream";
import { workerSource } from "../shared/worker-source";
import type { Endpoint, WorkerRequest } from "../shared/types";

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function sshArgs(endpoint: Endpoint) {
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9_.:[\]-]+$/.test(endpoint.target) ||
    endpoint.target.startsWith("-")
  )
    throw new Error("Enter an SSH host or user@host.");
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  // Honor ssh_config and ssh-agent defaults; pin only an explicitly selected key.
  if (endpoint.identityFile)
    args.push("-o", "IdentitiesOnly=yes", "-i", endpoint.identityFile);
  if (endpoint.knownHostsFile)
    args.push("-o", `UserKnownHostsFile=${endpoint.knownHostsFile}`);
  if (endpoint.port) args.push("-p", String(endpoint.port));
  return [...args, "--", endpoint.target];
}
const RUNNER = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(s);const m={exports:{}};new Function('require','module','exports',p.source)(require,m,m.exports);const result=await m.exports.dispatch(p.request);process.stdout.write(JSON.stringify({result}));}catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1;}});`;
const active = new Set<ChildProcess>();
function command(endpoint: Endpoint, runner: string): [string, string[]] {
  return endpoint.target
    ? [
        "ssh",
        [
          ...sshArgs(endpoint),
          `bash -lc ${shellQuote(`node -e ${shellQuote(runner)}`)}`,
        ],
      ]
    : ["node", ["-e", runner]];
}
export async function invoke<T>(
  endpoint: Endpoint,
  request: WorkerRequest,
  limits: TransferLimits = defaultLimits,
): Promise<T> {
  const payload = { ...request, home: endpoint.home };
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    const [bin, args] = command(endpoint, RUNNER);
    child = execFile(
      bin,
      args,
      {
        timeout: limits.taskTimeoutSeconds * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        active.delete(child);
        try {
          const envelope = JSON.parse(String(stdout));
          if (envelope.error) throw new Error(envelope.error);
          if (error) throw new Error(String(stderr).trim() || error.message);
          resolve(envelope.result);
        } catch (e) {
          reject(
            new Error(
              String(stdout).trim()
                ? (e as Error).message
                : String(stderr).trim() ||
                    error?.message ||
                    "Host did not return a transfer response.",
            ),
          );
        }
      },
    );
    active.add(child);
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({ source: workerSource, request: payload }),
    );
  });
}
// A bounded bootstrap prefix carries only worker code + metadata. The rest of stdin is binary.
const STREAM_RUNNER = `let b=Buffer.alloc(0),n;const input=process.stdin;function fail(e){process.stderr.write(String(e.message||e));process.exitCode=1;input.destroy();}function read(c){b=Buffer.concat([b,c]);if(n===undefined&&b.length>=4){n=b.readUInt32BE();if(!n||n>4*1024*1024){input.removeListener('data',read);fail(new Error('Invalid stream bootstrap size'));return;}}if(n!==undefined&&b.length>=n+4){input.pause();input.removeListener('data',read);try{const p=JSON.parse(b.subarray(4,n+4).toString());const rest=b.subarray(n+4);b=null;if(rest.length)input.unshift(rest);const m={exports:{}};new Function('require','module','exports',p.source)(require,m,m.exports);Promise.resolve(m.exports.streamArchive(p.request,input,process.stdout)).then(result=>{if(p.request.direction==='write')process.stdout.write(JSON.stringify(result));}).catch(fail);}catch(e){fail(e);}}}input.on('data',read);input.on('end',()=>{if(b!==null)fail(new Error('Truncated stream bootstrap'));});`;
function streamPrefix(request: StreamRequest) {
  const data = Buffer.from(JSON.stringify({ source: workerSource, request }));
  if (data.length > 4 * 1024 * 1024)
    throw new Error("Stream bootstrap is too large.");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
function streamProcess(endpoint: Endpoint, limits: TransferLimits) {
  const [bin, args] = command(endpoint, STREAM_RUNNER);
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  active.add(child);
  let stderr = "",
    output = "";
  child.stderr.on("data", (data) => {
    if (stderr.length < 65536)
      stderr += String(data).slice(0, 65536 - stderr.length);
  });
  const timer = setTimeout(
    () => child.kill("SIGTERM"),
    limits.taskTimeoutSeconds * 1000,
  );
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr || `Archive transport failed (${code}).`)),
    );
  }).finally(() => {
    active.delete(child);
    clearTimeout(timer);
  });
  // Attach immediately: a failed source must not create an unhandled rejection before piping starts.
  void done.catch(() => {});
  return {
    child,
    done,
    collect() {
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.length > 65536) {
          child.kill("SIGTERM");
          output = output.slice(0, 65536);
        }
      });
      return () => JSON.parse(output);
    },
  };
}

/** Relay a raw archive locally, over one SSH connection, or between two authenticated SSH peers. */
export async function copyArchive(
  source: Endpoint,
  target: Endpoint,
  archive: { file: string; wireBytes: number; checksum: string },
  upload: string,
  limits: TransferLimits = defaultLimits,
) {
  // Validate both endpoints before starting either owned process.
  if (source.target) sshArgs(source);
  if (target.target) sshArgs(target);
  const reader = streamProcess(source, limits);
  const writer = streamProcess(target, limits);
  const result = writer.collect();
  reader.child.stdin.on("error", () => {});
  writer.child.stdin.on("error", () => {});
  try {
    writer.child.stdin.write(
      streamPrefix({
        direction: "write",
        file: upload,
        wireBytes: archive.wireBytes,
        checksum: archive.checksum,
        limits,
      }),
    );
    reader.child.stdin.end(
      streamPrefix({ direction: "read", ...archive, limits }),
    );
    await Promise.all([
      pipeline(reader.child.stdout, writer.child.stdin),
      reader.done,
      writer.done,
    ]);
    const received = result();
    if (
      received.bytes !== archive.wireBytes ||
      received.checksum !== archive.checksum
    )
      throw new Error("Target did not confirm the archive stream checksum.");
  } catch (error) {
    reader.child.kill("SIGTERM");
    writer.child.kill("SIGTERM");
    await Promise.allSettled([reader.done, writer.done]);
    throw error;
  }
}
export function disposeTransport() {
  for (const child of active) child.kill("SIGTERM");
  active.clear();
}
