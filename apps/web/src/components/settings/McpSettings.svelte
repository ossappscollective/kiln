<!--
  McpSettings: the "Connect an AI assistant" card of the Settings screen (docs/mcp.md, docs/api/mcp.md, docs/adr/0023-mcp-server.md).
  Owners and admins only (it creates an API token). It shows:
  - whether the MCP server is on (a server switch, KILN_MCP_ENABLED: off by default; the card says where to set it),
  - one button that creates an "MCP read-only" token (a viewer limited to the read tools' actions, expiring after 90 days) and shows
    it ONCE, with the copy and paste configuration for Claude Code, Claude Desktop and Cursor, over HTTP and over stdio,
  - the tools the server offers, by kind: read, change the workspace's own data, and preview only. Nothing here applies a store action:
    those are previewed by the assistant and confirmed by a person in this app.
  The token is held in memory only. Props: api, workspaceId, role.
  Readable pass (docs/design/readability.md): one sentence under the title, the state as one word, the one warning about what an assistant can
  read stays visible, ONE primary (create the token), and the stdio details sit behind a disclosure.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { MCP_WARNING, type McpStatus, groupTools, mcpErrorMessage, presetTokenInput, snippets, stateView, toolNeeds } from '../../lib/mcp.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { CreatedApiToken } from '../../lib/types.ts';
  import OneTimeSecret from '../automation/OneTimeSecret.svelte';
  import T from '../ui/T.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import '../readable-card.css';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, role }: { api: Api; workspaceId: string; role: Role } = $props();

  const allowed = $derived(can(role, 'tokens.manage'));

  let status = $state<McpStatus | null>(null);
  let loadError = $state('');
  let creating = $state(false);
  let createError = $state('');
  let created = $state<CreatedApiToken | null>(null);

  const view = $derived(status ? stateView(status) : null);
  const groups = $derived(status ? groupTools(status.tools) : []);
  const configs = $derived(status ? snippets(location.origin, created?.token ?? null, status.endpoint) : []);

  async function load() {
    loadError = '';
    try {
      status = await api.mcpStatus(workspaceId);
    } catch (e) {
      loadError = e instanceof ApiError ? mcpErrorMessage(e.status) : mcpErrorMessage(undefined);
    }
  }

  async function createToken() {
    if (!status || creating) return;
    creating = true;
    createError = '';
    try {
      created = await api.createApiToken(workspaceId, presetTokenInput(status));
    } catch (e) {
      createError = e instanceof ApiError ? e.message : t('settings:mcp.createFailed');
    } finally {
      creating = false;
    }
  }

  onMount(() => {
    if (allowed) void load();
  });
</script>

{#if allowed}
  <Card
    title={t('settings:mcp.title')}
    collapseKey="mcp"
    defaultOpen={false}
    description={t('settings:mcp.description')}
  >
    {#if loadError}
      <Alert tone="error">{loadError}</Alert>
    {:else if !status || !view}
      <Skeleton />
    {:else}
      <div class="stack readable-card">
        <p class="row">
          <Badge tone={view.tone} dot>{view.label}</Badge>
          <span class="muted">{view.detail}</span>
        </p>

        <Alert tone="warn" title={t('settings:mcp.beforeTitle')}>{t(MCP_WARNING)}</Alert>

        {#if status.enabled}
          {#if created}
            <OneTimeSecret
              title={t('settings:mcp.tokenTitle', { name: created.summary.name })}
              label={t('settings:mcp.tokenLabel')}
              value={created.token}
              warning={t('settings:mcp.tokenWarning', { count: status.preset.expiresInDays })}
              ondismiss={() => (created = null)}
            />
          {:else}
            <div class="row">
              <Button variant="primary" loading={creating} onclick={createToken}>{t('settings:mcp.createToken', { name: status.preset.name })}</Button>
              <span class="muted">{t('settings:mcp.createNote')}</span>
            </div>
            {#if createError}<Alert tone="error">{createError}</Alert>{/if}
          {/if}

          <h3 class="h">{t('settings:mcp.configTitle')}</h3>
          <p class="muted">
            {t('settings:mcp.configHelp', { url: `${location.origin}${status.endpoint}` })}
            {#if !created}{t('settings:mcp.configPlaceholder')}{/if}
          </p>
          <Disclosure summary={t('settings:mcp.stdioSummary')}>
            <p class="muted">
              <T key="settings:mcp.stdioText" />
            </p>
          </Disclosure>
          {#each configs as config (config.title)}
            <details class="snippet">
              <summary>{config.title}</summary>
              <p class="muted">{config.where}</p>
              <pre class="mono">{config.text}</pre>
              <CopyButton value={config.text} label={t('settings:mcp.copy')} />
            </details>
          {/each}
        {/if}

        <h3 class="h">{t('settings:mcp.toolsTitle', { count: status.tools.length })}</h3>
        {#each groups as group (group.kind)}
          <details class="snippet">
            <summary>{group.label} ({group.tools.length})</summary>
            <p class="muted">{group.help}</p>
            <ul class="tools">
              {#each group.tools as tool (tool.name)}
                <li>
                  <code>{tool.name}</code>
                  <span class="muted">{toolNeeds(tool) ? t('settings:mcp.toolWithNeeds', { title: tool.title, needs: toolNeeds(tool) }) : tool.title}</span>
                </li>
              {/each}
            </ul>
          </details>
        {/each}
      </div>
    {/if}
  </Card>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
  }

  .muted {
    color: var(--text-muted, inherit);
    font-size: 0.9375rem;
  }

  .h {
    margin: var(--space-2) 0 0;
    font-size: 1rem;
  }

  .snippet {
    border: 1px solid var(--border, currentColor);
    border-radius: var(--radius-2, 6px);
    padding: var(--space-3);
  }

  .snippet pre {
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin: var(--space-2) 0;
    font-size: 0.8125rem;
  }

  .tools {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
</style>
