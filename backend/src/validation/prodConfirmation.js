'use strict';

/**
 * T-51: production deploys require typing the exact project name to confirm.
 *
 * This is a fixed contract the frontend implements against 1:1 — see the
 * exact error shape below — so nothing here may change without touching
 * both sides.
 */

/**
 * @param {{ name: string }} project
 * @param {{ environment?: string, confirmation?: string }} parameters
 * @returns {null|{ error: string, code: string, expected: string }} `null`
 *   when the deploy may proceed (not Prod, or the confirmation matches);
 *   otherwise the exact 400 body to send.
 */
function checkProdConfirmation(project, parameters) {
  const params = parameters || {};
  if (params.environment !== 'Prod') {
    return null;
  }

  const expected = project.name;
  const provided = typeof params.confirmation === 'string' ? params.confirmation.trim() : '';

  // Case-sensitive, trimmed comparison against the project's name — no
  // normalization beyond stripping surrounding whitespace the user may
  // have introduced by copy/pasting.
  if (provided !== expected) {
    return {
      error: 'Production deployments require typing the project name to confirm.',
      code: 'CONFIRMATION_REQUIRED',
      expected,
    };
  }

  return null;
}

module.exports = { checkProdConfirmation };
