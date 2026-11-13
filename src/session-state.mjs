import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const sessionPath = (dir, session, agent) => typeof session === 'string' && session ?
  join(dir, 'sessions', createHash('sha256').update(session + '\0' + (agent ?? 'root')).digest('hex') + '.json') : null;
export async function cached(path) {
  if (!path) return null;
  try {
    if (Date.now() - (await stat(path)).mtimeMs > 30 * 86400000) return null;
    const raw = await readFile(path, 'utf8');
    let block;
    try { block = JSON.parse(raw)?.block; } catch { /* Interrupted or invalid cache. */ }
    if (typeof block === 'string' && block.trim()) return block;
    await unlink(path);
    return null;
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// A stale stat describes the old pathname, not necessarily its current owner.
// Move the actual entry aside before deciding whether it may be discarded.
export async function retireStale(path, cutoff, move = rename) {
  const tomb = path + '.' + randomUUID() + '.retired';
  try {
    if ((await stat(path)).mtimeMs >= cutoff) return false;
    await move(path, tomb);
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if ((await stat(tomb)).mtimeMs < cutoff) {
    await unlink(tomb);
    return true;
  }
  await rename(tomb, path);
  return false;
}

export async function acquire(path, timeout) {
  if (!path) return async () => {};
  const lock = path.slice(0, -5) + '.lock', owner = randomUUID();
  const create = () => writeFile(lock, owner, { flag: 'wx', mode: 0o600 });
  try { await create(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale takeover. Other contenders need not wait for this session.
    const claim = lock + '.takeover';
    const claimTakeover = () => writeFile(claim, owner, { flag: 'wx', mode: 0o600 });
    try { await claimTakeover(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!await retireStale(claim, Date.now() - 5000)) return null;
      try { await claimTakeover(); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    }
    try {
      if (!await retireStale(lock, Date.now() - timeout - 5000)) return null;
      try { await create(); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    } finally { if (await readFile(claim, 'utf8').catch(() => null) === owner) await unlink(claim); }
  }
  return async () => { if (await readFile(lock, 'utf8').catch(() => null) === owner) await unlink(lock); };
}

export async function prepareSessions(dataDir) {
  const dir = join(dataDir, 'sessions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cutoff = Date.now() - 30 * 86400000;
  for (const name of await readdir(dir)) {
    if (!/^[0-9a-f]{64}\.(?:json|lock(?:\.takeover)?)$/u.test(name)) continue;
    const path = join(dir, name);
    try { await retireStale(path, cutoff); } catch { /* Best effort. */ }
  }
}

export async function saveBlock(path, block) {
  if (!path) return;
  const tmp = path + '.' + randomUUID();
  try { await writeFile(tmp, JSON.stringify({ block }), { mode: 0o600, flag: 'wx' }); await rename(tmp, path); }
  finally { await unlink(tmp).catch(() => {}); }
}
