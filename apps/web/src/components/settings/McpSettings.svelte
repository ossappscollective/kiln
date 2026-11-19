<!--
  McpSettings: the "Connect an AI assistant" card of the Settings screen (docs/mcp.md, docs/api/mcp.md, docs/adr/0023-mcp-server.md).
  Owners and admins only (it creates an API token). It shows:
  - whether the MCP server is on (a server switch, MRM_MCP_ENABLED: off by default; the card says where to set it),
  - one button that creates an "MCP read-only" token (a viewer limited to the read tools' actions, expiring after 90 days) and shows
    it ONCE, with the copy and paste configuration for Claude Code, Claude Desktop and Cursor, over HTTP and over stdio,
  - the tools the server offers, by kind: read, change the workspace's own data, and preview only. Nothing here applies a store action:
    those are previewed by the assistant and confirmed by a person in this app.
  The token is held in memory only. Props: api, workspaceId, role.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { MCP_WARNING, type McpStatus, groupTools, mcpErrorMessage, presetTokenInput, snippets, stateView, toolNeeds } from '../../lib/mcp.ts';
  import type { CreatedApiToken } from '../../lib/types.ts';
  import OneTimeSecret from '../automation/OneTimeSecret.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Card from '../ui/Card.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
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
      createError = e instanceof ApiError ? e.message : 'Could not create the token.';
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
    title="Connect an AI assistant"
    collapseKey="mcp"
    defaultOpen={false}
    description="Let Claude, Cursor or another MCP assistant read this workspace: releases, listings, reviews, keyword ranks and analytics. It can preview store actions, never apply them."
  >
    {#if loadError}
      <Alert tone="error">{loadError}</Alert>
    {:else if !status || !view}
      <Skeleton />
    {:else}
      <div class="stack">
        <p class="row">
          <Badge tone={view.tone} dot>{view.label}</Badge>
          <span class="muted">{view.detail}</span>
        </p>

        <Alert tone="warn" title="Before you connect one">{MCP_WARNING}</Alert>

        {#if status.enabled}
          {#if created}
            <OneTimeSecret
              title="Your token “{created.summary.name}”"
              label="API token"
              value={created.token}
              warning="Shown once. Put it in the assistant's configuration below, not in code. Revoke it under API tokens if it leaks; it expires on its own after {status.preset.expiresInDays} days."
              ondismiss={() => (created = null)}
            />
          {:else}
            <div class="row">
              <Button variant="primary" loading={creating} onclick={createToken}>Create an “{status.preset.name}” token</Button>
              <span class="muted">A viewer token limited to the read tools. Create a wider one under API tokens if you want triage or previews.</span>
            </div>
            {#if createError}<Alert tone="error">{createError}</Alert>{/if}
          {/if}

          <h3 class="h">Configuration</h3>
          <p class="muted">
            HTTP needs the address {location.origin}{status.endpoint}. The stdio form starts a small local command
            (<code>apps/server/src/mcp/stdio.ts</code>, Node 22.18 or newer): replace the path with where this repository is on your computer.
            {#if !created}The token below is a placeholder until you create one.{/if}
          </p>
          {#each configs as config (config.title)}
            <details class="snippet">
              <summary>{config.title}</summary>
              <p class="muted">{config.where}</p>
              <pre class="mono">{config.text}</pre>
              <CopyButton value={config.text} label="Copy" />
            </details>
          {/each}
        {/if}

        <h3 class="h">Tools ({status.tools.length})</h3>
        {#each groups as group (group.kind)}
          <details class="snippet">
            <summary>{group.label} ({group.tools.length})</summary>
            <p class="muted">{group.help}</p>
            <ul class="tools">
              {#each group.tools as tool (tool.name)}
                <li>
                  <code>{tool.name}</code>
                  <span class="muted">{tool.title}{toolNeeds(tool) ? `, ${toolNeeds(tool)}` : ''}</span>
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
    font-size: 0.875rem;
  }

  .h {
    margin: var(--space-2) 0 0;
    font-size: 1rem;
  }

  .snippet {
    border: 1px solid var(--border, currentColor);
    border-radius: var(--radius-2, 6px);
    padding: var(--space-2) var(--space-3);
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
