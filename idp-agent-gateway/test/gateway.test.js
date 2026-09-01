'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AgentGateway, isAuthorized } = require('../src/gateway');

class Socket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
}

const request = (token = '') => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test('Bearer token doğrulaması kapalı veya doğru token ile geçer', () => {
  assert.equal(isAuthorized(request(), ''), true);
  assert.equal(isAuthorized(request('secret'), 'secret'), true);
  assert.equal(isAuthorized(request('wrong'), 'secret'), false);
});

test('agent handshake, ping ve listeleme akışı', () => {
  const gateway = new AgentGateway({ logger: { info() {}, warn() {} } });
  const socket = new Socket(); gateway.accept(socket, request());
  socket.emit('message', JSON.stringify({ type: 'agent', agentId: 'WIN-01', process: 'handshake', payload: { version: '2.1', agent_version: '1.0', os_info: 'Windows' } }));
  socket.emit('message', JSON.stringify({ type: 'agent', agentId: 'WIN-01', process: 'ping', payload: { cpu: 10 } }));
  assert.equal(socket.sent[0].process, 'handshake_ack');
  assert.equal(socket.sent[1].process, 'pong');
  assert.equal(gateway.listAgents()[0].id, 'WIN-01');
  assert.ok(gateway.listAgents()[0].last_ping);
});

test('web aboneliğine agent sonucu yönlendirilir', () => {
  const gateway = new AgentGateway({ logger: { info() {}, warn() {} } });
  const agent = new Socket(); const web = new Socket();
  gateway.accept(agent, request()); gateway.accept(web, request());
  agent.emit('message', JSON.stringify({ type: 'agent', agentId: 'WIN-01', process: 'handshake', payload: {} }));
  web.emit('message', JSON.stringify({ type: 'web', agentId: 'idp-client', process: 'handshake', payload: {} }));
  web.emit('message', JSON.stringify({ type: 'web', agentId: 'idp-client', process: 'subscribe', payload: { targetAgentId: 'WIN-01' } }));
  agent.emit('message', JSON.stringify({ type: 'agent', agentId: 'WIN-01', process: 'command_execution_result', payload: { success: true } }));
  assert.equal(web.sent.at(-1).process, 'command_execution_result');
  assert.equal(web.sent.at(-1).agentId, 'WIN-01');
});

test('bağlantısı kapanan agent listede çevrimdışı kalır', () => {
  const gateway = new AgentGateway({ logger: { info() {}, warn() {} } });
  const socket = new Socket(); gateway.accept(socket, request());
  socket.emit('message', JSON.stringify({ type: 'agent', agentId: 'WIN-01', process: 'handshake', payload: {} }));
  assert.equal(gateway.listAgents()[0].online, true);
  socket.close(1000, 'restart');
  assert.equal(gateway.listAgents()[0].online, false);
});
