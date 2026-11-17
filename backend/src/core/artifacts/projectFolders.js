'use strict';

/**
 * Names each project's folder in the artifact store after the project, so an
 * operator on the server finds builds at `<root>/<project name>/<version>`.
 *
 * A folder, once given, stays the project's: the id → folder map is kept in
 * `<root>/.project-folders.json`. Renaming the project does not move its
 * releases (their rows point at the project id, and the id still resolves to
 * the old folder), and a second project with the same name gets
 * `<name>-<id>` instead of sharing a folder.
 *
 * A name is cleaned for Windows: characters a path segment cannot hold become
 * `-`, a leading dot is dropped (dot folders are the store's own: `.staging`),
 * reserved device names (CON, NUL, COM1, ...) get the id appended.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAP_FILE = '.project-folders.json';
const MAX_NAME = 80;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/** Folders the store itself writes under the root; a project never gets one of these. */
const STORE_FOLDERS = new Set(['releases', 'layered', 'staging']);

function cleanName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, MAX_NAME)
    .replace(/[.\s]+$/, '');
  return cleaned;
}

/**
 * @param {object} deps
 * @param {string} deps.root - absolute artifact storage root.
 * @param {(projectId: string) => (string|null)} deps.getProjectName - current name, null if unknown.
 * @returns {(projectId: string) => string} folder name for a project id.
 */
function createProjectFolders({ root, getProjectName }) {
  const mapPath = path.join(root, MAP_FILE);
  let map = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${mapPath}: ${err.message}`);
  }

  function save() {
    fs.mkdirSync(root, { recursive: true });
    const temp = `${mapPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(map, null, 2)}\n`);
    fs.renameSync(temp, mapPath);
  }

  function taken(folder) {
    const key = folder.toLowerCase();
    return Object.values(map).some((existing) => String(existing).toLowerCase() === key);
  }

  return function projectFolder(projectId) {
    const id = String(projectId);
    if (typeof map[id] === 'string' && map[id]) return map[id];

    let name = null;
    try { name = getProjectName(id); } catch { name = null; }
    let folder = cleanName(name);
    const unsafeId = cleanName(id) || 'project';
    if (!folder || RESERVED.test(folder) || STORE_FOLDERS.has(folder.toLowerCase())) {
      folder = folder ? `${folder}-${unsafeId}` : unsafeId;
    }
    if (taken(folder)) folder = `${folder}-${unsafeId}`;

    map[id] = folder;
    save();
    return folder;
  };
}

module.exports = { createProjectFolders, cleanName };
