'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAddress, normalizeRule, isValidRule, matchesAny } = require('../src/ipMatch');

test('IPv4-mapped IPv6 adresleri düz IPv4 biçimine indirgenir', () => {
  // Node çift yığınlı sokette adresi bu biçimde döndürür; normalize edilmezse
  // listeye "192.168.0.5" yazan operatörün girdisi hiçbir zaman eşleşmez.
  assert.equal(normalizeAddress('::ffff:192.168.0.5'), '192.168.0.5');
  assert.equal(normalizeAddress('192.168.0.5'), '192.168.0.5');
  assert.equal(matchesAny(['192.168.0.5'], '::ffff:192.168.0.5'), true);
  assert.equal(matchesAny(['::ffff:192.168.0.5'], '192.168.0.5'), true);
});

test('IPv6 adresleri kanonik biçime getirilir, bölge eki atılır', () => {
  assert.equal(normalizeAddress('2001:DB8::1'), '2001:db8:0:0:0:0:0:1');
  assert.equal(normalizeAddress('fe80::1%en0'), 'fe80:0:0:0:0:0:0:1');
});

test('geçersiz girdiler null döner, istisna fırlatmaz', () => {
  for (const value of ['', 'bogus', '999.1.1.1', '1.2.3', null, undefined, {}]) {
    assert.equal(normalizeAddress(value), null, String(value));
  }
});

test('CIDR eşleşmesi bayt ve bit sınırlarında doğru çalışır', () => {
  assert.equal(matchesAny(['192.168.0.0/24'], '192.168.0.5'), true);
  assert.equal(matchesAny(['192.168.0.0/24'], '192.168.1.5'), false);
  assert.equal(matchesAny(['10.0.0.0/8'], '10.255.255.255'), true);
  assert.equal(matchesAny(['0.0.0.0/0'], '8.8.8.8'), true);

  // Bayt ortasında biten prefix.
  assert.equal(matchesAny(['198.51.100.128/25'], '198.51.100.200'), true);
  assert.equal(matchesAny(['198.51.100.128/25'], '198.51.100.100'), false);
});

test('IPv6 CIDR eşleşmesi çalışır ve aileler birbirine karışmaz', () => {
  assert.equal(matchesAny(['2001:db8::/32'], '2001:db8:1234::1'), true);
  assert.equal(matchesAny(['2001:db8::/32'], '2001:db9::1'), false);
  assert.equal(matchesAny(['192.168.0.0/24'], '2001:db8::1'), false);
  assert.equal(matchesAny(['2001:db8::/32'], '192.168.0.1'), false);
});

test('tek adres tam uzunlukta prefix sayılır', () => {
  assert.equal(matchesAny(['203.0.113.4'], '203.0.113.4'), true);
  assert.equal(matchesAny(['203.0.113.4'], '203.0.113.5'), false);
  assert.equal(normalizeRule('203.0.113.4/32'), '203.0.113.4', 'tam prefix metinde gösterilmez');
  assert.equal(normalizeRule('203.0.113.0/24'), '203.0.113.0/24');
});

test('bozuk kural girdileri reddedilir', () => {
  for (const rule of ['', 'not-an-ip', '203.0.113.0/33', '203.0.113.4/abc', '2001:db8::/129']) {
    assert.equal(isValidRule(rule), false, rule);
    assert.equal(normalizeRule(rule), null, rule);
  }
});

test('boş liste hiçbir şeyle eşleşmez; bozuk girdi listeyi düşürmez', () => {
  assert.equal(matchesAny([], '1.2.3.4'), false);
  assert.equal(matchesAny(null, '1.2.3.4'), false);
  assert.equal(matchesAny(['not-an-ip', '1.2.3.4'], '1.2.3.4'), true);
});
