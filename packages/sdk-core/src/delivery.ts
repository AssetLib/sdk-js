import type { AssetlibConfig, AssetPagePayload, ManifestPayload } from './types.js';
import { validateRenditions } from './renditions.js';
import { validateAccessibility } from './accessibility.js';

export const stateName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
export const assetIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateDescriptor(value: unknown, width: number, height: number, config: AssetlibConfig, renditionSchemaVersion?: unknown): void {
  if (!record(value) || typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || value.mime !== 'image/webp' || !integer(value.bytes, 1, 8 * 1024 * 1024) || typeof value.url !== 'string') throw new Error('Invalid image descriptor.');
  const url = new URL(value.url, config.manifestUrl);
  if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${value.assetId}`) throw new Error('Image descriptor URL is outside the configured app.');
  validateRenditions(renditionSchemaVersion === undefined ? {} : { renditionSchemaVersion }, { ...value, width, height }, config);
  if ('accessibility' in value) validateAccessibility(value.accessibility);
}

function validateStateImages(states: Record<string, unknown>, slot: Record<string, unknown>, config: AssetlibConfig, renditionSchemaVersion: unknown): void {
  for (const value of Object.values(states)) validateDescriptor(value, Number(slot.width), Number(slot.height), config, renditionSchemaVersion);
  const maximumBytes = Object.values(states).reduce((sum: number, value) => {
    const descriptor = value as { bytes: number; renditions?: { bytes: number }[] };
    return sum + Math.max(descriptor.bytes, ...(descriptor.renditions ?? []).map(item => item.bytes));
  }, 0);
  if (maximumBytes > 50 * 1024 * 1024) throw new Error('State set exceeds the complete-group byte budget.');
}

function equivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equivalent(item, right[index]));
  if (!record(left) || !record(right)) return false;
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every(name => Object.hasOwn(right, name) && equivalent(left[name], right[name]));
}

function validateCells(slot: Record<string, unknown>, payload: Record<string, unknown>, config: AssetlibConfig): void {
  if (!('variants' in slot)) {
    if ('cells' in slot) throw new Error('Appearance cells require declared variants.');
    return;
  }
  const variants = slot.variants;
  if (payload.variantSchemaVersion !== 1 || !record(variants) || Object.keys(variants).length !== 1 || !Array.isArray(variants.appearance) || variants.appearance.length < 1 || variants.appearance.length > 2 || variants.appearance.some(value => value !== 'light' && value !== 'dark') || new Set(variants.appearance).size !== variants.appearance.length) throw new Error('Invalid appearance variants.');
  if (!('cells' in slot)) return;
  if (!Array.isArray(slot.cells) || slot.cells.length > variants.appearance.length) throw new Error('Invalid appearance cells.');
  const appearances = new Set<string>();
  for (const cell of slot.cells) {
    if (!record(cell) || typeof cell.appearance !== 'string' || !variants.appearance.includes(cell.appearance) || appearances.has(cell.appearance)) throw new Error('Invalid or duplicate appearance cell.');
    appearances.add(cell.appearance);
    validateDescriptor(cell, Number(slot.width), Number(slot.height), config, payload.renditionSchemaVersion);
    if ('defaultState' in cell) throw new Error('Appearance cells use the placement default state.');
    if (record(slot.states)) {
      if (!record(cell.states) || Object.keys(cell.states).length !== Object.keys(slot.states).length || Object.keys(slot.states).some(name => !Object.hasOwn(cell.states as object, name))) throw new Error('Appearance state family must contain every declared state.');
      validateStateImages(cell.states, slot, config, payload.renditionSchemaVersion);
      const fallback = cell.states[String(slot.defaultState)] as Record<string, unknown>;
      if (['assetId', 'sha256', 'url', 'mime', 'bytes', 'renditions', 'accessibility'].some(name => !equivalent(cell[name], fallback[name]))) throw new Error('Appearance artwork must match its default state.');
    } else if ('states' in cell) throw new Error('A stateless placement cannot have appearance states.');
  }
}

export function validateDeliveryExtensions(payload: Record<string, unknown>, config: AssetlibConfig): void {
  if ('stateSchemaVersion' in payload && payload.stateSchemaVersion !== 1) throw new Error('Unsupported state schema.');
  if ('catalogSchemaVersion' in payload && payload.catalogSchemaVersion !== 1) throw new Error('Unsupported catalog schema.');
  if ('variantSchemaVersion' in payload && payload.variantSchemaVersion !== 1) throw new Error('Unsupported variant schema.');
  if ('catalog' in payload) {
    if (payload.catalogSchemaVersion !== 1 || !record(payload.catalog) || !integer(payload.catalog.count, 0, 1_000_000) || typeof payload.catalog.url !== 'string') throw new Error('Invalid catalog descriptor.');
    const url = new URL(payload.catalog.url, config.manifestUrl);
    const deliveryPath = `/api/delivery/${config.orgId}/${config.appId}`;
    const environmentPath = `${deliveryPath}/environments/${config.environment}/releases/${payload.sequence}/assets`;
    const legacyProductionPath = config.environment === 'production' && url.pathname === `${deliveryPath}/releases/${payload.sequence}/assets`;
    if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || (url.pathname !== environmentPath && !legacyProductionPath)) throw new Error('Catalog URL is outside the configured release.');
  }
  for (const slot of payload.slots as Record<string, unknown>[]) {
    if (!('states' in slot)) {
      if ('defaultState' in slot) throw new Error('A default state requires a state set.');
      validateCells(slot, payload, config);
      continue;
    }
    if (payload.stateSchemaVersion !== 1 || !record(slot.states) || !stateName(slot.defaultState)) throw new Error('Invalid state set.');
    const names = Object.keys(slot.states);
    if (names.length < 2 || names.length > 16 || names.some(name => !stateName(name)) || !Object.hasOwn(slot.states, slot.defaultState)) throw new Error('Invalid state declarations.');
    validateStateImages(slot.states, slot, config, payload.renditionSchemaVersion);
    const fallback = slot.states[slot.defaultState] as Record<string, unknown>;
    if (fallback.assetId !== slot.assetId || fallback.sha256 !== slot.sha256 || fallback.bytes !== slot.bytes || fallback.mime !== slot.mime || fallback.url !== slot.url) throw new Error('Legacy artwork must match the default state.');
    validateCells(slot, payload, config);
  }
}

export function validateAssetPage(payload: unknown, config: AssetlibConfig): AssetPagePayload {
  if (!record(payload) || payload.kind !== 'asset-page' || payload.schemaVersion !== 1 || payload.orgId !== config.orgId || payload.appId !== config.appId || payload.environment !== config.environment || !integer(payload.sequence, 1, 2_147_483_647) || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.assets) || payload.assets.length > 50 || !(payload.nextCursor === null || typeof payload.nextCursor === 'string' && assetIdPattern.test(payload.nextCursor))) throw new Error('Invalid or cross-app asset page.');
  if ('renditionSchemaVersion' in payload && payload.renditionSchemaVersion !== 1) throw new Error('Unsupported rendition schema.');
  if (!(payload.cursor === null || typeof payload.cursor === 'string' && assetIdPattern.test(payload.cursor))) throw new Error('Invalid catalog request cursor.');
  let previous = '';
  for (const asset of payload.assets) {
    if (!record(asset) || !integer(asset.width, 1, 8192) || !integer(asset.height, 1, 8192) || asset.width * asset.height > 16_777_216 || typeof asset.assetId !== 'string' || asset.assetId <= previous || ('name' in asset && (typeof asset.name !== 'string' || asset.name.length > 200))) throw new Error('Invalid or unordered catalog asset.');
    validateDescriptor(asset, asset.width, asset.height, config, payload.renditionSchemaVersion);
    previous = asset.assetId;
  }
  if (payload.nextCursor !== null && (!previous || payload.nextCursor !== previous)) throw new Error('Invalid catalog continuation.');
  return payload as AssetPagePayload;
}

export function validStateRef(states: readonly string[]): boolean {
  return Array.isArray(states) && states.length >= 2 && states.length <= 16 && new Set(states).size === states.length && states.every(stateName);
}

export function catalogForSequence(history: readonly { payload: ManifestPayload }[], sequence: number | undefined): ManifestPayload | undefined {
  return sequence === undefined ? history[0]?.payload : history.find(entry => entry.payload.sequence === sequence)?.payload;
}
