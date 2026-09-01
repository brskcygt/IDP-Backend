#!/usr/bin/env node
/**
 * One-time migration: move plaintext secrets out of projects.json into the
 * encrypted SecretStore, leaving `secret://<projectId>/<fieldPath>` references
 * behind (T-10 / SEC-01).
 *
 * Runs as a dry run by default. Pass --apply to actually write.
 *
 *   node scripts/migrate-secrets.js            # report only
 *   node scripts/migrate-secrets.js --apply    # migrate
 *
 * Idempotent: values that are already references are left alone, so re-running
 * is safe.
 *
 * Canonical key format: the reference string itself is the store key. One
 * format for both read and write, no derivation rules to get out of sync.
 */
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const { createSecretStore } = require('../src/secrets');
const { describeKeyStatus } = require('../src/secrets/keyManager');
const { makeRef, isRef, SECRET_FIELD_PATHS } = require('../src/secrets/secretRef');

const PROJECTS_FILE = path.join(__dirname, '..', 'src', 'projects.json');
const APPLY = process.argv.includes('--apply');

/**
 * Patterns for credentials that live inside free-text script bodies rather than
 * in a known config field. These are reported, never rewritten automatically —
 * editing someone's deploy script by regex is how you break a deploy at 3am.
 */
const EMBEDDED_SECRET_PATTERNS = [
  { name: 'GitHub PAT (classic)', re: /\bghp_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub PAT (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'GitLab PAT', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Generic bearer/api key assignment', re: /\b(?:api[_-]?key|token|secret)\s*[=:]\s*["']?[A-Za-z0-9_\-]{24,}/gi },
];

function getAtPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

/** Returns a new object with `dottedPath` set — never mutates the input. */
function setAtPath(obj, dottedPath, value) {
  const [head, ...rest] = dottedPath.split('.');
  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }
  return { ...obj, [head]: setAtPath(obj[head] || {}, rest.join('.'), value) };
}

function scanScriptContent(project) {
  const findings = [];
  const script = project.config?.scriptContent;
  if (typeof script !== 'string' || script.length === 0) return findings;

  for (const { name, re } of EMBEDDED_SECRET_PATTERNS) {
    const matches = script.match(re);
    if (matches) {
      findings.push({ type: name, count: matches.length });
    }
  }
  return findings;
}

async function main() {
  const keyStatus = describeKeyStatus();
  console.log(`\nSecret key: ${keyStatus.message}`);

  const store = createSecretStore();
  if (!store) {
    console.error(
      '\n✗ IDP_SECRET_KEY is not configured, so there is nowhere to put the secrets.\n' +
      '  Generate one and add it to backend/.env:\n\n' +
      "    node -e \"console.log(require('./src/secrets/keyManager').generateKey())\"\n"
    );
    process.exit(1);
  }

  if (!fs.existsSync(PROJECTS_FILE)) {
    console.error(`✗ ${PROJECTS_FILE} not found.`);
    process.exit(1);
  }

  const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
  const migrated = [];
  const embeddedFindings = [];
  let alreadyReferenced = 0;

  const nextProjects = [];

  for (const project of projects) {
    let config = project.config || {};

    for (const fieldPath of SECRET_FIELD_PATHS) {
      const value = getAtPath(config, fieldPath);
      if (typeof value !== 'string' || value.trim() === '') continue;

      if (isRef(value)) {
        alreadyReferenced++;
        continue;
      }

      const ref = makeRef(project.id, fieldPath);
      if (APPLY) {
        await store.set(ref, value);
      }
      config = setAtPath(config, fieldPath, ref);
      migrated.push({ project: project.name, fieldPath, ref });
    }

    const findings = scanScriptContent(project);
    if (findings.length > 0) {
      embeddedFindings.push({ project: project.name, findings });
    }

    nextProjects.push({ ...project, config });
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Projects scanned      : ${projects.length}`);
  console.log(`Secrets to migrate    : ${migrated.length}`);
  console.log(`Already referenced    : ${alreadyReferenced}`);

  for (const m of migrated) {
    console.log(`  • ${m.project} → ${m.fieldPath}`);
  }

  if (embeddedFindings.length > 0) {
    console.log(`\n⚠  Credentials found inside scriptContent — NOT migrated automatically:`);
    for (const f of embeddedFindings) {
      for (const finding of f.findings) {
        console.log(`  • ${f.project}: ${finding.type} ×${finding.count}`);
      }
    }
    console.log(
      '\n  These live in free-text deploy scripts, so moving them would mean rewriting\n' +
      '  the script. Rotate them, then reference them from the store instead of\n' +
      '  hardcoding. Leaving them in place keeps them in plaintext on disk.'
    );
  }

  if (!APPLY) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log('DRY RUN — nothing was written. Re-run with --apply to migrate.\n');
    return;
  }

  const backupPath = `${PROJECTS_FILE}.pre-secretstore.${Date.now()}.bak`;
  fs.copyFileSync(PROJECTS_FILE, backupPath);
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(nextProjects, null, 2), { mode: 0o600 });

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`✓ Migrated ${migrated.length} secret(s) into the encrypted store.`);
  console.log(`✓ Backup written to: ${path.basename(backupPath)}`);
  console.log('\nVerify the app still deploys, then delete the backup — it still');
  console.log('contains the plaintext secrets.\n');
}

main().catch((err) => {
  console.error('\n✗ Migration failed:', err.message);
  process.exit(1);
});
