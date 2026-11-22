import type { Role } from '@kiln/core';
import { t } from '../../lib/i18n/t.ts';

/**
 * The role names, in the language of the app. The shared words of `common`: reading `roleLabel.admin` translates at that moment
 * (a getter), so a template that reads it follows the language, and `roleLabel[role].toLowerCase()` keeps working.
 */
export const roleLabel: Record<Role, string> = {
  get owner() {
    return t('common:role.owner');
  },
  get admin() {
    return t('common:role.admin');
  },
  get member() {
    return t('common:role.member');
  },
  get viewer() {
    return t('common:role.viewer');
  },
};

/** One line per role for the invite form, so a person knows what they are handing out (translated when read, like `roleLabel`). */
export const roleHelp: Record<Role, string> = {
  get owner() {
    return t('workspace:members.role.help.owner');
  },
  get admin() {
    return t('workspace:members.role.help.admin');
  },
  get member() {
    return t('workspace:members.role.help.member');
  },
  get viewer() {
    return t('workspace:members.role.help.viewer');
  },
};
