'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const VpnManager = require('../src/services/vpn/VpnManager');

test('Check Point info parser accepts a connected tunnel', () => {
  assert.equal(VpnManager.isCheckpointInfoConnected('Tunnel status: Connected\n'), true);
  assert.equal(VpnManager.isCheckpointInfoConnected('Current tunnel is UP\n'), true);
});

test('Check Point info parser never mistakes disconnected text for connected', () => {
  assert.equal(VpnManager.isCheckpointInfoConnected('Status: Disconnected\n'), false);
  assert.equal(VpnManager.isCheckpointInfoConnected('Tunnel status: down\n'), false);
  assert.equal(VpnManager.isCheckpointInfoConnected('Connection failed: not connected\n'), false);
});

test('Check Point verification polls until trac reports a real tunnel', async () => {
  const original = VpnManager._runCheckpointCommand;
  const outputs = ['Status: Disconnected', 'Status: Connected'];
  VpnManager._runCheckpointCommand = async () => outputs.shift();
  const logs = [];
  try {
    await VpnManager._verifyCheckpointConnection('/fake/trac', 'site', (line) => logs.push(line), 2, 0);
  } finally {
    VpnManager._runCheckpointCommand = original;
  }
  assert.ok(logs.some((line) => line.includes('reports the tunnel as connected')));
});

test('Check Point verification rejects authentication-only false positives', async () => {
  const original = VpnManager._runCheckpointCommand;
  VpnManager._runCheckpointCommand = async () => 'Status: Disconnected';
  try {
    await assert.rejects(
      VpnManager._verifyCheckpointConnection('/fake/trac', 'site', () => {}, 2, 0),
      /authentication completed but the VPN tunnel is not connected/
    );
  } finally {
    VpnManager._runCheckpointCommand = original;
  }
});
