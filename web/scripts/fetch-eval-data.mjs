// Downloads the real-voice evaluation data into eval/data (git-ignored; the sets are not redistributed here).
//   vocadito  (Zenodo 5578807, CC BY 4.0)         40 solo singing excerpts with f0 and note annotations, 58 MB
//   HumTrans  (Hugging Face dadinghh2/HumTrans,    120 hummed recordings from the test split (12 per person) and
//              CC BY-NC 4.0)                       their MIDI; read out of the 18 GB archive by HTTP range requests
//   DEMAND    (Zenodo 1227121, CC BY 4.0)          one channel of three background-noise recordings, 16 kHz
// Run: npm run eval:fetch [-- --data <dir>]. Files that already exist are skipped.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf('--data');
const root = at >= 0 ? args[at + 1] : join(here, '..', 'eval', 'data');
const UA = { 'user-agent': 'musictool-eval-fetch/1.0' };

async function get(url, range) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: range ? { ...UA, range } : UA, redirect: 'follow' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function save(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

// ---- ZIP reading (central directory, ZIP64, stored or deflated members), from a local buffer or by ranges

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** A zip archive read through `read(offset, length)`. */
async function openZip(read, size) {
  const tailLen = Math.min(size, 65557 + 20 + 56);
  const tail = await read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (u32(tail, loc) !== 0x07064b50) throw new Error('missing ZIP64 locator');
    const rec = await read(u64(tail, loc + 8), 56);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const cd = await read(cdOffset, cdSize);
  const entries = new Map();
  for (let p = 0, k = 0; k < count; k++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('bad central directory');
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.set(name, { method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    async extract(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} not in archive`);
      const head = await read(e.offset, 30);
      const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
      const data = await read(start, e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`unsupported compression ${e.method} for ${name}`);
    },
  };
}

function localZip(bytes) {
  return openZip(async (o, n) => bytes.subarray(o, o + n), bytes.length);
}

async function remoteZip(url) {
  const res = await fetch(url, { headers: { ...UA, range: 'bytes=0-0' }, redirect: 'follow' });
  const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
  await res.arrayBuffer();
  if (!total) throw new Error(`${url}: the server does not report the size`);
  return openZip((o, n) => get(url, `bytes=${o}-${o + n - 1}`), total);
}

// ---- the sets

async function vocadito() {
  const dir = join(root, 'vocadito');
  if (existsSync(join(dir, 'Audio', 'vocadito_40.wav'))) return console.log('vocadito: already there');
  console.log('vocadito: downloading 58 MB from Zenodo ...');
  const zip = await localZip(await get('https://zenodo.org/api/records/5578807/files/vocadito.zip/content'));
  let n = 0;
  for (const name of zip.names) {
    if (name.startsWith('__MACOSX') || name.endsWith('/')) continue;
    await save(join(dir, name), await zip.extract(name));
    n++;
  }
  console.log(`vocadito: ${n} files`);
}

const HUMTRANS = 'https://huggingface.co/datasets/dadinghh2/HumTrans/resolve/main';

async function humtrans(perPerson = 12) {
  const dir = join(root, 'humtrans');
  const keysPath = join(dir, 'keys.json');
  if (!existsSync(keysPath)) await save(keysPath, await get(`${HUMTRANS}/train_valid_test_keys.json`));
  const keys = JSON.parse(await readFile(keysPath, 'utf8')).TEST.slice().sort();
  const byPerson = new Map();
  for (const k of keys) {
    const p = k.split('_')[0];
    if (!byPerson.has(p)) byPerson.set(p, []);
    byPerson.get(p).push(k);
  }
  const chosen = [];
  for (const p of [...byPerson.keys()].sort()) {
    const ks = byPerson.get(p);
    const step = Math.max(1, Math.floor(ks.length / perPerson));
    chosen.push(...ks.filter((_, i) => i % step === 0).slice(0, perPerson));
  }
  const missing = chosen.filter((k) => !existsSync(join(dir, 'wav', `${k}.wav`)) || !existsSync(join(dir, 'midi', `${k}.mid`)));
  if (!missing.length) return console.log(`humtrans: ${chosen.length} recordings already there`);
  console.log(`humtrans: ${missing.length} of ${chosen.length} recordings to fetch ...`);
  const midi = await localZip(await get(`${HUMTRANS}/all_midi.zip`));
  const midiName = new Map(midi.names.map((n) => [n.split('/').pop().replace(/\.mid$/, ''), n]));
  const wav = await remoteZip(`${HUMTRANS}/all_wav.zip`);
  const wavName = new Map(wav.names.map((n) => [n.split('/').pop().replace(/\.wav$/, ''), n]));
  for (const k of missing) {
    await save(join(dir, 'midi', `${k}.mid`), await midi.extract(midiName.get(k)));
    await save(join(dir, 'wav', `${k}.wav`), await wav.extract(wavName.get(k)));
    process.stdout.write('.');
  }
  console.log(`\nhumtrans: ${chosen.length} recordings`);
}

async function demand() {
  for (const env of ['PCAFETER', 'STRAFFIC', 'DLIVING']) {
    const path = join(root, 'noise', `${env}.wav`);
    if (existsSync(path)) continue;
    const zip = await remoteZip(`https://zenodo.org/api/records/1227121/files/${env}_16k.zip/content`);
    await save(path, await zip.extract(zip.names.find((n) => n.endsWith('ch01.wav'))));
    console.log(`noise: ${env}`);
  }
  console.log('noise: DEMAND PCAFETER, STRAFFIC, DLIVING (channel 1)');
}

await vocadito();
await humtrans();
await demand();
console.log(`Data in ${root}. Run: npm run eval:real`);
