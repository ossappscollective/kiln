<!--
  ProductsTab: the in-app purchases and subscriptions of one app, read from its store (docs/api/products.md, docs/adr/0034-in-app-products.md).
  A table of what the last sync read (name, type, status, price, languages), a "Sync products" button, and the detail of the product that is
  open (prices and availability read only; the display name and description editable per language, behind a preview).
  Reading and syncing never change a store. The one write, a text change, is OFF until the server's switch is on and needs the admin role:
  the page says so instead of hiding the texts.
  Sales (28 days): a column from STORED analytics only (`GET .../analytics/product-sales`, no store call), shown to roles that may read analytics and
  only once the app has a stored sales day. Units and one amount line per currency (never summed); the header's tooltip says what the number is
  (Apple proceeds, or a Google buyer-paid estimate that is not proceeds). Without sales data the column is hidden and one line says how to turn it on.
  RevenueCat: when the app is linked to a RevenueCat project (docs/adr/0039-revenuecat.md), a RevenueCat column says where each product stands
  there (and names its first entitlements), the detail has a RevenueCat section, and a collapsed list gives the things to check. All of it comes
  from the STORED copy (`GET .../revenuecat/products`, no RevenueCat call) and is configuration only: no money, no customers. "Sync products" reads
  RevenueCat as its second step; a failure of that step is shown beside the store result and never hides it. Not linked: one line says how to connect.
  Props: api, workspaceId, role, app, refreshKey (changes when an app sync finished, so this reads again).
-->
<script lang="ts">
  import { can, platformSupports, type Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import {
    type ProductSalesView,
    salesByProduct,
    salesCell,
    salesColumnTitle,
    salesMeasureText,
    salesSetupHint,
    salesVisible,
  } from '../../lib/analytics/product-sales.ts';
  import { type Api, ApiError } from '../../lib/api.ts';
  import {
    classifyProductFailure,
    kindLabel,
    periodLabel,
    priceCountText,
    priceText,
    READ_ONLY_NOTE,
    stateBadge,
    syncLine,
  } from '../../lib/products.ts';
  import {
    connectHint,
    type RevenueCatProductsView,
    type RevenueCatStep,
    revenueCatRead,
    showRevenueCatColumn,
    stepFromBody,
    stepResult,
    syncLine as revenueCatSyncLine,
  } from '../../lib/revenuecat/revenuecat.ts';
  import { storeForPlatform } from '../../lib/stores.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary, ProductsView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import RevenueCatCell from '../revenuecat/RevenueCatCell.svelte';
  import RevenueCatWarnings from '../revenuecat/RevenueCatWarnings.svelte';
  import ProductDetail from './ProductDetail.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const maySync = $derived(can(role, 'apps.sync'));
  const storeName = $derived(storeForPlatform(app.platform).fullLabel);

  let view = $state<ProductsView | null>(null);
  let loading = $state(true);
  let problem = $state('');
  let syncing = $state(false);
  let syncProblem = $state('');
  let openId = $state<string | null>(null);
  let detailKey = $state(0);
  let now = $state(Date.now());
  let generation = 0;
  let sales = $state<ProductSalesView | null>(null);
  let salesGeneration = 0;
  let revenueCat = $state<RevenueCatProductsView | null>(null);
  let revenueCatGeneration = 0;
  let revenueCatStep = $state<RevenueCatStep | null>(null);

  const mayReadSales = $derived(can(role, 'analytics.read'));
  const apple = $derived(platformSupports(app.platform, 'appleAnalyticsReports'));
  const showSales = $derived(mayReadSales && salesVisible(sales));
  const salesById = $derived(salesByProduct(sales));
  const showRevenueCat = $derived(showRevenueCatColumn(revenueCat));
  const columns = $derived(6 + (showSales ? 1 : 0) + (showRevenueCat ? 1 : 0));

  /** Sales are an extra: stored analytics only, and a failure to read them never gets in the way of the product list. */
  async function loadSales() {
    const mine = ++salesGeneration;
    if (!mayReadSales) {
      sales = null;
      return;
    }
    try {
      const read = await api.analyticsProductSales(workspaceId, app.id);
      if (mine === salesGeneration) sales = read;
    } catch {
      if (mine === salesGeneration) sales = null;
    }
  }

  /** RevenueCat is an extra, like sales: the stored copy only, and a failure to read it never gets in the way of the product list. */
  async function loadRevenueCat() {
    const mine = ++revenueCatGeneration;
    try {
      const read = await api.revenueCatProducts(workspaceId, app.id);
      if (mine === revenueCatGeneration) revenueCat = read;
    } catch {
      if (mine === revenueCatGeneration) revenueCat = null;
    }
  }

  async function load() {
    const mine = ++generation;
    loading = true;
    problem = '';
    try {
      const read = await api.appProducts(workspaceId, app.id);
      if (mine !== generation) return;
      view = read;
      now = Date.now();
    } catch (e) {
      if (mine !== generation) return;
      view = null;
      problem = e instanceof ApiError ? e.message : 'Could not load the products.';
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    openId = null;
    untrack(() => {
      void load();
      void loadSales();
      void loadRevenueCat();
    });
  });

  async function sync() {
    if (syncing) return;
    syncing = true;
    syncProblem = '';
    revenueCatStep = null;
    try {
      const done = await api.syncAppProducts(workspaceId, app.id);
      const n = done.sync.products;
      toast.success(`Read ${n} ${n === 1 ? 'product' : 'products'} from ${storeName}.`);
      revenueCatStep = done.revenuecat ?? null;
      detailKey += 1;
      await load();
      void loadRevenueCat();
    } catch (e) {
      syncProblem = classifyProductFailure(e, 'read').message;
      // The RevenueCat step runs even when the store step failed: its result is shown beside the store failure.
      revenueCatStep = e instanceof ApiError ? stepFromBody(e.body) : null;
      // The failure is also kept on the server, so the list says it.
      await load();
      void loadRevenueCat();
    } finally {
      syncing = false;
    }
  }

  const products = $derived(view?.products ?? []);
  const line = $derived(view ? syncLine(view.sync, now) : null);
  const headline = $derived(
    view === null
      ? 'In-app purchases and subscriptions'
      : products.length === 0
        ? 'No products read yet'
        : `${products.length} ${products.length === 1 ? 'product' : 'products'} in ${storeName}`,
  );
</script>

<div class="stack">
  <PageLead {headline} hint="What the store sells in this app, as of the last sync. Prices are read only; display texts can be changed here by an admin.">
    {#snippet aside()}
      <InfoTip label="About products" buttonText="About products" width="26rem">
        <p>{READ_ONLY_NOTE}</p>
        <p>Subscriptions and in-app purchases are read from {storeName} with the credential of this app. Reading and syncing change nothing in the store.</p>
      </InfoTip>
    {/snippet}
    {#snippet actions()}
      {#if maySync && view?.supported !== false}
        <Button variant={products.length === 0 ? 'primary' : 'secondary'} icon="refresh" loading={syncing} onclick={() => void sync()}>Sync products</Button>
      {/if}
    {/snippet}
  </PageLead>

  {#if syncProblem !== ''}<Alert tone="error" title="The sync did not finish">{syncProblem}</Alert>{/if}
  {#if revenueCatStep}
    {@const step = stepResult(revenueCatStep)}
    <Alert tone={step.tone === 'bad' ? 'error' : step.tone === 'warn' ? 'warn' : 'ok'} title="RevenueCat">{step.text}</Alert>
  {/if}

  {#if loading && !view}
    <div role="status" aria-label="Reading the products" class="stack">
      <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
    </div>
  {:else if problem !== ''}
    <Alert tone="error" title="Could not load the products">
      {problem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>Try again</Button></div>
    </Alert>
  {:else if view}
    {#if line && view.sync !== null}
      <p class="sync-line text-sm" class:bad={line.tone === 'bad'} class:warn={line.tone === 'warn'} role={line.tone === 'bad' ? 'alert' : 'status'}>
        {line.text}
      </p>
    {/if}
    {#if view.sync && view.sync.warnings.length > 0}
      <Alert tone="warn" title="Some parts could not be read">
        <ul class="warnings">
          {#each view.sync.warnings as warning (warning)}<li>{warning}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if showRevenueCat && revenueCat}
      {@const rcLine = revenueCatSyncLine(revenueCat.sync, now)}
      <p class="sync-line text-sm" class:bad={rcLine.tone === 'bad'} class:warn={rcLine.tone === 'warn'} role={rcLine.tone === 'bad' ? 'alert' : 'status'} data-testid="revenuecat-sync-line">
        {rcLine.text}
      </p>
    {/if}

    {#if !view.supported}
      <EmptyState icon="tag" title="No in-app purchases for this store" description="This app's store has no in-app purchases or subscriptions that this tool reads." />
    {:else if products.length === 0}
      <EmptyState
        icon="tag"
        title={view.sync === null || view.sync.lastSyncedAt === null ? 'Nothing read from the store yet' : 'No in-app purchases or subscriptions'}
        description={view.sync === null || view.sync.lastSyncedAt === null
          ? `Sync to read the in-app purchases and subscriptions of this app from ${storeName}. Nothing is changed in the store.`
          : `${storeName} lists no in-app purchases or subscriptions for this app. If that is wrong, check that the credential may read them, then sync again.`}
      >
        {#snippet actions()}
          {#if maySync}
            <Button variant="primary" icon="refresh" loading={syncing} onclick={() => void sync()}>Sync products</Button>
          {:else}
            <span class="muted text-sm">Ask a member to sync this app's products.</span>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap card flush">
        <table aria-label="In-app purchases and subscriptions of {app.name}">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Price</th>
              {#if showSales && sales}
                <th scope="col" class="num">
                  <span class="sales-head">{salesColumnTitle}<InfoTip label="About the sales numbers" text={salesMeasureText(sales)} align="end" width="24rem" /></span>
                </th>
              {/if}
              {#if showRevenueCat}<th scope="col">RevenueCat</th>{/if}
              <th scope="col">Languages</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each products as p (p.productId)}
              {@const status = stateBadge(p.state)}
              <tr class:open={openId === p.productId}>
                <td>
                  <div class="name">{p.name ?? p.referenceName}</div>
                  <div class="muted text-sm"><span class="mono">{p.productId}</span>{#if p.group} · {p.group}{/if}</div>
                </td>
                <td>
                  {kindLabel(p.kind)}
                  {#if periodLabel(p.period)}<div class="muted text-sm">{periodLabel(p.period)}</div>{/if}
                </td>
                <td><Badge tone={status.tone} dot>{status.label}</Badge></td>
                <td class="num">
                  {priceText(p.price)}
                  <div class="muted text-sm">{priceCountText(p.territoryCount)}</div>
                </td>
                {#if showSales && sales}
                  {@const cell = salesCell(sales, salesById.get(p.productId))}
                  <td class="num sales-cell" class:none={cell[0] === '—'} title={salesMeasureText(sales)} data-testid="product-sales">
                    {#each cell as line (line)}<div>{line}</div>{/each}
                  </td>
                {/if}
                {#if showRevenueCat && revenueCat}
                  <td data-testid="product-revenuecat"><RevenueCatCell view={revenueCat} productId={p.productId} /></td>
                {/if}
                <td class="muted text-sm">{p.locales.length === 0 ? 'None' : p.locales.length <= 3 ? p.locales.join(', ') : `${p.locales.slice(0, 3).join(', ')} and ${p.locales.length - 3} more`}</td>
                <td class="actions">
                  <Button
                    size="sm"
                    icon={openId === p.productId ? 'chevron-up' : 'chevron-down'}
                    aria-expanded={openId === p.productId}
                    aria-controls="product-detail-{p.productId}"
                    onclick={() => (openId = openId === p.productId ? null : p.productId)}
                  >
                    {openId === p.productId ? 'Hide' : 'Details'}<span class="visually-hidden"> {p.name ?? p.referenceName}</span>
                  </Button>
                </td>
              </tr>
              {#if openId === p.productId}
                <tr class="detail-row">
                  <td colspan={columns} id="product-detail-{p.productId}">
                    <ProductDetail
                      {api}
                      {workspaceId}
                      {role}
                      {app}
                      productId={p.productId}
                      sales={showSales ? sales : null}
                      revenueCat={showRevenueCat ? revenueCat : null}
                      writeEnabled={view.write.enabled}
                      refreshKey={detailKey}
                      embedded
                      onsaved={() => void load()}
                      onclose={() => (openId = null)}
                      onswitchoff={() => {
                        if (view) view = { ...view, write: { ...view.write, enabled: false } };
                      }}
                    />
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      {#if mayReadSales && sales !== null && !showSales}
        <p class="muted text-sm sales-hint" data-testid="sales-hint">{salesSetupHint(sales, apple)}</p>
      {/if}
      {#if showRevenueCat && revenueCat}
        <RevenueCatWarnings warnings={revenueCat.warnings} appId={app.id} />
        {#if !revenueCatRead(revenueCat)}
          <p class="muted text-sm" data-testid="revenuecat-unread-hint">This app is linked to RevenueCat, but RevenueCat has not been read yet. {maySync ? 'Use "Sync products" to read it.' : 'Ask a member to sync this app\'s products.'}</p>
        {/if}
      {:else if connectHint(revenueCat, can(role, 'apps.write')) !== ''}
        <p class="muted text-sm" data-testid="revenuecat-connect-hint">{connectHint(revenueCat, can(role, 'apps.write'))}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .sync-line {
    margin: 0;
    color: var(--muted);
  }

  .sync-line.bad {
    color: var(--bad-ink);
  }

  .sync-line.warn {
    color: var(--warn-ink);
  }

  .name {
    font-weight: 500;
  }

  .warnings {
    margin: 0;
    padding-left: var(--space-4);
  }

  .retry {
    margin-top: var(--space-2);
  }

  tr.open {
    background: var(--accent-bg);
  }

  .sales-head {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .sales-cell.none {
    color: var(--muted);
  }

  .sales-hint {
    margin: 0;
  }

  .detail-row > td {
    padding: 0;
    border-top: 1px solid var(--line);
  }
</style>
