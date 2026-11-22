window.__ModuleLoader__.load({
  id: '@snapai/dsh-dragonbyte-client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'dsh-dragonbyte';
    const zh = {
      'Local MCP': '本地 MCP',
      'Serve the MCP servers on your own machine to your DSH tenant.': '将你机器上的 MCP 服务器提供给你的 DSH 租户。',
      'Pair this machine': '配对此机器',
      'Pairing…': '正在配对…',
      'Paired': '已配对',
      'Not paired yet.': '尚未配对。',
      'Open Google sign-in in your browser, approve this machine, then come back.': '在浏览器中打开 Google 登录，批准此机器后返回。',
      'Tenant': '租户',
      'MCP servers': 'MCP 服务器',
      'One per line: name: command, or name: https URL.': '每行一个：name: 命令，或 name: https URL。',
      'Save servers': '保存服务器',
      'Saving…': '正在保存…',
      'Saved': '已保存',
      'Reconnect': '重新连接',
      'Disconnect': '断开连接',
      'Connected': '已连接',
      'Connecting…': '正在连接…',
      'Not connected': '未连接',
      'No servers configured yet.': '尚未配置服务器。',
      'Could not reach the local host.': '无法连接本地主机。',
      'Could not pair. Try again.': '无法配对，请重试。',
      'Could not save. Check the format and retry.': '无法保存，请检查格式后重试。',
      'Revoke': '撤销',
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
      .dsh-dragonbyte textarea { width: 100%; min-height: 96px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
      .dsh-dragonbyte .actions { display: flex; flex-wrap: wrap; gap: 12px; }
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

    function parseLines(text) {
      const servers = [];
      for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const at = line.indexOf(':');
        if (at < 1) throw new Error('each line needs "name: command or URL"');
        const name = line.slice(0, at).trim();
        const rest = line.slice(at + 1).trim();
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`${name}: name must match [a-z][a-z0-9-]{0,31}`);
        if (/^https?:\/\//.test(rest)) servers.push({ name, transport: 'http', url: rest });
        else {
          const [command, ...args] = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) ?? [];
          if (!command) throw new Error(`${name}: needs a command`);
          servers.push({ name, transport: 'stdio', command, args });
        }
      }
      return servers;
    }

    function formatLines(servers) {
      return (servers || []).map((entry) => entry.transport === 'http'
        ? `${entry.name}: ${entry.url}`
        : `${entry.name}: ${[entry.command, ...(entry.args || [])].join(' ')}`).join('\n');
    }

    const STATUS_LABEL = {
      connected: 'Connected', connecting: 'Connecting…', idle: 'Not connected',
      'no-servers': 'No servers configured yet.', error: 'Not connected',
    };

    function DragonbyteSection({ t }) {
      const base = React.useMemo(hostBase, []);
      const [state, setState] = React.useState({ loading: true, status: 'idle', servers: [], paired: false, tenantId: '' });
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [serversText, setServersText] = React.useState('');

      const load = React.useCallback(async (signal) => {
        try {
          const response = await fetch(`${base}status`, { cache: 'no-store', signal, headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('Could not reach the local host.');
          const payload = await response.json();
          setState({ loading: false, ...payload });
          setServersText((current) => current || formatLines(payload.servers));
          setError('');
        } catch (failure) {
          if (!signal?.aborted) { setState((s) => ({ ...s, loading: false })); setError(failure.message || 'Could not reach the local host.'); }
        }
      }, [base]);

      React.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

      const call = async (path, init) => {
        const response = await fetch(`${base}${path}`, { cache: 'no-store', ...init });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || 'Request failed. Try again.');
        setState({ loading: false, ...payload });
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
          let servers;
          try { servers = parseLines(serversText); } catch (failure) { setError(failure.message); setBusy(''); return; }
          await call('mcp', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mcpServers: servers }) });
          setError('');
        } catch (failure) { setError(failure.message || 'Could not save. Check the format and retry.'); }
        finally { setBusy(''); }
      }

      async function disconnect() {
        setBusy('revoke');
        try { await call('credential', { method: 'DELETE' }); setError(''); }
        catch (failure) { setError(failure.message || 'Could not revoke. Try again.'); }
        finally { setBusy(''); }
      }

      const statusLabel = STATUS_LABEL[state.status] || 'Not connected';
      const tenantMissing = !state.tenantId;

      return h('section', { className: 'dsh-dragonbyte' },
        h('style', null, css),
        h('h2', null, t('Local MCP')),
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
              h('button', { type: 'button', disabled: busy !== '' || tenantMissing, onClick: () => void pair() },
                busy === 'pair' ? t('Pairing…') : t('Pair this machine')),
              state.paired ? h('button', { type: 'button', disabled: busy !== '', onClick: () => void disconnect() },
                busy === 'revoke' ? t('Revoking…') : t('Disconnect')) : null))),

        h('div', { className: 'group' },
          h('h3', null, t('MCP servers')),
          h('p', { className: 'muted' }, t('One per line: name: command, or name: https URL.')),
          h('textarea', {
            value: serversText, spellCheck: false,
            placeholder: 'fs: npx -y @modelcontextprotocol/server-filesystem ~/docs\ndocs: https://mcp.example.com/mcp',
            onChange: (event) => setServersText(event.target.value),
          }),
          h('div', { className: 'actions' },
            h('button', { type: 'button', disabled: busy !== '', onClick: () => void save() },
              busy === 'save' ? t('Saving…') : t('Save servers')),
            h('button', { type: 'button', disabled: busy !== '' || !state.paired, onClick: () => void call('reconnect', { method: 'POST' }).catch(() => setError('Could not reach the local host.')) },
              t('Reconnect')))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dragonbyte: locale');
        const t = ctx.locale.bind(namespace);
        function Section() { return h(DragonbyteSection, { t }); }
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dragonbyte', order: 23,
          label: () => t('Local MCP'), locale: namespace,
        }, Section)), 'dragonbyte: settings section');
      },
    };
  },
});
