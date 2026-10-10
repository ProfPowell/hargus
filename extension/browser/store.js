// Readings library in IndexedDB (no wrapper library). Two stores:
//   readings: { id, har }  — the full HAR-PLUS document
//   index:    lightweight records for listing (title, host, thumbnail, finding counts…)

import { indexRecord } from '../core/harplus.js';
import { profileFromSettings } from '../core/score.js';
import { getPlugins } from '../plugins/index.js';
import { getSettings } from './settings.js';

const DB = 'harplus';
const VERSION = 1;
let opening;

function db() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('readings')) d.createObjectStore('readings', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('index')) d.createObjectStore('index', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return opening;
}

const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const complete = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

export async function saveReading(reading) {
  const profile = profileFromSettings(await getSettings().catch(() => ({})));
  const d = await db();
  const id = reading.log._harplus.id;
  const tx = d.transaction(['readings', 'index'], 'readwrite');
  tx.objectStore('readings').put({ id, har: reading });
  tx.objectStore('index').put(indexRecord(reading, getPlugins(), { profile }));
  await complete(tx);
  return id;
}

/** Re-score every stored reading's index record with `profile`; returns how many were updated. */
export async function rescoreAll(profile, onProgress = () => {}) {
  const d = await db();
  const ids = (await request(d.transaction('index').objectStore('index').getAllKeys())) || [];
  let n = 0;
  for (const id of ids) {
    const har = await getReading(id);
    if (!har) continue;
    const tx = d.transaction('index', 'readwrite');
    tx.objectStore('index').put(indexRecord(har, getPlugins(), { profile }));
    await complete(tx);
    onProgress(++n, ids.length);
  }
  return n;
}

export async function getReading(id) {
  const d = await db();
  return (await request(d.transaction('readings').objectStore('readings').get(id)))?.har ?? null;
}

export async function getIndexRecord(id) {
  const d = await db();
  return (await request(d.transaction('index').objectStore('index').get(id))) ?? null;
}

export async function listReadings() {
  const d = await db();
  const all = await request(d.transaction('index').objectStore('index').getAll());
  return all.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
}

export async function deleteReading(id) {
  const d = await db();
  const tx = d.transaction(['readings', 'index'], 'readwrite');
  tx.objectStore('readings').delete(id);
  tx.objectStore('index').delete(id);
  await complete(tx);
}

export async function deleteAll() {
  const d = await db();
  const tx = d.transaction(['readings', 'index'], 'readwrite');
  tx.objectStore('readings').clear();
  tx.objectStore('index').clear();
  await complete(tx);
}
