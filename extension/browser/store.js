// Readings library in IndexedDB (no wrapper library). Three stores:
//   readings: { id, har }  — the full HAR-PLUS document
//   index:    lightweight records for listing (title, host, thumbnail, finding counts…)
//   patches:  { id, … } views results waiting to be merged

import { indexRecord } from '../core/harplus.js';
import { profileFromSettings } from '../core/score.js';
import { getPlugins } from '../plugins/index.js';
import { getSettings } from './settings.js';

const DB = 'harplus';
export const VERSION = 3;
let opening;

function db() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('readings')) d.createObjectStore('readings', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('index')) d.createObjectStore('index', { keyPath: 'id' }).createIndex('capturedAt', 'capturedAt');
      if (!d.objectStoreNames.contains('patches')) d.createObjectStore('patches', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('sets')) d.createObjectStore('sets', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); opening = null; };
      resolve(d);
    };
    r.onerror = () => { opening = null; reject(r.error); };
    r.onblocked = () => { opening = null; reject(new Error('database upgrade blocked by another open HARgus page — close other HARgus tabs')); };
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

/** A views patch waiting to be merged into reading `patch.id`. */
export async function saveViewsPatch(patch) {
  const d = await db();
  const tx = d.transaction('patches', 'readwrite');
  tx.objectStore('patches').put(patch);
  await complete(tx);
}

export async function getViewsPatch(id) {
  const d = await db();
  return (await request(d.transaction('patches').objectStore('patches').get(id))) ?? null;
}

export async function deleteViewsPatch(id) {
  const d = await db();
  const tx = d.transaction('patches', 'readwrite');
  tx.objectStore('patches').delete(id);
  await complete(tx);
}

/** Re-score every stored reading's index record with `profile`; returns how many were updated. */
export async function rescoreAll(profile, onProgress = () => {}, shouldStop = () => false) {
  const d = await db();
  const ids = (await request(d.transaction('index').objectStore('index').getAllKeys())) || [];
  let n = 0;
  for (const id of ids) {
    if (shouldStop()) return n;
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
  let all = await request(d.transaction('index').objectStore('index').getAll());
  if (all.some((r) => !r.profile)) {
    // One-time migration: records saved before scoring profiles carry old-formula scores.
    const profile = profileFromSettings(await getSettings().catch(() => ({})));
    const updated = [];
    for (const r of all) {
      if (r.profile) { updated.push(r); continue; }
      const har = await getReading(r.id);
      if (!har) { updated.push(r); continue; }
      const rec = indexRecord(har, getPlugins(), { profile });
      const tx = d.transaction('index', 'readwrite');
      tx.objectStore('index').put(rec);
      await complete(tx);
      updated.push(rec);
    }
    all = updated;
  }
  return all.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
}

export async function deleteReading(id) {
  const d = await db();
  const tx = d.transaction(['readings', 'index', 'patches'], 'readwrite');
  tx.objectStore('readings').delete(id);
  tx.objectStore('index').delete(id);
  tx.objectStore('patches').delete(id);
  await complete(tx);
}

/** All saved sets, newest first. */
export async function listSets() {
  const d = await db();
  const all = await request(d.transaction('sets').objectStore('sets').getAll());
  return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getSet(id) {
  const d = await db();
  return (await request(d.transaction('sets').objectStore('sets').get(id))) ?? null;
}

export async function saveSet(set) {
  const d = await db();
  const tx = d.transaction('sets', 'readwrite');
  tx.objectStore('sets').put(set);
  await complete(tx);
}

/** Deletes the set only; its readings stay. */
export async function deleteSet(id) {
  const d = await db();
  const tx = d.transaction('sets', 'readwrite');
  tx.objectStore('sets').delete(id);
  await complete(tx);
}

export async function deleteAll() {
  const d = await db();
  const tx = d.transaction(['readings', 'index', 'patches'], 'readwrite');
  tx.objectStore('readings').clear();
  tx.objectStore('index').clear();
  tx.objectStore('patches').clear();
  await complete(tx);
}
