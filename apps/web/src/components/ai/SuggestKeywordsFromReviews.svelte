<!--
  SuggestKeywordsFromReviews: "Ideas from reviews", next to "Suggest keywords" on the ASO Ideas view. It asks the assistant for keyword ideas
  taken from the words customers use in the reviews of the last 90 days (the review text is sent with names, emails, links and numbers
  taken out), in ONE language and storefront, for each app in scope. The ideas arrive as a proposal in the tray above the list, exactly
  like the other keyword ideas: each has a short reason, how relevant the assistant thinks it is and which sources it came from;
  nothing is tracked until a person accepts it. Reads stored data only; it never contacts a store.
  Props: api, workspaceId, role, members, keywords, localeFor (as SuggestKeywords).
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
  /** The options of the first app: the data a run would send is shown for it (every app is built the same way). */
  const first = $derived(targets[0] ?? null);
  const preview = $derived.by(() => {
    if (first === null) return null;
    const locale = localeFor(first);
    if (locale === null) return null;
    const country = countryForLocale(locale, keywords.filter((k) => k.appId === first.id));
    return { appId: first.id, locale, ...(country ? { country } : {}), days: 90 };
  });

  async function run() {
    const problems: string[] = [];
    let made = 0;
    for (const app of targets) {
      const locale = localeFor(app);
      if (locale === null) continue;
      const country = countryForLocale(locale, keywords.filter((k) => k.appId === app.id));
      try {
        await aiStore.run(api, workspaceId, 'keyword_ideas_reviews', { appId: app.id, locale, days: 90, ...(country ? { country } : {}) });
        made += 1;
      } catch (e) {
        const message = aiErrorMessage(e);
        problems.push(multi ? t('ai:suggestKeywords.problemFor', { platform: platformLabel(app.platform), message }) : message);
      }
    }
    if (problems.length > 0) toast.error(problems.join(' '));
    else if (made > 0) toast.info(t('ai:suggestKeywords.readyFromReviews'));
  }
</script>

<SuggestButton {api} {workspaceId} {role} kind="keywords" taskId="keyword_ideas_reviews" label={t('ai:suggestKeywords.labelFromReviews')} onrun={run} disabledReason={reason} align="end" {preview} />
