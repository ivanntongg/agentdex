// File tools confined to one folder. Paths come from the model, so every one is resolved and
// checked against the root (including through symlinks) before it is touched.
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_READ = 200 * 1024;
const MAX_WRITE = 500 * 1024;
const FREE_DIR = 'drafts';

export class WorkspaceError extends Error {}

export async function createWorkspace(rootDir) {
  await mkdir(path.join(rootDir, FREE_DIR), { recursive: true });
  const root = await realpath(rootDir);

  async function resolve(p) {
    if (typeof p !== 'string' || !p.trim()) throw new WorkspaceError('path is required');
    const target = path.resolve(root, p);
    const rel = path.relative(root, target);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new WorkspaceError(`${p} is outside the workspace`);
    // Follow symlinks on the deepest part that exists, then check again.
    let existing = target;
    while (true) {
      try { existing = await realpath(existing); break; } catch { const up = path.dirname(existing); if (up === existing) break; existing = up; }
    }
    const realRel = path.relative(root, existing);
    if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) throw new WorkspaceError(`${p} points outside the workspace`);
    return { abs: target, rel: rel || '.' };
  }

  // True when writing this path needs the user's approval.
  async function needsApproval(p) {
    const { rel } = await resolve(p);
    return !(rel === FREE_DIR || rel.startsWith(FREE_DIR + path.sep));
  }

  const tools = {
    async list_files({ path: p = '.' }) {
      const { abs, rel } = await resolve(p);
      const entries = await readdir(abs, { withFileTypes: true }).catch(() => { throw new WorkspaceError(`${rel} is not a folder`); });
      if (!entries.length) return `${rel} is empty.`;
      return entries.slice(0, 200).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    },
    async read_file({ path: p }) {
      const { abs, rel } = await resolve(p);
      const s = await stat(abs).catch(() => { throw new WorkspaceError(`${rel} does not exist`); });
      if (!s.isFile()) throw new WorkspaceError(`${rel} is not a file`);
      if (s.size > MAX_READ) throw new WorkspaceError(`${rel} is ${Math.round(s.size / 1024)} KB; the limit is ${MAX_READ / 1024} KB`);
      return readFile(abs, 'utf8');
    },
    async write_file({ path: p, content }) {
      const { abs, rel } = await resolve(p);
      if (typeof content !== 'string') throw new WorkspaceError('content must be a string');
      if (Buffer.byteLength(content) > MAX_WRITE) throw new WorkspaceError(`content is over ${MAX_WRITE / 1024} KB`);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return `Wrote ${Buffer.byteLength(content)} bytes to ${rel}.`;
    },
  };

  return { root, resolve, needsApproval, tools };
}

export const FILE_TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders at a path in the workspace. Folders end with /. Use "." for the top.',
    strict: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace (up to 200 KB).',
    strict: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace. Files under drafts/ are written straight away; anywhere else the user is asked first and may decline.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];
