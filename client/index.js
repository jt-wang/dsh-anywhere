import React from 'react';
import { DICTIONARIES, NS } from './strings.js';

const h = React.createElement;
const API = '/api/dsh-anywhere';
const PACKAGE = '@jt-wang/dsh-anywhere';
// Settings → DSH Anywhere. The id is also the settings.section.icon id.
const SECTION = 'dsh-anywhere';

// DSH's locale service once apply() ran; English text before that (and in tests).
let locale;
function t(key, params) {
  if (locale) return locale.bind(NS)(key, params);
  const template = DICTIONARIES.en[key] ?? key;
  return params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template;
}
const activeLocale = () => locale?.getSnapshot?.().active ?? 'en';
function useLocale() {
  const subscribe = React.useCallback(listener => locale?.subscribe ? locale.subscribe(listener) : () => {}, []);
  const snapshot = React.useCallback(() => locale?.getSnapshot?.().revision ?? 0, []);
  return React.useSyncExternalStore ? React.useSyncExternalStore(subscribe, snapshot) : 0;
}

/** "1 paired phone", "2 paired phones", "已配对 2 部手机": the active language's plural form. */
export function pairedPhones(count, language = activeLocale()) {
  let category = 'other';
  try { category = new Intl.PluralRules(language).select(count); } catch {}
  const key = `phones.${category}`;
  const text = t(key, { count });
  return text === key ? t('phones.other', { count }) : text;
}

async function request(path, body) {
  const response = await fetch(`${API}/${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json?.error?.message ?? `Request failed (${response.status})`), { status: response.status, code: json?.error?.code });
  return json;
}

const card = { border: '0.5px solid var(--dsw-alias-settings-card-stroke, #ddd)', borderRadius: 12, background: 'var(--dsw-alias-settings-card-fill, #fff)', padding: '12px 16px' };
const section = { display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary, #111)', fontSize: 13, lineHeight: '20px', padding: '8px 0' };
const label = { color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 12, lineHeight: '18px' };
const button = { minHeight: 32, padding: '0 12px', borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l3, #ccc)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 };
const primary = { ...button, background: 'var(--dsw-alias-button-primary-fill, #111)', color: 'var(--dsw-alias-label-primary-foreground, #fff)', borderColor: 'transparent' };
// DSH's error red is #f25a5a on a #2c2c2e card in dark mode (4.2:1, under 4.5:1 for 13 px text). Mixed a quarter toward
// the label color it reads darker on white and lighter on dark (about 6.8:1 and 5.6:1); the frame is DSH's own 30% red.
const red = 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 75%, var(--dsw-alias-label-primary, #111))';
const danger = { ...button, color: red, fontWeight: 500, borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #b42318) 40%, transparent)' };
const errorText = { color: red };
const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2, #eee)' };
const dot = color => ({ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: color, marginRight: 6, verticalAlign: 'middle' });

function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

const when = value => new Date(value).toLocaleString(activeLocale());
function grantText(grants) {
  const read = grants?.readWorkspaceIds?.includes('*') ? t('devices.all') : t('devices.some', { count: grants?.readWorkspaceIds?.length ?? 0 });
  return `${read} · ${grants?.executeWorkspaceIds?.length ? t('devices.run') : t('devices.read')}`;
}

/** Phone with signal arcs, drawn like DSH's 16 px outline icons. */
export function SectionIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('rect', { x: 2.75, y: 1.75, width: 7.5, height: 12.5, rx: 1.75 }),
    h('path', { d: 'M5.5 12h2' }),
    h('path', { d: 'M12.25 6a2.5 2.5 0 0 1 0 3.5' }),
    h('path', { d: 'M14 4.25a5 5 0 0 1 0 7' }));
}

function Device({ device, busy, onRevoke }) {
  const name = device.deviceName || t('devices.phone');
  return h('div', { style: row, 'data-device': device.revokedAt === null ? 'active' : 'revoked' },
    h('div', { style: { minWidth: 0 } },
      h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(device.revokedAt === null ? {} : label) } }, name),
      h('div', { style: label }, device.revokedAt === null
        ? `${grantText(device.grants)} · ${t('devices.paired', { date: when(device.createdAt) })}`
        : `${t('devices.paired', { date: when(device.createdAt) })} · ${t('devices.revokedAt', { date: when(device.revokedAt) })}`)),
    device.revokedAt === null ? h('button', { type: 'button', style: danger, disabled: busy, onClick: () => onRevoke(device) }, t('devices.revoke')) : null);
}

/** Active phones first, newest pairing first; revoked ones folded under their own heading, newest revocation first. */
export function sortDevices(devices) {
  const active = devices.filter(device => device.revokedAt === null).sort((a, b) => b.createdAt - a.createdAt);
  const revoked = devices.filter(device => device.revokedAt !== null).sort((a, b) => b.revokedAt - a.revokedAt);
  return { active, revoked };
}

function Pairing({ onChanged }) {
  // pairing: undefined | { id, svg, expiresAt, phase, emoji?, device? }
  const [pairing, setPairing] = React.useState(undefined);
  const [making, setMaking] = React.useState(false);
  const [problem, setProblem] = React.useState('');

  React.useEffect(() => {
    if (pairing === undefined || (pairing.phase !== 'waiting' && pairing.phase !== 'confirm')) return undefined;
    const timer = setInterval(async () => {
      try {
        const view = await request('pairing', { id: pairing.id });
        setPairing(current => current?.id === pairing.id ? { ...current, ...view, ...(view.emoji ? {} : { emoji: undefined, device: undefined }) } : current);
        if (view.phase === 'approved') onChanged();
      } catch (cause) {
        setPairing(current => current?.id === pairing.id ? { ...current, phase: cause.status === 404 ? 'expired' : 'failed' } : current);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing?.id, pairing?.phase]);

  // The phone finishes pairing over Tailcat a moment after the approval; read the list again until it shows.
  React.useEffect(() => {
    if (pairing?.phase !== 'approved') return undefined;
    const timer = setInterval(onChanged, 2000);
    const stop = setTimeout(() => clearInterval(timer), 30_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [pairing?.phase]);

  const start = async () => {
    // DSH Anywhere is the owner's phone: it reads every chat and drives agents, so a pairing grants all of DSH Desktop.
    if (!window.confirm(t('pair.warning'))) return;
    setMaking(true); setProblem(''); setPairing(undefined);
    try { setPairing({ ...(await request('pair', { execute: true })), phase: 'waiting' }); }
    catch { setProblem(t('pair.unavailable')); }
    finally { setMaking(false); }
  };
  const answer = async approve => {
    try { const view = await request('pairing/answer', { id: pairing.id, approve }); setPairing(current => ({ ...current, ...view, emoji: undefined, device: undefined })); }
    catch { setPairing(current => ({ ...current, phase: 'failed' })); }
  };
  const cancel = async () => {
    const id = pairing?.id;
    setPairing(undefined);
    if (id) await request('pairing/cancel', { id }).catch(() => {});
  };

  const phase = pairing?.phase;
  const outcome = { approved: t('pair.approved'), refused: t('pair.refused'), expired: t('pair.expired'), failed: t('pair.failed') }[phase];
  return h('div', { style: card, 'data-pairing': phase ?? (making ? 'making' : 'idle') },
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
      phase === 'waiting' || phase === 'confirm' ? null
        : h('button', { type: 'button', style: primary, disabled: making, onClick: start }, making ? t('pair.making') : phase === 'approved' ? t('pair.another') : outcome ? t('pair.again') : t('pair.button'))),
    phase === undefined ? h('div', { style: { ...label, marginTop: 8 } }, t('pair.hint')) : null,
    problem === '' ? null : h('div', { style: { ...errorText, marginTop: 8 }, role: 'alert' }, problem),
    outcome === undefined ? null : h('div', { style: { marginTop: 8, ...(phase === 'approved' ? {} : errorText) }, role: 'status' }, outcome),
    phase === 'waiting' ? h('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('img', { src: svgDataUrl(pairing.svg), alt: t('pair.scan'), width: 224, height: 224, style: { display: 'block', borderRadius: 4 } }),
      h('div', { style: { flex: '1 1 180px', minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { fontWeight: 500 } }, t('pair.scan')),
        h('div', { style: label }, t('pair.hint')),
        h('div', { style: label }, t('pair.scanDetail', { time: new Date(pairing.expiresAt).toLocaleTimeString(activeLocale(), { hour: '2-digit', minute: '2-digit' }) })),
        h('div', null, h('button', { type: 'button', style: { ...button, marginTop: 8 }, onClick: cancel }, t('pair.cancel'))))) : null,
    phase === 'confirm' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { fontWeight: 500 } }, t('pair.ask', { device: pairing.device || t('devices.phone') })),
      h('div', { style: { fontSize: 40, lineHeight: '52px', letterSpacing: 8 }, 'aria-label': (pairing.emoji ?? []).join(' ') }, (pairing.emoji ?? []).join('')),
      h('div', { style: label }, t('pair.askDetail')),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('button', { type: 'button', style: primary, onClick: () => answer(true) }, t('pair.allow')),
        h('button', { type: 'button', style: danger, onClick: () => answer(false) }, t('pair.deny')))) : null);
}

function Section({ embedded = false } = {}) {
  useLocale();
  const [status, setStatus] = React.useState(undefined);
  const [devices, setDevices] = React.useState([]);
  const [down, setDown] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState('');

  const refresh = React.useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([request('status'), request('devices')]);
      setStatus(nextStatus); setDevices(nextDevices.items ?? []); setDown(false);
    } catch { setDown(true); }
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  const revoke = async device => {
    if (!window.confirm(t('devices.revokeConfirm', { device: device.deviceName || t('devices.phone') }))) return;
    setBusy(true); setProblem('');
    try { await request('revoke', { deviceId: device.deviceId }); await refresh(); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const { active, revoked } = sortDevices(devices);
  // On the plugin's own page DSH already shows the title above this.
  const header = h('div', null,
    embedded ? null : h('div', { style: { fontSize: 14, fontWeight: 500 } }, 'DSH Anywhere'),
    down || status === undefined ? null : h('div', { style: label },
      `${t('status.versions', { host: status.hostVersion ?? '', dsh: status.dshVersion ?? '' })} · ${pairedPhones(active.length)} · `,
      h('span', { style: dot(status.running ? 'var(--dsw-alias-state-success-primary, #12b76a)' : 'var(--dsw-alias-state-warning-primary, #f79009)') }),
      status.transport === 'direct' ? t('direct.ready') : t(status.running ? 'tailcat.ready' : 'tailcat.waiting')));

  if (down) return h('div', { style: section, 'data-state': 'error' }, header,
    h('div', { style: card, role: 'alert' },
      h('div', { style: { ...errorText, fontWeight: 500 } }, t('error.down')),
      h('div', { style: { ...label, marginTop: 4 } }, t('error.downNext')),
      h('button', { type: 'button', style: { ...button, marginTop: 8 }, onClick: refresh }, t('error.retry'))));
  if (status === undefined) return h('div', { style: section, 'data-state': 'loading' }, header, h('div', { style: label }, t('status.loading')));

  return h('div', { style: section, 'data-state': active.length ? 'paired' : 'unpaired' },
    header,
    h(Pairing, { onChanged: refresh }),
    h('div', { style: card },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 4 } },
        h('div', { style: { fontWeight: 500 } }, t('devices.title')),
        h('button', { type: 'button', style: button, disabled: busy, onClick: refresh }, t('devices.refresh'))),
      problem === '' ? null : h('div', { style: errorText, role: 'alert' }, problem),
      active.length === 0 ? h('div', { style: { ...label, paddingTop: 4 } }, t('devices.empty'))
        : active.map(device => h(Device, { key: device.deviceId, device, busy, onRevoke: revoke })),
      revoked.length === 0 ? null : h('details', { style: { marginTop: 8 } },
        h('summary', { style: { ...label, cursor: 'pointer', padding: '6px 0' } }, t('devices.revoked', { count: revoked.length })),
        revoked.map(device => h(Device, { key: device.deviceId, device, busy, onRevoke: revoke })))),
    h('div', { style: label }, t('footer')));
}

const PluginPage = () => h(Section, { embedded: true });

/** The chat card for a show_interface call: the agent built a native interface; it opens in DSH Anywhere. */
export function InterfaceCard(props) {
  const block = props.block ?? {};
  const settled = props.phase !== 'preparing' && 'kind' in block;
  const raw = (settled ? block.call?.argsRaw : block.argsRaw) ?? '';
  let title = '';
  try { title = String(JSON.parse(raw).title ?? ''); } catch { title = /"title"\s*:\s*"([^"\\]{1,80})/.exec(raw)?.[1] ?? ''; }
  const state = !settled ? 'building' : block.isError ? 'failed' : 'ready';
  return h('div', { 'data-tool': 'show_interface', 'data-state': state, style: { ...card, display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0', padding: '10px 14px' } },
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title || t('card.title')),
      h('div', { style: label }, t(`card.${state}`))
    )
  );
}

export const name = 'dsh-anywhere-client';
export const inject = ['slots', 'locale'];

export function apply(ctx) {
  locale = ctx.locale;
  if (locale) ctx.effect(() => locale.register(NS, DICTIONARIES), 'dsh-anywhere: copy dictionaries');
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: SECTION, order: 60, label: () => 'DSH Anywhere',
  }, Section)), 'dsh-anywhere: settings section');
  ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon', id: SECTION,
  }, SectionIcon)), 'dsh-anywhere: settings icon');
  // The same page on the plugin's own page under Settings → Plugins.
  ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE,
  }, PluginPage)), 'dsh-anywhere: plugin page');
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'show_interface',
  }, InterfaceCard)), 'dsh-anywhere: show_interface card');
}
