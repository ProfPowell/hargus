// Bot-check and waiting-room pages: a reading of one of these audits the gate, not the site.
// Pure: works from data every HAR already has, so imported and older readings are covered too.

import { mainEntry } from './har-util.js';

// Only ever served as part of a challenge or failover page.
const STRONG_URLS = [
  [/botfailover|sitefailover/i, 'Akamai'],
  [/captcha-delivery\.com/i, 'DataDome'],
  [/px-captcha/i, 'HUMAN'],
];
// Also loaded by normal protected pages: they name the vendor, never trigger detection.
const HINT_URLS = [
  [/_Incapsula_Resource/i, 'Imperva'],
  [/queue-it\.net/i, 'Queue-it'],
  [/perimeterx\.net/i, 'HUMAN'],
  [/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform/i, 'Cloudflare'],
];
const TITLE = /just a moment|attention required|access denied|are you a (robot|human)|verify(ing)? you are (a )?human|security check|hang tight|you are (now )?in (the )?(queue|line)|waiting room|pardon our interruption|request unsuccessful/i;
const THIN = 300;
const ERRORS = [403, 429, 503];

const header = (entry, name) => (entry?.response?.headers || []).find((h) => String(h.name).toLowerCase() === name)?.value;
const shortUrl = (u) => { try { return `…${new URL(u).pathname.slice(0, 60)}`; } catch { return String(u).slice(0, 60); } };
const match = (urls, table) => { for (const u of urls) for (const [re, vendor] of table) if (re.test(u)) return { vendor, url: u }; return null; };

function vendorHint(doc, urls) {
  const server = String(header(doc, 'server') || '').toLowerCase();
  if (header(doc, 'cf-ray') || server === 'cloudflare') return 'Cloudflare';
  if (header(doc, 'x-datadome')) return 'DataDome';
  if (server.includes('akamai')) return 'Akamai';
  return match(urls, [...STRONG_URLS, ...HINT_URLS])?.vendor || 'unknown';
}

/** @returns {{ vendor: string, reason: string } | null} */
export function detectInterstitial(reading) {
  const log = reading?.log;
  if (!log?.entries?.length) return null;
  const doc = mainEntry(reading);
  const urls = log.entries.map((e) => e?.request?.url || '');
  const status = doc?.response?.status || 0;
  if (/^challenge$/i.test(String(header(doc, 'cf-mitigated') || '').trim())) return { vendor: 'Cloudflare', reason: 'a cf-mitigated: challenge response header' };
  if (header(doc, 'x-datadome') && status === 403) return { vendor: 'DataDome', reason: 'a 403 response with an x-datadome header' };
  const strong = match(urls, STRONG_URLS);
  if (strong) return { vendor: strong.vendor, reason: `a request to ${shortUrl(strong.url)}` };
  const words = log._harplus?.plugins?.content?.data?.reading?.words;
  if (!Number.isFinite(words) || words >= THIN) return null;
  const title = String(log._harplus?.target?.title || '');
  if (TITLE.test(title)) return { vendor: vendorHint(doc, urls), reason: `the title “${title.slice(0, 80)}”` };
  if (ERRORS.includes(status)) return { vendor: vendorHint(doc, urls), reason: `a ${status} response with only ${words} words` };
  return null;
}
