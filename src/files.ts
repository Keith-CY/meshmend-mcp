// Local file handling: which paths are accepted, where results are written.
// Nothing here touches the network. Inputs are read only; outputs are new
// binary STL files that never replace the input.

import { constants } from 'node:fs';
import { open, stat, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { MAX_BYTES } from './core/mesh';

export type InputFormat = 'stl' | '3mf';
export type InputFile = { path: string; format: InputFormat; bytes: number; buffer: ArrayBuffer; dev: number; ino: number };

export class UserError extends Error {}

/** Expands a leading `~` and resolves relative paths against the server's working directory. */
export function resolvePath(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new UserError('Give the path of an STL or 3MF file.');
  let p = raw.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
}

export function formatOf(path: string): InputFormat | null {
  const ext = extname(path).toLowerCase();
  return ext === '.stl' ? 'stl' : ext === '.3mf' ? '3mf' : null;
}

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** Reads an STL or 3MF file after checking its extension, type and size. */
export async function readInput(raw: string): Promise<InputFile> {
  const path = resolvePath(raw);
  const format = formatOf(path);
  if (!format) throw new UserError(`Only .stl and .3mf files are supported; got "${basename(path)}".`);
  let info;
  try {
    info = await stat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UserError(`No file at ${path}. Check the path; relative paths are resolved from ${process.cwd()}, so an absolute path is safer.`);
    if (code === 'EACCES' || code === 'EPERM') throw new UserError(`Permission denied reading ${path}.`);
    throw new UserError(`Could not open ${path} (${code ?? 'unknown error'}).`);
  }
  if (!info.isFile()) throw new UserError(`${path} is not a regular file.`);
  if (info.size === 0) throw new UserError(`${path} is empty.`);
  if (info.size > MAX_BYTES) throw new UserError(`${basename(path)} is ${mib(info.size)}; the limit is 30 MiB. Reduce or split the model first.`);
  const handle = await open(path, 'r');
  try {
    const data = await handle.readFile();
    if (data.byteLength > MAX_BYTES) throw new UserError(`${basename(path)} grew past the 30 MiB limit while it was being read.`);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return { path, format, bytes: data.byteLength, buffer, dev: info.dev, ino: info.ino };
  } finally {
    await handle.close();
  }
}

async function exists(path: string) {
  try {
    return await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Where to write. With no explicit path: `<name><suffix>.stl` next to the input,
 * then `-2`, `-3`, … rather than replacing anything. With an explicit path: it
 * must end in .stl, its folder must exist, and an existing file is replaced
 * only with `overwrite`. The input itself is never a valid output.
 */
export async function chooseOutput(input: InputFile, requested: string | undefined, suffix: string, overwrite: boolean): Promise<{ path: string; replaces: boolean }> {
  if (requested === undefined || requested === null || (typeof requested === 'string' && !requested.trim())) {
    const dir = dirname(input.path);
    const stem = basename(input.path, extname(input.path));
    for (let n = 1; n < 1000; n++) {
      const candidate = join(dir, `${stem}${suffix}${n === 1 ? '' : `-${n}`}.stl`);
      if (!(await exists(candidate))) return { path: candidate, replaces: false };
    }
    throw new UserError(`Too many earlier results next to ${basename(input.path)}; pass output_path.`);
  }
  const path = resolvePath(requested);
  if (extname(path).toLowerCase() !== '.stl') throw new UserError('output_path must end in .stl (the result is always a binary STL).');
  const dir = await exists(dirname(path));
  if (!dir || !dir.isDirectory()) throw new UserError(`The folder ${dirname(path)} does not exist.`);
  const current = await exists(path);
  if (current) {
    if (path === input.path || (current.dev === input.dev && current.ino === input.ino)) throw new UserError('output_path is the input file. The original is never overwritten; choose another name.');
    if (!current.isFile()) throw new UserError(`${path} exists and is not a regular file.`);
    if (!overwrite) throw new UserError(`${path} already exists. Pass overwrite: true to replace it, or choose another output_path.`);
    return { path, replaces: true };
  }
  if (path === input.path) throw new UserError('output_path is the input file. The original is never overwritten; choose another name.');
  return { path, replaces: false };
}

/** Writes the result: exclusive create for new files, temp file + rename when replacing. */
export async function writeOutput(target: { path: string; replaces: boolean }, data: ArrayBuffer): Promise<number> {
  const bytes = new Uint8Array(data);
  if (!target.replaces) {
    try {
      await writeFile(target.path, bytes, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new UserError(`${target.path} appeared while writing; nothing was replaced. Try again.`);
      if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') throw new UserError(`Permission denied writing ${target.path}.`);
      throw e;
    }
    return bytes.byteLength;
  }
  const temp = join(dirname(target.path), `.${basename(target.path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, target.path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    if ((e as NodeJS.ErrnoException).code === 'EACCES' || (e as NodeJS.ErrnoException).code === 'EPERM') throw new UserError(`Permission denied writing ${target.path}.`);
    throw e;
  }
  return bytes.byteLength;
}
