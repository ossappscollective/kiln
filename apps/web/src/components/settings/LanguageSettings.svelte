<!--
  LanguageSettings: the language of this browser. Not a workspace setting: it is not part of the settings form, is not saved to the
  server and applies at once (lib/i18n, docs/i18n.md). The same choice is in the account menu and on the sign-in page.
-->
<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import Card from '../ui/Card.svelte';
  import LanguageSelect from '../ui/LanguageSelect.svelte';
  import T from '../ui/T.svelte';
</script>

<Card title={t('common:language.title')} collapseKey="language" description={t('common:language.description')}>
  <LanguageSelect layout="stacked" account />
  <p class="hint"><T key="common:language.help" /></p>
</Card>
