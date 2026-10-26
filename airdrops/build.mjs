// build.mjs - turns one eligibility list (csv / txt, plain or .gz, a URL or a local path) into an index file.
// index.mjs runs it in a child process (`node build.mjs <jobs json>`): a build briefly needs ~100-250 MB, which
// the scan process would otherwise keep as RSS until it exits. The child prints { id: { count, bytes } | { error } } as JSON.
//
// File: 16-byte header ("ADX1", record count, bucket count), a table of 4097 uint32 record offsets by the
// address's first 12 bits, then 28-byte records (20-byte address + float64 LE amount, NaN = no amount) sorted by
// address. Repeated addresses are merged (amounts add up).

import { openSync, writeSync, closeSync, mkdirSync, renameSync, createReadStream } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";

export const FORMAT = 1, REC = 28, NB = 4096, HEAD = 16 + (NB + 1) * 4;
export const pre = (b, o) => (b[o] << 4) | (b[o + 1] >> 4); // bucket = first 12 bits of the address
const HEX = /^0x[0-9a-fA-F]{40}$/;

async function lines(url) {
  let body;
  if (/^https?:/.test(url)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    body = Readable.fromWeb(r.body);
  } else body = createReadStream(url);
  if (url.endsWith(".gz")) { const gz = createGunzip(); body.on("error", (e) => gz.destroy(e)); body = body.pipe(gz); }
  return createInterface({ input: body, crlfDelay: Infinity });
}

// list: { url, amountCol (header name, default "amount"; headerless files use column 2), raw (decimals), share, format }
//   format "pairs": JSON lines or a .ts array, `"address": "0x.."` then `"earnings": "0x<hex wei>"` or `ether(n)`
//   format "array": JSON `[["0x..", "<raw amount>"], ...]` (dYdX), any number of rows per line
//   format "tree": an OpenZeppelin standard-v1 merkle tree (Sablier's IPFS file): leaf values `[index, "0x..", "<raw>"]`
const ROW = { array: /\["(0x[0-9a-fA-F]{40})"\s*,\s*"?(\d+)"?\]/g, tree: /\\"(0x[0-9a-fA-F]{40})\\",\\"(\d+)\\"/g };
export async function buildList(list, file) {
  let buf = Buffer.allocUnsafe(1 << 20), n = 0, col = -1, first = true, addr = null;
  const push = (a, v) => {
    if ((n + 1) * REC > buf.length) { const b = Buffer.allocUnsafe(buf.length * 2); buf.copy(b, 0, 0, n * REC); buf = b; }
    buf.write(a.slice(2), n * REC, 20, "hex");
    buf.writeDoubleLE(list.raw && Number.isFinite(v) ? v / 10 ** list.raw : v, n * REC + 20);
    n++;
  };
  for await (const line of await lines(list.url)) {
    if (ROW[list.format]) {
      for (const m of line.matchAll(ROW[list.format])) push(m[1], Number(m[2]));
      continue;
    }
    if (list.format === "pairs") {
      addr = /"address"\s*:\s*"(0x[0-9a-fA-F]{40})"/.exec(line)?.[1] || addr;
      const m = /"earnings"\s*:\s*(?:"(0x[0-9a-fA-F]+)"|ether\(([\d.]+)\))/.exec(line);
      if (addr && m) { push(addr, m[1] ? Number(BigInt(m[1])) / 1e18 : Number(m[2])); addr = null; }
      continue;
    }
    const c = line.replace(/"/g, "").split(/[,\t]/).map((s) => s.trim());
    if (first) {
      first = false;
      if (!HEX.test(c[0])) { col = c.indexOf(list.amountCol || "amount"); continue; } // a header row
      col = c.length > 1 ? 1 : -1;
    }
    if (HEX.test(c[0])) push(c[0], col < 0 || list.share ? NaN : Number(c[col]));
  }
  // counting sort by bucket, then sort each (small) bucket in place and merge repeats
  const table = new Uint32Array(NB + 1), at = new Uint32Array(NB);
  for (let i = 0; i < n; i++) table[pre(buf, i * REC) + 1]++;
  for (let b = 0; b < NB; b++) { table[b + 1] += table[b]; at[b] = table[b]; }
  const out = Buffer.allocUnsafe(n * REC);
  for (let i = 0; i < n; i++) buf.copy(out, at[pre(buf, i * REC)]++ * REC, i * REC, i * REC + REC);
  buf = null;
  let w = 0;
  for (let b = 0; b < NB; b++) {
    const s = table[b], e = table[b + 1];
    table[b] = w;
    if (e === s) continue;
    const tmp = Buffer.from(out.subarray(s * REC, e * REC));
    const ord = Array.from({ length: e - s }, (_, k) => k * REC).sort((x, y) => tmp.compare(tmp, y, y + 20, x, x + 20));
    for (const o of ord) {
      if (w > table[b] && tmp.compare(out, (w - 1) * REC, (w - 1) * REC + 20, o, o + 20) === 0) {
        const prev = out.readDoubleLE((w - 1) * REC + 20), v = tmp.readDoubleLE(o + 20);
        out.writeDoubleLE(Number.isNaN(prev) ? v : Number.isNaN(v) ? prev : prev + v, (w - 1) * REC + 20);
        continue;
      }
      tmp.copy(out, w++ * REC, o, o + REC); // w never passes s: writing back into the same buffer is safe
    }
  }
  table[NB] = w;
  const head = Buffer.alloc(HEAD);
  head.write("ADX1", 0);
  head.writeUInt32LE(w, 4);
  head.writeUInt32LE(NB, 8);
  Buffer.from(table.buffer).copy(head, 16);
  mkdirSync(dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`, fd = openSync(tmpFile, "w");
  try { writeSync(fd, head); writeSync(fd, out, 0, w * REC); } finally { closeSync(fd); }
  renameSync(tmpFile, file);
  return { count: w, bytes: HEAD + w * REC };
}

// child mode: argv[2] = JSON [{ list, file }], two builds at a time
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const jobs = JSON.parse(process.argv[2] || "[]"), out = {};
  let i = 0;
  await Promise.all([0, 1].map(async () => {
    while (i < jobs.length) {
      const { list, file } = jobs[i++], t = Date.now();
      try { out[list.id] = { ...(await buildList(list, file)), ms: Date.now() - t }; }
      catch (e) { out[list.id] = { error: String(e?.message || e).split("\n")[0].slice(0, 200), ms: Date.now() - t }; }
    }
  }));
  process.stdout.write(JSON.stringify(out));
}
