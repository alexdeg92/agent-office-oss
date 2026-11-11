'use strict';
const Busboy = require('busboy');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ApiError, invalid } = require('../v2/errors');
const { normalizeAvatarImage, MAX_INPUT_BYTES, MAX_PIXELS } = require('./avatar-image');
const { createAvatarStorage } = require('./avatar-storage');

const MIME_TYPES = Object.freeze(['image/png','image/jpeg','image/webp']);
const ACCESSORY_SLOT_ORDER = Object.freeze(['body', 'neck', 'face', 'head', 'badge']);
const ACCESSORY_NAMES_EN = Object.freeze({ cap:'Cap', headphones:'Headphones', glasses:'Glasses', scarf:'Scarf', badge:'Badge', beanie:'Beanie',
  'bow-tie':'Bow tie', necktie:'Necktie', crown:'Crown', bandana:'Bandana', monocle:'Monocle', 'flower-crown':'Flower crown',
  'wizard-hat':'Wizard hat', 'party-hat':'Party hat', earrings:'Earrings' });
// The profile picker exposes only named, user-facing packs. Generic role and family
// placeholders remain valid for office occupants but are not account-avatar choices.
const selectableProfileCharacter = character => !!character && character.role !== 'main'
  && !['subagent', 'family-b'].includes(character.id);
const failImage = () => invalid(null, 'invalid-avatar-image');
const failSize = () => new ApiError('validation_failed', { status: 413, details: [{ issue: 'too-large' }] });
const failBusy = () => new ApiError('rate_limited');

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/u).filter(Boolean);
  return Array.from((words.length > 1 ? words[0][0] + words.at(-1)[0] : words[0]?.slice(0, 2) || '?').toLocaleUpperCase()).slice(0, 2).join('');
}

function readUpload(req) {
  const maxRequestBytes = MAX_INPUT_BYTES + 16384;
  if (Number(req.headers['content-length']) > maxRequestBytes) return Promise.reject(failSize());
  return new Promise((resolve, reject) => {
    let parser, settled = false, file = null, mimeType = null, failure = null, fileSeen = false, requestBytes = 0, parserClosed = false, requestEnded = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const complete = () => {
      if (!parserClosed || !requestEnded) return;
      failure ? finish(failure) : file ? finish(null, { bytes: file, mimeType }) : finish(failImage());
    };
    try { parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_INPUT_BYTES, fieldNameSize: 32 } }); }
    catch { finish(failImage()); return; }
    parser.on('file', (field, stream, info) => {
      if (field !== 'file' || fileSeen) { stream.resume(); failure = failImage(); return; }
      fileSeen = true;
      mimeType = info.mimeType;
      let size = 0; const chunks = [];
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_INPUT_BYTES) { failure = failSize(); stream.resume(); return; }
        chunks.push(chunk);
      });
      stream.once('limit', () => { failure = failSize(); });
      stream.once('end', () => { if (!failure) file = Buffer.concat(chunks, size); });
    });
    parser.on('field', () => { failure = failImage(); });
    parser.on('filesLimit', () => { failure = failImage(); });
    parser.on('fieldsLimit', () => { failure = failImage(); });
    parser.once('error', () => finish(failure || failImage()));
    parser.once('close', () => { parserClosed = true; complete(); });
    req.once('end', () => { requestEnded = true; complete(); });
    req.once('error', () => finish(failImage()));
    req.on('data', chunk => {
      requestBytes += chunk.length;
      if (requestBytes > maxRequestBytes && !failure) {
        failure = failSize(); req.unpipe(parser); parser.destroy(); req.resume(); finish(failure);
      }
    });
    req.pipe(parser);
  });
}

function mountAccountAvatar({ r, auth, store, cfg, authed, ok, log = () => {}, now = () => Date.now(), localeOf = () => 'fr' }) {
  if (!store?.avatars || !store?.users || !cfg?.dataDir) return { avatarFor: () => null, profileAvatarForPerson: () => null, close() {} };
  const storage = createAvatarStorage({ dataDir: cfg.dataDir });
  let characterIndex = { characters: new Map(), accessories: new Map() };
  try {
    const index = require('../v2/vm/office').officeDefaults().index;
    characterIndex = { characters: index.characters, accessories: index.accessories };
  } catch { /* An unavailable catalogue fails closed: the VM offers no character choices. */ }
  const selectableCharacters = [...characterIndex.characters.values()].filter(character => selectableProfileCharacter(character)
    && typeof character.packManifest === 'string' && !!character.names?.fr && !!character.names?.en
    && Array.isArray(character.variants) && character.variants.some(variant => !!variant.names?.fr && !!variant.names?.en && typeof variant.thumbnail === 'string'));
  const characterNames = (entry, locale) => entry?.names?.[locale] || entry?.label || entry?.id || '';
  const packMetadata = new Map();
  const packMetadataFor = character => {
    if (typeof character.packManifest !== 'string') return null;
    if (packMetadata.has(character.packManifest)) return packMetadata.get(character.packManifest);
    const filename = path.resolve(__dirname, '../../../design', character.packManifest);
    const root = path.resolve(__dirname, '../../../design');
    if (filename !== root && !filename.startsWith(root + path.sep)) { packMetadata.set(character.packManifest, null); return null; }
    let value = null;
    try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { /* an unavailable pack has no accessory preview refs */ }
    packMetadata.set(character.packManifest, value);
    return value;
  };
  const spriteRef = value => {
    if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return null;
    const normalized = path.posix.normalize(value);
    return normalized.startsWith('assets/') && !normalized.split('/').includes('..') ? normalized : null;
  };
  const accessoryPreviewLayers = (character, accessoryId, variantId) => {
    const accessory = characterIndex.accessories.get(accessoryId);
    const registered = accessory?.layers?.[`${character.id}/${variantId}`]?.idle || accessory?.layers?.[character.id]?.idle;
    const layer = registered?.modes ? registered.modes.day : registered;
    if (layer && (layer.back || layer.front)) return {
      backSpriteRef: spriteRef(layer.back), frontSpriteRef: spriteRef(layer.front),
    };
    const pack = packMetadataFor(character);
    const frame = pack?.variants?.find(variant => variant.id === variantId)?.frames?.find(item => item.id === 'idle');
    const packLayer = frame?.accessories?.[accessoryId];
    if (!packLayer || packLayer.occluded) return { backSpriteRef: null, frontSpriteRef: null };
    const base = character.packManifest.replace(/manifest\.json$/u, '');
    return { backSpriteRef: spriteRef(packLayer.back ? base + packLayer.back : null),
      frontSpriteRef: spriteRef(packLayer.front ? base + packLayer.front : null) };
  };
  const characterChoicesFor = (locale = 'fr', selected = null) => selectableCharacters.map(character => {
    const current = selected?.id === character.id;
    const defaultVariant = selected?.variant || character.variants?.[0]?.id || null;
    const defaultAccessories = new Set(character.variants?.find(variant => variant.id === defaultVariant)?.defaultAccessories || []);
    const colours = (character.variants || []).filter(variant => !!variant.names?.fr && !!variant.names?.en && typeof variant.thumbnail === 'string').map((variant, index) => ({
      id: variant.id, displayName: characterNames(variant, locale), swatch: variant.swatch || null,
      spriteRef: variant.thumbnail || character.thumbnail || null,
      selected: current && selected.variant === variant.id, default: index === 0,
      defaultAccessories: [...(variant.defaultAccessories || character.defaultAccessories || [])].filter(id => character.accessorySupport?.[id]?.supported === true),
    }));
    const accessories = Object.entries(character.accessorySupport || {}).filter(([id, support]) => support?.supported === true && characterIndex.accessories.has(id)
      && typeof characterIndex.accessories.get(id)?.label === 'string' && typeof ACCESSORY_NAMES_EN[id] === 'string')
      .map(([id]) => {
        const accessory = characterIndex.accessories.get(id);
        return { id, displayName: locale === 'en' ? ACCESSORY_NAMES_EN[id] : accessory.label,
          slot: accessory.slot || 'other', selected: current && (selected.accessories || []).includes(id),
          default: defaultAccessories.has(id),
          previewLayers: colours.map(colour => ({ variantId: colour.id, ...accessoryPreviewLayers(character, id, colour.id) })) };
      }).sort((left, right) => {
        const slotOrder = id => { const index = ACCESSORY_SLOT_ORDER.indexOf(id); return index < 0 ? ACCESSORY_SLOT_ORDER.length : index; };
        return slotOrder(left.slot) - slotOrder(right.slot) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      });
    return { id: character.id, displayName: characterNames(character, locale), spriteRef: colours.find(colour => colour.default)?.spriteRef || character.thumbnail || null,
      selected: current, colours, accessories };
  });
  const stages = new Map();
  const stageByUser = new Map();
  const STAGE_TTL_MS = 30 * 60 * 1000;
  const MAX_STAGES = 256;
  const signingKey = typeof cfg.sessionSecret === 'string' ? cfg.sessionSecret : null;
  const signProfileToken = (userId, authGeneration, viewerUserId, viewerGeneration, expiresAt) => {
    if (!signingKey) return null;
    const payload = Buffer.from(JSON.stringify({ userId, authGeneration, viewerUserId, viewerGeneration, expiresAt })).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
    return payload + '.' + signature;
  };
  const verifyProfileToken = token => {
    if (!signingKey || typeof token !== 'string' || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = crypto.createHmac('sha256', signingKey).update(payload).digest();
    let supplied; try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof value.userId === 'string' && Number.isSafeInteger(value.authGeneration)
        && typeof value.viewerUserId === 'string' && Number.isSafeInteger(value.viewerGeneration)
        && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now() ? value : null;
    } catch { return null; }
  };
  const removeStage = (token, { removeBlob = true } = {}) => {
    const stage = stages.get(token); if (!stage) return false;
    stages.delete(token); if (stageByUser.get(stage.userId) === token) stageByUser.delete(stage.userId);
    if (removeBlob && stage.blobId) { try { storage.remove(stage.blobId); } catch { try { log({ event: 'account.avatar.stage_cleanup_failed' }); } catch {} } }
    return true;
  };
  const expireStages = () => { for (const [token, stage] of stages) if (stage.expiresAt <= now()) removeStage(token); };
  const cleanupTimer = setInterval(expireStages, 60_000); cleanupTimer.unref?.();
  try {
    const removed = storage.reconcile(store.avatars.blobIds());
    if (removed) log({ event: 'account.avatar.orphans_removed', count: removed });
  } catch { try { log({ event: 'account.avatar.reconcile_failed' }); } catch {} }

  function userFor(req) {
    const session = auth.sessionOf(req);
    if (!session || req.principal) throw new ApiError('unauthorized');
    const user = store.users.byId(session.userId);
    if (!user || user.status !== 'active' || user.auth_generation !== session.authGeneration) throw new ApiError('unauthorized');
    const person = user.person_id ? store.persons.byId?.(user.person_id) : null;
    if (!person || person.kind !== 'human') throw new ApiError('unauthorized');
    user.name = person.name;
    return user;
  }
  const displayFor = (userId, displayName = '', { profile = false, viewerUserId = null } = {}) => {
    const record = store.avatars.get(userId);
    const kind = record?.kind || 'initials';
    const expiresAt = now() + 5 * 60_000;
    const user = profile && kind === 'photo' ? store.users.byId(userId) : null;
    const viewer = profile && kind === 'photo' && viewerUserId ? store.users.byId(viewerUserId) : null;
    const token = user?.status === 'active' && viewer?.status === 'active'
      ? signProfileToken(userId, user.auth_generation, viewer.id, viewer.auth_generation, expiresAt) : null;
    const imageUrl = kind !== 'photo' ? null : profile && token
      ? `${cfg.publicApiBase || ''}/api/v3/profile-avatars/${encodeURIComponent(token)}`
      : profile ? null : `${cfg.publicApiBase || ''}/api/v3/me/avatar`;
    return { kind, character: kind === 'character' ? { id: record.characterId, variant: record.look.variant ?? null, accessories: [...record.look.accessories] } : null,
      imageUrl, initials: initialsOf(displayName), altLabel: { key: kind === 'photo' ? 'account.avatar.photo' : kind === 'character' ? 'account.avatar.character' : 'account.avatar.initials' } };
  };
  const canWriteAvatar = () => !cfg.readonly && !cfg.readonlyStore;
  const resolveAvatarLocale = req => localeOf(req) === 'en' ? 'en' : 'fr';
  const avatarCapabilities = kind => ({ chooseCharacter: canWriteAvatar() && selectableCharacters.length > 0, uploadPhoto: canWriteAvatar(),
    remove: kind !== 'initials' && canWriteAvatar() });
  const avatarFor = (userId, displayName = '', locale = 'fr', override = {}) => {
    const avatar = displayFor(userId, displayName);
    const kind = override.kind || avatar.kind;
    const character = Object.hasOwn(override, 'character') ? override.character : avatar.character;
    const selected = kind === 'character' && character ? { id: character.id, variant: character.variant, accessories: character.accessories || [] } : null;
    return { ...avatar, kind, character, capabilities: avatarCapabilities(kind),
      uploadLimits: { acceptedTypes: [...MIME_TYPES], maxBytes: MAX_INPUT_BYTES, maxPixels: MAX_PIXELS },
      characterChoices: characterChoicesFor(locale, selected) };
  };
  const profileAvatarForPerson = (personId, displayName = '', viewerUserId = null) => {
    const user = store.users.byPerson?.(personId);
    return user?.status === 'active' ? displayFor(user.id, displayName || store.persons.byId?.(personId)?.name || user.email?.split('@')[0] || '', { profile: true, viewerUserId }) : null;
  };
  const owner = (req, res, next) => { try { if (req.apiVersion !== 3) throw new ApiError('not_found'); req.avatarUser = userFor(req); next(); } catch (error) { next(error); } };
  const operation = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  const audit = (req, user, command) => {
    try { store.audit?.append({ at: now(), requestId: req.requestId || 'req_unknown', actor: { kind: 'human', personId: user.person_id },
      command, target: user.id, outcome: 'ok', detail: 'avatar-updated' }); } catch { /* audit observer failure is handled by the store boundary */ }
  };
  const respond = (res, avatar) => res.json(require('../v2/envelope').okBody({ ok: true, result: { avatar }, revision: null, vm: null }));
  const avatarOrInitials = (user, displayName, locale) => avatarFor(user.id, displayName, locale);
  const stageResponse = (res, token, avatar) => res.json(require('../v2/envelope').okBody({ ok: true,
    result: { avatar, stageId: token, staged: true, expiresAt: stages.get(token)?.expiresAt ?? null }, revision: null, vm: null }));
  const stage = (req, action, avatar, blobId = null) => {
    expireStages();
    const user = userFor(req), prior = stageByUser.get(user.id);
    if (user.id !== req.avatarUser.id || user.auth_generation !== req.avatarUser.auth_generation) throw new ApiError('unauthorized');
    if (prior) removeStage(prior);
    if (stages.size >= MAX_STAGES) {
      const oldest = stages.keys().next().value;
      if (oldest) removeStage(oldest);
    }
    const token = crypto.randomBytes(24).toString('base64url'), expiresAt = now() + STAGE_TTL_MS;
    stages.set(token, { userId: user.id, authGeneration: user.auth_generation, action, blobId, avatar, expiresAt });
    stageByUser.set(user.id, token);
    return token;
  };
  const stagedForCommit = (req, token) => {
    const user = userFor(req); expireStages();
    const pending = typeof token === 'string' ? stages.get(token) : null;
    if (!pending || pending.userId !== user.id || pending.authGeneration !== user.auth_generation || pending.expiresAt <= now()) throw new ApiError('not_found');
    return { token, ...pending };
  };
  const commitStage = (pending, previousBlobId) => {
    removeStage(pending.token, { removeBlob: false });
    if (previousBlobId && previousBlobId !== pending.blobId) {
      try { storage.remove(previousBlobId); } catch { try { log({ event: 'account.avatar.old_blob_remove_failed' }); } catch {} }
    }
  };
  const cancelStage = (req, token) => {
    const pending = stagedForCommit(req, token);
    removeStage(pending.token);
    const user = userFor(req);
    return avatarOrInitials(user, user.name || '', resolveAvatarLocale(req));
  };
  const stagedChange = (req, token) => {
    const pending = stagedForCommit(req, token);
    return { pending, change: { kind: pending.action, ...(pending.action === 'character' ? { characterId: pending.avatar.character.id,
      look: { character: pending.avatar.character.id, variant: pending.avatar.character.variant, accessories: pending.avatar.character.accessories } } : {}),
      ...(pending.action === 'photo' ? { blobId: pending.blobId } : {}) } };
  };
  const serveBytes = (res, bytes) => {
    res.setHeader('Content-Type', 'image/webp'); res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Disposition', 'inline; filename="avatar.webp"'); res.end(bytes);
  };

  r.get('/me/avatar', authed, owner, (req, res) => {
    const record = store.avatars.get(req.avatarUser.id);
    if (record?.kind !== 'photo' || !record.blobId) throw new ApiError('not_found');
    let bytes;
    try { bytes = storage.read(record.blobId); } catch { throw new ApiError('not_found'); }
    serveBytes(res, bytes);
  });

  r.get('/profile-avatars/:token', authed, owner, (req, res) => {
    const target = verifyProfileToken(req.params.token);
    const targetUser = target && store.users.byId(target.userId);
    if (!targetUser || targetUser.status !== 'active' || targetUser.auth_generation !== target.authGeneration
      || target.viewerUserId !== req.avatarUser.id || target.viewerGeneration !== req.avatarUser.auth_generation) throw new ApiError('not_found');
    const record = target && store.avatars.get(target.userId);
    if (!record || record.kind !== 'photo' || !record.blobId) throw new ApiError('not_found');
    let bytes; try { bytes = storage.read(record.blobId); } catch { throw new ApiError('not_found'); }
    serveBytes(res, bytes);
  });

  r.get('/me/avatar/staged/:stageId', authed, owner, (req, res) => {
    const pending = stagedForCommit(req, req.params.stageId);
    if (pending.action !== 'photo' || !pending.blobId) throw new ApiError('not_found');
    let bytes; try { bytes = storage.read(pending.blobId); } catch { throw new ApiError('not_found'); }
    serveBytes(res, bytes);
  });

  r.put('/me/avatar/character', authed, owner, operation(async (req, res) => {
    if (cfg.readonly || cfg.readonlyStore) throw new ApiError('readonly');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !['characterId','variant','accessories'].includes(key))) throw failImage();
    const { characterId, variant = null, accessories = [] } = req.body;
    if (typeof characterId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(characterId)
      || (variant !== null && (typeof variant !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(variant)))
      || !Array.isArray(accessories) || accessories.length > 12 || accessories.some(item => typeof item !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item))
      || new Set(accessories).size !== accessories.length) throw failImage();
    let character;
    try { character = require('../v2/vm/office').officeDefaults().index.characters.get(characterId); } catch { throw failImage(); }
    const variantIds = new Set((character?.variants || []).map(row => row.id));
    const supported = new Set(Object.entries(character?.accessorySupport || {}).filter(([, value]) => value?.supported === true).map(([id]) => id));
    if (!selectableProfileCharacter(character) || !selectableCharacters.some(item => item.id === characterId)
      || (variant !== null && !variantIds.has(variant)) || accessories.some(id => !supported.has(id))) throw failImage();
    const look = { character: characterId, variant, accessories: [...accessories] };
    userFor(req);
    const preview = { ...avatarFor(req.avatarUser.id, req.avatarUser.name || req.avatarUser.email?.split('@')[0] || '', resolveAvatarLocale(req),
      { kind: 'character', character: { id: characterId, variant, accessories: [...accessories] } }),
      imageUrl: null, altLabel: { key: 'account.avatar.character' } };
    const token = stage(req, 'character', preview);
    stageResponse(res, token, preview);
  }));

  r.post('/me/avatar/photo', authed, owner, operation(async (req, res) => {
    if (cfg.readonly || cfg.readonlyStore) throw new ApiError('readonly');
    const input = await readUpload(req);
    let normalized;
    try { normalized = await normalizeAvatarImage(input.bytes, input.mimeType); }
    catch (error) { if (error.code === 'avatar-too-large') throw failSize(); if (error.code === 'avatar-busy') throw failBusy(); throw failImage(); }
    const current = userFor(req);
    if (current.id !== req.avatarUser.id || current.auth_generation !== req.avatarUser.auth_generation) throw new ApiError('unauthorized');
    let blobId;
    try { blobId = storage.write(normalized.bytes); } catch { throw new ApiError('internal'); }
    const latest = userFor(req);
    if (latest.id !== req.avatarUser.id || latest.auth_generation !== req.avatarUser.auth_generation) { try { storage.remove(blobId); } catch {} throw new ApiError('unauthorized'); }
    let token;
    try { token = stage(req, 'photo', { ...avatarFor(req.avatarUser.id, req.avatarUser.name || req.avatarUser.email?.split('@')[0] || '', resolveAvatarLocale(req), { kind: 'photo', character: null }),
      imageUrl: `/api/v3/me/avatar/staged/${encodeURIComponent('pending')}`, altLabel: { key: 'account.avatar.photo' } }, blobId);
    } catch (error) { try { storage.remove(blobId); } catch {} throw error; }
    const pending = stages.get(token);
    pending.avatar.imageUrl = `/api/v3/me/avatar/staged/${encodeURIComponent(token)}`;
    stageResponse(res, token, pending.avatar);
  }));

  r.delete('/me/avatar', authed, owner, operation(async (req, res) => {
    if (cfg.readonly || cfg.readonlyStore) throw new ApiError('readonly');
    const preview = { ...avatarFor(req.avatarUser.id, req.avatarUser.name || req.avatarUser.email?.split('@')[0] || '', resolveAvatarLocale(req), { kind: 'initials', character: null }),
      imageUrl: null, altLabel: { key: 'account.avatar.initials' } };
    const token = stage(req, 'remove', preview);
    stageResponse(res, token, preview);
  }));

  r.delete('/me/avatar/staged/:stageId', authed, owner, operation(async (req, res) => {
    const avatar = cancelStage(req, req.params.stageId);
    respond(res, avatar);
  }));

  return { avatarFor, profileAvatarForPerson, stagedChange, commitStage,
    close() { clearInterval(cleanupTimer); for (const token of stages.keys()) removeStage(token); } };
}

module.exports = { mountAccountAvatar, initialsOf, readUpload, MIME_TYPES };
