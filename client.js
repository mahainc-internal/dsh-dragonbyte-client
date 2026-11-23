window.__ModuleLoader__.load({
  id: '@snapai/dsh-dragonbyte-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'dsh-dragonbyte';
    const zh = {
      'DragonByte': 'DragonByte',
      'Serve the MCP servers on your own machine to your DSH tenant.': '将你机器上的 MCP 服务器提供给你的 DSH 租户。',
      'Pair this machine': '配对此机器',
      'Pairing…': '正在配对…',
      'Paired': '已配对',
      'Not paired yet.': '尚未配对。',
      'Open Google sign-in in your browser, approve this machine, then come back.': '在浏览器中打开 Google 登录，批准此机器后返回。',
      'MCP servers': 'MCP 服务器',
      'Reconnect': '重新连接',
      'Disconnect': '断开连接',
      'Connected': '已连接',
      'Connecting…': '正在连接…',
      'Not connected': '未连接',
      'No servers configured yet.': '尚未配置服务器。',
      'One per line: name: command, or name: https URL.': '每行一个：name: 命令，或 name: https URL。',
      'These run on this machine.': '这些服务器在此机器上运行。',
      'Save servers': '保存服务器',
      'Saving…': '正在保存…',
      'Could not reach the local host.': '无法连接本地主机。',
      'Could not pair. Try again.': '无法配对，请重试。',
      'Revoking…': '正在撤销…',
    };
    const en = Object.fromEntries(Object.keys(zh).map((key) => [key, key]));
    const css = `
      .dsh-dragonbyte { width: 100%; max-width: 840px; min-width: 0; box-sizing: border-box; color: var(--dsw-alias-label-primary); }
      .dsh-dragonbyte *, .dsh-dragonbyte *::before, .dsh-dragonbyte *::after { box-sizing: border-box; }
      .dsh-dragonbyte h2 { margin: 0 0 8px; font-size: 20px; font-weight: 500; line-height: 1.4; }
      .dsh-dragonbyte > p { margin: 0 0 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
      .dsh-dragonbyte h3 { margin: 0 0 8px; font-size: 14px; font-weight: 500; }
      .dsh-dragonbyte .group { display: grid; gap: 12px; margin: 0 0 28px; }
      .dsh-dragonbyte .row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; min-width: 0; padding: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .dsh-dragonbyte .detail { flex: 1 1 200px; min-width: 0; }
      .dsh-dragonbyte .muted { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .dsh-dragonbyte .actions { display: flex; flex-wrap: wrap; gap: 12px; }
      .dsh-dragonbyte textarea { width: 100%; min-height: 96px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .dsh-dragonbyte textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .dsh-dragonbyte .link { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font-size: 13px; text-decoration: none; }
      .dsh-dragonbyte .link:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-dragonbyte button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font: inherit; font-size: 13px; cursor: pointer; }
      .dsh-dragonbyte button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-dragonbyte button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dsh-dragonbyte button:disabled { cursor: default; opacity: .6; }
      @media (max-width: 560px) { .dsh-dragonbyte button { width: 100%; min-height: 44px; } }
    `;

    // ⚠ THESE ROUTES ARE THE LOCAL HOST'S, NOT THE GATEWAY'S. The page is served
    // by the DSH this plugin is installed in, and that Host owns the routes
    // under its own origin — the same origin `dsh-app://app` forwards to.
    function hostBase() {
      return new URL('dragonbyte/', document.baseURI).toString();
    }

    const STATUS_LABEL = {
      connected: 'Connected', connecting: 'Connecting…', idle: 'Not connected',
      'no-servers': 'No servers configured yet.', error: 'Not connected',
    };

    function DragonbyteSection({ t }) {
      const base = React.useMemo(hostBase, []);
      const [state, setState] = React.useState({ loading: true, status: 'idle', servers: '', paired: false, tenantId: '' });
      const [draft, setDraft] = React.useState('');
      // ⚠ A REFRESH MUST NOT EAT A HALF-TYPED LINE. The field takes the host's
      // value until the person types in it; a save clears this again.
      const edited = React.useRef(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');

      const load = React.useCallback(async (signal) => {
        try {
          const response = await fetch(`${base}status`, { cache: 'no-store', signal, headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('Could not reach the local host.');
          const payload = await response.json();
          setState({ loading: false, ...payload });
          if (!edited.current) setDraft(payload.servers);
          setError('');
        } catch (failure) {
          if (!signal?.aborted) { setState((s) => ({ ...s, loading: false })); setError(failure.message || 'Could not reach the local host.'); }
        }
      }, [base]);

      React.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

      const call = async (path, init, { adopt = true } = {}) => {
        const response = await fetch(`${base}${path}`, { cache: 'no-store', ...init });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || 'Request failed. Try again.');
        // ⚠ A SAVE DOES NOT REPLACE THE FIELD WITH WHAT IT JUST SENT. Adopting
        // the answer here would rewrite the textarea with the same text, which
        // puts the caret back at the end mid-line.
        if (adopt) setState({ loading: false, ...payload });
        return payload;
      };

      async function pair() {
        setBusy('pair');
        try {
          await call('pair', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tenantId: state.tenantId || '' }),
          });
          setError('');
        } catch (failure) { setError(failure.message || 'Could not pair. Try again.'); }
        finally { setBusy(''); void load(); }
      }

      async function save() {
        setBusy('save');
        try {
          // ⚠ THE HOST PARSES AND VALIDATES THIS TEXT. It is the same parser the
          // headless prompt uses, so a line means the same thing in both, and a
          // bad line comes back as the message shown here.
          await call('servers', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: draft }),
          }, { adopt: false });
          edited.current = false;
          setError('');
        } catch (failure) { setError(failure.message || 'Could not save. Check the format and retry.'); }
        finally { setBusy(''); void load(); }
      }

      async function disconnect() {
        setBusy('revoke');
        try { await call('credential', { method: 'DELETE' }); setError(''); }
        catch (failure) { setError(failure.message || 'Could not revoke. Try again.'); }
        finally { setBusy(''); }
      }

      const statusLabel = STATUS_LABEL[state.status] || 'Not connected';

      return h('section', { className: 'dsh-dragonbyte' },
        h('style', null, css),
        h('h2', null, t('DragonByte')),
        h('p', null, t('Serve the MCP servers on your own machine to your DSH tenant.')),
        error ? h('p', { className: 'muted', role: 'alert' }, t(error)) : null,

        h('div', { className: 'group' },
          h('h3', null, t('Pair this machine')),
          h('div', { className: 'row' },
            h('div', { className: 'detail' },
              h('p', { className: 'muted' },
                state.paired ? `${t('Paired')} · ${state.tenantId || '—'} · ${t(statusLabel)}` : t('Not paired yet.')),
              h('p', { className: 'muted' }, t('Open Google sign-in in your browser, approve this machine, then come back.'))),
            h('div', { className: 'actions' },
              // ⚠ ENABLED WITH NO TENANT KNOWN, DELIBERATELY. Which tenant an
              // address owns is answered only after sign-in, on the pairing
              // page, so requiring one here would make the flow impossible to
              // start. An already-paired machine keeps its tenant.
              h('button', { type: 'button', disabled: busy !== '', onClick: () => void pair() },
                busy === 'pair' ? t('Pairing…') : t('Pair this machine')),
              state.paired ? h('button', { type: 'button', disabled: busy !== '', onClick: () => void call('reconnect', { method: 'POST' }).catch(() => setError('Could not reach the local host.')) },
                t('Reconnect')) : null,
              state.paired ? h('button', { type: 'button', disabled: busy !== '', onClick: () => void disconnect() },
                busy === 'revoke' ? t('Revoking…') : t('Disconnect')) : null))),

        // ⚠ THIS IS THE ONE EDITOR. A save goes to the bridge, which is what
        // re-reads the list on every start, and the bridge's copy is written
        // first so a list that never arrived never looks saved.
        h('div', { className: 'group' },
          h('h3', null, t('MCP servers')),
          state.paired ? null : h('p', { className: 'muted' }, t('No servers configured yet.')),
          h('p', { className: 'muted' }, t('One per line: name: command, or name: https URL.')),
          h('p', { className: 'muted' }, t('These run on this machine.')),
          h('textarea', {
            value: draft, spellCheck: false, rows: 6,
            onChange: (event) => { edited.current = true; setDraft(event.target.value); },
            'aria-label': t('MCP servers'),
          }),
          h('div', { className: 'actions' },
            h('button', { type: 'button', disabled: busy !== '', onClick: () => void save() },
              busy === 'save' ? t('Saving…') : t('Save servers')))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dragonbyte: locale');
        const t = ctx.locale.bind(namespace);
        function Section() { return h(DragonbyteSection, { t }); }
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dragonbyte', order: 23,
          label: () => t('DragonByte'), locale: namespace,
        }, Section)), 'dragonbyte: settings section');
      },
    };
  },
});
