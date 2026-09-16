'use strict';

/**
 * IP normalisation and CIDR matching, with no dependencies beyond `node:net`.
 *
 * The gateway's only runtime dependency is `ws`; pulling in an IP library for
 * this would be the second one. The subset needed here is small: parse an
 * address or a CIDR, and test whether an address falls inside it.
 *
 * Everything works on the byte representation, so an IPv4 address and its
 * IPv4-mapped IPv6 form (`::ffff:192.168.0.5`, which is what Node hands back
 * on a dual-stack socket) compare equal. Without that, an allowlist entry
 * written as `192.168.0.5` would silently never match.
 */

const net = require('node:net');

/** @returns {number[] | null} 4 bytes for IPv4, 16 for IPv6; null if unparseable. */
function toBytes(address) {
  const value = String(address == null ? '' : address).trim();
  const kind = net.isIP(value);
  if (kind === 4) return parseIpv4(value);
  if (kind === 6) return parseIpv6(value);
  return null;
}

function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseIpv6(value) {
  // Strip a zone index (`fe80::1%en0`) — it identifies an interface, not a
  // different address, and never appears in an allowlist entry.
  let text = value.split('%')[0];

  // An IPv4-mapped/compatible tail (`::ffff:192.168.0.5`) is rewritten into
  // two hex groups so the rest of this function only deals with hex.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;

  const groups = [];
  for (const group of head) groups.push(group);
  if (rest !== null) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    for (let i = 0; i < missing; i += 1) groups.push('0');
    for (const group of rest) groups.push(group);
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const n = Number.parseInt(group, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/**
 * Unwraps an IPv4-mapped IPv6 address to its 4-byte form so the two spellings
 * of the same address compare equal.
 */
function unmap(bytes) {
  if (bytes.length !== 16) return bytes;
  const mappedPrefix = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mappedPrefix ? bytes.slice(12) : bytes;
}

/**
 * Canonical text form of an address, or null if it cannot be parsed.
 * `::ffff:192.168.0.5` → `192.168.0.5`; `2001:DB8::1` → `2001:db8:0:0:0:0:0:1`.
 */
function normalizeAddress(address) {
  const bytes = toBytes(address);
  if (!bytes) return null;
  const flat = unmap(bytes);
  if (flat.length === 4) return flat.join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((flat[i] << 8) | flat[i + 1]).toString(16));
  return groups.join(':');
}

/**
 * Parses `"203.0.113.4"` or `"203.0.113.0/24"` into a comparable rule.
 * A bare address is treated as a full-length prefix (/32 or /128).
 *
 * @returns {{ bytes: number[], prefix: number, text: string } | null}
 */
function parseRule(entry) {
  const value = String(entry == null ? '' : entry).trim();
  if (!value) return null;

  const slash = value.indexOf('/');
  const addressPart = slash === -1 ? value : value.slice(0, slash);
  const prefixPart = slash === -1 ? null : value.slice(slash + 1);

  const bytes = toBytes(addressPart);
  if (!bytes) return null;
  const flat = unmap(bytes);
  const maxPrefix = flat.length * 8;

  let prefix = maxPrefix;
  if (prefixPart !== null) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix > maxPrefix) return null;
  }

  const canonical = normalizeAddress(addressPart);
  return {
    bytes: flat,
    prefix,
    text: prefix === maxPrefix ? canonical : `${canonical}/${prefix}`,
  };
}

/** @returns {boolean} whether `entry` is a usable address or CIDR. */
function isValidRule(entry) {
  return parseRule(entry) !== null;
}

/** Canonical text of a rule, or null when it is not one. */
function normalizeRule(entry) {
  const rule = parseRule(entry);
  return rule ? rule.text : null;
}

/** @returns {boolean} whether `address` falls inside the parsed `rule`. */
function ruleMatches(rule, address) {
  if (!rule) return false;
  const bytes = toBytes(address);
  if (!bytes) return false;
  const flat = unmap(bytes);

  // An IPv4 rule never matches an IPv6 address, and vice versa.
  if (flat.length !== rule.bytes.length) return false;

  const wholeBytes = Math.floor(rule.prefix / 8);
  for (let i = 0; i < wholeBytes; i += 1) {
    if (flat[i] !== rule.bytes[i]) return false;
  }

  const remainingBits = rule.prefix % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (flat[wholeBytes] & mask) === (rule.bytes[wholeBytes] & mask);
}

/**
 * @param {string[]} entries - addresses and/or CIDRs. Unparseable ones are
 *   ignored rather than throwing: a bad entry must not take the gateway down,
 *   and entries are validated before they are ever stored.
 * @param {string} address
 * @returns {boolean} whether any entry covers the address.
 */
function matchesAny(entries, address) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  for (const entry of entries) {
    const rule = parseRule(entry);
    if (rule && ruleMatches(rule, address)) return true;
  }
  return false;
}

module.exports = { normalizeAddress, normalizeRule, isValidRule, matchesAny, parseRule, ruleMatches };
