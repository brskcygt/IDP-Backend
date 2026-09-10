'use strict';

/**
 * GET /api/health — liveness probe for the remote (Windows server) install.
 *
 * Unauthenticated and not rate-limited on purpose: installers, service
 * monitors and the desktop client poll it before a user has logged in.
 * server.js mounts it before the session middleware, so a probe never reads
 * or writes the session store and never receives a cookie.
 *
 * Returns only static facts (service name + package version). Never add
 * config, paths, env values or anything derived from secrets here.
 */
const express = require('express');
const { version } = require('../../package.json');

const router = express.Router();

router.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, service: 'idp-backend', version });
});

module.exports = router;
