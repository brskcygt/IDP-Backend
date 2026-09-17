'use strict';

/**
 * Repository for the artifact-deploy tables (see store/db.js and
 * docs/ARTIFACT-DEPLOY.md): releases, release_artifacts, deploy_targets,
 * deployment_events and artifact_download_tokens.
 *
 * Same shape as the other repositories: plain functions bound to a
 * `DatabaseSync`, inputs never mutated, the default export bound to the
 * shared database, tests build their own via `createArtifactDeployRepository(db)`.
 * JSON columns are (de)serialized here; nothing here interprets them.
 */

const crypto = require('node:crypto');
const { getDb } = require('./db');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function parseJson(text, fallback = null) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sqlValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowToRelease(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    commitSha: row.commit_sha ?? null,
    sourcePlatform: row.source_platform ?? null,
    sourceIdentity: parseJson(row.source_identity_json),
    status: row.status,
    manifest: parseJson(row.manifest_json),
    configSchema: parseJson(row.config_schema_json) ?? null,
    buildDeploymentId: row.build_deployment_id ?? null,
    error: row.error ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function rowToArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    releaseId: row.release_id,
    component: row.component,
    os: row.os,
    fileName: row.file_name,
    sourceRef: row.source_ref ?? null,
    sha256: row.sha256,
    size: row.size,
  };
}

function rowToTarget(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    agentId: row.agent_id,
    os: row.os,
    environment: row.environment ?? null,
    basePath: row.base_path ?? null,
    ref: row.ref ?? null,
    components: parseJson(row.components_json),
    runtimeConfig: parseJson(row.runtime_config_json),
    currentReleaseId: row.current_release_id ?? null,
    currentVersions: parseJson(row.current_versions_json),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function rowToEvent(row) {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    ts: row.ts,
    component: row.component ?? null,
    stage: row.stage ?? null,
    status: row.status ?? null,
    progress: row.progress ?? null,
    message: row.message ?? null,
  };
}

function rowToToken(row) {
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    agentId: row.agent_id ?? null,
    deploymentId: row.deployment_id ?? null,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    uses: row.uses,
    createdAt: row.created_at ?? null,
  };
}

/** field → [column, serializer] for partial updates. */
const RELEASE_PATCH_COLUMNS = {
  status: ['status', sqlValue],
  commitSha: ['commit_sha', sqlValue],
  sourcePlatform: ['source_platform', sqlValue],
  sourceIdentity: ['source_identity_json', toJson],
  manifest: ['manifest_json', toJson],
  configSchema: ['config_schema_json', toJson],
  buildDeploymentId: ['build_deployment_id', sqlValue],
  error: ['error', sqlValue],
  createdBy: ['created_by', sqlValue],
};

const TARGET_PATCH_COLUMNS = {
  name: ['name', sqlValue],
  agentId: ['agent_id', sqlValue],
  os: ['os', sqlValue],
  environment: ['environment', sqlValue],
  basePath: ['base_path', sqlValue],
  ref: ['ref', sqlValue],
  components: ['components_json', toJson],
  runtimeConfig: ['runtime_config_json', toJson],
  currentReleaseId: ['current_release_id', sqlValue],
  currentVersions: ['current_versions_json', toJson],
};

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function createArtifactDeployRepository(db) {
  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function applyPatch(table, columns, id, patch) {
    const sets = [];
    const values = [];
    for (const [field, [column, serialize]] of Object.entries(columns)) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        sets.push(`${column} = ?`);
        values.push(serialize(patch[field]));
      }
    }
    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  const repo = {
    newId,

    // ------------------------------------------------------------ releases

    createRelease(release) {
      const now = new Date().toISOString();
      const id = release.id || newId('rel');
      db.prepare(`
        INSERT INTO releases (id, project_id, version, commit_sha, source_platform, source_identity_json, status, manifest_json,
          build_deployment_id, error, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        release.projectId,
        release.version,
        sqlValue(release.commitSha),
        sqlValue(release.sourcePlatform),
        toJson(release.sourceIdentity),
        release.status,
        toJson(release.manifest),
        sqlValue(release.buildDeploymentId),
        sqlValue(release.error),
        sqlValue(release.createdBy),
        now,
        now
      );
      return repo.findRelease(id);
    },

    findRelease(id) {
      return rowToRelease(db.prepare('SELECT * FROM releases WHERE id = ?').get(id));
    },

    findReleaseByVersion(projectId, version) {
      return rowToRelease(db.prepare('SELECT * FROM releases WHERE project_id = ? AND version = ?').get(projectId, version));
    },

    listReleases(projectId, limit = 100) {
      return db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(projectId, limit)
        .map(rowToRelease);
    },

    /** All locally stored successful releases, newest first (retention input). */
    listReadyLocalReleases(projectId) {
      return db.prepare(`
        SELECT * FROM releases
        WHERE project_id = ? AND status = 'ready' AND source_platform = 'local'
        ORDER BY ready_order DESC, updated_at DESC, rowid DESC
      `).all(projectId).map(rowToRelease);
    },

    /** Monotonic per-project finalization order; avoids created_at/clock ties. */
    markReleaseFinalized(releaseId, projectId) {
      return db.prepare(`
        UPDATE releases
        SET ready_order = (
          SELECT COALESCE(MAX(ready_order), 0) + 1 FROM releases WHERE project_id = ?
        )
        WHERE id = ? AND project_id = ?
      `).run(projectId, releaseId, projectId).changes > 0;
    },

    /** A target reporting this release is protected from delete/prune. */
    isReleaseCurrent(releaseId) {
      if (db.prepare('SELECT 1 FROM deploy_targets WHERE current_release_id = ? LIMIT 1').get(releaseId)) return true;
      const release = repo.findRelease(releaseId);
      if (!release) return false;
      // A partial/component-only deploy deliberately leaves current_release_id
      // null. Protect any local release still reported in currentVersions too.
      const rows = db.prepare('SELECT current_versions_json FROM deploy_targets WHERE project_id = ? AND current_versions_json IS NOT NULL')
        .all(release.projectId);
      return rows.some((row) => {
        const versions = parseJson(row.current_versions_json);
        return isObject(versions) && Object.values(versions).some(
          (entry) => isObject(entry) && entry.version === release.version
        );
      });
    },

    updateRelease(id, patch) {
      applyPatch('releases', RELEASE_PATCH_COLUMNS, id, patch);
      return repo.findRelease(id);
    },

    /** Marks rows left mid-build by a previous backend process as failed. */
    recoverInterruptedReleases(reason = 'Interrupted by a server restart') {
      return db.prepare(`
        UPDATE releases
        SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'building'
      `).run(reason, new Date().toISOString()).changes;
    },

    /** Deletes the release, its artifact rows and their download tokens. DB rows only. */
    deleteRelease(id) {
      return transaction(() => {
        db.prepare(`
          DELETE FROM artifact_download_tokens
          WHERE artifact_id IN (SELECT id FROM release_artifacts WHERE release_id = ?)
        `).run(id);
        db.prepare('DELETE FROM release_artifacts WHERE release_id = ?').run(id);
        db.prepare('UPDATE deploy_targets SET current_release_id = NULL WHERE current_release_id = ?').run(id);
        return db.prepare('DELETE FROM releases WHERE id = ?').run(id).changes > 0;
      });
    },

    // ----------------------------------------------------------- artifacts

    /**
     * Replaces a release's artifact rows. A row for the same component/os
     * keeps its id (so a re-import never invalidates an in-flight download
     * URL); rows no longer in the manifest are removed with their tokens.
     * @param {string} releaseId
     * @param {{ component: string, os: string, file: string, sha256: string, size: number, sourceRef: string }[]} artifacts
     */
    replaceArtifacts(releaseId, artifacts) {
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM release_artifacts WHERE release_id = ?').all(releaseId).map(rowToArtifact);
        const keep = new Set();
        for (const artifact of artifacts) {
          const match = existing.find((row) => row.component === artifact.component && row.os === artifact.os);
          if (match) {
            keep.add(match.id);
            db.prepare(`
              UPDATE release_artifacts SET file_name = ?, source_ref = ?, sha256 = ?, size = ? WHERE id = ?
            `).run(artifact.file, sqlValue(artifact.sourceRef), artifact.sha256, artifact.size, match.id);
          } else {
            db.prepare(`
              INSERT INTO release_artifacts (id, release_id, component, os, file_name, source_ref, sha256, size)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(newId('art'), releaseId, artifact.component, artifact.os, artifact.file, sqlValue(artifact.sourceRef), artifact.sha256, artifact.size);
          }
        }
        for (const row of existing) {
          if (keep.has(row.id)) continue;
          db.prepare('DELETE FROM artifact_download_tokens WHERE artifact_id = ?').run(row.id);
          db.prepare('DELETE FROM release_artifacts WHERE id = ?').run(row.id);
        }
        return repo.listArtifacts(releaseId);
      });
    },

    listArtifacts(releaseId) {
      return db.prepare('SELECT * FROM release_artifacts WHERE release_id = ? ORDER BY component ASC, os ASC')
        .all(releaseId)
        .map(rowToArtifact);
    },

    findArtifact(id) {
      return rowToArtifact(db.prepare('SELECT * FROM release_artifacts WHERE id = ?').get(id));
    },

    // ------------------------------------------------------------- targets

    createTarget(target) {
      const now = new Date().toISOString();
      const id = target.id || newId('tgt');
      db.prepare(`
        INSERT INTO deploy_targets (id, project_id, name, agent_id, os, environment, base_path, ref, components_json,
          runtime_config_json, current_release_id, current_versions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        target.projectId,
        target.name,
        target.agentId,
        target.os,
        sqlValue(target.environment),
        sqlValue(target.basePath),
        sqlValue(target.ref),
        toJson(target.components),
        toJson(target.runtimeConfig),
        sqlValue(target.currentReleaseId),
        toJson(target.currentVersions),
        now,
        now
      );
      return repo.findTarget(id);
    },

    findTarget(id) {
      return rowToTarget(db.prepare('SELECT * FROM deploy_targets WHERE id = ?').get(id));
    },

    findTargetByAgent(agentId) {
      return rowToTarget(db.prepare('SELECT * FROM deploy_targets WHERE agent_id = ?').get(agentId));
    },

    listTargets(projectId) {
      return db.prepare('SELECT * FROM deploy_targets WHERE project_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(projectId)
        .map(rowToTarget);
    },

    updateTarget(id, patch) {
      applyPatch('deploy_targets', TARGET_PATCH_COLUMNS, id, patch);
      return repo.findTarget(id);
    },

    deleteTarget(id) {
      return db.prepare('DELETE FROM deploy_targets WHERE id = ?').run(id).changes > 0;
    },

    // -------------------------------------------------------------- events

    insertEvent(event) {
      db.prepare(`
        INSERT INTO deployment_events (deployment_id, ts, component, stage, status, progress, message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.deploymentId,
        event.ts || new Date().toISOString(),
        sqlValue(event.component),
        sqlValue(event.stage),
        sqlValue(event.status),
        sqlValue(event.progress),
        sqlValue(event.message)
      );
    },

    listEvents(deploymentId, limit = 5000) {
      return db.prepare('SELECT * FROM deployment_events WHERE deployment_id = ? ORDER BY id ASC LIMIT ?')
        .all(deploymentId, limit)
        .map(rowToEvent);
    },

    countEvents(deploymentId) {
      return db.prepare('SELECT COUNT(*) AS count FROM deployment_events WHERE deployment_id = ?').get(deploymentId).count;
    },

    // -------------------------------------------------------------- tokens

    insertToken(token) {
      db.prepare(`
        INSERT INTO artifact_download_tokens (token_hash, artifact_id, agent_id, deployment_id, expires_at, max_uses, uses, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(
        token.tokenHash,
        token.artifactId,
        sqlValue(token.agentId),
        sqlValue(token.deploymentId),
        token.expiresAt,
        token.maxUses,
        token.createdAt || new Date().toISOString()
      );
    },

    /**
     * Atomically counts one use of a token — only when it exists, is bound to
     * `artifactId`, is unexpired and has uses left.
     * @returns {object|null} the token record after the use, or null.
     */
    consumeToken(tokenHash, artifactId, nowMs) {
      const result = db.prepare(`
        UPDATE artifact_download_tokens SET uses = uses + 1
        WHERE token_hash = ? AND artifact_id = ? AND expires_at > ? AND uses < max_uses
      `).run(tokenHash, artifactId, nowMs);
      if (result.changes !== 1) return null;
      return rowToToken(db.prepare('SELECT * FROM artifact_download_tokens WHERE token_hash = ?').get(tokenHash));
    },

    deleteExpiredTokens(nowMs) {
      return db.prepare('DELETE FROM artifact_download_tokens WHERE expires_at <= ?').run(nowMs).changes;
    },

    deleteTokensForDeployment(deploymentId) {
      return db.prepare('DELETE FROM artifact_download_tokens WHERE deployment_id = ?').run(deploymentId).changes;
    },
  };
  return repo;
}

module.exports = createArtifactDeployRepository(getDb());
module.exports.createArtifactDeployRepository = createArtifactDeployRepository;
