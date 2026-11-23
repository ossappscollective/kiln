import { k, t } from './i18n/t.ts';
import type { RailGroup } from './section-rail.ts';

/**
 * The sections of the app Builds page, for the section rail (components/ui/SectionRail.svelte, address `?section=`):
 *   Builds           Builds (the CI builds matched to the releases), Test builds (what can be installed to try; includes the EAS builds)
 *   Expo (EAS)       EAS submissions, EAS configuration, EAS updates (only for an app linked to an Expo project / with a repository)
 *   Automation       Workflows
 * The old `?view=builds|tests|workflows` addresses are the same ids, so they keep opening the same section.
 */
export type BuildsSectionId = 'builds' | 'tests' | 'submissions' | 'eas-config' | 'eas-updates' | 'workflows';

export type BuildsSectionsInput = {
  /** Some app in scope is linked to an Expo project (the stored EAS status names a project). */
  expoLinked: boolean;
  /** Some app in scope has a repository and the role may scan it (the eas.json read). */
  configReadable: boolean;
  /** The role may read test builds. */
  testsReadable: boolean;
  /** EAS submissions stored for the apps in scope; null while unknown. */
  submissions: number | null;
};

export function buildsGroups(input: BuildsSectionsInput): RailGroup[] {
  const expo: RailGroup['entries'] = [];
  if (input.expoLinked) expo.push({ id: 'submissions', label: t(k('app:builds.section.submissions')), count: input.submissions });
  if (input.configReadable) expo.push({ id: 'eas-config', label: t(k('app:builds.section.config')) });
  if (input.expoLinked) expo.push({ id: 'eas-updates', label: t(k('app:builds.section.updates')) });
  return [
    {
      id: 'builds',
      label: t(k('app:builds.group.builds')),
      entries: [
        { id: 'builds', label: t(k('app:builds.section.builds')) },
        ...(input.testsReadable ? [{ id: 'tests', label: t(k('app:builds.section.tests')) }] : []),
      ],
    },
    { id: 'expo', label: t(k('app:builds.group.expo')), entries: expo },
    { id: 'automation', label: t(k('app:builds.group.automation')), entries: [{ id: 'workflows', label: t(k('app:builds.section.workflows')) }] },
  ];
}
