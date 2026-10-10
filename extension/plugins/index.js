// Plugin registry. To add a plugin: write a module that default-exports a plugin object
// (see docs/PLUGINS.md), import it here and add it to BUILTIN. Order sets display order.

import meta from './meta.js';
import vitals from './vitals.js';
import images from './images.js';
import a11yBasics from './a11y-basics.js';
import axe from './axe.js';
import tech from './tech.js';
import network from './network.js';
import security from './security.js';
import wellKnown from './well-known.js';
import dns from './dns.js';
import whois from './whois.js';
import ipIntel from './ip-intel.js';
import exposure from './exposure.js';
import reputation from './reputation.js';
import htmlValidate from './html-validate.js';
import ctLogs from './ct-logs.js';
import html from './html.js';
import css from './css.js';
import javascript from './javascript.js';
import baseline from './baseline.js';
import resilience from './resilience.js';
import cssValidate from './css-validate.js';
import observatory from './observatory.js';
import pagespeed from './pagespeed.js';
import history from './history.js';
import { remotePlugin } from './remote.js';

export const BUILTIN = [
  // in the page
  meta, html, css, vitals, images, a11yBasics, axe,
  // offline analysis
  tech, javascript, baseline, resilience, network, security,
  // validators and outside services
  htmlValidate, cssValidate, pagespeed, observatory,
  dns, whois, ipIntel, exposure, wellKnown, history, ctLogs, reputation,
];

export const GROUP_LABELS = {
  build: 'How it\'s built',
  quality: 'Quality, performance & accessibility',
  security: 'Security',
  infrastructure: 'Infrastructure & intel',
  other: 'Other',
};

export const PHASE_LABELS = {
  page: 'In-page sensors',
  analyze: 'Offline analysis',
  enrich: 'Lookups & external services',
};

/** Built-ins plus remote plugins from settings. */
export function getPlugins(settings = {}) {
  const remotes = (settings.remotes || []).filter((r) => r?.url).map(remotePlugin);
  return [...BUILTIN, ...remotes];
}

export const pluginById = (plugins, id) => plugins.find((p) => p.id === id);
