#!/usr/bin/env node
'use strict';

// node scripts/make-manifest.js <artifactName> <version> <commit> <component>:<os>:<file> ...

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,31}$/;
const OS_VALUES = new Set(['win-x64', 'linux-x64', 'any']);

function parseEntry(entry) {
  const first = entry.indexOf(':');
  const second = first < 0 ? -1 : entry.indexOf(':', first + 1);
  if (first < 1 || second < first + 2 || second === entry.length - 1) {
    throw new Error(`Invalid artifact entry '${entry}'; expected component:os:file.`);
  }
  const component = entry.slice(0, first);
  const os = entry.slice(first + 1, second);
  const file = entry.slice(second + 1);
  if (!COMPONENT.test(component)) throw new Error(`Invalid component '${component}'.`);
  if (!OS_VALUES.has(os)) throw new Error(`Invalid artifact OS '${os}'.`);
  return { component, os, file };
}

async function hashFile(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Artifact is empty or not a regular file: ${file}`);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { size: stat.size, sha256: hash.digest('hex') };
}

async function makeManifest(args, cwd = process.cwd()) {
  const [project, version, commit, ...rawEntries] = args;
  if (!NAME.test(project || '')) throw new Error('artifactName must be 1-64 letters, digits, dot, underscore or dash.');
  if (!VERSION.test(version || '')) throw new Error('version must be 1-64 letters, digits, dot, underscore or dash.');
  if (typeof commit !== 'string' || commit.length < 7 || commit.length > 128 || /\s/.test(commit)) {
    throw new Error('commit must be a non-whitespace revision of 7-128 characters.');
  }
  if (rawEntries.length === 0 || rawEntries.length > 40) throw new Error('Provide between 1 and 40 artifact entries.');

  const seen = new Set();
  const seenFiles = new Set();
  const artifacts = [];
  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    const key = `${entry.component}/${entry.os}`;
    if (seen.has(key)) throw new Error(`Duplicate component/OS entry: ${key}.`);
    seen.add(key);
    const absolute = path.resolve(cwd, entry.file);
    const fileName = path.basename(absolute);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(fileName)) {
      throw new Error(`Invalid artifact file name '${fileName}'.`);
    }
    if (seenFiles.has(fileName)) throw new Error(`Duplicate artifact file: ${fileName}.`);
    seenFiles.add(fileName);
    const digest = await hashFile(absolute);
    artifacts.push({ component: entry.component, os: entry.os, file: fileName, ...digest });
  }

  return {
    fileName: `${project}-${version}-manifest.json`,
    manifest: {
      schema: 1,
      project,
      version,
      commit,
      createdAt: new Date().toISOString(),
      artifacts,
    },
  };
}

async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const result = await makeManifest(args, cwd);
  const output = path.join(cwd, result.fileName);
  const temporary = `${output}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: 'wx' });
  await fs.promises.rename(temporary, output);
  process.stdout.write(`${output}\n`);
  return output;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`make-manifest: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseEntry, hashFile, makeManifest, main };
