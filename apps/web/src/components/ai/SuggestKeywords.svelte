<!--
  SuggestKeywords: "Suggest keywords", the quiet entry point on the ASO Ideas and Keywords views. For each app record in scope it asks the
  assistant for keyword ideas in ONE language (the one chosen, else the one the app tracks most, or the one the view reads) and storefront.
  The ideas arrive as a proposal in the AI suggestions tray: nothing is tracked until the person accepts them there. It reads stored data
  and sends only what the disclosure lists; it never contacts a store.
  Props: api, workspaceId, role, members (the app records in scope), keywords (the tracked keywords, to find the storefront),
  localeFor (the language to use for an app, or null when it has none yet).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { aiErrorMessage } from '../../lib/ai/ai.ts';
  import { aiStore } from '../../lib/app-state/ai-facade.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AsoKeyword, countryForLocale } from '../../lib/aso/aso.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import SuggestButton from './SuggestButton.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    keywords,
    localeFor,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    keywords: AsoKeyword[];
    localeFor: (app: AppSummary) => string | null;
  } = $props();

  const multi = $derived(members.length > 1);
  const targets = $derived(members.filter((m) => localeFor(m) !== null));
  const reason = $derived(targets.length === 0 ? t('ai:suggestKeywords.noLanguage') : null);

  async function run() {
    const problems: string[] = [];
    let made = 0;
    for (const app of targets) {
      const locale = localeFor(app);
      if (locale === null) continue;
      const country = countryForLocale(locale, keywords.filter((kw) => kw.appId === app.id));
      try {
        await aiStore.run(api, workspaceId, 'keyword_ideas', { appId: app.id, locale, ...(country ? { country } : {}) });
        made += 1;
      } catch (e) {
        const message = aiErrorMessage(e);
        problems.push(multi ? t('ai:suggestKeywords.problemFor', { platform: platformLabel(app.platform), message }) : message);
      }
    }
    if (problems.length > 0) toast.error(problems.join(' '));
    else if (made > 0) toast.info(t('ai:suggestKeywords.ready'));
  }
</script>

<SuggestButton {api} {workspaceId} {role} kind="keywords" taskId="keyword_ideas" label={t('ai:suggestKeywords.label')} onrun={run} disabledReason={reason} align="end" />
