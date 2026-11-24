/**
 * Which written reviews talk about crashes or freezes. Deterministic and documented (docs/api/health.md): the text (title and body) is lowercased
 * and a review matches when it CONTAINS any of the phrases below. There is no language detection and no AI. The same list builds the SQL filter of
 * the Reviews list (`mentions=crash`), so the number in the health table and the list that opens from it always agree.
 * Phrases hold no apostrophe (store text mixes ' and the curly one) and no word that means something else in common use ("plant", "hängt von").
 * Extending it: add lowercase phrases here and a line to the test; a Latin or Cyrillic phrase of fewer than 5 characters is refused by the test (too many false hits).
 */
export const CRASH_PHRASES: readonly string[] = [
  // English
  'crash',
  'freez',
  'froze',
  'frozen',
  'force close',
  'force quit',
  'keeps closing',
  'keeps quitting',
  'not responding',
  'unresponsive',
  'closes by itself',
  'shuts down',
  'not open',
  'wont open',
  'hangs and',
  // French
  'plantage',
  'ça plante',
  'ca plante',
  'planté',
  'se ferme',
  'ferme tout seul',
  'se bloque',
  'bloqué',
  'se fige',
  'reste figé',
  'ne répond plus',
  'ne repond plus',
  'ne s’ouvre pas',
  'ne souvre pas',
  // Spanish
  'se cierra',
  'cierra sola',
  'cierra solo',
  'cierre inesperado',
  'se cuelga',
  'se congela',
  'se traba',
  'se bloquea',
  'no responde',
  'no abre',
  'falla al abrir',
  // German
  'absturz',
  'abgestürzt',
  'stürzt',
  'friert ein',
  'eingefroren',
  'hängt sich auf',
  'hängt fest',
  'reagiert nicht',
  'schließt sich',
  'startet nicht',
  'öffnet sich nicht',
  // Portuguese, Italian, Dutch, Turkish, Russian, Japanese, Chinese (a few common words each)
  'travando',
  'trava sozinho',
  'fecha sozinho',
  'fechando sozinho',
  'si blocca',
  'si chiude da solo',
  'crasht',
  'loopt vast',
  'çöküyor',
  'donuyor',
  'вылетает',
  'зависает',
  'クラッシュ',
  '落ちる',
  '闪退',
  '崩溃',
  '卡死',
];

export const crashMention = (
  title: string | null | undefined,
  body: string | null | undefined,
): boolean => {
  const text = `${title ?? ''} ${body ?? ''}`.toLowerCase();
  return CRASH_PHRASES.some((p) => text.includes(p));
};
