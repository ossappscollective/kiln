// What complaints in reviews are about, counted on this machine with no AI. A coarse net on purpose: a card says "6 low reviews this month
// mention crashes" and links to the reviews, and a person reads them. Terms are written for the four languages Kiln's interface speaks (English,
// French, Spanish, German); a review in another language matches nothing and is simply not counted.
//
// Text is folded first (lower case, accents and umlauts removed, "ß" as "ss", every non-letter a space), so "Stürzt ab" is matched by
// "sturzt ab". Terms are of three kinds: `prefixes` match the start of a word, `exact` match a whole word (for short words like "lent" that start
// longer ones), and `phrases` match a run of words. Everything here is plain string work, so it runs where the web app does (ES2017).

export const REVIEW_THEMES = ['crash', 'bug', 'login', 'data', 'price', 'ads', 'performance', 'update'] as const;
export type ReviewTheme = (typeof REVIEW_THEMES)[number];

type Terms = { prefixes: string[]; exact: string[]; phrases: string[] };

const THEMES: Record<ReviewTheme, Terms> = {
  crash: {
    prefixes: ['crash', 'freez', 'absturz', 'abgesturzt', 'plantage', 'crashea'],
    exact: ['froze', 'plante', 'friert', 'sturzt', 'crashe'],
    phrases: ['force clos', 'keeps closing', 'won t open', 'wont open', 'closes by itself', 'se ferme', 'ferme tout seul', 'se cierra', 'se cuelga', 'sturzt ab', 'hangt sich auf', 'schliesst sich'],
  },
  bug: {
    prefixes: ['bug', 'glitch', 'fehler', 'erreur', 'fallo', 'defaut'],
    exact: ['broken', 'error', 'errors', 'falla', 'fallas', 'panne'],
    phrases: ['doesn t work', 'does not work', 'not working', 'stopped working', 'no funciona', 'dejo de funcionar', 'deja de funcionar', 'funktioniert nicht', 'geht nicht', 'ne marche pas', 'ne fonctionne pas', 'marche plus', 'ne fonctionne plus'],
  },
  login: {
    prefixes: ['login', 'passwort', 'anmeld', 'einlog', 'contrasena', 'identifiant'],
    exact: ['password', 'connexion', 'verification'],
    phrases: ['log in', 'sign in', 'cant log', 'can t log', 'mot de passe', 'se connecter', 'iniciar sesion', 'no puedo entrar', 'kann mich nicht', 'verification code'],
  },
  data: {
    prefixes: ['synchron', 'sincroniz', 'sauvegarde', 'verloren', 'verschwund', 'desaparec', 'geloscht'],
    exact: ['sync', 'backup', 'perdu', 'perdi', 'perdido', 'disparu', 'disappeared'],
    phrases: ['lost my', 'lost all', 'data loss', 'deleted my', 'daten weg', 'copia de seguridad'],
  },
  price: {
    prefixes: ['subscri', 'suscrip', 'abonnement', 'rembours', 'reembols', 'abzock', 'overpric', 'paywall'],
    exact: ['expensive', 'refund', 'scam', 'cher', 'chere', 'arnaque', 'payant', 'caro', 'cara', 'estafa', 'teuer', 'abo', 'kostet', 'charged'],
    phrases: ['too much', 'rip off', 'free trial', 'trop cher', 'de pago', 'pay to', 'zu teuer'],
  },
  ads: {
    prefixes: ['advert', 'werbung', 'publicit', 'anunci', 'reklame'],
    exact: ['ad', 'ads', 'pub', 'pubs'],
    phrases: [],
  },
  performance: {
    prefixes: ['laggy', 'lenteur', 'bateria', 'batterie', 'ruckel'],
    exact: ['slow', 'lag', 'battery', 'drain', 'drains', 'lent', 'lente', 'rame', 'lento', 'lenta', 'langsam', 'akku', 'trage', 'heavy'],
    phrases: ['takes forever', 'se traba', 'se pone lento'],
  },
  update: {
    prefixes: [],
    exact: [],
    phrases: [
      'since the update', 'after the update', 'latest update', 'new update', 'last update', 'update ruined', 'update broke',
      'depuis la mise a jour', 'derniere mise a jour', 'depuis la derniere',
      'desde la actualizacion', 'ultima actualizacion', 'despues de actualizar', 'despues de la actualizacion',
      'seit dem update', 'nach dem update', 'neues update', 'letztes update', 'seit der aktualisierung', 'nach der aktualisierung',
    ],
  },
};

/** Lower case, no accents, "ß" as "ss", every run of other characters one space, padded with a space at both ends. */
export function foldText(text: string): string {
  const folded = text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${folded} `;
}

/** The themes a review text touches, in the order of `REVIEW_THEMES`. */
export function themesOf(text: string): ReviewTheme[] {
  const folded = foldText(text);
  const words = folded.trim().split(' ');
  const found: ReviewTheme[] = [];
  for (const theme of REVIEW_THEMES) {
    const terms = THEMES[theme];
    const hit =
      terms.phrases.some((phrase) => folded.indexOf(` ${phrase} `) >= 0) ||
      words.some((word) => terms.exact.indexOf(word) >= 0 || terms.prefixes.some((p) => word.indexOf(p) === 0));
    if (hit) found.push(theme);
  }
  return found;
}

export type ThemedReview = { rating: number; text: string };

export type ThemeCount = { theme: ReviewTheme; count: number };

/** Reviews of at most this many stars are complaints for the counting. */
export const COMPLAINT_MAX_RATING = 3;

/** How many complaints (reviews of 1 to 3 stars) touch each theme, biggest first; themes no review touches are left out. */
export function complaintThemes(reviews: readonly ThemedReview[]): { complaints: number; themes: ThemeCount[] } {
  const counts = new Map<ReviewTheme, number>();
  let complaints = 0;
  for (const review of reviews) {
    if (!(review.rating <= COMPLAINT_MAX_RATING)) continue;
    complaints += 1;
    for (const theme of themesOf(review.text)) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  const themes = REVIEW_THEMES.filter((theme) => counts.has(theme))
    .map((theme) => ({ theme, count: counts.get(theme) as number }))
    .sort((a, b) => b.count - a.count || REVIEW_THEMES.indexOf(a.theme) - REVIEW_THEMES.indexOf(b.theme));
  return { complaints, themes };
}
