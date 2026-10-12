import { msg, label, has, getLang } from '../i18n.js';
import * as dictionary from '../messages/settings.js';

// MetaVM owns diagnostic wording and parameters; examples use the page fallback.
export function settingsLabel(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  return has(ref.key) ? label(ref) : Object.hasOwn(dictionary[getLang()],ref.key) ? msg(ref.key,ref.params) : label(ref);
}

export function readOnlyBanner(reason) {
  const detail = reason && reason.key !== 'settings.readonly' ? settingsLabel(reason) : '';
  return msg('settings.readonly.banner') + (detail ? ' ' + detail : '');
}

// Older example/adapter rows may omit the identity parameter. Resolve it from the VM.
export function diagnosticText(row, vm) {
  const runtime = vm.runtimes.find(r => row.id === 'runtime:' + r.id);
  const unsupported = runtime && !runtime.supported;
  const ref = unsupported && row.label.key === 'settings.detection.unsupported'
    ? {key:'settings.diagnostic.unsupported',params:{runtime:runtime.name}} : row.label;
  const text = settingsLabel(ref);
  return {
    title:runtime && !ref.params?.runtime ? msg('settings.diagnostic.named',{runtime:runtime.name,status:text}) : text,
    detail:row.detail ? settingsLabel(row.detail) : unsupported ? msg('settings.diagnostic.unsupportedDetail') : null
  };
}

export function detectionText(runtime) {
  const status = runtime.detection?.status || (runtime.found ? 'detected' : runtime.checkedPaths?.length ? 'not-detected' : 'not-checked');
  const keys = { 'not-checked':'notChecked', detected:'detected', 'not-detected':'notDetected', unreadable:'unreadable', enabled:'enabled' };
  return { status, badge:msg('settings.agents.' + keys[status]), reason:settingsLabel(status === 'not-checked' ? {key:'settings.detection.notChecked'} : runtime.reason), checkedAt:runtime.detection?.checkedAt ?? null };
}

export function connectorDetectionText(runtime) {
  const detection = detectionText(runtime);
  const key = { detected:'settings.connectorDetected', 'not-detected':'settings.connectorNotDetected' }[detection.status];
  return key ? msg(key) : detection.badge + ' · ' + msg('settings.connection.connectorComing');
}
