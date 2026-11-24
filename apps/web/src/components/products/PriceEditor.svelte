<!--
  PriceEditor: change the price of ONE product in the store (docs/adr/0062-price-writes.md). The most careful write of the app, so it is
  STAGED, never sent from here: "Add to pending changes" saves a draft in Kiln only; the pending cart is where it is reviewed, dry-run, typed
  out and sent (and where the store's answer is shown). Unavailable states say why and never hide the prices: a role below admin, the server
  switch (KILN_PRICE_WRITES_ENABLED) and the workspace setting (prices.writeEnabled).
  What the screen guarantees: an amount is read exactly as typed (4.99 is 499, three decimals in a two decimal currency is refused, never
  rounded); the current price and currency are the synced ones and the server reads them again; Apple only sells at its price points, so a
  typed amount that is not one shows the nearest ones to pick; Google Play can convert one base price; a date only where the store can
  schedule; existing subscribers keep their price unless that is changed on purpose (and the consequence is written next to the choice);
  every guard rail (a big change in percent or in money, existing subscribers) needs its own tick. Amounts of different currencies are never
  added. The server checks all of it again.
  Props: api, workspaceId, role, app ({ id, platform }), store, product (the detail, with syncedAt), onstaged (staged: read again).
-->
<script lang="ts">
  import { can, minorToDecimal, nearestPricePoints, type Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import { announceCartAdded, announceCartOpen } from '../../lib/pending-cart.ts';
  import {
    amountProblemText,
    bpText,
    changedRows,
    classifyPriceFailure,
    hasInvalid,
    issueText,
    limitsOf,
    money,
    neededAcks,
    type PriceFailure,
    type PriceRow,
    PRICE_SETTING,
    priceBlock,
    rowChange,
    stageLines,
    subscriberRules,
  } from '../../lib/prices.ts';
  import { groupPrices } from '../../lib/products.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type {
    AppSummary,
    PriceAck,
    PricePointOption,
    PriceSubscriberRule,
    PriceWriteView,
    ProductDetail,
  } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    store,
    product,
    onstaged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform'>;
    store: string;
    product: ProductDetail;
    onstaged: () => void;
  } = $props();

  const uid = $props.id();
  const apple = $derived(store !== 'googleplay');
  const groups = $derived(groupPrices(product.prices));

  let view = $state<PriceWriteView | null>(null);
  let open = $state(false);
  let planKey = $state('');
  let rows = $state<PriceRow[]>([]);
  let rule = $state<PriceSubscriberRule>('preserve');
  let date = $state('');
  let acked = $state<Record<string, boolean>>({});
  let saving = $state(false);
  let failure = $state<PriceFailure | null>(null);
  let baseTerritory = $state('');
  let baseAmount = $state('');
  let converting = $state(false);
  let convertNote = $state('');
  let points = $state<Record<string, PricePointOption[]>>({});
  let loadingPoints = $state<Record<string, boolean>>({});
  let pointsNote = $state('');
  let switching = $state(false);
  let switchError = $state('');

  const block = $derived(priceBlock(view, role));
  const group = $derived(groups.find((g) => (g.planId ?? '') === planKey) ?? groups[0]);
  const planId = $derived(group?.planId ?? null);
  const staged = $derived(view?.staged.find((s) => s.productId === product.productId && s.planId === planId) ?? null);
  const stagedHere = $derived(view?.staged.filter((s) => s.productId === product.productId) ?? []);
  const rules = $derived(subscriberRules(store, product.kind));
  const limits = $derived(limitsOf(view));
  const changed = $derived(changedRows(rows));
  const needed = $derived<PriceAck[]>(neededAcks({ store, productId: product.productId, kind: product.kind, rule, rows, limits }));
  const allAcked = $derived(needed.every((a) => acked[a] === true));
  const invalid = $derived(hasInvalid(rows));
  const tooMany = $derived(view !== null && changed.length > view.limits.maxTerritories);
  const today = new Date().toISOString().slice(0, 10);
  const canSave = $derived(open && !saving && block === null && changed.length > 0 && !invalid && !tooMany && allAcked);

  const ACK_KEYS = {
    large_change: k('products:price.ack.largeChange'),
    large_absolute: k('products:price.ack.largeAbsolute'),
    existing_subscribers: k('products:price.ack.existingSubscribers'),
  } as const;
  const RULE_KEYS = {
    preserve: [k('products:price.rule.preserve'), k('products:price.ruleHelp.preserve')],
    apply: [k('products:price.rule.apply'), k('products:price.ruleHelp.apply')],
    opt_in: [k('products:price.rule.optIn'), k('products:price.ruleHelp.optIn')],
    opt_out: [k('products:price.rule.optOut'), k('products:price.ruleHelp.optOut')],
    not_applicable: [k('products:price.rule.notApplicable'), k('products:price.rule.notApplicable')],
  } as const;
  const DIRECTION_KEYS = {
    increase: k('products:price.direction.increase'),
    decrease: k('products:price.direction.decrease'),
    same: k('products:price.direction.same'),
  } as const;

  // What the price section needs from the app's list: both switches, the guard rails and what is staged. Read once, again after a stage.
  async function loadView() {
    try {
      view = (await api.appProducts(workspaceId, app.id)).priceWrite;
    } catch {
      view = null;
    }
  }
  $effect(() => {
    void product.productId;
    void loadView();
  });

  function fill() {
    const g = group;
    if (!g) {
      rows = [];
      return;
    }
    const draft = new Map((staged?.lines ?? []).map((l) => [l.territory, l]));
    rows = g.prices.map((p) => {
      const d = draft.get(p.territory);
      return {
        territory: p.territory,
        currency: p.currency,
        current: p.amount,
        input: d ? minorToDecimal(d.after, p.currency) : '',
        pricePointId: d?.pricePointId ?? null,
      };
    });
    rule = staged?.existingSubscribers ?? 'preserve';
    date = staged?.effectiveDate ?? '';
    acked = {};
    failure = null;
    convertNote = '';
    pointsNote = '';
    baseTerritory = product.baseTerritory ?? g.prices[0]?.territory ?? '';
    baseAmount = '';
  }

  function openEditor() {
    planKey = groups[0]?.planId ?? '';
    open = true;
    fill();
  }
  function closeEditor() {
    open = false;
    failure = null;
  }
  function switchPlan(key: string) {
    planKey = key;
    fill();
  }

  // Apple: the price points of a territory, read once. A typed amount that is one of them gets its price point; otherwise the nearest are offered.
  async function ensurePoints(territory: string) {
    if (!apple || points[territory] || loadingPoints[territory]) return;
    loadingPoints = { ...loadingPoints, [territory]: true };
    try {
      const done = await api.productPricePoints(workspaceId, app.id, product.productId, territory);
      points = { ...points, [territory]: done.pricePoints };
    } catch (e) {
      pointsNote = classifyPriceFailure(e).message;
    } finally {
      loadingPoints = { ...loadingPoints, [territory]: false };
    }
  }
  function matchPoint(row: PriceRow) {
    const c = rowChange(row);
    if (c.state !== 'changed') {
      row.pricePointId = null;
      return;
    }
    row.pricePointId = (points[row.territory] ?? []).find((p) => p.amount === c.minor)?.id ?? null;
  }
  async function typed(row: PriceRow) {
    if (apple && row.input.trim() !== '') {
      await ensurePoints(row.territory);
      matchPoint(row);
    } else row.pricePointId = null;
  }
  const nearest = (row: PriceRow): PricePointOption[] => {
    const c = rowChange(row);
    const list = points[row.territory];
    if (!apple || c.state !== 'changed' || !list || row.pricePointId !== null) return [];
    return nearestPricePoints(list, row.territory, c.minor, 3);
  };
  function usePoint(row: PriceRow, p: PricePointOption) {
    row.input = minorToDecimal(p.amount, p.currency);
    row.pricePointId = p.id;
  }

  // Google Play: one base price converted to the regions the plan has. Google's numbers are a start: each stays editable.
  async function convert() {
    const base = rows.find((r) => r.territory === baseTerritory);
    const read = base ? rowChange({ ...base, input: baseAmount }) : null;
    if (!base || read?.state !== 'changed') {
      convertNote = t('products:price.convert.needBase');
      return;
    }
    converting = true;
    convertNote = '';
    try {
      const done = await api.convertProductPrices(workspaceId, app.id, product.productId, { planId, baseTerritory, amount: read.minor });
      const byTerritory = new Map(done.prices.map((p) => [p.territory, p]));
      rows = rows.map((r) => {
        const p = byTerritory.get(r.territory);
        // Only a price in the region's own currency is taken: never a converted amount in another currency.
        return p && p.currency === r.currency ? { ...r, input: minorToDecimal(p.amount, r.currency) } : r;
      });
      convertNote = t('products:price.convert.done', { count: done.prices.length });
    } catch (e) {
      convertNote = classifyPriceFailure(e).message;
    } finally {
      converting = false;
    }
  }

  async function stage() {
    if (!canSave) return;
    saving = true;
    failure = null;
    try {
      await api.stageProductPrice(workspaceId, app.id, product.productId, {
        planId,
        lines: stageLines(rows, apple),
        effectiveDate: apple && date !== '' ? date : null,
        existingSubscribers: product.kind === 'subscription' ? rule : 'not_applicable',
        acknowledgements: needed,
        seenSyncedAt: product.syncedAt,
      });
      toast.success(t('products:price.staged'));
      announceCartAdded();
      open = false;
      await loadView();
      onstaged();
    } catch (e) {
      failure = classifyPriceFailure(e);
      if (failure.kind === 'disabled') await loadView();
    } finally {
      saving = false;
    }
  }

  // The workspace setting, for those who may change settings. Turning it ON is a step-up action when the workspace asks for it.
  const maySwitch = $derived(can(role, 'settings.write') && view !== null && view.reason !== 'server_switch');
  async function setSwitch(on: boolean) {
    switching = true;
    switchError = '';
    try {
      await confirmed((grant) => api.updateWorkspaceSettings(workspaceId, { [PRICE_SETTING]: on }, grant));
      await loadView();
    } catch (e) {
      switchError = classifyPriceFailure(e).message;
    } finally {
      switching = false;
    }
  }

  const rowId = (row: PriceRow) => `${uid}-${row.territory}`;
</script>

<div class="price-editor stack" data-testid="price-editor">
  {#if stagedHere.length > 0}
    <Alert tone="info">
      {t('products:price.alreadyStaged', { count: stagedHere.reduce((n, s) => n + s.lines.length, 0) })}
      <Button size="sm" variant="link" onclick={() => announceCartOpen(null)}>{t('products:price.openCart')}</Button>
    </Alert>
  {/if}

  {#if !open}
    <div class="row">
      <Button disabled={block !== null || product.prices.length === 0} aria-describedby={block ? `${uid}-block` : undefined} onclick={openEditor}>{t('products:price.edit')}</Button>
      {#if block}<span id="{uid}-block" class="muted text-sm" data-testid="price-block">{block.message}</span>{/if}
    </div>
    {#if maySwitch && view}
      <div class="row">
        {#if view.workspaceEnabled}
          <Button size="sm" variant="ghost" loading={switching} disabled={switching} onclick={() => setSwitch(false)}>{t('products:price.switchOff')}</Button>
        {:else}
          <Button size="sm" loading={switching} disabled={switching} onclick={() => setSwitch(true)}>{t('products:price.switchOn')}</Button>
        {/if}
      </div>
    {/if}
    {#if switchError}<Alert tone="error">{switchError}</Alert>{/if}
  {:else}
    <form class="editor stack" onsubmit={(e) => { e.preventDefault(); void stage(); }} aria-label={t('products:price.formAria', { id: product.productId })}>
      <Alert tone="warn">{t('products:price.delay')}</Alert>

      {#if groups.length > 1}
        <label class="field">
          <span>{t('products:price.plan')}</span>
          <select value={planKey} onchange={(e) => switchPlan(e.currentTarget.value)}>
            {#each groups as g (g.planId ?? '')}<option value={g.planId ?? ''}>{g.label}</option>{/each}
          </select>
        </label>
      {/if}
      {#if staged}<p class="muted text-sm">{t('products:price.replaces')}</p>{/if}

      {#if !apple}
        <fieldset class="convert">
          <legend>{t('products:price.convert.title')}</legend>
          <p class="muted text-sm">{t('products:price.convert.help')}</p>
          <div class="row">
            <label class="field">
              <span>{t('products:price.convert.base')}</span>
              <select bind:value={baseTerritory}>{#each rows as r (r.territory)}<option value={r.territory}>{r.territory} ({r.currency})</option>{/each}</select>
            </label>
            <label class="field">
              <span>{t('products:price.convert.amount')}</span>
              <input type="text" inputmode="decimal" autocomplete="off" bind:value={baseAmount} />
            </label>
            <Button loading={converting} disabled={converting || baseAmount.trim() === ''} onclick={convert}>{t('products:price.convert.go')}</Button>
          </div>
          {#if convertNote}<p class="text-sm" role="status">{convertNote}</p>{/if}
        </fieldset>
      {/if}

      <div class="table-wrap scroll">
        <table class="compact">
          <caption class="visually-hidden">{t('products:price.caption', { id: product.productId })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('products:detail.colTerritory')}</th>
              <th scope="col" class="num">{t('products:price.colCurrent')}</th>
              <th scope="col">{t('products:price.colNew')}</th>
              <th scope="col">{t('products:price.colChange')}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.territory)}
              {@const c = rowChange(row)}
              {@const near = nearest(row)}
              <tr>
                <td><span class="mono">{row.territory}</span>{#if row.territory === product.baseTerritory} <span class="muted text-sm">{t('products:detail.base')}</span>{/if}</td>
                <td class="num">{money(row.current, row.currency)}</td>
                <td>
                  <input
                    id={rowId(row)}
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    class="amount"
                    aria-label={t('products:price.newFor', { territory: row.territory, currency: row.currency })}
                    aria-invalid={c.state === 'invalid'}
                    aria-describedby="{rowId(row)}-m"
                    placeholder={minorToDecimal(row.current, row.currency)}
                    bind:value={row.input}
                    onblur={() => void typed(row)}
                  />
                  <span class="muted text-sm cur">{row.currency}</span>
                  <div id="{rowId(row)}-m" class="msg text-sm">
                    {#if c.state === 'invalid'}
                      <span class="bad" role="alert">{amountProblemText(c.problem, row.currency)}</span>
                    {:else if apple && c.state === 'changed' && row.pricePointId === null && points[row.territory]}
                      <span class="bad">{t('products:price.notPoint')}</span>
                      {#each near as p (p.id)}<button type="button" class="link sm" onclick={() => usePoint(row, p)}>{t('products:price.usePoint', { amount: money(p.amount, p.currency) })}</button>{/each}
                    {:else if apple && loadingPoints[row.territory]}
                      <span class="muted">{t('products:price.loadingPoints')}</span>
                    {/if}
                  </div>
                </td>
                <td>
                  {#if c.state === 'changed'}
                    <span class={c.direction}>{bpText(c.bp)} {t(DIRECTION_KEYS[c.direction])}</span>
                  {:else}<span class="muted">-</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if pointsNote}<Alert tone="error">{pointsNote}</Alert>{/if}
      <p class="muted text-sm" aria-live="polite">{t('products:price.changedCount', { count: changed.length, max: view?.limits.maxTerritories ?? 50 })}</p>
      {#if tooMany}<Alert tone="error">{t('products:price.tooMany', { max: view?.limits.maxTerritories ?? 50 })}</Alert>{/if}

      {#if apple}
        <label class="field">
          <span>{t('products:price.date')}</span>
          <input type="date" min={today} bind:value={date} aria-describedby="{uid}-date-h" />
          <span id="{uid}-date-h" class="muted text-sm">{t('products:price.dateHelp')}</span>
        </label>
      {:else}
        <p class="muted text-sm">{t('products:price.noDate')}</p>
      {/if}

      {#if product.kind === 'subscription'}
        <fieldset class="subscribers">
          <legend>{t('products:price.subscribers')}</legend>
          {#each rules as r (r)}
            <label class="choice">
              <input type="radio" name="{uid}-rule" value={r} checked={rule === r} onchange={() => (rule = r)} />
              <span>
                <strong>{t(RULE_KEYS[r][0])}{#if r === 'preserve'} <Badge tone="ok">{t('products:price.default')}</Badge>{/if}</strong>
                <span class="muted text-sm help">{t(RULE_KEYS[r][1])}</span>
              </span>
            </label>
          {/each}
        </fieldset>
      {/if}

      {#if needed.length > 0}
        <fieldset class="acks">
          <legend>{t('products:price.acks')}</legend>
          {#each needed as a (a)}
            <label class="choice">
              <input type="checkbox" checked={acked[a] === true} onchange={(e) => (acked = { ...acked, [a]: e.currentTarget.checked })} />
              <span>{t(ACK_KEYS[a], { percent: view?.limits.relativeChangePercent ?? 50, amount: view?.limits.absoluteChangeMajor ?? 100 })}</span>
            </label>
          {/each}
        </fieldset>
      {/if}

      {#if failure}
        <div role="alert" class="fail">
          <Alert tone="error">{t('products:price.failure.withNothing', { message: failure.message })}</Alert>
          {#if failure.issues.length > 0}
            <ul>{#each failure.issues as issue}<li>{issueText(issue, rows.find((r) => r.territory === issue.territory)?.currency)}</li>{/each}</ul>
          {/if}
          {#if failure.kind === 'stale'}<Button size="sm" onclick={() => { closeEditor(); onstaged(); }}>{t('products:price.reload')}</Button>{/if}
        </div>
      {/if}

      <div class="row">
        <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>{t('products:price.stage')}</Button>
        <Button disabled={saving} onclick={closeEditor}>{t('common:action.cancel')}</Button>
        <span class="muted text-sm">{t('products:price.stageHelp')}</span>
      </div>
    </form>
  {/if}
</div>

<style>
  .editor {
    padding: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }
  .scroll {
    max-height: 22rem;
    overflow: auto;
  }
  .amount {
    width: 8rem;
  }
  .cur {
    margin-left: var(--space-1);
  }
  .msg {
    min-height: 1.2em;
  }
  .bad {
    color: var(--bad-ink);
  }
  .increase {
    color: var(--warn-ink);
  }
  .decrease {
    color: var(--info-ink);
  }
  .field {
    display: grid;
    gap: var(--space-1);
    max-width: 22rem;
  }
  fieldset {
    margin: 0;
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  legend {
    padding: 0 var(--space-1);
    font-weight: 600;
  }
  .choice {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    padding: var(--space-1) 0;
  }
  .help {
    display: block;
  }
  .acks {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn-ink);
  }
  .fail ul {
    margin: var(--space-2) 0 0;
    padding-left: var(--space-4);
  }
</style>
