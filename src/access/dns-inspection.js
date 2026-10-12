'use strict';
const net = require('node:net');
const { domainToASCII } = require('node:url');
const providers = require('./dns-providers.json');

const TYPES = Object.freeze({ A: 1, CNAME: 5, AAAA: 28, NS: 2 });
const OUTPUT_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'NS']);
const RESOLVERS = Object.freeze([
  Object.freeze({ id: 'google', endpoint: 'https://dns.google/resolve' }),
  Object.freeze({ id: 'cloudflare', endpoint: 'https://cloudflare-dns.com/dns-query' }),
]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RECORDS_PER_TYPE = 16;
const QUERY_TIMEOUT_MS = 3000;
const JOB_TIMEOUT_MS = 15000;
const MAX_ZONE_LABELS = 3;
const MAX_QUERIES_PER_INSPECTION = 8;
const asTimeout = (ms) => AbortSignal.timeout(ms);

function canonicalDomain(value) {
  if (typeof value !== 'string' || value.length > 260 || value !== value.trim() || /[\s\x00-\x1f\x7f\\/@?#:*%]/.test(value)) throw invalidDomain();
  let name = value.endsWith('.') ? value.slice(0, -1) : value;
  name = domainToASCII(name).toLowerCase();
  if (!name || name.length > 253 || net.isIP(name) || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) throw invalidDomain();
  const labels = name.split('.');
  if (labels.length < 2 || labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw invalidDomain();
  return name;
}
function invalidDomain() { return Object.assign(new Error('invalid domain'), { code: 'EDOMAIN' }); }
function canonicalDnsName(value) {
  if (typeof value !== 'string' || value.length > 260 || !value.endsWith('.')) throw new Error('invalid DNS name');
  return canonicalDomain(value.slice(0, -1));
}
function safeTtl(value) { return Number.isInteger(value) && value >= 0 && value <= 86400 ? value : null; }
function suffixMatch(name, suffix) { return name === suffix || name.endsWith('.' + suffix); }
function detectProvider(nameservers) {
  const matches = new Set();
  for (const server of nameservers) for (const provider of providers) {
    if (provider.id === 'unknown') continue;
    if (provider.nsSuffixes.some(s => suffixMatch(server, s)) || provider.nsPatterns.some(pattern => new RegExp(pattern, 'i').test(server))) matches.add(provider.id);
  }
  if (matches.size !== 1) return { id: 'unknown', confidence: 'unknown', evidence: [] };
  const id = [...matches][0], evidence = [...new Set(nameservers)].filter(ns => {
    const provider = providers.find(p => p.id === id);
    return provider.nsSuffixes.some(s => suffixMatch(ns, s)) || provider.nsPatterns.some(pattern => new RegExp(pattern, 'i').test(ns));
  }).map(ns => ({ ns }));
  return { id, confidence: evidence.length > 1 ? 'high' : 'medium', evidence };
}

async function readBounded(response, signal) {
  if (!response?.body?.getReader) throw new Error('invalid response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || new Error('timeout');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('oversized response'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks, size).toString('utf8');
}
function parseAnswer(answer, name, type) {
  const actualType = Object.keys(TYPES).find(key => TYPES[key] === answer?.type);
  if (!answer || typeof answer.name !== 'string' || typeof answer.data !== 'string'
    || (actualType !== type && !(actualType === 'CNAME' && ['A', 'AAAA'].includes(type)))) throw new Error('invalid DNS record');
  const owner = canonicalDnsName(answer.name);
  const ttl = safeTtl(answer.TTL);
  let value;
  if (actualType === 'A' || actualType === 'AAAA') {
    if (net.isIP(answer.data) !== (actualType === 'A' ? 4 : 6)) throw new Error('invalid IP record');
    value = answer.data.toLowerCase();
  } else value = canonicalDnsName(answer.data);
  return { name: owner, type: actualType, value, ttl };
}
function validatePayload(payload, queryName, type) {
  if (!payload || ![0, 3].includes(payload.Status) || !Array.isArray(payload.Question) || payload.Question.length !== 1 || !Array.isArray(payload.Answer || [])) throw new Error('invalid DNS response');
  const question = payload.Question[0];
  if (canonicalDnsName(question.name) !== queryName || question.type !== TYPES[type] || (payload.Answer || []).length > MAX_RECORDS_PER_TYPE || payload.Status === 3 && (payload.Answer || []).length) throw new Error('DNS question mismatch');
  const parsed = (payload.Answer || []).map(answer => parseAnswer(answer, queryName, type));
  const accepted = [], reachable = new Set([queryName]);
  for (let hop = 0; hop <= 4; hop++) {
    const rows = parsed.filter(record => reachable.has(record.name) && !accepted.includes(record));
    for (const record of rows) accepted.push(record);
    const aliases = rows.filter(record => record.type === 'CNAME');
    if (!aliases.length) break;
    for (const alias of aliases) {
      if (reachable.has(alias.value) || hop === 4) throw new Error('DNS CNAME chain invalid');
      reachable.add(alias.value);
    }
  }
  if (accepted.length !== parsed.length) throw new Error('DNS answer owner mismatch');
  return accepted;
}
async function query(fetcher, resolver, name, type, jobSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(jobSignal.reason || new Error('job timeout'));
  jobSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('query timeout')), QUERY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const url = new URL(resolver.endpoint);
    url.searchParams.set('name', name);
    url.searchParams.set('type', type);
    const response = await fetcher(url.toString(), { method: 'GET', headers: { accept: 'application/dns-json' }, cache: 'no-store', redirect: 'error', signal: controller.signal });
    const contentType = response.headers?.get?.('content-type') || '';
    if (!response.ok || !/^application\/dns-json(?:\s*;|$)/i.test(contentType)) throw new Error('resolver unavailable');
    const body = await readBounded(response, controller.signal);
    return validatePayload(JSON.parse(body), name, type);
  } finally {
    clearTimeout(timer);
    jobSignal.removeEventListener('abort', abort);
  }
}

function createDnsInspector(options = {}) {
  const { fetcher = globalThis.fetch, now = () => Date.now(), env = process.env } = options;
  if (!fetcher) throw new Error('DNS fetcher required');
  const assertFixture = () => {
    if ((env.AO_ENV === 'test' || process.env.NODE_TEST_CONTEXT) && !Object.hasOwn(options, 'fetcher')) {
      throw Object.assign(new Error('DNS inspection requires an injected resolver fixture'), { code: 'ETESTPROBE' });
    }
  };
  async function inspect(value) {
    assertFixture();
    const hostname = canonicalDomain(value);
    const started = now();
    const job = new AbortController();
    const jobTimer = setTimeout(() => job.abort(new Error('job timeout')), JOB_TIMEOUT_MS);
    jobTimer.unref?.();
    try {
      const rows = RESOLVERS.map(resolver => ({ resolver, id: resolver.id, state: 'answered', failures: [], zone: null,
        records: { A: [], AAAA: [], CNAME: [], NS: [] } }));
      let queryCount = 0;
      const queryRecord = async (row, name, type) => {
          try {
            if (++queryCount > MAX_QUERIES_PER_INSPECTION) throw Object.assign(new Error('DNS query capacity reached'), { code: 'ECAPACITY' });
            const answers = await query(fetcher, row.resolver, name, type, job.signal);
            for (const answer of answers) if (row.records[answer.type]) row.records[answer.type].push(answer);
            return answers;
          }
          catch (error) { row.failures.push(error?.name === 'AbortError' || /timeout/i.test(error?.message || '') ? 'timeout' : 'invalid-response'); return null; }
      };
      await Promise.all(rows.map(async row => { await queryRecord(row, hostname, 'A'); await queryRecord(row, hostname, 'AAAA'); }));
      // Walk from the entered host toward its parents, using exact-owner NS answers to find
      // the closest delegated zone. Recheck only that owner at the second public resolver.
      // Two address queries per resolver plus at most three NS ancestors and one cross-check
      // stay under the eight-query inspection budget.
      const first = rows[0];
      if (!first.failures.includes('timeout')) {
        const labels = hostname.split('.');
        const candidates = [];
        for (let index = 0; index < labels.length - 1 && candidates.length < MAX_ZONE_LABELS; index++) candidates.push(labels.slice(index).join('.'));
        for (const candidate of candidates) {
          const ns = await queryRecord(first, candidate, 'NS');
          if (ns?.length) { first.zone = candidate; break; }
        }
      }
      if (first.zone) {
        rows[1].zone = first.zone;
        await queryRecord(rows[1], first.zone, 'NS');
      }
      for (const row of rows) row.state = row.failures.includes('timeout') ? 'timeout' : row.failures.length ? 'invalid-response' : 'answered';
      const resolvedRows = rows.map(({ resolver, failures, ...row }) => row);
      if (job.signal.aborted) throw Object.assign(new Error('DNS job timed out'), { code: 'ETIMEDOUT' });
      const answered = resolvedRows.filter(row => row.state === 'answered');
      const namesByResolver = answered.map(row => [...new Set(row.records.NS.map(record => record.value))].sort());
      const sameDelegation = answered.length === 2 && answered[0].zone && answered[0].zone === answered[1].zone
        && JSON.stringify(namesByResolver[0]) === JSON.stringify(namesByResolver[1]);
      const nsObservations = sameDelegation ? answered.flatMap(row => row.records.NS.map(record => ({ resolver: row.id, ns: record.value }))) : [];
      const detected = detectProvider(sameDelegation ? namesByResolver[0] : []);
      const elapsedMs = Math.max(0, now() - started);
      return {
        hostname, zone: sameDelegation ? answered[0].zone : null,
        observedAt: now(),
        elapsedMs,
        provider: { ...detected, confidence: detected.id !== 'unknown' && sameDelegation ? 'high' : detected.confidence,
          evidence: detected.evidence.flatMap(item => nsObservations.filter(observation => observation.ns === item.ns).map(observation => ({ resolver: observation.resolver, ns: item.ns }))) },
        resolvers: resolvedRows,
        records: Object.fromEntries(OUTPUT_TYPES.map(type => [type, [...new Map(resolvedRows.flatMap(row => row.records[type]).map(record => [JSON.stringify(record), record])).values()]])),
      };
    } finally { clearTimeout(jobTimer); }
  }
  return Object.freeze({ inspect });
}

module.exports = { createDnsInspector, canonicalDomain, detectProvider, providers, RESOLVERS, TYPES, MAX_RESPONSE_BYTES, MAX_RECORDS_PER_TYPE, QUERY_TIMEOUT_MS, JOB_TIMEOUT_MS, MAX_ZONE_LABELS, MAX_QUERIES_PER_INSPECTION };
