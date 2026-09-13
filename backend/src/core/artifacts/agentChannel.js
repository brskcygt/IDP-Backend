'use strict';

/**
 * Small helpers around AgentGatewayClient for the artifact-deploy services:
 * a subscription that resolves once the gateway acknowledged it, and a
 * command sender that maps gateway answers onto core errors.
 *
 * `gateway` is anything with `subscribe(agentId, handlers)`,
 * `sendArtifactCommand(agentId, process, payload)` and `listAgents()` —
 * AgentGatewayClient in production, a fake in tests.
 */

const { ConflictError, UpstreamError, ValidationError } = require('../errors');

const MAX_ARTIFACT_COMMAND_BYTES = 256 * 1024;

/**
 * Subscribes to one agent's forwarded messages. Resolves after the gateway's
 * `handshake_ack` (the subscribe frame is processed right after the
 * handshake, so a command sent afterwards cannot outrun the subscription).
 *
 * @param {object} gateway
 * @param {string} agentId
 * @param {{ onMessage: (message: object) => void, onClose?: () => void, timeoutMs?: number }} handlers
 * @returns {Promise<{ close: () => void }>}
 */
function openAgentChannel(gateway, agentId, { onMessage, onClose, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    let unsubscribe = null;
    const close = () => {
      try {
        if (unsubscribe) unsubscribe();
      } catch {
        // Closing a dead socket is not an error worth surfacing.
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(error);
    };
    const timer = setTimeout(() => fail(new UpstreamError('Timed out subscribing to the agent gateway.')), timeoutMs);
    timer.unref?.();

    try {
      unsubscribe = gateway.subscribe(agentId, {
        onMessage: (message) => {
          if (!opened) {
            if (message && message.process === 'handshake_ack') {
              opened = true;
              settled = true;
              clearTimeout(timer);
              resolve({ close });
            }
            return;
          }
          onMessage(message);
        },
        onError: (error) => {
          if (!opened) fail(new UpstreamError(`Agent gateway subscription failed: ${error && error.message ? error.message : error}`));
        },
        onClose: () => {
          if (!opened) fail(new UpstreamError('The agent gateway closed the subscription.'));
          else if (onClose) onClose();
        },
      });
    } catch (error) {
      fail(new UpstreamError(`Agent gateway subscription failed: ${error.message}`));
    }
  });
}

/**
 * Sends an artifact command. 404 from the gateway (agent offline) becomes a
 * ConflictError; anything else an UpstreamError. The payload is never logged.
 */
async function sendAgentCommand(gateway, agentId, process, payload) {
  const bytes = Buffer.byteLength(JSON.stringify({ process, payload }));
  if (bytes > MAX_ARTIFACT_COMMAND_BYTES) {
    throw new ValidationError(`Artifact command is too large for the agent gateway (${bytes} > ${MAX_ARTIFACT_COMMAND_BYTES} bytes).`);
  }
  try {
    await gateway.sendArtifactCommand(agentId, process, payload);
  } catch (error) {
    if (error && error.status === 404) throw new ConflictError(`Agent ${agentId} is not connected.`);
    throw new UpstreamError(`The agent gateway rejected the ${process} command: ${error && error.message ? error.message : error}`);
  }
}

/** @returns {Promise<object[]>} the gateway's agent list (UpstreamError when unreachable). */
async function listGatewayAgents(gateway) {
  try {
    return await gateway.listAgents();
  } catch (error) {
    throw new UpstreamError(`Could not reach the agent gateway: ${error && error.message ? error.message : error}`);
  }
}

module.exports = { openAgentChannel, sendAgentCommand, listGatewayAgents, MAX_ARTIFACT_COMMAND_BYTES };
