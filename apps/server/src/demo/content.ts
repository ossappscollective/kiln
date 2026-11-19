/**
 * Everything made up for the demo workspace: the studio's apps, their listing texts in six languages,
 * review texts and keyword lists. All of it is fictional. No icon, screenshot or text is copied from a
 * real product.
 */

export type Platform = 'ios' | 'macos' | 'android';

export const APPLE_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'ja', 'pt-BR'] as const;
export const PLAY_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'es-ES', 'ja-JP', 'pt-BR'] as const;
/** The language part of a locale: `ja` and `ja-JP` are the same copy. */
export const langOf = (locale: string) => locale.split('-')[0] as Lang;
export type Lang = 'en' | 'de' | 'fr' | 'es' | 'ja' | 'pt';
export const LANGS: Lang[] = ['en', 'de', 'fr', 'es', 'ja', 'pt'];

type Copy = {
  name: string;
  subtitle: string;
  short: string;
  description: string;
  promo: string;
  notes: string;
  keywords: string;
};

export type DemoApp = {
  key: 'notes' | 'weather' | 'focus';
  name: string;
  identifier: string;
  appleId: string;
  platforms: Platform[];
  color: [number, number, number];
  accent: [number, number, number];
  glyph: 'note' | 'sun' | 'timer';
  copy: Record<Lang, Copy>;
  /** App Store version / Play release names. */
  live: string;
  next: string;
};

const notes: Record<Lang, Copy> = {
  en: {
    name: 'Demo Notes',
    subtitle: 'Quick notes, in sync',
    short: 'Capture ideas in a second and find them again on every device.',
    description:
      'Demo Notes is a calm place for everything you want to remember. Open it, type, and the note is saved and synced before you look away.\n\n- Checklists, tags and pinned notes\n- Search that understands what you meant\n- Works offline and syncs when you are back online\n- Share a note as text or as a link\n\nNo account is needed to start. Your notes stay on your device unless you turn on sync.',
    promo: 'New: shared folders. Invite a friend and write together.',
    notes: 'Shared folders are here. We also made search faster and fixed a rare crash when pasting long text.',
    keywords: 'notes,notebook,memo,checklist,todo,journal,sync,text,write,ideas',
  },
  de: {
    name: 'Demo Notes',
    subtitle: 'Notizen, immer synchron',
    short: 'Ideen in einer Sekunde festhalten und auf jedem Gerät wiederfinden.',
    description:
      'Demo Notes ist ein ruhiger Ort für alles, was Sie sich merken möchten. Öffnen, tippen, und die Notiz ist gespeichert und synchronisiert.\n\n- Checklisten, Tags und angeheftete Notizen\n- Suche, die versteht, was Sie meinten\n- Funktioniert offline und synchronisiert später\n- Notizen als Text oder Link teilen\n\nZum Start brauchen Sie kein Konto. Ihre Notizen bleiben auf dem Gerät, solange Sie die Synchronisierung nicht einschalten.',
    promo: 'Neu: geteilte Ordner. Laden Sie Freunde ein und schreiben Sie gemeinsam.',
    notes: 'Geteilte Ordner sind da. Außerdem ist die Suche schneller und ein seltener Absturz beim Einfügen langer Texte ist behoben.',
    keywords: 'notizen,notizbuch,memo,checkliste,aufgaben,tagebuch,sync,text,schreiben,ideen',
  },
  fr: {
    name: 'Demo Notes',
    subtitle: 'Vos notes, toujours à jour',
    short: 'Notez une idée en une seconde et retrouvez-la sur tous vos appareils.',
    description:
      'Demo Notes est un endroit calme pour tout ce que vous voulez retenir. Ouvrez, écrivez, et la note est enregistrée et synchronisée.\n\n- Listes, étiquettes et notes épinglées\n- Une recherche qui comprend ce que vous cherchez\n- Fonctionne hors ligne et se synchronise au retour du réseau\n- Partagez une note en texte ou par lien\n\nAucun compte n’est nécessaire pour commencer. Vos notes restent sur l’appareil tant que vous n’activez pas la synchronisation.',
    promo: 'Nouveau : dossiers partagés. Invitez un ami et écrivez à deux.',
    notes: 'Les dossiers partagés arrivent. La recherche est aussi plus rapide et un plantage rare au collage de longs textes est corrigé.',
    keywords: 'notes,carnet,mémo,liste,tâches,journal,synchro,texte,écrire,idées',
  },
  es: {
    name: 'Demo Notes',
    subtitle: 'Notas siempre sincronizadas',
    short: 'Apunta una idea en un segundo y encuéntrala en todos tus dispositivos.',
    description:
      'Demo Notes es un lugar tranquilo para todo lo que quieres recordar. Abre, escribe y la nota se guarda y se sincroniza.\n\n- Listas, etiquetas y notas fijadas\n- Una búsqueda que entiende lo que quieres decir\n- Funciona sin conexión y se sincroniza al volver\n- Comparte una nota como texto o como enlace\n\nNo necesitas una cuenta para empezar. Tus notas se quedan en tu dispositivo salvo que actives la sincronización.',
    promo: 'Novedad: carpetas compartidas. Invita a un amigo y escribid juntos.',
    notes: 'Llegan las carpetas compartidas. También hemos acelerado la búsqueda y corregido un cierre inesperado al pegar textos largos.',
    keywords: 'notas,libreta,memo,lista,tareas,diario,sincronizar,texto,escribir,ideas',
  },
  ja: {
    name: 'デモノート',
    subtitle: 'どこでも同期するメモ',
    short: 'ひらめきを一瞬でメモ。すべてのデバイスで見つかります。',
    description:
      'デモノートは、覚えておきたいことのための静かな場所です。開いて書くだけで、保存と同期が完了します。\n\n- チェックリスト、タグ、ピン留め\n- 意図を汲み取る検索\n- オフラインでも使え、接続後に同期\n- テキストまたはリンクで共有\n\n始めるのにアカウントは不要です。同期をオンにしない限り、メモは端末の中に残ります。',
    promo: '新機能：共有フォルダ。友だちを招待して一緒に書こう。',
    notes: '共有フォルダを追加しました。検索も高速になり、長い文章を貼り付けたときに起きるまれなクラッシュを修正しました。',
    keywords: 'メモ,ノート,チェックリスト,タスク,日記,同期,文章,アイデア',
  },
  pt: {
    name: 'Demo Notes',
    subtitle: 'Notas sempre sincronizadas',
    short: 'Anote uma ideia em um segundo e encontre em todos os dispositivos.',
    description:
      'O Demo Notes é um lugar tranquilo para tudo o que você quer lembrar. Abra, escreva e a nota é salva e sincronizada.\n\n- Listas, etiquetas e notas fixadas\n- Busca que entende o que você quis dizer\n- Funciona offline e sincroniza quando voltar a conexão\n- Compartilhe uma nota como texto ou link\n\nNão é preciso conta para começar. Suas notas ficam no aparelho, a menos que você ative a sincronização.',
    promo: 'Novidade: pastas compartilhadas. Convide um amigo e escrevam juntos.',
    notes: 'As pastas compartilhadas chegaram. A busca ficou mais rápida e corrigimos uma falha rara ao colar textos longos.',
    keywords: 'notas,caderno,memo,checklist,tarefas,diário,sincronizar,texto,escrever,ideias',
  },
};

const weather: Record<Lang, Copy> = {
  en: {
    name: 'Demo Weather',
    subtitle: 'Rain alerts that help',
    short: 'Minute-by-minute rain alerts and a clear forecast for the next 10 days.',
    description:
      'Demo Weather tells you what you need to know and nothing else: will it rain in the next hour, and what should you wear.\n\n- Minute-by-minute rain alerts\n- Hourly and 10-day forecast\n- Widgets for the home and lock screen\n- Air quality and pollen where available\n\nLocation is used only to show your forecast and never leaves your device.',
    promo: 'Rain alerts now arrive up to 20 minutes earlier.',
    notes: 'Rain alerts arrive earlier and the 10-day forecast has a new compact view. Fixes a widget that showed yesterday’s high.',
    keywords: 'weather,forecast,rain,radar,temperature,wind,widget,alerts,pollen,umbrella',
  },
  de: {
    name: 'Demo Wetter',
    subtitle: 'Regenwarnungen, die helfen',
    short: 'Regenwarnungen im Minutentakt und eine klare Vorhersage für 10 Tage.',
    description:
      'Demo Wetter sagt Ihnen, was Sie wissen müssen: Regnet es in der nächsten Stunde, und was ziehe ich an?\n\n- Regenwarnungen im Minutentakt\n- Stündliche und 10-Tage-Vorhersage\n- Widgets für Home- und Sperrbildschirm\n- Luftqualität und Pollen, wo verfügbar\n\nDer Standort wird nur für Ihre Vorhersage genutzt und verlässt Ihr Gerät nie.',
    promo: 'Regenwarnungen kommen jetzt bis zu 20 Minuten früher.',
    notes: 'Regenwarnungen kommen früher und die 10-Tage-Vorhersage hat eine neue kompakte Ansicht. Ein Widget zeigte den Höchstwert von gestern; das ist behoben.',
    keywords: 'wetter,vorhersage,regen,radar,temperatur,wind,widget,warnung,pollen,schirm',
  },
  fr: {
    name: 'Demo Météo',
    subtitle: 'Des alertes pluie utiles',
    short: 'Alertes pluie à la minute et prévisions claires sur 10 jours.',
    description:
      'Demo Météo vous dit l’essentiel : va-t-il pleuvoir dans l’heure, et comment s’habiller ?\n\n- Alertes pluie à la minute\n- Prévisions horaires et sur 10 jours\n- Widgets pour l’écran d’accueil et verrouillé\n- Qualité de l’air et pollens selon la région\n\nLa position sert uniquement à afficher vos prévisions et ne quitte jamais l’appareil.',
    promo: 'Les alertes pluie arrivent jusqu’à 20 minutes plus tôt.',
    notes: 'Les alertes pluie arrivent plus tôt et les prévisions à 10 jours ont une vue compacte. Correction d’un widget qui affichait le maximum d’hier.',
    keywords: 'météo,prévisions,pluie,radar,température,vent,widget,alertes,pollen,parapluie',
  },
  es: {
    name: 'Demo Tiempo',
    subtitle: 'Avisos de lluvia útiles',
    short: 'Avisos de lluvia minuto a minuto y una previsión clara a 10 días.',
    description:
      'Demo Tiempo te cuenta lo que necesitas: ¿lloverá en la próxima hora y qué me pongo?\n\n- Avisos de lluvia minuto a minuto\n- Previsión por horas y a 10 días\n- Widgets para inicio y pantalla de bloqueo\n- Calidad del aire y polen donde esté disponible\n\nLa ubicación solo se usa para mostrar tu previsión y nunca sale de tu dispositivo.',
    promo: 'Los avisos de lluvia llegan hasta 20 minutos antes.',
    notes: 'Los avisos de lluvia llegan antes y la previsión a 10 días tiene una vista compacta. Corregido un widget que mostraba la máxima de ayer.',
    keywords: 'tiempo,previsión,lluvia,radar,temperatura,viento,widget,avisos,polen,paraguas',
  },
  ja: {
    name: 'デモ天気',
    subtitle: '役立つ雨のお知らせ',
    short: '1分ごとの雨のお知らせと、10日間のわかりやすい予報。',
    description:
      'デモ天気は必要なことだけを伝えます。1時間以内に雨は降る？何を着ていく？\n\n- 1分ごとの雨のお知らせ\n- 1時間ごと・10日間の予報\n- ホーム画面とロック画面のウィジェット\n- 大気質と花粉（対応地域）\n\n位置情報は予報の表示にだけ使われ、端末の外には出ません。',
    promo: '雨のお知らせが最大20分早く届きます。',
    notes: '雨のお知らせが早くなり、10日間予報にコンパクト表示を追加しました。昨日の最高気温を表示していたウィジェットを修正しました。',
    keywords: '天気,予報,雨,レーダー,気温,風,ウィジェット,通知,花粉,傘',
  },
  pt: {
    name: 'Demo Clima',
    subtitle: 'Alertas de chuva úteis',
    short: 'Alertas de chuva minuto a minuto e previsão clara para 10 dias.',
    description:
      'O Demo Clima diz o que você precisa saber: vai chover na próxima hora e o que vestir?\n\n- Alertas de chuva minuto a minuto\n- Previsão por hora e para 10 dias\n- Widgets para a tela inicial e a de bloqueio\n- Qualidade do ar e pólen quando disponível\n\nA localização é usada só para mostrar a previsão e nunca sai do seu aparelho.',
    promo: 'Os alertas de chuva chegam até 20 minutos antes.',
    notes: 'Os alertas de chuva chegam mais cedo e a previsão de 10 dias tem uma visão compacta. Corrigido um widget que mostrava a máxima de ontem.',
    keywords: 'clima,previsão,chuva,radar,temperatura,vento,widget,alertas,pólen,guarda-chuva',
  },
};

const focus: Record<Lang, Copy> = {
  en: {
    name: 'Demo Focus',
    subtitle: 'A timer in your menu bar',
    short: 'A quiet focus timer that lives in the menu bar.',
    description:
      'Demo Focus is a small timer for people who want to start working and stop thinking about the tool.\n\n- One click starts a 25 minute session\n- Gentle break reminders\n- Daily and weekly focus time, kept on your Mac\n- Keyboard shortcuts for everything\n\nNo account and no tracking.',
    promo: 'Now with Shortcuts actions.',
    notes: 'Adds Shortcuts actions to start and stop a session, and a darker menu bar icon for light wallpapers.',
    keywords: 'focus,timer,pomodoro,menubar,work,break,productivity,study',
  },
  de: {
    name: 'Demo Focus',
    subtitle: 'Ein Timer in der Menüleiste',
    short: 'Ein ruhiger Fokus-Timer in der Menüleiste.',
    description:
      'Demo Focus ist ein kleiner Timer für alle, die anfangen wollen zu arbeiten.\n\n- Ein Klick startet eine 25-Minuten-Sitzung\n- Sanfte Pausenerinnerungen\n- Tägliche und wöchentliche Fokuszeit, nur auf Ihrem Mac\n- Tastenkürzel für alles\n\nKein Konto und kein Tracking.',
    promo: 'Jetzt mit Kurzbefehle-Aktionen.',
    notes: 'Neue Kurzbefehle-Aktionen zum Starten und Beenden einer Sitzung und ein dunkleres Symbol für helle Hintergründe.',
    keywords: 'fokus,timer,pomodoro,menüleiste,arbeit,pause,produktiv,lernen',
  },
  fr: {
    name: 'Demo Focus',
    subtitle: 'Un minuteur dans la barre des menus',
    short: 'Un minuteur de concentration discret, dans la barre des menus.',
    description:
      'Demo Focus est un petit minuteur pour celles et ceux qui veulent se mettre au travail.\n\n- Un clic lance une session de 25 minutes\n- Rappels de pause discrets\n- Temps de concentration quotidien et hebdomadaire, sur votre Mac\n- Raccourcis clavier pour tout\n\nSans compte et sans suivi.',
    promo: 'Désormais avec des actions Raccourcis.',
    notes: 'Ajoute des actions Raccourcis pour démarrer et arrêter une session, et une icône plus sombre pour les fonds clairs.',
    keywords: 'focus,minuteur,pomodoro,barre des menus,travail,pause,productivité,étude',
  },
  es: {
    name: 'Demo Focus',
    subtitle: 'Un temporizador en la barra',
    short: 'Un temporizador de concentración discreto en la barra de menús.',
    description:
      'Demo Focus es un pequeño temporizador para quien quiere ponerse a trabajar.\n\n- Un clic inicia una sesión de 25 minutos\n- Recordatorios de descanso suaves\n- Tiempo de concentración diario y semanal, en tu Mac\n- Atajos de teclado para todo\n\nSin cuenta y sin seguimiento.',
    promo: 'Ahora con acciones de Atajos.',
    notes: 'Añade acciones de Atajos para iniciar y detener una sesión y un icono más oscuro para fondos claros.',
    keywords: 'focus,temporizador,pomodoro,barra de menús,trabajo,descanso,productividad,estudio',
  },
  ja: {
    name: 'デモフォーカス',
    subtitle: 'メニューバーのタイマー',
    short: 'メニューバーにいる、静かな集中タイマー。',
    description:
      'デモフォーカスは、すぐ作業を始めたい人のための小さなタイマーです。\n\n- ワンクリックで25分のセッションを開始\n- やさしい休憩のお知らせ\n- 毎日・毎週の集中時間をMac内に保存\n- すべてにキーボードショートカット\n\nアカウント不要、トラッキングなし。',
    promo: 'ショートカットのアクションに対応しました。',
    notes: 'セッションの開始と終了をショートカットから操作できるようになりました。明るい壁紙向けにメニューバーアイコンも濃くしました。',
    keywords: '集中,タイマー,ポモドーロ,メニューバー,仕事,休憩,勉強',
  },
  pt: {
    name: 'Demo Focus',
    subtitle: 'Um timer na barra de menus',
    short: 'Um timer de foco discreto na barra de menus.',
    description:
      'O Demo Focus é um timer pequeno para quem quer começar a trabalhar.\n\n- Um clique inicia uma sessão de 25 minutos\n- Lembretes de pausa suaves\n- Tempo de foco diário e semanal, só no seu Mac\n- Atalhos de teclado para tudo\n\nSem conta e sem rastreamento.',
    promo: 'Agora com ações do Atalhos.',
    notes: 'Adiciona ações do Atalhos para iniciar e parar uma sessão e um ícone mais escuro para fundos claros.',
    keywords: 'foco,timer,pomodoro,barra de menus,trabalho,pausa,produtividade,estudo',
  },
};

export const DEMO_APPS: DemoApp[] = [
  {
    key: 'notes',
    name: 'Demo Notes',
    identifier: 'com.demostudio.notes',
    appleId: '6740010101',
    platforms: ['ios', 'macos', 'android'],
    color: [250, 204, 21],
    accent: [30, 41, 59],
    glyph: 'note',
    copy: notes,
    live: '3.4.0',
    next: '3.5.0',
  },
  {
    key: 'weather',
    name: 'Demo Weather',
    identifier: 'com.demostudio.weather',
    appleId: '6740020202',
    platforms: ['ios', 'android'],
    color: [56, 189, 248],
    accent: [255, 255, 255],
    glyph: 'sun',
    copy: weather,
    live: '2.8.1',
    next: '2.9.0',
  },
  {
    key: 'focus',
    name: 'Demo Focus',
    identifier: 'com.demostudio.focus',
    appleId: '6740030303',
    platforms: ['macos'],
    color: [244, 63, 94],
    accent: [255, 255, 255],
    glyph: 'timer',
    copy: focus,
    live: '1.6.2',
    next: '1.7.0',
  },
];

/** The listing texts of one app in one language, as the fields of each store. */
export function appleTexts(app: DemoApp, lang: Lang): Record<string, string> {
  const c = app.copy[lang];
  return {
    name: c.name,
    subtitle: c.subtitle,
    description: c.description,
    keywords: c.keywords,
    promotional_text: c.promo,
    release_notes: c.notes,
    marketing_url: `https://demo.example.com/${app.key}`,
    support_url: `https://demo.example.com/${app.key}/support`,
    privacy_url: `https://demo.example.com/${app.key}/privacy`,
  };
}

export function playTexts(app: DemoApp, lang: Lang): Record<string, string> {
  const c = app.copy[lang];
  return { title: c.name, short_description: c.short, full_description: c.description };
}

export const appleLocalesOf = (): string[] => [...APPLE_LOCALES];
export const playLocalesOf = (): string[] => [...PLAY_LOCALES];

// ---- reviews ---------------------------------------------------------------------------------------------------------

type ReviewLine = { title: string; body: string };
export const REVIEW_LINES: Record<Lang, { good: ReviewLine[]; mid: ReviewLine[]; bad: ReviewLine[] }> = {
  en: {
    good: [
      { title: 'Exactly what I needed', body: 'Simple, fast and it just works. I have replaced three other apps with this one.' },
      { title: 'Love the new search', body: 'Finds things I forgot I wrote. Sync is instant between my phone and laptop.' },
      { title: 'Clean and calm', body: 'No clutter, no nagging. The design is a pleasure to use every day.' },
      { title: 'Five stars', body: 'The widget is perfect and the dark mode is easy on the eyes.' },
    ],
    mid: [
      { title: 'Good, but missing one thing', body: 'Great app overall. I would love a way to export everything as one file.' },
      { title: 'Nice update, small bug', body: 'The new version is faster, but the widget sometimes shows old data until I open the app.' },
    ],
    bad: [
      { title: 'Crashes on launch', body: 'Since the last update the app closes right after the splash screen. Please fix this soon.' },
      { title: 'Lost my notes', body: 'After updating, a folder was empty. Support did not answer for a week.' },
      { title: 'Too many permissions', body: 'Why does it need access to my contacts? Uninstalled.' },
    ],
  },
  de: {
    good: [
      { title: 'Genau richtig', body: 'Einfach, schnell und zuverlässig. Ich habe damit drei andere Apps ersetzt.' },
      { title: 'Sehr aufgeräumt', body: 'Keine Ablenkung, tolles Design. Die Synchronisierung klappt sofort.' },
    ],
    mid: [{ title: 'Gut, aber ein Wunsch', body: 'Tolle App. Ein Export als einzelne Datei wäre super.' }],
    bad: [{ title: 'Stürzt ab', body: 'Seit dem letzten Update schließt sich die App direkt nach dem Start.' }],
  },
  fr: {
    good: [
      { title: 'Parfait', body: 'Simple, rapide et fiable. Je n’utilise plus que celle-ci.' },
      { title: 'Très agréable', body: 'Design épuré et synchronisation instantanée entre mes appareils.' },
    ],
    mid: [{ title: 'Presque parfait', body: 'Très bonne application, il manque juste un export complet.' }],
    bad: [{ title: 'Plantage au démarrage', body: 'Depuis la dernière mise à jour, l’application se ferme aussitôt.' }],
  },
  es: {
    good: [
      { title: 'Justo lo que buscaba', body: 'Sencilla, rápida y funciona. La sincronización es inmediata.' },
      { title: 'Muy limpia', body: 'Sin distracciones y con un diseño muy cuidado.' },
    ],
    mid: [{ title: 'Buena, pero', body: 'Me encanta, aunque me gustaría poder exportar todo en un archivo.' }],
    bad: [{ title: 'Se cierra sola', body: 'Después de actualizar se cierra al abrirla. Por favor, arreglad esto.' }],
  },
  ja: {
    good: [
      { title: 'とても使いやすい', body: 'シンプルで速く、同期もすぐ終わります。毎日使っています。' },
      { title: 'デザインが好き', body: '余計なものがなく、落ち着いて使えます。' },
    ],
    mid: [{ title: '惜しい', body: '良いアプリですが、まとめて書き出せる機能があるとうれしいです。' }],
    bad: [{ title: '起動時に落ちる', body: 'アップデート後、起動してすぐに終了してしまいます。' }],
  },
  pt: {
    good: [
      { title: 'Exatamente o que eu queria', body: 'Simples, rápido e funciona. A sincronização é instantânea.' },
      { title: 'Limpo e calmo', body: 'Sem distrações e com um design muito bom.' },
    ],
    mid: [{ title: 'Quase perfeito', body: 'Ótimo app, só falta exportar tudo em um arquivo.' }],
    bad: [{ title: 'Fecha sozinho', body: 'Depois da atualização o app fecha ao abrir. Por favor, corrijam.' }],
  },
};

export const APPLE_TERRITORIES: Record<Lang, string[]> = {
  en: ['USA', 'GBR', 'CAN', 'AUS'],
  de: ['DEU', 'AUT', 'CHE'],
  fr: ['FRA', 'BEL', 'CAN'],
  es: ['ESP', 'MEX', 'ARG'],
  ja: ['JPN'],
  pt: ['BRA', 'PRT'],
};

export const DEVELOPER_REPLY: Record<Lang, string> = {
  en: 'Thank you for the feedback. We are sorry about the trouble and are looking into it. If you can, write to support@demo.example.com with your device model and we will help you directly.',
  de: 'Danke für Ihre Rückmeldung. Das tut uns leid, wir kümmern uns darum. Schreiben Sie uns gern an support@demo.example.com.',
  fr: 'Merci pour votre retour. Nous sommes désolés et nous regardons cela. Écrivez-nous à support@demo.example.com.',
  es: 'Gracias por tu opinión. Lamentamos el problema y lo estamos revisando. Escríbenos a support@demo.example.com.',
  ja: 'ご意見ありがとうございます。ご不便をおかけして申し訳ありません。support@demo.example.com までご連絡ください。',
  pt: 'Obrigado pelo retorno. Sentimos pelo problema e estamos analisando. Escreva para support@demo.example.com.',
};

// ---- ASO -------------------------------------------------------------------------------------------------------------

export const KEYWORDS: Record<DemoApp['key'], { term: string; country: string }[]> = {
  notes: [
    { term: 'notes app', country: 'us' },
    { term: 'note taking', country: 'us' },
    { term: 'checklist', country: 'us' },
    { term: 'markdown notes', country: 'us' },
    { term: 'notizen app', country: 'de' },
    { term: 'carnet de notes', country: 'fr' },
  ],
  weather: [
    { term: 'weather forecast', country: 'us' },
    { term: 'rain alerts', country: 'us' },
    { term: 'weather widget', country: 'us' },
    { term: 'wetter app', country: 'de' },
    { term: 'météo pluie', country: 'fr' },
  ],
  focus: [
    { term: 'focus timer', country: 'us' },
    { term: 'pomodoro mac', country: 'us' },
    { term: 'menu bar timer', country: 'us' },
  ],
};

export const COMPETITORS: Record<DemoApp['key'], { id: string; name: string }[]> = {
  notes: [
    { id: '1700000001', name: 'Scribble Pad' },
    { id: '1700000002', name: 'Quill Notes' },
  ],
  weather: [
    { id: '1700000011', name: 'Cloudy Day' },
    { id: '1700000012', name: 'Skylark Weather' },
  ],
  focus: [{ id: '1700000021', name: 'Tomato Timer' }],
};
