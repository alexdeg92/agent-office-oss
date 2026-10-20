'use strict';
function fixAllSchemas(s, LabelRef) {
  const obj = shape => s.object(shape, { extra: 'reject' });
  const id = s.string().min(1).max(8192);
  const Fix = obj({ id, kind: s.enumOf(['integration.install','integration.update','integration.review','runtime.enable','runtime.configure','agent.configure','instance.restart','client.reload']),
    target: obj({ runtime: s.string().nullable(), agentId: s.string().nullable(), integration: s.string().nullable() }),
    label: LabelRef, detail: LabelRef.nullable(), automatic: s.boolean(), requiresInput: s.boolean(), requiresConsent: s.boolean(),
    requiresReauth: s.boolean(), requiresRestart: s.boolean() }).refine(f => !f.automatic || !f.requiresInput && !f.requiresConsent, 'automatic fixes need no input or opt-in')
    .refine(f => f.kind !== 'runtime.enable' || !f.automatic && f.requiresConsent, 'runtime enabling requires explicit consent');
  const Request = obj({ expectedRevision: s.int().min(0), confirmed: s.literal(true), items: s.array(obj({ id, consent: s.literal(true).optional() })).min(1).max(100)
    .refine(items => new Set(items.map(i=>i.id)).size === items.length, 'unique fix ids') });
  const Result = obj({ items: s.array(obj({ id, status: s.enumOf(['applied','failed','input-required']), changed: s.array(s.string()),
    error: obj({ code: s.enumOf(['validation_failed','internal','not_found','conflict','forbidden','unauthorized','readonly','upstream_failed','upstream_unavailable','rate_limited']), issue: s.string().nullable() }).nullable(),
    restartRequired: s.boolean() })).max(100).refine(items => new Set(items.map(i=>i.id)).size === items.length, 'unique result ids'), restartRequired: s.boolean() });
  return { Fix, Request, Result };
}
// Contract-only SettingsVM, v3. Factory uses the shared LabelRef and schema DSL.
module.exports = function settingsSchema(s, LabelRef) {
  const obj = shape => s.object(shape, { extra: 'reject' });
  const str = () => s.string();
  const bool = () => s.boolean();
  const nn = () => s.int().min(0);
  const nstr = () => str().nullable();
  const label = () => LabelRef.nullable();
  const collection = item => s.array(item).refine(rows => new Set(rows.map(r => r.id)).size === rows.length, 'unique ids');
  const source = s.enumOf(['env', 'file', 'default']);
  const value = s.union([str(), s.number(), bool()]).nullable();
  const field = obj({ value, source, editable: bool(), reason: label() });
  const officeField = obj({ value, source, editable: bool(), reason: label(), label: LabelRef, help: LabelRef, minimum: s.int().min(0).max(1440), maximum: s.int().min(1).max(15000) });
  const officeDebounceField = obj({ value, source, editable: bool(), reason: label(), label: LabelRef, help: LabelRef, minimum: s.literal(0), maximum: s.literal(15000) });
  const section = s.enumOf(['diagnostic', 'runtimes', 'connection', 'integrations', 'instance', 'office', 'account']);
  const definition = obj({ id: str(), label: LabelRef, type: s.enumOf(['text', 'textarea', 'url', 'secret', 'number', 'boolean', 'select']), control: s.enumOf(['chips']).optional(),
    required: bool(), writeOnly: bool(), options: s.array(obj({ value: str(), label: LabelRef })) });
  const connectionField = obj({ value, source, editable: bool(), reason: label(), tokenSet: bool().optional() });
  const brand=obj({mark:str(),color:str(),foreground:str(),providerName:str().max(80).optional(),logo:str().refine(v=>/^assets\/connectors\/[a-z0-9-]+\.svg$/.test(v),'local connector logo').optional(),logoDark:str().refine(v=>/^assets\/connectors\/[a-z0-9-]+\.svg$/.test(v),'local connector logo').optional()});
  const integrationStatus = s.enumOf(['installed', 'outdated', 'modified', 'missing', 'unsupported']);
  return obj({
    revision: nn(), readonly: bool(), disabledReason: label(),
    reauth: obj({ expiresAt: nn().nullable(), windowMs: s.literal(300000) }),
    restart: obj({ supported: bool(), command: nstr(), reason: label() }).nullable(),
    instance: obj({ name: field, locale: field, timeZone: field }).nullable(),
    office: obj({ finishedSessionWindowMinutes: officeField, agentPresenceWindowMinutes: officeField, idleRelocationMinutes: officeField, idleTransitionDebounceMs: officeDebounceField }).nullable(),
    owner: obj({ revision: nn().optional(), displayName: field, email: field, passwordChangeEnabled: bool(), reason: label() }),
    network: obj({ mode: field, host: field, port: field, publicUrl: field, cookieSecure: field,
      active: obj({ mode: str(), host: str(), port: s.int().min(1).max(65535), publicUrl: nstr(), cookieSecure: bool() }), restartRequired: bool() }).nullable(),
    herdr: obj({ found: bool(), enabled: bool(), active: bool(), status: s.enumOf(['not-checked', 'available', 'unavailable', 'unsupported', 'stale', 'not-detected']), checkedAt: nn().nullable(), brand:brand.nullable().optional() }),
    runtimes: collection(obj({ id: str(), adapter: str(), enabled: bool(), candidate: bool(), name: str(), brand:obj({mark:str(),color:str(),foreground:str(),providerName:str().max(80).optional(),logo:str().refine(v=>/^assets\/connectors\/[a-z0-9-]+\.svg$/.test(v),'local connector logo').optional(),logoDark:str().refine(v=>/^assets\/connectors\/[a-z0-9-]+\.svg$/.test(v),'local connector logo').optional()}).nullable().optional(), optional:bool().optional(), autoAdd:obj({enabled:bool(),defaultEnabled:bool(),managed:bool()}).optional(), found: bool(), supported: bool(), selected: bool(),
      detection: obj({ status: s.enumOf(['not-checked', 'detected', 'not-detected', 'unreadable', 'enabled']), checkedAt: nn().nullable() }).optional(),
      confidence: str(), reason: LabelRef, checkedPaths: s.array(str()), fields: collection(definition), values: s.record(connectionField),
      connection: obj({ status: s.enumOf(['connected', 'unreachable', 'refused', 'unauthorized', 'not-configured', 'unsupported', 'unsupported-format', 'capacity-limited']),
        protocol: nn().nullable(), latencyMs: nn().nullable(), checkedAt: nn().nullable() }) }).refine(runtime => {
      if (runtime.detection) {
        const { status, checkedAt } = runtime.detection;
        if (runtime.found !== ['detected', 'enabled'].includes(status) || (status === 'not-checked' && checkedAt !== null) || (!['not-checked', 'enabled'].includes(status) && checkedAt === null)) return false;
      }
      const declared = new Map(runtime.fields.map(f => [f.id, f]));
      return Object.entries(runtime.values).every(([id, value]) => {
        const definition = declared.get(id);
        return definition && (definition.writeOnly ? value.value === null && typeof value.tokenSet === 'boolean' : value.tokenSet === undefined);
      });
    }, 'declared connection fields; credentials are write-only')),
    agents: collection(obj({ id: str(), agentId: str(), runtime: str(), name: nstr(), detectedName: nstr(), nameSource: nstr(), autoAddedAt:nn().nullable().optional(), isNew:bool().optional(),
      configured: bool(), hidden: bool(), isPrimary: bool(), model: nstr(), lookRoute: nstr(),
      integrations: collection(obj({ id: str(), status: integrationStatus })) })),
    diagnostics: collection(obj({ id: str(), level: s.enumOf(['error', 'warning', 'info', 'ok']), label: LabelRef, detail: label(), section,
      fix: fixAllSchemas(s, LabelRef).Fix.nullable() })),
  });
};
module.exports.fixAllSchemas = fixAllSchemas;
