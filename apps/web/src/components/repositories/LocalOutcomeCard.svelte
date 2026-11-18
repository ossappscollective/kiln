<!--
  LocalOutcomeCard: the result of applying a change set as a commit in the local clone: the branch
  and the commit, how to look at it (git switch), and each step on its own line (commit, push, pull
  request) with why it failed when it did. A failed push or pull request does not undo the commit;
  the buttons retry exactly the step that is left.
  Props: changeSet (with its outcome), options (the retries that are possible, from retryOptions),
  busy (the id of the retry that is running, or ''), onretry (called with the option), onfixup (given
  only to who may fix up the branch: shows "Fix up this branch", which adds one commit on top of it).
-->
<script lang="ts">
  import { type RetryOption, outcomeSignature, outcomeSteps, switchHint } from '../../lib/change-set-apply.ts';
  import { isWebUrl } from '../../lib/credentials.ts';
  import { prLabel } from '../../lib/repositories.ts';
  import type { ChangeSetView } from '../../lib/types.ts';
  import ExternalLink from '../credentials/ExternalLink.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';

  let {
    changeSet,
    options,
    busy = '',
    onretry,
    onfixup,
  }: {
    changeSet: ChangeSetView;
    options: RetryOption[];
    busy?: string;
    onretry: (option: RetryOption) => void;
    onfixup?: (() => void) | undefined;
  } = $props();

  const outcome = $derived(changeSet.outcome);
  const steps = $derived(outcome ? outcomeSteps(outcome) : []);
  const signature = $derived(outcomeSignature(outcome));
  const hint = $derived(outcome ? switchHint(outcome.commit.branch) : '');
  const problem = $derived(steps.some((step) => step.tone === 'bad'));
</script>

{#if outcome}
  <Alert tone={problem ? 'warn' : 'ok'} title={problem ? 'Committed to the local clone, with a problem' : 'Committed to the local clone'}>
    <div class="stack tight">
      <p>
        The commit is on the branch <code>{outcome.commit.branch}</code> (<code>{outcome.commit.sha.slice(0, 7)}</code>), made on top of
        <code>{outcome.base.branch}</code>. The checked out branch and the working folder were not touched.
      </p>
      <p class="row">
        To look at it: <code>{hint}</code>
        <CopyButton value={hint} label="Copy the command" iconOnly />
      </p>

      <ul class="steps" aria-label="What happened, step by step">
        {#each steps as step (step.id)}
          <li>
            <Badge tone={step.tone}>{step.label}</Badge>
            <span>
              {step.status}.
              {#if step.id === 'pr' && changeSet.prUrl && isWebUrl(changeSet.prUrl)}
                <ExternalLink href={changeSet.prUrl} label={prLabel(changeSet)} />
              {/if}
              {#if step.detail}<span class="detail">{step.detail}</span>{/if}
              {#if step.id === 'commit' && signature}
                <Badge tone="ok">{signature.label}</Badge>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
      {#if signature}
        <p class="muted small">{signature.tip}</p>
      {/if}

      {#if changeSet.fixups && changeSet.fixups.length > 0}
        <p class="muted small">
          {changeSet.fixups.length === 1 ? 'One fix up commit was' : `${changeSet.fixups.length} fix up commits were`} added on top of the first one; the commit above is the latest.
        </p>
      {/if}

      {#if options.length > 0 || onfixup}
        <div class="row wrap">
          {#each options as option (option.id)}
            <Button icon="git-pull-request" disabled={busy !== ''} loading={busy === option.id} onclick={() => onretry(option)}>
              {busy === option.id ? 'Working…' : option.label}
            </Button>
          {/each}
          {#if onfixup}
            <Button icon="git-branch" disabled={busy !== ''} onclick={onfixup}>Fix up this branch</Button>
          {/if}
        </div>
      {/if}
    </div>
  </Alert>
{/if}

<style>
  .steps {
    display: grid;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .steps li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: baseline;
  }

  .detail {
    display: block;
    overflow-wrap: anywhere;
    color: var(--muted);
  }

  p {
    margin: 0;
  }
</style>
