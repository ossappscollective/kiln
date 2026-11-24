# French (fr) review sheet

Status: UNREVIEWED machine-quality translation. Every row below was added or changed after commit 550fb83. Mark each row OK or Fix (and write the correction in the notes). See [README](README.md).

Plural `_many` forms (French and Spanish only) are derived mechanically from `_other` ("de" or "d’" inserted after the number: "1 million de ...") and are not listed.
Keys identical in every language (brand names, units, numbers) are skipped. Placeholders such as `{{count}}` must stay exactly as they are.

## Glossary

| English term | Translation in the catalog | Flag |
|---|---|---|
| release (a store release) | publication (publier = publish) | consistent |
| build | build (kept in English) | consistent |
| rollout | déploiement | consistent |
| listing (store page) | fiche (fiche de store) | consistent |
| cart / pending changes | Modifications en attente | consistent; "cart" is only a key prefix |
| staged / stage (prepared locally, nothing sent) | en attente / préparé / mis en attente | 3 variants for "staged"; pick one |
| draft | brouillon | consistent |
| track (Google Play) | piste | distinct from EAS "channel" (canal / channel) |
| in review (App Review) | en cours d’examen (examen) | one variant left over, now fixed ("en revue") |
| reviews (ratings and reviews) | avis | consistent |
| rating | note, moyenne | "note" also means notes; check context |
| submit | soumettre / envoyer / soumission | mixed; "envoyer" for sending, "soumettre" for App Review |
| keyword | mot-clé | consistent |
| workflow | workflow (kept) | consistent |
| workspace | espace de travail | consistent |
| tester | testeur | consistent |
| screenshot | capture d’écran | consistent |
| token | jeton (API: jeton d’API) | a few "token" left in English |
| territory / region | territoire / région | both used; check which store term applies |
| app | app / application | mixed: "application(s)" is more frequent; style choice for the reviewer |
| store | store (boutique in 37 places) | check the 37 "boutique" |

## server/alerts (39)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `action.openHealth` | Open the ratings and app health | Ouvrir les notes et la santé de l’app |  | rating = note |
| `action.openTestflight` | Open the TestFlight feedback | Ouvrir les retours TestFlight |  |  |
| `competitor.listingChanged.body` | A followed competitor changed: {{what}}. | Un concurrent suivi a modifié : {{what}}. |  |  |
| `competitor.listingChanged.body.noKinds` | A followed competitor changed its public App Store listing. | Un concurrent suivi a modifié sa fiche publique App Store. |  | listing = fiche |
| `competitor.listingChanged.kind.category` | category | catégorie |  |  |
| `competitor.listingChanged.kind.description` | description | description |  |  |
| `competitor.listingChanged.kind.icon` | icon | icône |  |  |
| `competitor.listingChanged.kind.name` | name | nom |  |  |
| `competitor.listingChanged.kind.price` | price | prix |  |  |
| `competitor.listingChanged.kind.releaseNotes` | release notes | notes de version |  | release = publication |
| `competitor.listingChanged.kind.screenshots` | screenshots | captures d’écran |  |  |
| `competitor.listingChanged.kind.version` | version | version |  |  |
| `competitor.listingChanged.title` | A competitor of {{app}} changed its App Store listing | Un concurrent de {{app}} a modifié sa fiche App Store |  | listing = fiche |
| `eas.buildFailed.body` | Build {{build}} ({{platform}}) of {{app}} failed at Expo. Open Builds to read Expo’s reason. | Le build {{build}} ({{platform}}) de {{app}} a échoué chez Expo. Ouvrez Builds pour lire la raison donnée par Expo. |  |  |
| `eas.buildFailed.body.noBuild` | A build of {{app}} failed at Expo. Open Builds to read Expo’s reason. | Un build de {{app}} a échoué chez Expo. Ouvrez Builds pour lire la raison donnée par Expo. |  |  |
| `eas.buildFailed.title` | The EAS build of {{app}} failed | Le build EAS de {{app}} a échoué |  |  |
| `eas.submissionFailed.body` | The submission of build {{build}} ({{platform}}) of {{app}} to the store failed. Open Builds to read Expo’s reason. | La soumission du build {{build}} ({{platform}}) de {{app}} au store a échoué. Ouvrez Builds pour lire la raison donnée par Expo. |  | submit: soumettre vs envoyer |
| `eas.submissionFailed.body.noBuild` | A store submission of {{app}} failed. Open Builds to read Expo’s reason. | Une soumission de {{app}} au store a échoué. Ouvrez Builds pour lire la raison donnée par Expo. |  | submit: soumettre vs envoyer |
| `eas.submissionFailed.title` | The EAS submission of {{app}} failed | La soumission EAS de {{app}} a échoué |  | submit: soumettre vs envoyer |
| `eas.updateRolloutStuck.body` | An over-the-air update of {{app}} on the {{channel}} channel has been at {{percentage}}% for {{hours}} hours. Open Builds, EAS updates, to raise it or end it. | Une mise à jour à distance de {{app}} sur le canal {{channel}} est à {{percentage}} % depuis {{hours}} heures. Ouvrez Builds, Mises à jour EAS, pour l’augmenter ou la terminer. |  |  |
| `eas.updateRolloutStuck.body.short` | An over-the-air update rollout of {{app}} has been at the same percentage for a long time. Open Builds, EAS updates, to raise it or end it. | Le déploiement d’une mise à jour à distance de {{app}} reste au même pourcentage depuis longtemps. Ouvrez Builds, Mises à jour EAS, pour l’augmenter ou le terminer. |  | rollout = déploiement |
| `eas.updateRolloutStuck.title` | The EAS Update rollout of {{app}} is stuck | Le déploiement EAS Update de {{app}} est bloqué |  | rollout = déploiement |
| `health.crashRegression.body.perSessions` | {{app}} {{version}} crashes {{after}} times for every 1,000 sessions, up from {{before}} in {{previous}}. Only people who share analytics with developers are counted. | {{app}} {{version}} plante {{after}} fois pour 1 000 sessions, contre {{before}} dans la version {{previous}}. Seules les personnes qui partagent leurs données d’analyse avec les développeurs sont comptées. |  |  |
| `health.crashRegression.body.share` | {{after}}% of the people using {{app}} {{version}} had a crash, up from {{before}}% in {{previous}}. | {{after}} % des personnes qui utilisent {{app}} {{version}} ont subi un plantage, contre {{before}} % dans la version {{previous}}. |  |  |
| `health.crashRegression.title` | {{app}} {{version}} crashes more | {{app}} {{version}} plante davantage |  |  |
| `testflight.crash.body` | A tester sent a crash report for build {{build}} of {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Un testeur a envoyé un rapport de plantage pour la build {{build}} de {{app}}. Ouvrez la vue TestFlight pour le lire avec son journal ; le journal n’est pas envoyé ici. |  |  |
| `testflight.crash.body.grouped_one` | {{count}} more crash report of {{app}} was stored. Open the TestFlight view to read it and its log; the log is not sent here. | {{count}} rapport de plantage de plus pour {{app}} a été enregistré. Ouvrez la vue TestFlight pour le lire avec son journal ; le journal n’est pas envoyé ici. |  |  |
| `testflight.crash.body.grouped_other` | {{count}} more crash reports of {{app}} were stored. Open the TestFlight view to read them and their logs; the logs are not sent here. | {{count}} rapports de plantage de plus pour {{app}} ont été enregistrés. Ouvrez la vue TestFlight pour les lire avec leurs journaux ; les journaux ne sont pas envoyés ici. |  |  |
| `testflight.crash.body.noBuild` | A tester sent a crash report for {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Un testeur a envoyé un rapport de plantage pour {{app}}. Ouvrez la vue TestFlight pour le lire avec son journal ; le journal n’est pas envoyé ici. |  |  |
| `testflight.crash.title` | New TestFlight crash in {{app}} | Nouveau plantage TestFlight dans {{app}} |  |  |
| `testflight.crash.title.grouped_one` | {{count}} more TestFlight crash in {{app}} | {{count}} plantage TestFlight de plus dans {{app}} |  |  |
| `testflight.crash.title.grouped_other` | {{count}} more TestFlight crashes in {{app}} | {{count}} plantages TestFlight de plus dans {{app}} |  |  |
| `testflight.feedback.body` | A tester sent feedback on build {{build}} of {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Un testeur a envoyé un retour sur la build {{build}} de {{app}}. Ouvrez la vue TestFlight pour le lire ; le commentaire n’est pas envoyé ici. |  |  |
| `testflight.feedback.body.grouped_one` | {{count}} more feedback of {{app}} was stored. Open the TestFlight view to read it; the comment is not sent here. | {{count}} retour de plus sur {{app}} a été enregistré. Ouvrez la vue TestFlight pour le lire ; le commentaire n’est pas envoyé ici. |  |  |
| `testflight.feedback.body.grouped_other` | {{count}} more feedback items of {{app}} were stored. Open the TestFlight view to read them; the comments are not sent here. | {{count}} retours de plus sur {{app}} ont été enregistrés. Ouvrez la vue TestFlight pour les lire ; les commentaires ne sont pas envoyés ici. |  |  |
| `testflight.feedback.body.noBuild` | A tester sent feedback on {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Un testeur a envoyé un retour sur {{app}}. Ouvrez la vue TestFlight pour le lire ; le commentaire n’est pas envoyé ici. |  |  |
| `testflight.feedback.title` | New TestFlight feedback for {{app}} | Nouveau retour TestFlight pour {{app}} |  |  |
| `testflight.feedback.title.grouped_one` | {{count}} more TestFlight feedback for {{app}} | {{count}} retour TestFlight de plus pour {{app}} |  |  |
| `testflight.feedback.title.grouped_other` | {{count}} more TestFlight feedback items for {{app}} | {{count}} retours TestFlight de plus pour {{app}} |  |  |

## server/chat (23)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `digest.heading_one` | {{count}} alert since the last summary | {{count}} alerte depuis le dernier résumé |  |  |
| `digest.heading_other` | {{count}} alerts since the last summary | {{count}} alertes depuis le dernier résumé |  |  |
| `digest.more_one` | and {{count}} more alert. Open Kiln to see all of them. | et {{count}} alerte de plus. Ouvrez Kiln pour toutes les voir. |  |  |
| `digest.more_other` | and {{count}} more alerts. Open Kiln to see all of them. | et {{count}} alertes de plus. Ouvrez Kiln pour toutes les voir. |  |  |
| `digest.title` | Alert summary | Résumé des alertes |  |  |
| `field.app` | App | Application |  |  |
| `field.platform` | Platform | Plateforme |  |  |
| `field.version` | Version | Version |  |  |
| `footer.digest` | Kiln · daily summary | Kiln · résumé quotidien |  |  |
| `footer.test` | Kiln · test message | Kiln · message de test |  |  |
| `item.repeated_one` | {{title}} ({{count}} time) | {{title}} ({{count}} fois) |  |  |
| `item.repeated_other` | {{title}} ({{count}} times) | {{title}} ({{count}} fois) |  |  |
| `noLink` | Open Kiln: {{where}}. | Ouvrez Kiln : {{where}}. |  |  |
| `openKiln` | Open Kiln | Ouvrir Kiln |  |  |
| `repeated_one` | Happened {{count}} time. | Survenu {{count}} fois. |  |  |
| `repeated_other` | Happened {{count}} times. | Survenu {{count}} fois. |  |  |
| `severity.critical` | Critical | Critique |  |  |
| `severity.info` | For your information | Pour information |  |  |
| `severity.warning` | Needs attention | Demande votre attention |  |  |
| `test.body` | If you can read this, the destination “{{name}}” works. Alerts and summaries routed to it will appear here. | Si vous lisez ce message, la destination « {{name}} » fonctionne. Les alertes et les résumés qui lui sont destinés apparaîtront ici. |  |  |
| `test.hint` | Nothing is wrong. This message was sent because someone pressed “Send test message” in Kiln. | Rien ne va mal. Ce message a été envoyé parce que quelqu’un a appuyé sur « Envoyer un message de test » dans Kiln. |  |  |
| `test.title` | Kiln test message | Message de test de Kiln |  |  |
| `whatToDo` | What to do | Que faire |  |  |

## web/ads (100)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `account.neverSynced` | Nothing has been read from Apple Ads yet. Press Sync. | Rien n’a encore été lu depuis Apple Ads. Appuyez sur Synchroniser. |  |  |
| `account.partial` | The last read was cut short, so some rows may be missing. | La dernière lecture a été interrompue : des lignes peuvent manquer. |  |  |
| `account.synced` | The last read covered {{campaigns}} campaigns, from {{from}} to {{to}}. | La dernière lecture couvrait {{campaigns}} campagnes, du {{from}} au {{to}}. |  |  |
| `campaigns.days_one` | {{count}} day with data | {{count}} jour avec des données |  |  |
| `campaigns.days_other` | {{count}} days with data | {{count}} jours avec des données |  |  |
| `campaigns.empty` | No campaign promoting this app has data in this range. | Aucune campagne qui promeut cette application n’a de données sur cette période. |  |  |
| `col.campaign` | Campaign | Campagne |  |  |
| `col.conversion` | Conversion rate | Taux de conversion |  |  |
| `col.country` | Country | Pays |  |  |
| `col.cpi` | Cost per install | Coût par installation |  |  |
| `col.cpt` | Cost per tap | Coût par appui |  |  |
| `col.day` | Day | Jour |  |  |
| `col.impressions` | Impressions | Impressions |  |  |
| `col.installs` | Installs | Installations |  |  |
| `col.spend` | Spend | Dépenses |  |  |
| `col.taps` | Taps | Appuis |  |  |
| `col.ttr` | Tap-through rate | Taux d’appui |  |  |
| `err.credentialKind` | Choose an Apple Ads API user key credential. | Choisissez un identifiant d’accès de type clé d’utilisateur de l’API Apple Ads. |  |  |
| `err.credentialNotFound` | That credential does not exist in this workspace. | Cet identifiant d’accès n’existe pas dans cet espace de travail. |  |  |
| `err.forbidden` | Your role cannot do this. | Votre rôle ne permet pas cette action. |  |  |
| `err.notFound` | This app was not found. | Cette application est introuvable. |  |  |
| `err.notLinked` | This app is not linked to an Apple Ads account. Link it first. | Cette application n’est pas liée à un compte Apple Ads. Liez-la d’abord. |  |  |
| `err.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads concerne les applications de l’App Store. Cette application n’en est pas une. |  |  |
| `err.rateLimited` | Too many requests. Try again in a minute. | Trop de requêtes. Réessayez dans une minute. |  |  |
| `link.account` | Ad account | Compte publicitaire |  |  |
| `link.accountHint` | Only accounts the key can read are listed. Loading them asks Apple Ads once. | Seuls les comptes que la clé peut lire sont listés. Les charger interroge Apple Ads une fois. |  |  |
| `link.adamHint` | The number after id in the App Store address of the app. Kiln uses the store id of the record when you leave it empty. | Le nombre après id dans l’adresse App Store de l’application. Kiln utilise l’identifiant de store de la fiche si vous le laissez vide. |  |  |
| `link.adamId` | Apple id of the app | Identifiant Apple de l’application |  |  |
| `link.adamInvalid` | Use only digits: 5 to 15 of them. | Utilisez uniquement des chiffres : de 5 à 15. |  |  |
| `link.adamPlaceholder` | For example 1234567890 | Par exemple 1234567890 |  |  |
| `link.askAdmin` | Ask an admin to link this app to an Apple Ads account. | Demandez à un administrateur de lier cette application à un compte Apple Ads. |  |  |
| `link.badgeLinked` | Linked | Liée |  |  |
| `link.badgeNeedsCredential` | Needs a credential | Identifiant d’accès requis |  |  |
| `link.checked` | Checked {{when}}. | Vérifié {{when}}. |  |  |
| `link.chooseAccount` | Choose an ad account | Choisissez un compte publicitaire |  |  |
| `link.chooseCredential` | Choose a credential | Choisissez un identifiant d’accès |  |  |
| `link.credential` | Apple Ads credential | Identifiant d’accès Apple Ads |  |  |
| `link.credentialDeleted` | The credential of this link was deleted. Choose another. | L’identifiant d’accès de ce lien a été supprimé. Choisissez-en un autre. |  |  |
| `link.credentialsHint` | Add an Apple Ads API user key under <link>Credentials</link> first. It only needs read access. | Ajoutez d’abord une clé d’utilisateur de l’API Apple Ads sous <link>Identifiants d’accès</link>. Un accès en lecture suffit. |  |  |
| `link.currency` | Currency | Devise |  |  |
| `link.linkAccount` | Link ad account | Lier le compte publicitaire |  |  |
| `link.linked` | Linked to {{account}}. | Liée à {{account}}. |  |  |
| `link.loadAccounts` | Load ad accounts | Charger les comptes publicitaires |  |  |
| `link.loadFirst` | Load the ad accounts first | Chargez d’abord les comptes publicitaires |  |  |
| `link.noAccounts` | This key sees no ad account. Invite its API user to the account in Apple Ads. | Cette clé ne voit aucun compte publicitaire. Invitez son utilisateur d’API sur le compte dans Apple Ads. |  |  |
| `link.notLinked` | This app is not linked to an Apple Ads account. | Cette application n’est pas liée à un compte Apple Ads. |  |  |
| `link.readOnly` | Read only: Kiln reads reports and never changes a campaign, a budget or a bid. | Lecture seule : Kiln lit des rapports et ne modifie jamais une campagne, un budget ni une enchère. |  |  |
| `link.remove` | Remove link | Retirer le lien |  |  |
| `link.removed` | The link was removed. The stored reports of this app were kept until they age out. | Le lien a été retiré. Les rapports enregistrés de cette application sont conservés jusqu’à leur expiration. |  |  |
| `link.saveChanges` | Save changes | Enregistrer les modifications |  |  |
| `noApple` | Apple Ads is for App Store apps. This app has no App Store record. | Apple Ads concerne les applications de l’App Store. Cette application n’a pas de fiche App Store. |  |  |
| `overview.compare` | Compared with {{from}} to {{to}}. | Comparé au {{from}} au {{to}}. |  |  |
| `overview.coverage` | Days with data: {{days}}. Campaigns: {{campaigns}}. Amounts in {{currency}}. | Jours avec des données : {{days}}. Campagnes : {{campaigns}}. Montants en {{currency}}. |  |  |
| `overview.daily` | Per day | Par jour |  |  |
| `overview.dailyAria` | {{metric}} per day over {{days}} days | {{metric}} par jour sur {{days}} jours |  |  |
| `overview.dailyOf` | Show | Afficher |  |  |
| `overview.deltaAria` | Before: {{previous}} | Avant : {{previous}} |  |  |
| `overview.empty` | No Apple Ads data from {{from}} to {{to}}. Press Sync to read it, or choose another range. | Aucune donnée Apple Ads du {{from}} au {{to}}. Appuyez sur Synchroniser pour la lire, ou choisissez une autre période. |  |  |
| `overview.noCompare` | Nothing to compare with | Rien à comparer |  |  |
| `overview.table` | Show the days as a table | Afficher les jours sous forme de tableau |  |  |
| `overview.totals` | Totals of the range | Totaux de la période |  |  |
| `pick` | App Store record | Fiche App Store |  |  |
| `rail.account` | Account | Compte |  |  |
| `rail.campaigns` | Campaigns | Campagnes |  |  |
| `rail.keywords` | Keywords | Mots-clés |  |  |
| `rail.label` | Apple Ads sections | Sections d’Apple Ads |  |  |
| `rail.overview` | Overview | Vue d’ensemble |  |  |
| `rail.terms` | Search terms | Termes de recherche |  |  |
| `rangeClamped` | Apple Ads is read one year at a time: the last year of this range is shown. | Apple Ads se lit un an à la fois : la dernière année de cette période est affichée. |  |  |
| `settings.description` | Which Apple Ads ad account reports on this app. Read only: nothing is changed in Apple Ads. | Quel compte publicitaire Apple Ads rend compte de cette application. Lecture seule : rien n’est modifié dans Apple Ads. |  |  |
| `settings.platformLabel` | Apple Ads of the {{platform}} record | Apple Ads de la fiche {{platform}} |  |  |
| `setup.lead` | Link an Apple Ads account to see what your campaigns spent and which search terms led to taps and installs. Kiln only reads reports. | Liez un compte Apple Ads pour voir ce que vos campagnes ont dépensé et quels termes de recherche ont mené à des appuis et des installations. Kiln ne fait que lire des rapports. |  |  |
| `setup.needsCredential` | No Apple Ads credential exists yet. Add one under Credentials: the guide there explains the key. | Aucun identifiant d’accès Apple Ads n’existe encore. Ajoutez-en un sous Identifiants d’accès : le guide y explique la clé. |  |  |
| `setup.step1` | In Apple Ads, create an API user with a read-only role and a key pair, and save the public key. | Dans Apple Ads, créez un utilisateur d’API avec un rôle en lecture seule et une paire de clés, puis enregistrez la clé publique. |  |  |
| `setup.step2` | Add the private key and its ids under Credentials, as an Apple Ads API user key. | Ajoutez la clé privée et ses identifiants sous Identifiants d’accès, comme clé d’utilisateur de l’API Apple Ads. |  |  |
| `setup.step3` | Choose the credential and the ad account below, then press Link ad account. | Choisissez l’identifiant d’accès et le compte publicitaire ci-dessous, puis appuyez sur Lier le compte publicitaire. |  |  |
| `setup.title` | Link Apple Ads | Lier Apple Ads |  |  |
| `terms.col.keyword` | Keyword | Mot-clé |  |  |
| `terms.col.term` | Search term | Terme de recherche |  |  |
| `terms.count_one` | {{count}} row | {{count}} ligne |  |  |
| `terms.count_other` | {{count}} rows | {{count}} lignes |  |  |
| `terms.empty` | No search term in this range. Apple hides terms with very few impressions, so a small campaign may show none. | Aucun terme de recherche sur cette période. Apple masque les termes très peu affichés : une petite campagne peut n’en montrer aucun. |  |  |
| `terms.emptyKeywords` | No keyword has data in this range. | Aucun mot-clé n’a de données sur cette période. |  |  |
| `terms.filter` | Filter the list | Filtrer la liste |  |  |
| `terms.hiddenNote` | Apple hides search terms with very few impressions, so this is not every search. | Apple masque les termes de recherche très peu affichés : ce n’est donc pas chaque recherche. |  |  |
| `terms.isTracked` | Tracked | Suivi |  |  |
| `terms.matched` | Matched your keyword: {{keyword}} | Correspond à votre mot-clé : {{keyword}} |  |  |
| `terms.next` | Next | Suivant |  |  |
| `terms.noMatch` | Nothing matches that filter. | Rien ne correspond à ce filtre. |  |  |
| `terms.prev` | Previous | Précédent |  |  |
| `terms.range` | {{from}} to {{to}} of {{total}} | {{from}} à {{to}} sur {{total}} |  |  |
| `terms.track` | Track keyword | Suivre le mot-clé |  | track = piste (Play) / suivre (keyword) |
| `terms.tracked` | {{term}} is now a tracked keyword. | {{term}} est maintenant un mot-clé suivi. |  |  |
| `warn.capCampaigns` | Only the campaigns with the most impressions were read. | Seules les campagnes ayant le plus d’impressions ont été lues. |  |  |
| `warn.currencyMismatch` | Some days were left out because they were not in the currency of the ad account. | Certains jours ont été écartés car ils n’étaient pas dans la devise du compte publicitaire. |  |  |
| `warn.noCampaign` | No campaign promotes this app. Check the Apple id of the app. | Aucune campagne ne promeut cette application. Vérifiez l’identifiant Apple de l’application. |  |  |
| `warn.popularityFailed` | Apple’s own popularity could not be read this time. The rest was read. | La popularité propre à Apple n’a pas pu être lue cette fois. Le reste a été lu. |  |  |
| `warn.popularityPartial` | Apple’s own popularity was read for some of your keywords only. | La popularité propre à Apple n’a été lue que pour certains de vos mots-clés. |  |  |
| `warn.readCut` | A read was cut short to stay within limits. Press Sync again later. | Une lecture a été interrompue pour respecter les limites. Appuyez de nouveau sur Synchroniser plus tard. |  |  |
| `warn.unknown` | The last read reported something this version does not know. | La dernière lecture a signalé quelque chose que cette version ne connaît pas. |  |  |

## web/ai (10)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `insight.changesSince` | Since the last summary: | Depuis le dernier résumé : |  |  |
| `insight.generatedFrom_one` | Generated {{time}} from {{count}} review. | Généré {{time}} à partir de {{count}} avis. |  | review: avis (user) vs examen (App Review) |
| `insight.generatedFrom_other` | Generated {{time}} from {{count}} reviews. | Généré {{time}} à partir de {{count}} avis. |  | review: avis (user) vs examen (App Review) |
| `insight.madeWith` | {{provider}}, {{model}}, {{tokens}} tokens | {{provider}}, {{model}}, {{tokens}} jetons |  |  |
| `insight.shareTitle` | Counted from the reviews that were read, which include some extra low-rated ones: an approximate share, not a share of all reviews. | Compté sur les avis lus, qui incluent quelques avis mal notés en plus : une part approximative, pas une part de tous les avis. |  | review: avis (user) vs examen (App Review) |
| `insight.themeShare` | about {{percent}} of the reviews read | environ {{percent}} des avis lus |  | review: avis (user) vs examen (App Review) |
| `insight.trend` | Average rating: {{earlier}} in the first half of the period, {{recent}} in the second half ({{direction}}). | Note moyenne : {{earlier}} dans la première moitié de la période, {{recent}} dans la seconde ({{direction}}). |  | rating = note |
| `insight.trendDown` | falling | en baisse |  |  |
| `insight.trendFlat` | steady | stable |  |  |
| `insight.trendUp` | rising | en hausse |  |  |

## web/analytics (78)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `bucketField.empty` | Enter the bucket of this app, or switch back to the workspace default. | Saisissez le bucket de cette app, ou revenez au bucket de l'espace de travail. |  |  |
| `bucketField.invalid` | That is not a Play reports bucket. Paste pubsite_prod_rev_ followed by digits, a gs:// address or a Cloud Storage link. | Ce n'est pas un bucket de rapports Play. Collez pubsite_prod_rev_ suivi de chiffres, une adresse gs:// ou un lien Cloud Storage. |  |  |
| `bucketField.normalized` | Will be saved as {{bucket}}. | Sera enregistré sous {{bucket}}. |  |  |
| `error.bucketForbidden` | Google refused the service account the Cloud Storage bucket of the Play Console reports (403). Either the bucket belongs to another Play developer account than this app, or the service account was not invited in Play Console with "View app information and download bulk reports (read-only)". Check the bucket id, then the invitation. | Google a refusé au compte de service le bucket Cloud Storage des rapports Play Console (403). Soit le bucket appartient à un autre compte développeur Play que cette app, soit le compte de service n’a pas été invité dans Play Console avec « Afficher les informations sur l’application et télécharger les rapports groupés (lecture seule) ». Vérifiez l’identifiant du bucket, puis l’invitation. |  |  |
| `error.bucketNotFound` | Google Cloud Storage has no bucket with this id. Copy it again from Play Console, Download reports, Statistics, Copy Cloud Storage URI: it is pubsite_prod_rev_ followed by your developer account number. | Google Cloud Storage ne connaît aucun bucket avec cet identifiant. Copiez-le à nouveau depuis Play Console, Télécharger les rapports, Statistiques, Copier l’URI Cloud Storage : c’est pubsite_prod_rev_ suivi du numéro de votre compte développeur. |  |  |
| `error.playSalesForbidden` | Google refused the service account the financial reports (sales, earnings, subscription statistics) while the statistics of the same bucket can be read. In Play Console, Users and permissions, the service account needs "View financial data, orders and cancellation survey responses" set to Global (all apps), not for one app only. A new permission can take 24 to 48 hours to apply. | Google a refusé au compte de service les rapports financiers (ventes, revenus, statistiques d’abonnements) alors que les statistiques du même bucket sont lisibles. Dans Play Console, Utilisateurs et autorisations, le compte de service doit avoir « Afficher les données financières, les commandes et les réponses aux enquêtes d’annulation » au niveau global (toutes les apps), pas pour une seule app. Une nouvelle autorisation peut mettre 24 à 48 heures à s’appliquer. |  |  |
| `error.salesForbidden` | Apple refused the API key the Sales and Trends reports (HTTP 403). The key needs the role Sales, Finance, Admin or Account Holder (roles without access to sales, such as Developer or Marketing, are refused), and the vendor number must belong to the same team as the key. Check both in App Store Connect, then test access again. | Apple a refusé à la clé d’API les rapports Ventes et tendances (HTTP 403). La clé doit avoir le rôle Ventes, Finances, Admin ou Titulaire du compte (les rôles sans accès aux ventes, comme Développeur ou Marketing, sont refusés), et le numéro de fournisseur doit appartenir à la même équipe que la clé. Vérifiez les deux dans App Store Connect, puis testez à nouveau l’accès. |  |  |
| `error.storeRejected` | The store refused the request (this is not an outage). Check the credential, the vendor number and the bucket id of the data sources, then test access. | La boutique a refusé la requête (ce n’est pas une panne). Vérifiez l’identifiant de connexion, le numéro de fournisseur et l’identifiant du bucket des sources de données, puis testez l’accès. |  |  |
| `guide.account` | Invite this address | Invitez cette adresse |  |  |
| `guide.accountUnknown` | The client_email in the JSON key of this service account | Le client_email de la clé JSON de ce compte de service |  |  |
| `guide.bucket.cause` | Google refused the service account the bucket of the Play Console reports. Either this bucket belongs to another Play developer account than this app, or the service account was not invited in the Play Console of this account. | Google a refusé au compte de service le bucket des rapports Play Console. Soit ce bucket appartient à un autre compte développeur Play que cette app, soit le compte de service n’a pas été invité dans la Play Console de ce compte. |  |  |
| `guide.bucket.step1` | In Play Console, open Users and permissions of the Play account that owns this app and invite the address below. | Dans Play Console, ouvrez Utilisateurs et autorisations du compte Play propriétaire de cette app et invitez l’adresse ci-dessous. |  |  |
| `guide.bucket.step2` | Give it the account permission “View app information and download bulk reports (read-only)”. | Donnez-lui l’autorisation de compte « Afficher les informations sur l’application et télécharger les rapports groupés (lecture seule) ». |  |  |
| `guide.bucket.step3` | Still refused? Open the bucket in Google Cloud. If you can see its permissions, the service account must be listed with Storage Object Viewer. Google manages this bucket for most accounts, so the invitation above is normally enough. | Toujours refusé ? Ouvrez le bucket dans Google Cloud. Si vous voyez ses autorisations, le compte de service doit y figurer avec Storage Object Viewer. Google gère ce bucket pour la plupart des comptes, l’invitation ci-dessus suffit donc normalement. |  |  |
| `guide.bucket.step4` | Wait: a new permission can take 24 to 48 hours to apply. Then press Test access. | Patientez : une nouvelle autorisation peut mettre 24 à 48 heures à s’appliquer. Puis appuyez sur Tester l’accès. |  |  |
| `guide.bucketId.cause` | Copy the Cloud Storage URI from Play Console, Download reports, Statistics, and set it for the Play account that owns this app. | Copiez l’URI Cloud Storage depuis Play Console, Télécharger les rapports, Statistiques, et indiquez-la pour le compte Play propriétaire de cette app. |  |  |
| `guide.finance.cause` | Google lets the service account read the statistics but refuses the financial reports (sales, earnings, subscriptions). The missing piece is a Play Console permission, not Cloud Storage. | Google laisse le compte de service lire les statistiques mais refuse les rapports financiers (ventes, revenus, abonnements). Ce qui manque est une autorisation Play Console, pas Cloud Storage. |  |  |
| `guide.finance.step1` | In Play Console, open Users and permissions, then the service account with the address below. | Dans Play Console, ouvrez Utilisateurs et autorisations, puis le compte de service dont l’adresse est ci-dessous. |  |  |
| `guide.finance.step2` | Under Account permissions, tick “View financial data, orders and cancellation survey responses”. It must apply to the whole account (Global, all apps), not to one app. | Sous Autorisations du compte, cochez « Afficher les données financières, les commandes et les réponses aux enquêtes d’annulation ». Elle doit s’appliquer à tout le compte (global, toutes les apps), pas à une seule app. |  |  |
| `guide.finance.step3` | Save, wait up to 24 to 48 hours, then press Test access. | Enregistrez, patientez 24 à 48 heures au plus, puis appuyez sur Tester l’accès. |  |  |
| `guide.heading` | How to fix this | Comment corriger |  |  |
| `guide.link.bucket` | Open the bucket permissions | Ouvrir les autorisations du bucket |  |  |
| `guide.link.playConsole` | Open Play Console | Ouvrir Play Console |  |  |
| `guide.link.usersAndAccess` | Open Users and Access | Ouvrir Utilisateurs et accès |  |  |
| `guide.link.usersAndPermissions` | Open Users and permissions | Ouvrir Utilisateurs et autorisations |  |  |
| `guide.link.vendor` | Open Payments and Financial Reports | Ouvrir Paiements et rapports financiers |  |  |
| `guide.opensNew` | (opens in a new tab) | (s’ouvre dans un nouvel onglet) |  |  |
| `guide.otherAccount` | This app reads the bucket set for the whole workspace, and the workspace has several Play accounts. That bucket is probably the one of another account: set the bucket of this app’s own account below. | Cette app lit le bucket défini pour tout l’espace de travail, qui contient plusieurs comptes Play. Ce bucket est probablement celui d’un autre compte : indiquez ci-dessous le bucket du compte de cette app. |  |  |
| `guide.role.cause` | Apple refused the API key the Sales and Trends reports (403). Two things cause this: the role of the key, or a vendor number that belongs to another Apple team. | Apple a refusé à la clé d’API les rapports Ventes et tendances (403). Deux causes possibles : le rôle de la clé, ou un numéro de fournisseur d’une autre équipe Apple. |  |  |
| `guide.role.step1` | In App Store Connect, Users and Access, Integrations: the key needs the role Sales, Finance, Admin or Account Holder. Roles without access to sales, such as Developer or Marketing, are refused. Create a key with the right role and replace it under Credentials. | Dans App Store Connect, Utilisateurs et accès, Intégrations : la clé doit avoir le rôle Ventes, Finances, Admin ou Titulaire du compte. Les rôles sans accès aux ventes, comme Développeur ou Marketing, sont refusés. Créez une clé avec le bon rôle et remplacez-la dans Identifiants. |  |  |
| `guide.role.step2` | Check that the vendor number below is the one of the same team as the key. | Vérifiez que le numéro de fournisseur ci-dessous est celui de la même équipe que la clé. |  |  |
| `guide.testAccess` | Test access | Tester l’accès |  |  |
| `guide.testNoReport` | Access works. The store has no file for the period asked yet, which is normal for a new app or a new month. | L’accès fonctionne. La boutique n’a pas encore de fichier pour la période demandée, ce qui est normal pour une nouvelle app ou un nouveau mois. |  |  |
| `guide.testOk` | Access works. Nothing is missing for this source. | L’accès fonctionne. Il ne manque rien pour cette source. |  |  |
| `guide.testing` | Testing… | Test en cours… |  |  |
| `guide.vendor.causeInvalid` | Apple does not accept this vendor number. Check it against App Store Connect. | Apple n’accepte pas ce numéro de fournisseur. Comparez-le avec App Store Connect. |  |  |
| `guide.vendor.causeMissing` | Sales and Trends and the subscription reports need the vendor number of your Apple team. | Ventes et tendances et les rapports d’abonnements ont besoin du numéro de fournisseur de votre équipe Apple. |  |  |
| `guide.vendor.hint` | Digits only, 5 to 12. | Chiffres uniquement, 5 à 12. |  |  |
| `guide.vendor.invalid` | Enter digits only, 5 to 12 of them. | Saisissez uniquement des chiffres, de 5 à 12. |  |  |
| `guide.vendor.label` | Vendor number | Numéro de fournisseur |  |  |
| `guide.vendor.saved` | Vendor number saved. | Numéro de fournisseur enregistré. |  |  |
| `guide.vendor.step1` | Open Payments and Financial Reports in App Store Connect. The vendor number is shown at the top left, next to the team name (about 8 digits). | Ouvrez Paiements et rapports financiers dans App Store Connect. Le numéro de fournisseur s’affiche en haut à gauche, à côté du nom de l’équipe (environ 8 chiffres). |  |  |
| `guide.vendor.step2` | Enter it here. It is kept for this Apple team, so apps of another team can have their own number. | Saisissez-le ici. Il est conservé pour cette équipe Apple, les apps d’une autre équipe peuvent donc avoir leur propre numéro. |  |  |
| `guide.vendor.usingWorkspace` | Now using the workspace default. Saving a number here keeps it for this Apple team only. | Le numéro par défaut de l’espace de travail est utilisé. Enregistrer un numéro ici le garde pour cette équipe Apple seulement. |  |  |
| `metric.anrRatePerceived` | User-perceived ANR rate | Taux d’ANR perçu par les utilisateurs |  |  |
| `metric.anrUsers` | Users behind the ANR rate | Utilisateurs derrière le taux d’ANR |  |  |
| `metric.crashRatePerceived` | User-perceived crash rate | Taux de plantage perçu par les utilisateurs |  |  |
| `metric.crashUsers` | Users behind the crash rate | Utilisateurs derrière le taux de plantage |  |  |
| `overview.empty.error` | No {{platform}} numbers: they could not be read. | Pas de chiffres {{platform}} : ils n'ont pas pu être lus. |  |  |
| `overview.empty.loading` | Reading {{platform}} data… | Lecture des données {{platform}}… |  |  |
| `overview.empty.never` | No {{platform}} data yet. Nothing has been read: use Sync in the header, or check the data sources. | Pas encore de données {{platform}}. Rien n'a été lu : utilisez Synchroniser en haut de page ou vérifiez les sources de données. |  |  |
| `overview.empty.off` | No {{platform}} data yet. Analytics is off, so nothing is read. | Pas encore de données {{platform}}. Les statistiques sont désactivées, rien n'est lu. |  |  |
| `overview.measure` | Measure | Mesure |  |  |
| `overview.noValue` | No data | Pas de données |  |  |
| `overview.openSources` | Open Data sources | Ouvrir les sources de données |  |  |
| `rail.acquisition` | Acquisition | Acquisition |  |  |
| `rail.groupMore` | More | Plus |  |  |
| `rail.groupNumbers` | Numbers | Chiffres |  |  |
| `rail.label` | Sections of Insights | Sections d’Insights |  |  |
| `rail.next` | Next steps | Prochaines étapes |  |  |
| `rail.nothingStored` | Nothing stored for this yet. See Data sources. | Rien n’est encore enregistré ici. Voir Sources de données. |  |  |
| `rail.overview` | Overview | Vue d’ensemble |  |  |
| `rail.quality` | Quality | Qualité |  |  |
| `rail.revenue` | Revenue | Revenus |  |  |
| `rail.sources` | Data sources | Sources de données |  |  |
| `rail.sourcesFailed_one` | {{count}} source could not be read | {{count}} source n’a pas pu être lue |  |  |
| `rail.sourcesFailed_other` | {{count}} sources could not be read | {{count}} sources n’ont pas pu être lues |  |  |
| `revenue.openProducts` | Products and sync | Produits et synchronisation |  |  |
| `revenue.title` | Revenue | Revenus |  |  |
| `revenue.waiting` | The RevenueCat figures are not read yet. Open Products and choose “Sync products” to read them. | Les chiffres de RevenueCat ne sont pas encore lus. Ouvrez Produits et choisissez « Synchroniser les produits » pour les lire. |  |  |
| `setup.bucketForbidden` | Google refuses the service account the Play Console reports bucket. See the steps below. | Google refuse au compte de service le bucket des rapports Play Console. Voir les étapes ci-dessous. |  |  |
| `setup.bucketNotFound` | Google Cloud Storage has no bucket with this id. Set the bucket of this app’s Play account. | Google Cloud Storage n’a aucun bucket avec cet identifiant. Indiquez le bucket du compte Play de cette app. |  |  |
| `setup.packageNotInBucket` | This bucket can be read but holds no report of this app: it is probably the bucket of another Play account. Set the bucket of the account that owns this app. | Ce bucket est lisible mais ne contient aucun rapport de cette app : c’est probablement le bucket d’un autre compte Play. Indiquez le bucket du compte propriétaire de cette app. |  |  |
| `setup.playSalesForbidden` | Google reads the statistics but refuses the financial reports (sales, earnings, subscriptions). One Play Console permission is missing. See the steps below. | Google lit les statistiques mais refuse les rapports financiers (ventes, revenus, abonnements). Il manque une autorisation Play Console. Voir les étapes ci-dessous. |  |  |
| `setup.salesForbidden` | Apple refuses the key the Sales and Trends reports. Its role or the vendor number is wrong. See the steps below. | Apple refuse à la clé les rapports Ventes et tendances. Son rôle ou le numéro de fournisseur est incorrect. Voir les étapes ci-dessous. |  |  |
| `setup.vendorNumberInvalid` | Apple does not accept this vendor number. It must be the one of the same Apple team as this app’s key. | Apple n’accepte pas ce numéro de fournisseur. Ce doit être celui de la même équipe Apple que la clé de cette app. |  |  |
| `setup.vendorNumberMissing` | Optional: enter the Apple vendor number of this app’s team to read daily units and proceeds, also by product, and subscription counts. | Facultatif : saisissez le numéro de fournisseur Apple de l’équipe de cette app pour lire les unités et revenus quotidiens, aussi par produit, et le nombre d’abonnements. |  |  |
| `sources.retryStillFailed` | {{source}} could not be read again. The reason is in the list. | {{source}} n'a pas pu être relu. La raison figure dans la liste. |  |  |

## web/app (211)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `builds.group.automation` | Automation | Automatisation |  |  |
| `builds.navLabel` | Sections of Builds | Sections de Builds |  |  |
| `builds.section.config` | EAS configuration | Configuration EAS |  |  |
| `builds.section.submissions` | EAS submissions | Soumissions EAS |  | submit: soumettre vs envoyer |
| `builds.section.tests` | Test builds | Builds de test |  |  |
| `builds.section.updates` | EAS updates | Mises à jour EAS |  |  |
| `builds.section.workflows` | Workflows | Workflows |  |  |
| `cart.added` | Added to pending changes | Ajouté aux modifications en attente |  | cart = "Modifications en attente" |
| `cart.bundleNote` | Staged changes are sent to the store together as one draft, so selecting one selects them all. | Les modifications préparées partent ensemble vers le store, en un seul brouillon : en choisir une les choisit toutes. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `cart.confirm.approval` | You will be asked to confirm again. | Une nouvelle confirmation vous sera demandée. |  |  |
| `cart.confirm.discardBody` | This removes the draft here only. The store is not touched and nothing is sent. | Cela supprime uniquement le brouillon ici. Le store n’est pas touché et rien n’est envoyé. |  |  |
| `cart.confirm.discardGo` | Discard | Abandonner |  |  |
| `cart.confirm.discardTitle_one` | Discard {{count}} item? | Abandonner {{count}} élément ? |  |  |
| `cart.confirm.discardTitle_other` | Discard {{count}} items? | Abandonner {{count}} éléments ? |  |  |
| `cart.confirm.drafts_one` | {{count}} staged change will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} modification préparée sera écrite dans {{stores}} comme brouillon. Rien n’est envoyé en revue. |  | stage = prepare locally, nothing is sent: see staged glossary row; review: avis (user) vs examen (App Review) |
| `cart.confirm.drafts_other` | {{count}} staged changes will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} modifications préparées seront écrites dans {{stores}} comme brouillon. Rien n’est envoyé en revue. |  | stage = prepare locally, nothing is sent: see staged glossary row; review: avis (user) vs examen (App Review) |
| `cart.confirm.go` | Publish | Publier |  |  |
| `cart.confirm.pricesDelay` | Stores can take a while to show a new price everywhere. If an answer is lost, Kiln reads the store back instead of sending again. | Les stores peuvent mettre du temps à afficher un nouveau prix partout. Si une réponse se perd, Kiln relit le store au lieu de renvoyer. |  |  |
| `cart.confirm.prices_one` | {{count}} price change goes live in the store. It changes what customers pay. | {{count}} changement de prix sera appliqué dans le store. Il modifie ce que paient les clients. |  | live = en ligne |
| `cart.confirm.prices_other` | {{count}} price changes go live in the store. They change what customers pay. | {{count}} changements de prix seront appliqués dans le store. Ils modifient ce que paient les clients. |  | live = en ligne |
| `cart.confirm.publishTitle_one` | Publish {{count}} item? | Publier {{count}} élément ? |  |  |
| `cart.confirm.publishTitle_other` | Publish {{count}} items? | Publier {{count}} éléments ? |  |  |
| `cart.confirm.replies_one` | {{count}} reply will be public on {{stores}} right away. | {{count}} réponse sera publique sur {{stores}} immédiatement. |  |  |
| `cart.confirm.replies_other` | {{count}} replies will be public on {{stores}} right away. | {{count}} réponses seront publiques sur {{stores}} immédiatement. |  |  |
| `cart.confirm.type` | To confirm, type | Pour confirmer, saisissez |  |  |
| `cart.confirm.typeFor` | For {{platform}}, type | Pour {{platform}}, saisissez |  |  |
| `cart.countAnnounce_one` | {{count}} pending change | {{count}} modification en attente |  |  |
| `cart.countAnnounce_other` | {{count}} pending changes | {{count}} modifications en attente |  | cart = "Modifications en attente" |
| `cart.diffNew` | New: {{after}} | Nouveau : {{after}} |  |  |
| `cart.discard` | Discard selected | Abandonner la sélection |  |  |
| `cart.dryRun.button` | Check prices with the store (dry run) | Vérifier les prix avec le store (simulation) |  |  |
| `cart.dryRun.error` | Could not check | Vérification impossible |  |  |
| `cart.dryRun.noStoreCheck` | This store has no check of its own. These requests would be sent: | Ce store n'a pas de vérification propre. Ces requêtes seraient envoyées : |  |  |
| `cart.dryRun.note` | Kiln read the store and checked each change. Nothing was sent. | Kiln a lu le store et vérifié chaque changement. Rien n'a été envoyé. |  |  |
| `cart.dryRun.refused` | Would be refused | Serait refusé |  |  |
| `cart.dryRun.storeChecked` | The store's own check accepted it. | La vérification du store l'a acceptée. |  |  |
| `cart.dryRun.switchOff` | Sending is switched off: this check works, but a send would be refused. | L'envoi est désactivé : cette vérification fonctionne, mais un envoi serait refusé. |  |  |
| `cart.dryRun.title` | Dry run of the price changes | Simulation des changements de prix |  |  |
| `cart.dryRun.wouldSend` | Would be sent | Serait envoyé |  |  |
| `cart.empty` | Nothing is waiting. Changes you stage and replies you draft appear here. | Rien n’est en attente. Les modifications préparées et les réponses rédigées apparaissent ici. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `cart.fabLabel` | Pending | En attente |  |  |
| `cart.files_one` | {{count}} file | {{count}} fichier |  |  |
| `cart.files_other` | {{count}} files | {{count}} fichiers |  |  |
| `cart.fixFirst` | Fix this first: {{message}} | À corriger d’abord : {{message}} |  |  |
| `cart.graphicsDiff` | {{before}} → {{after}} images | {{before}} → {{after}} images |  |  |
| `cart.group.graphics` | Graphics | Visuels |  |  |
| `cart.group.listing` | Store listing | Fiche du store |  | listing = fiche |
| `cart.group.price` | Price changes | Changements de prix |  |  |
| `cart.group.release` | Release details | Détails de la version |  | release = publication |
| `cart.group.reviewReply` | Review replies | Réponses aux avis |  | review: avis (user) vs examen (App Review) |
| `cart.intro` | Nothing is published until you review it here and send it. | Rien n’est publié tant que vous ne l’avez pas relu ici et envoyé. |  | review: avis (user) vs examen (App Review) |
| `cart.loadFailed` | Could not load the pending changes. | Impossible de charger les modifications en attente. |  | cart = "Modifications en attente" |
| `cart.open` | Open | Ouvrir |  |  |
| `cart.openAria_one` | Open pending changes: {{count}} item waiting | Ouvrir les modifications en attente : {{count}} élément |  | cart = "Modifications en attente" |
| `cart.openAria_other` | Open pending changes: {{count}} items waiting | Ouvrir les modifications en attente : {{count}} éléments |  | cart = "Modifications en attente" |
| `cart.openRow` | Open {{title}} where it was made | Ouvrir {{title}} là où il a été créé |  |  |
| `cart.price.acks` | Confirmed: | Confirmé : |  |  |
| `cart.price.asap` | As soon as the store allows | Dès que le store le permet |  |  |
| `cart.price.caption` | Price changes of {{id}} | Changements de prix de {{id}} |  |  |
| `cart.price.colChange` | Price | Prix |  |  |
| `cart.price.colPercent` | Change | Variation |  |  |
| `cart.price.confirmed` | Confirmed by the store | Confirmé par le store |  |  |
| `cart.price.from` | From {{date}} | À partir du {{date}} |  |  |
| `cart.price.lineFailed` | {{territory}}: {{amount}} {{outcome}} | {{territory}} : {{amount}} {{outcome}} |  |  |
| `cart.price.lineRefused` | was not changed | n'a pas été modifié |  |  |
| `cart.price.lineUnknown` | may not have reached the store | a peut-être n'a pas atteint le store |  |  |
| `cart.price.noPrice` | no price | aucun prix |  |  |
| `cart.price.notSent` | Nothing was sent. | Rien n'a été envoyé. |  |  |
| `cart.price.perCurrency` | {{currency}}: {{up}} up, {{down}} down | {{currency}} : {{up}} en hausse, {{down}} en baisse |  |  |
| `cart.price.storeShows` | Store shows {{actual}} for {{territory}}, not {{expected}}. | Le store affiche {{actual}} pour {{territory}}, pas {{expected}}. |  |  |
| `cart.price.storeShowsOther` | The store shows other prices than the ones asked. | Le store affiche d'autres prix que ceux demandés. |  |  |
| `cart.price.summary_one` | Price change in {{count}} territory. | Changement de prix dans {{count}} territoire. |  |  |
| `cart.price.summary_other` | Price change in {{count}} territories. | Changement de prix dans {{count}} territoires. |  |  |
| `cart.price.territories_one` | Show {{count}} territory | Afficher {{count}} territoire |  |  |
| `cart.price.territories_other` | Show {{count}} territories | Afficher {{count}} territoires |  |  |
| `cart.price.unverified` | Not verified: the store's prices could not be read back. | Non vérifié : les prix du store n'ont pas pu être relus. |  |  |
| `cart.publishPage` | Open the full publish page | Ouvrir la page de publication complète |  |  |
| `cart.publishPageHint` | Submitting, releasing and rollout steps are done there. | L’envoi à l’examen, la sortie et le déploiement progressif s’y font. |  | rollout = déploiement; submit: soumettre vs envoyer |
| `cart.publish_one` | Publish {{count}} selected | Publier {{count}} sélectionné |  |  |
| `cart.publish_other` | Publish {{count}} selected | Publier {{count}} sélectionnés |  |  |
| `cart.reason.bundleBlocked` | Another staged change has an error, and they are sent together. | Une autre modification préparée contient une erreur, et elles partent ensemble. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `cart.reason.inProgress` | A send is already running. | Un envoi est déjà en cours. |  |  |
| `cart.reason.invalid` | This change has an error and cannot be sent yet. | Cette modification contient une erreur et ne peut pas encore être envoyée. |  |  |
| `cart.reason.metadataLocked` | This version is live or in review, so its listing is locked. Prepare a new version first. | Cette version est en ligne ou en cours d’examen : sa fiche est verrouillée. Préparez d’abord une nouvelle version. |  | listing = fiche; review: avis (user) vs examen (App Review) |
| `cart.reason.noRight` | You do not have the right to send this. | Vous n’avez pas le droit d’envoyer ceci. |  |  |
| `cart.reason.other` | It cannot be sent right now. | Impossible de l’envoyer pour le moment. |  |  |
| `cart.reason.outcomeUnknown` | The last send did not answer. Check the store first. | Le dernier envoi n’a pas répondu. Vérifiez d’abord le store. |  |  |
| `cart.reason.switchOff` | Sending this to the store is switched off for this server. | L’envoi vers le store est désactivé sur ce serveur. |  |  |
| `cart.reason.workspaceOff` | Price changes are switched off for this workspace. | Les changements de prix sont désactivés pour cet espace de travail. |  |  |
| `cart.report.dismiss` | Dismiss | Fermer |  |  |
| `cart.report.summary` | {{ok}} done, {{failed}} failed, {{skipped}} skipped | {{ok}} faits, {{failed}} en échec, {{skipped}} ignorés |  |  |
| `cart.result.blocked` | The store check blocks this change. | La vérification du store bloque cette modification. |  |  |
| `cart.result.bundleIncomplete` | Staged changes are sent together. Select all of them. | Les modifications préparées partent ensemble. Sélectionnez-les toutes. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `cart.result.changedSinceReview` | It changed after you opened this list. Review it again. | Modifié après l’ouverture de cette liste. Relisez-le. |  | review: avis (user) vs examen (App Review) |
| `cart.result.confirmationMismatch` | The typed phrase was not the right one. Nothing was sent. | La phrase saisie n'était pas la bonne. Rien n'a été envoyé. |  |  |
| `cart.result.network` | Could not reach the server. | Impossible de joindre le serveur. |  |  |
| `cart.result.notPending` | Already sent or removed. | Déjà envoyé ou supprimé. |  |  |
| `cart.result.other` | It could not be sent. | Envoi impossible. |  |  |
| `cart.result.priceAck` | An acknowledgement is missing. | Une confirmation manque. |  |  |
| `cart.result.priceCurrency` | The currency of a territory changed in the store. Nothing was changed. | La devise d'un territoire a changé dans le store. Rien n'a été modifié. |  |  |
| `cart.result.priceInvalid` | The change has an error and was not sent. | Le changement contient une erreur et n'a pas été envoyé. |  |  |
| `cart.result.priceNotAllowed` | The store does not allow this price change now (for example, one is already scheduled). | Le store n'autorise pas ce changement de prix maintenant (par exemple, un autre est déjà programmé). |  |  |
| `cart.result.pricePartial` | Some territories were changed and some were not. See below. | Certains territoires ont été modifiés, d'autres non. Voir ci-dessous. |  |  |
| `cart.result.pricePoint` | An amount is not an Apple price point. | Un montant n'est pas un palier de prix Apple. |  |  |
| `cart.result.priceProduct` | The product no longer exists in the store. | Le produit n'existe plus dans le store. |  |  |
| `cart.result.priceRejected` | The store rejected the price change. | Le store a refusé le changement de prix. |  |  |
| `cart.result.priceStale` | The price in the store changed since you reviewed it. Nothing was changed. Sync and review again. | Le prix dans le store a changé depuis votre vérification. Rien n'a été modifié. Synchronisez et vérifiez de nouveau. |  | review: avis (user) vs examen (App Review) |
| `cart.result.priceSubscribers` | The store does not accept that choice for existing subscribers. | Le store n'accepte pas ce choix pour les abonnés existants. |  |  |
| `cart.result.priceTerritory` | The store does not support a price in one of these territories. | Le store ne prend pas en charge un prix dans l'un de ces territoires. |  |  |
| `cart.result.rateLimited` | The store asked for a pause. Nothing more was sent. Review again in a moment. | Le store a demandé une pause. Rien d'autre n'a été envoyé. Vérifiez de nouveau dans un instant. |  | review: avis (user) vs examen (App Review) |
| `cart.result.stagedInvalid` | A staged change has an error. | Une modification préparée contient une erreur. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `cart.result.stateChanged` | The store changed since it was checked. Review again. | Le store a changé depuis la vérification. Relisez. |  | review: avis (user) vs examen (App Review) |
| `cart.result.stepUpRequired` | The confirmation was not completed. | La confirmation n’a pas été terminée. |  |  |
| `cart.review` | Review | Relire |  | review: avis (user) vs examen (App Review) |
| `cart.reviewLine` | Review, {{stars}}: {{excerpt}} | Avis, {{stars}} : {{excerpt}} |  | review: avis (user) vs examen (App Review) |
| `cart.risk.financial` | Changes what customers pay | Modifie ce que paient les clients |  |  |
| `cart.risk.publicReply` | Public reply | Réponse publique |  |  |
| `cart.risk.storeDraft` | Store draft | Brouillon du store |  |  |
| `cart.selectAll` | Select all | Tout sélectionner |  |  |
| `cart.selectedCount` | {{selected}} of {{total}} selected | {{selected}} sur {{total}} sélectionnés |  |  |
| `cart.stars_one` | {{count}} star | {{count}} étoile |  |  |
| `cart.stars_other` | {{count}} stars | {{count}} étoiles |  |  |
| `cart.status.failed` | Failed | Échec |  |  |
| `cart.status.ok` | Done | Fait |  |  |
| `cart.status.running` | Sending | Envoi |  |  |
| `cart.status.skipped` | Skipped | Ignoré |  |  |
| `cart.title` | Pending changes | Modifications en attente |  | cart = "Modifications en attente" |
| `listingSettings.compareMedia` | Compare repository and store graphics | Comparer les visuels du dépôt et du store |  |  |
| `listingSettings.compareMediaHint` | Compares the screenshots and icons in the repository with the store's; the store's own graphics are listed either way. | Compare les captures et icônes du dépôt avec celles du store ; les visuels du store sont listés dans tous les cas. |  |  |
| `listingSettings.compareRepo` | Compare repository and store | Comparer le dépôt et le store |  |  |
| `listingSettings.compareRepoHint` | Shows where the repository text and the store text differ and offers to stage the repository text; leave it off if this app keeps no fastlane files. | Montre où le texte du dépôt et celui du store diffèrent et propose de préparer le texte du dépôt ; laissez-le désactivé si cette app n'a pas de fichiers fastlane. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `listingSettings.description` | Choose whether Kiln compares your repository with the store; the store page is always checked on its own. | Choisissez si Kiln compare votre dépôt avec le store ; la fiche du store est toujours vérifiée seule. |  |  |
| `listingSettings.forbidden` | Only an admin can change this setting. | Seul un admin peut modifier ce paramètre. |  |  |
| `listingSettings.notSaved` | Not saved | Non enregistré |  |  |
| `listingSettings.readOnly` | You can see these settings; an admin changes them. | Vous pouvez voir ces paramètres ; un admin les modifie. |  |  |
| `listingSettings.saveFailed` | The setting could not be saved. Try again. | Le paramètre n'a pas pu être enregistré. Réessayez. |  |  |
| `listingSettings.saved` | Listing setting saved. | Paramètre de la fiche enregistré. |  | listing = fiche |
| `nav.badgeInsights_one` | {{count}} insight to look at | {{count}} point à examiner dans les analyses |  |  |
| `nav.badgeInsights_other` | {{count}} insights to look at | {{count}} points à examiner dans les analyses |  |  |
| `nav.expandToSwitch` | {{name}}: expand the navigation to switch apps | {{name}} : déplier la navigation pour changer d’app |  |  |
| `settings.group.connections` | Connections | Connexions |  |  |
| `settings.group.danger` | Removal | Suppression |  |  |
| `settings.group.data` | Data and alerts | Données et alertes |  |  |
| `settings.group.releases` | Releases | Releases |  | release = publication |
| `settings.integrationsNone` | Nothing here applies to this app yet: no Expo project and no RevenueCat link are available for it. | Rien ne s'applique encore à cette app : aucun projet Expo ni lien RevenueCat n'est disponible. |  |  |
| `settings.navLabel` | Sections of the app settings | Sections des réglages de l'app |  |  |
| `settings.part.integrations` | Expo and RevenueCat | Expo et RevenueCat |  |  |
| `settings.part.listing` | Store listing | Fiche du store |  | listing = fiche |
| `stores.effective.bucket` | Play reports bucket | Bucket des rapports Play |  |  |
| `stores.effective.fromAccount` | from this Play account | de ce compte Play |  |  |
| `stores.effective.fromApp` | set on this app | défini sur cette app |  |  |
| `stores.effective.fromCredential` | from this credential | de cet identifiant |  |  |
| `stores.effective.fromWorkspace` | from the workspace default | par défaut de l’espace de travail |  |  |
| `stores.effective.vendorNumber` | Vendor number | Numéro de fournisseur |  |  |
| `stores.identifiers` | Identifiers | Identifiants |  |  |
| `sync.couldNotRead` | Could not read: {{what}}. | Lecture impossible : {{what}}. |  |  |
| `sync.hint.ads` | Press Sync. If it keeps failing, check the Apple Ads key under Credentials. | Appuyez sur Synchroniser. Si cela échoue toujours, vérifiez la clé Apple Ads sous Identifiants d’accès. |  |  |
| `sync.hint.analytics` | Open Insights, Data sources, and follow the next step of that source. | Ouvrez Insights, Sources de données, et suivez la prochaine étape de cette source. |  |  |
| `sync.hint.app` | Check the store credential in the app settings, then press Sync. | Vérifiez l’identifiant du store dans les réglages de l’app, puis appuyez sur Synchroniser. |  |  |
| `sync.hint.eas` | Press Sync. If it keeps failing, check the Expo access token under Credentials. | Appuyez sur Synchroniser. Si cela échoue encore, vérifiez le jeton d’accès Expo dans Identifiants. |  |  |
| `sync.hint.products` | Press Sync. Check that the store credential may read in-app products. | Appuyez sur Synchroniser. Vérifiez que l’identifiant du store peut lire les produits intégrés. |  |  |
| `sync.hint.reviews` | Press Sync. If it keeps failing, check that the store credential may read reviews. | Appuyez sur Synchroniser. Si cela échoue encore, vérifiez que l’identifiant du store peut lire les avis. |  | review: avis (user) vs examen (App Review) |
| `sync.hint.testflight` | Press Sync. Check that the App Store Connect key may read beta feedback. | Appuyez sur Synchroniser. Vérifiez que la clé App Store Connect peut lire les retours bêta. |  |  |
| `sync.kind.ads` | Apple Ads reports | Rapports Apple Ads |  |  |
| `sync.kind.analytics` | Analytics | Analytics |  |  |
| `sync.kind.app` | Store listing and releases | Fiche store et versions |  | release = publication; listing = fiche |
| `sync.kind.eas` | EAS builds and submissions | Builds et soumissions EAS |  | submit: soumettre vs envoyer |
| `sync.kind.products` | In-app products and RevenueCat | Produits intégrés et RevenueCat |  |  |
| `sync.kind.reviews` | Reviews | Avis |  | review: avis (user) vs examen (App Review) |
| `sync.kind.testflight` | TestFlight feedback | Retours TestFlight |  |  |
| `sync.lastRead` | Read {{ago}} | Lu {{ago}} |  |  |
| `sync.neverRead` | Never read | Jamais lu |  |  |
| `sync.none` | Nothing to sync yet. Connect a store in the app settings. | Rien à synchroniser pour l’instant. Connectez un store dans les réglages de l’app. |  |  |
| `sync.notReadYet` | Not read yet. Use Sync at the top of the page. | Pas encore lu. Utilisez Synchroniser en haut de la page. |  |  |
| `sync.problem` | Some sources could not be queued: {{message}} | Certaines sources n’ont pas pu être mises en file : {{message}} |  |  |
| `sync.running` | Syncing… | Synchronisation… |  |  |
| `sync.seeStatus` | See Status | Voir Statut |  |  |
| `sync.sourcesLabel` | What this app is synced from | D’où cette app est synchronisée |  |  |
| `sync.sourcesTitle` | Sources | Sources |  |  |
| `sync.state.failed` | Could not read | Lecture impossible |  |  |
| `sync.state.never` | Not read yet | Pas encore lu |  |  |
| `sync.state.ok` | Up to date | À jour |  |  |
| `sync.state.running` | Syncing | Synchronisation |  |  |
| `sync.updated` | Updated {{ago}} | Mis à jour {{ago}} |  |  |
| `syncButton.everything` | Sync everything | Tout synchroniser |  |  |
| `syncButton.label.ads` | Sync Apple Ads | Synchroniser Apple Ads |  |  |
| `syncButton.label.analytics` | Sync analytics | Synchroniser les statistiques |  |  |
| `syncButton.label.builds` | Sync builds | Synchroniser les builds |  |  |
| `syncButton.label.health` | Sync ratings and health | Synchroniser notes et santé |  | rating = note |
| `syncButton.label.listing` | Sync listing | Synchroniser la fiche |  | listing = fiche |
| `syncButton.label.products` | Sync products | Synchroniser les produits |  |  |
| `syncButton.label.reviews` | Sync reviews | Synchroniser les avis |  | review: avis (user) vs examen (App Review) |
| `syncButton.label.timeline` | Sync timeline data | Synchroniser les données de la chronologie |  |  |
| `syncButton.menuTitle` | Sync | Synchronisation |  |  |
| `syncButton.more` | More sync options | Plus d'options de synchronisation |  |  |
| `syncButton.noPage` | Nothing on this page needs a sync. Sync everything reads the rest. | Rien sur cette page ne demande de synchronisation. « Tout synchroniser » lit le reste. |  |  |
| `syncButton.none` | Nothing to sync yet. | Rien à synchroniser pour l'instant. |  |  |
| `syncButton.onlyFailed` | Only failed ({{failed}}) | Seulement les échecs ({{failed}}) |  |  |
| `syncButton.progress` | Syncing {{done}} of {{total}} | Synchronisation {{done}} sur {{total}} |  |  |
| `syncButton.retry` | Retry failed ({{failed}}) | Relancer les échecs ({{failed}}) |  |  |
| `syncButton.retrySource` | Retry | Réessayer |  |  |
| `syncButton.run` | Sync | Synchroniser |  |  |
| `syncButton.runKind` | Sync: {{kind}} | Synchroniser : {{kind}} |  |  |
| `syncButton.upToDate` | Everything on this page was read recently. This reads it again. | Tout ce que montre cette page a été lu récemment. Ceci le relit. |  |  |
| `view.ads` | Ads | Publicités |  |  |
| `view.countries` | Countries | Pays |  |  |
| `view.experiments` | Experiments | Tests |  |  |
| `view.highlights` | Highlights | À retenir |  |  |
| `view.ratings` | Ratings and health | Notes et santé |  | rating = note |
| `view.reviews` | Reviews | Avis |  | review: avis (user) vs examen (App Review) |
| `view.timeline` | Timeline and reports | Chronologie et rapports |  |  |

## web/aso (161)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `changes.category` | Category: {{from}} to {{to}} | Catégorie : {{from}} devient {{to}} |  |  |
| `changes.checkFailed` | The check failed. | La vérification a échoué. |  |  |
| `changes.checkNow` | Check now | Vérifier maintenant |  |  |
| `changes.checkedAgo` | Last checked {{ago}}. | Dernière vérification : {{ago}}. |  |  |
| `changes.checkedNone` | Checked: no new changes. | Vérifié : aucun nouveau changement. |  |  |
| `changes.checkedNotFound` | The store no longer lists this app in that country. | Le store ne propose plus cette app dans ce pays. |  |  |
| `changes.checkedRecent` | Checked a moment ago. Kiln does not read the store again within 5 minutes. | Vérifié à l’instant. Kiln ne relit pas le store avant 5 minutes. |  |  |
| `changes.checked_one` | Checked: {{count}} new change found. | Vérifié : {{count}} nouveau changement trouvé. |  |  |
| `changes.checked_other` | Checked: {{count}} new changes found. | Vérifié : {{count}} nouveaux changements trouvés. |  |  |
| `changes.description` | Description changed | Description modifiée |  |  |
| `changes.firstOnly` | Kiln saved the first look on {{date}}. Changes show from the next check on. | Kiln a enregistré le premier état le {{date}}. Les changements apparaîtront à partir de la prochaine vérification. |  |  |
| `changes.icon` | Icon changed | Icône modifiée |  |  |
| `changes.iconAlt` | Icon, {{side}} | Icône, {{side}} |  |  |
| `changes.listLabel` | Listing changes of {{name}} | Changements de la fiche de {{name}} |  | listing = fiche |
| `changes.loadFailed` | The changes could not be loaded. | Les changements n’ont pas pu être chargés. |  |  |
| `changes.name` | Name changed | Nom modifié |  |  |
| `changes.noneSince` | Checked {{ago}}, no changes since we started watching on {{date}}. | Vérifié {{ago}}, aucun changement depuis le début de la surveillance le {{date}}. |  |  |
| `changes.notChecked` | Not checked yet. Changes show from the first check on. | Pas encore vérifié. Les changements apparaîtront dès la première vérification. |  |  |
| `changes.notWatched` | Not watched: Kiln does not read Google Play pages, so changes to this listing are not tracked. | Non surveillé : Kiln ne lit pas les pages Google Play, les changements de cette fiche ne sont donc pas suivis. |  | listing = fiche |
| `changes.older` | Show older changes | Afficher les changements plus anciens |  |  |
| `changes.part.added_one` | {{count}} added | {{count}} ajoutée |  |  |
| `changes.part.added_other` | {{count}} added | {{count}} ajoutées |  |  |
| `changes.part.removed_one` | {{count}} removed | {{count}} retirée |  |  |
| `changes.part.removed_other` | {{count}} removed | {{count}} retirées |  |  |
| `changes.part.reordered` | reordered | réordonnées |  |  |
| `changes.part.replaced_one` | {{count}} replaced | {{count}} remplacée |  |  |
| `changes.part.replaced_other` | {{count}} replaced | {{count}} remplacées |  |  |
| `changes.price` | Price: {{from}} to {{to}} | Prix : {{from}} devient {{to}} |  |  |
| `changes.rating` | Average rating: {{from}} to {{to}} stars | Note moyenne : de {{from}} à {{to}} étoiles |  | rating = note |
| `changes.ratingCount` | Number of ratings: {{from}} to {{to}} | Nombre de notes : de {{from}} à {{to}} |  | rating = note |
| `changes.releaseNotes` | Release notes changed | Notes de version modifiées |  | release = publication |
| `changes.retention` | Kept for {{days}} days, at most 200 changes per competitor. | Conservés {{days}} jours, 200 changements au plus par concurrent. |  |  |
| `changes.screenshots` | {{device}} screenshots: {{parts}} | Captures {{device}} : {{parts}} |  |  |
| `changes.shotAlt` | Screenshot {{n}} of {{total}}, {{side}} ({{device}}) | Capture {{n}} sur {{total}}, {{side}} ({{device}}) |  |  |
| `changes.showDiff` | Show the difference | Afficher la différence |  |  |
| `changes.side.after` | after | après |  |  |
| `changes.side.before` | before | avant |  |  |
| `changes.sr.added` | Added: | Ajouté : |  |  |
| `changes.sr.removed` | Removed: | Retiré : |  |  |
| `changes.status.new` | new | nouvelle |  |  |
| `changes.status.removed` | removed | retirée |  |  |
| `changes.stripLabel` | {{device}} screenshots, {{side}} | Captures {{device}}, {{side}} |  |  |
| `changes.summaryNone` | Listing changes: none seen yet | Changements de la fiche : aucun pour l’instant |  | listing = fiche |
| `changes.summaryNotWatched` | Listing changes: not watched | Changements de la fiche : non surveillée |  | listing = fiche |
| `changes.summary_one` | Listing changes ({{count}}{{more}}) | Changements de la fiche ({{count}}{{more}}) |  | listing = fiche |
| `changes.summary_other` | Listing changes ({{count}}{{more}}) | Changements de la fiche ({{count}}{{more}}) |  | listing = fiche |
| `changes.version` | Version: {{from}} to {{to}} | Version : {{from}} devient {{to}} |  |  |
| `changes.watchingSince` | Watching since {{date}}: Kiln only sees changes from then on. | Surveillé depuis le {{date}} : Kiln ne voit que les changements à partir de cette date. |  |  |
| `est.col.details` | Details | Détails |  |  |
| `est.col.difficulty` | Difficulty (est.) | Difficulté (est.) |  |  |
| `est.col.keyword` | Keyword | Mot-clé |  |  |
| `est.col.opportunity` | Opportunity (est.) | Opportunité (est.) |  |  |
| `est.col.popularity` | Popularity (est.) | Popularité (est.) |  |  |
| `est.col.rank` | Rank | Position |  |  |
| `est.confidence.high` | High confidence | Confiance élevée |  |  |
| `est.confidence.low` | Low confidence | Confiance faible |  |  |
| `est.confidence.medium` | Medium confidence | Confiance moyenne |  |  |
| `est.detail.appleAdsCampaigns` | Your campaigns: {{impressions}} impressions, {{taps}} taps, {{installs}} installs in {{days}} days. | Vos campagnes : {{impressions}} impressions, {{taps}} appuis, {{installs}} installations en {{days}} jours. |  |  |
| `est.detail.appleAdsIntro` | Apple’s own numbers, shown beside the estimate and never mixed into it. | Les chiffres propres à Apple, affichés à côté de l’estimation sans jamais y être mélangés. |  |  |
| `est.detail.appleAdsNoScore` | {{genre}}: Apple gave no popularity | {{genre}} : Apple n’a donné aucune popularité |  |  |
| `est.detail.appleAdsRank` | rank {{rank}} in the genre | rang {{rank}} dans le genre |  |  |
| `est.detail.appleAdsScore` | {{genre}}: Apple popularity {{score}} of 100 | {{genre}} : popularité Apple {{score}} sur 100 |  |  |
| `est.detail.close` | Close | Fermer |  |  |
| `est.detail.col.ratings` | Ratings | Notes |  | rating = note |
| `est.detail.competing` | Apps in the first results | Apps des premiers résultats |  |  |
| `est.detail.competingNone` | No search results have been read yet. | Aucun résultat de recherche n’a encore été lu. |  |  |
| `est.detail.difficulty` | Difficulty inputs | Entrées de la difficulté |  |  |
| `est.detail.hints` | Search hints | Suggestions de recherche |  |  |
| `est.detail.hintsIntro` | What the App Store suggests while this term is typed, in its order. | Ce que l’App Store propose pendant la saisie de ce terme, dans son ordre. |  |  |
| `est.detail.hintsNone` | No hints have been read yet. | Aucune suggestion n’a encore été lue. |  |  |
| `est.detail.line` | {{points}} of 100, share {{share}}% | {{points}} sur 100, part {{share}} % |  |  |
| `est.detail.noRead` | No public signal has been read yet. Model {{model}}. | Aucun signal public n’a encore été lu. Modèle {{model}}. |  |  |
| `est.detail.opportunity` | Opportunity: your current rank leaves {{percent}}% of the room. | Opportunité : votre position actuelle laisse {{percent}} % de marge. |  |  |
| `est.detail.popularity` | Popularity inputs | Entrées de la popularité |  |  |
| `est.detail.read` | Public signals read {{when}}. Model {{model}}. | Signaux publics lus {{when}}. Modèle {{model}}. |  |  |
| `est.detail.title` | Why this estimate: {{term}} | Pourquoi cette estimation : {{term}} |  |  |
| `est.detail.trend` | Trend of the estimate | Évolution de l’estimation |  |  |
| `est.detail.trendDifficulty` | Difficulty estimate over {{count}} days, latest {{latest}} | Estimation de difficulté sur {{count}} jours, dernière valeur {{latest}} |  |  |
| `est.detail.trendLabel` | Popularity estimate over {{count}} days, latest {{latest}} | Estimation de popularité sur {{count}} jours, dernière valeur {{latest}} |  |  |
| `est.detail.trendNone` | The trend needs readings from at least two days. | L’évolution demande des lectures sur au moins deux jours. |  |  |
| `est.empty` | Estimates appear after the keywords have been checked. | Les estimations apparaissent après la vérification des mots-clés. |  |  |
| `est.filter.all` | All keywords | Tous les mots-clés |  |  |
| `est.filter.estimated` | With an estimate | Avec une estimation |  |  |
| `est.filter.label` | Show | Afficher |  |  |
| `est.filter.none` | No estimate | Sans estimation |  |  |
| `est.filter.own` | From your data | De vos données |  |  |
| `est.how.confidence` | Confidence says how much evidence is behind a number: one dot is low, two medium, three high. Public signals alone never reach high, and difficulty never does. | La confiance indique la quantité d’indices derrière un chiffre : un point faible, deux moyenne, trois élevée. Les signaux publics seuls n’atteignent jamais « élevée », ni la difficulté. |  |  |
| `est.how.demand` | Popularity: how many ratings the first results have, a weak sign of how big the niche is. | Popularité : le nombre de notes des premiers résultats, un faible indice de la taille de la niche. |  | rating = note |
| `est.how.difficulty` | Difficulty: how strong the first results are (their ratings), how many have every word of the term in their name, how crowded the results are, and how much your own rank moves between checks. | Difficulté : la force des premiers résultats (leurs notes), combien ont tous les mots du terme dans leur nom, l’encombrement des résultats et l’ampleur des variations de votre position entre deux vérifications. |  | rating = note |
| `est.how.hints` | Popularity: where the App Store suggests the term while someone types it (its search hints). | Popularité : où l’App Store propose le terme pendant la saisie (ses suggestions de recherche). |  |  |
| `est.how.intro` | Apple and Google publish no search volume for a term. Kiln combines what it can see: | Apple et Google ne publient aucun volume de recherche pour un terme. Kiln combine ce qu’il peut observer : |  |  |
| `est.how.label` | How this is estimated | Comment c’est estimé |  |  |
| `est.how.limits` | Limits: the hints and the results are what Apple’s public services show and may differ from the App Store app. Each term is read once a day, at most {{count}} terms per check, only for keywords you track. Nothing is sent to an AI. | Limites : les suggestions et les résultats sont ceux des services publics d’Apple et peuvent différer de l’app App Store. Chaque terme est lu une fois par jour, au plus {{count}} termes par vérification, uniquement pour les mots-clés que vous suivez. Rien n’est envoyé à une IA. |  | track = piste (Play) / suivre (keyword) |
| `est.how.none` | With no signal there is “No estimate”, never 0. Google Play keywords get an estimate only from your own search terms file. | Sans signal, il n’y a « Pas d’estimation », jamais 0. Pour Google Play, une estimation n’existe qu’avec votre propre fichier de termes de recherche. |  |  |
| `est.how.own` | Popularity: your own visitors for the term (the Google Play search terms file). This is the strongest input and it is marked “from your data”. It is a lower bound: only people who reached your listing. | Popularité : vos propres visiteurs pour ce terme (le fichier des termes de recherche Google Play). C’est l’entrée la plus fiable ; elle est marquée « de vos données ». C’est un minimum : seules les personnes arrivées sur votre fiche sont comptées. |  | listing = fiche |
| `est.lead` | Popularity and difficulty are estimates that Kiln works out from public signals and from your own data. They are not Apple’s popularity score and not a Google Play number. | La popularité et la difficulté sont des estimations que Kiln calcule à partir de signaux publics et de vos propres données. Ce n’est pas le score de popularité d’Apple ni un chiffre de Google Play. |  |  |
| `est.loadFailed` | The estimates could not be loaded. | Impossible de charger les estimations. |  |  |
| `est.noMatch` | No keyword matches this filter. | Aucun mot-clé ne correspond à ce filtre. |  |  |
| `est.none` | No estimate | Pas d’estimation |  |  |
| `est.noneWhy` | Why there is no estimate | Pourquoi il n’y a pas d’estimation |  |  |
| `est.opportunity.tip` | Opportunity is an estimate too: popularity, times how easy the term looks, times how much room your current rank leaves. It is a place to look, not a promise. | L’opportunité est aussi une estimation : la popularité, multipliée par la facilité apparente du terme, multipliée par la marge que laisse votre position actuelle. C’est un endroit où regarder, pas une promesse. |  |  |
| `est.origin.adsData` | from your data (Apple Ads) | de vos données (Apple Ads) |  |  |
| `est.origin.ownData` | from your data | de vos données |  |  |
| `est.origin.publicSignals` | from public signals | de signaux publics |  |  |
| `est.reason.adsImpressions` | Your Apple Ads campaigns showed this search term {{impressions}} times, with {{taps}} taps and {{installs}} installs, in {{days}} days. Only searches that reached one of your ads are counted. | Vos campagnes Apple Ads ont affiché ce terme de recherche {{impressions}} fois, avec {{taps}} appuis et {{installs}} installations, en {{days}} jours. Seules les recherches qui ont atteint l’une de vos annonces sont comptées. |  |  |
| `est.reason.hintsAbsent` | The App Store suggests {{size}} other terms but not this one. | L’App Store propose {{size}} autres termes, mais pas celui-ci. |  |  |
| `est.reason.hintsEmpty` | The App Store suggests nothing for this term. | L’App Store ne propose rien pour ce terme. |  |  |
| `est.reason.hintsPosition` | The App Store suggests this term in place {{position}} of {{size}} while it is typed. | L’App Store propose ce terme en position {{position}} sur {{size}} pendant la saisie. |  |  |
| `est.reason.noSignal` | No signal has been read yet. Check the keywords to read the App Store. | Aucun signal n’a encore été lu. Vérifiez les mots-clés pour lire l’App Store. |  |  |
| `est.reason.ownVisitors` | {{visitors}} visitors and {{installs}} installs in {{days}} days, from your search terms file. Only people who reached your listing are counted. | {{visitors}} visiteurs et {{installs}} installations en {{days}} jours, d’après votre fichier de termes de recherche. Seules les personnes arrivées sur votre fiche sont comptées. |  | listing = fiche |
| `est.reason.playNeedsOwnData` | Google Play has no public signal. Import your Play Console search terms file to get an estimate. | Google Play n’a aucun signal public. Importez votre fichier de termes de recherche de la Play Console pour obtenir une estimation. |  |  |
| `est.reason.playNoCompetitionData` | Kiln does not read Google Play, so there is no difficulty estimate. | Kiln ne lit pas Google Play, il n’y a donc pas d’estimation de difficulté. |  |  |
| `est.reason.rankVolatility` | Your rank moved {{meanMove}} places per check on average over {{checks}} checks. | Votre position a varié de {{meanMove}} places par vérification en moyenne sur {{checks}} vérifications. |  |  |
| `est.reason.resultsCrowding` | The search returned {{total}} apps out of up to {{limit}}. | La recherche a renvoyé {{total}} apps sur {{limit}} au maximum. |  |  |
| `est.reason.resultsDemand` | The first {{apps}} results have {{ratings}} ratings together. | Les {{apps}} premiers résultats totalisent {{ratings}} notes. |  | rating = note |
| `est.reason.resultsEmpty` | The search returned no apps. | La recherche n’a renvoyé aucune app. |  |  |
| `est.reason.resultsStrength` | The first {{apps}} results have a median of {{medianRatings}} ratings. | Les {{apps}} premiers résultats ont une médiane de {{medianRatings}} notes. |  | rating = note |
| `est.reason.resultsTitleMatch` | {{matching}} of the first {{apps}} results have every word of the term in their name. | {{matching}} des {{apps}} premiers résultats ont tous les mots du terme dans leur nom. |  |  |
| `est.reason.tooFewResults` | Only {{apps}} results show a rating count, too few to estimate. | Seuls {{apps}} résultats affichent un nombre de notes, trop peu pour estimer. |  | rating = note |
| `est.reason.unknown` | Another input of the estimate. | Une autre entrée de l’estimation. |  |  |
| `est.showDetails` | Why this estimate for {{term}} | Pourquoi cette estimation pour {{term}} |  |  |
| `est.sort.difficulty` | Easiest first | Plus faciles d’abord |  |  |
| `est.sort.label` | Sort the estimates | Trier les estimations |  |  |
| `est.sort.opportunity` | Opportunity first | Opportunité d’abord |  |  |
| `est.sort.popularity` | Most popular first | Plus populaires d’abord |  |  |
| `est.sort.term` | Keyword A to Z | Mot-clé de A à Z |  |  |
| `est.suggest.failed` | The keyword could not be tracked. | Impossible de suivre ce mot-clé. |  |  |
| `est.suggest.from` | from {{terms}} | via {{terms}} |  |  |
| `est.suggest.lead` | Terms the App Store suggests for the keywords you track. Weigh them yourself: a suggestion does not promise traffic. | Termes que l’App Store propose pour les mots-clés que vous suivez. À vous de juger : une suggestion ne promet aucun trafic. |  | track = piste (Play) / suivre (keyword) |
| `est.suggest.none` | No related terms yet. Check the keywords to read the App Store’s hints. | Aucun terme associé pour l’instant. Vérifiez les mots-clés pour lire les suggestions de l’App Store. |  |  |
| `est.suggest.title` | Related terms | Termes associés |  |  |
| `est.suggest.track` | Track | Suivre |  | track = piste (Play) / suivre (keyword) |
| `est.suggest.trackFor` | Track {{term}} | Suivre {{term}} |  | track = piste (Play) / suivre (keyword) |
| `est.suggest.tracked` | Now tracking {{term}}. Check the keywords to read its estimate. | {{term}} est maintenant suivi. Vérifiez les mots-clés pour lire son estimation. |  |  |
| `est.title` | Keyword estimates | Estimations des mots-clés |  |  |
| `est.value` | {{score}} of 100, estimate | {{score}} sur 100, estimation |  |  |
| `follow.adding` | Following… | Suivi en cours… |  |  |
| `follow.badPackage` | That is not a package name. It looks like com.example.app, with at least two parts. | Ce n’est pas un nom de package. Il ressemble à com.example.app, avec au moins deux parties. |  |  |
| `follow.count_one` | {{count}} app found | {{count}} app trouvée |  |  |
| `follow.count_other` | {{count}} apps found | {{count}} apps trouvées |  |  |
| `follow.empty` | No apps found for “{{term}}” in {{country}}. Try another spelling or storefront, or paste the link or id. | Aucune app trouvée pour « {{term}} » dans {{country}}. Essayez une autre orthographe ou un autre store, ou collez le lien ou l’identifiant. |  |  |
| `follow.emptyShort` | No apps found | Aucune app trouvée |  |  |
| `follow.free` | Free | Gratuit |  |  |
| `follow.hintAppStore` | Type at least 2 letters to search the App Store, or paste an apps.apple.com link or an id. | Saisissez au moins 2 lettres pour chercher dans l’App Store, ou collez un lien apps.apple.com ou un identifiant. |  |  |
| `follow.hintPackage` | Google Play cannot be searched by name. Paste the package name (such as com.example.app) or the play.google.com address: the package is the text after id= in the address. | Google Play ne peut pas être cherché par nom. Collez le nom du package (par exemple com.example.app) ou l’adresse play.google.com : le package est le texte après id= dans l’adresse. |  |  |
| `follow.keys` | Use the arrow keys to move through the results, Enter to follow, Escape to close. | Flèches pour parcourir les résultats, Entrée pour suivre, Échap pour fermer. |  |  |
| `follow.noRating` | No ratings | Aucune note |  | rating = note |
| `follow.offline` | The server cannot be reached. Check your connection and try again. | Le serveur est injoignable. Vérifiez votre connexion et réessayez. |  |  |
| `follow.packageLabel` | Package name or Play Store link | Nom du package ou lien du Play Store |  |  |
| `follow.ratings_one` | {{count}} rating | {{count}} note |  | rating = note |
| `follow.ratings_other` | {{count}} ratings | {{count}} notes |  | rating = note |
| `follow.resolvedId` | App Store id {{id}} ({{country}}) recognised. Following reads it once. | Identifiant App Store {{id}} ({{country}}) reconnu. Le suivi le lit une fois. |  |  |
| `follow.resolvedPackage` | Package {{id}} recognised. Following reads it once. | Package {{id}} reconnu. Le suivi le lit une fois. |  |  |
| `follow.results` | Search results | Résultats de la recherche |  |  |
| `follow.searchFailed` | The search did not work. Try again. | La recherche n’a pas abouti. Réessayez. |  |  |
| `follow.searchLabel` | Search by name, or paste a store link or id | Chercher par nom, ou coller un lien ou un identifiant du store |  |  |
| `follow.searching` | Searching the App Store… | Recherche dans l’App Store… |  |  |
| `follow.stateFollowed` | Already followed | Déjà suivie |  |  |
| `follow.stateOwn` | This is your app | C’est votre app |  |  |
| `follow.wrongStoreApple` | That is an App Store link or id, but this app is on Google Play. Choose the matching store. | C’est un lien ou un identifiant App Store, mais cette app est sur Google Play. Choisissez le store correspondant. |  |  |
| `follow.wrongStorePlay` | That is a Google Play link or package, but this app is on the App Store. Choose the matching store. | C’est un lien ou un package Google Play, mais cette app est sur l’App Store. Choisissez le store correspondant. |  |  |

## web/assets (80)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `device.unrecognised` | Device not recognised | Appareil non reconnu |  |  |
| `filter.noDevice` | No device | Sans appareil |  |  |
| `lightbox.altNoDevice` | {{kind}} {{order}}, {{locale}}: {{name}} | {{kind}} {{order}}, {{locale}} : {{name}} |  |  |
| `store.add` | Add images | Ajouter des images |  |  |
| `store.addTitle` | Add images | Ajouter des images |  |  |
| `store.announceMoved` | Moved image {{from}} of {{set}} to place {{to}} (staged). | Image {{from}} de {{set}} déplacée à la place {{to}} (en attente). |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `store.announceRemoved` | Removed image {{position}} of {{set}} (staged). | Image {{position}} de {{set}} retirée (en attente). |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `store.announceStaged` | Staged {{set}}. | {{set}} mis en attente. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `store.dragHint` | Drag to reorder | Glisser pour réordonner |  |  |
| `store.editFailed` | The change could not be staged | La modification n’a pas pu être mise en attente |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `store.emptyText` | Nothing is uploaded to the store page of this app, in any language. | Rien n’est téléversé sur la page store de cette app, dans aucune langue. |  |  |
| `store.emptyTitle` | The store has no graphics yet | Le store n’a encore aucun visuel |  |  |
| `store.fullReason` | This set holds at most {{max}} images. | Cet ensemble contient au plus {{max}} images. |  |  |
| `store.groupCount_one` | {{count}} image | {{count}} image |  |  |
| `store.groupCount_other` | {{count}} images | {{count}} images |  |  |
| `store.imageAlt` | {{set}}, image {{position}} | {{set}}, image {{position}} |  |  |
| `store.images_one` | {{count}} image | {{count}} image |  |  |
| `store.images_other` | {{count}} images | {{count}} images |  |  |
| `store.lockedReason` | The version in the store is live or in review, so its listing and graphics are locked. Create a new version to change them. | La version dans le store est en ligne ou en cours d’examen : sa fiche et ses visuels sont verrouillés. Créez une nouvelle version pour les modifier. |  | listing = fiche; review: avis (user) vs examen (App Review) |
| `store.moveEarlier` | Move image {{position}} earlier | Avancer l’image {{position}} |  |  |
| `store.moveLater` | Move image {{position}} later | Reculer l’image {{position}} |  |  |
| `store.noPreview` | No preview | Pas d’aperçu |  |  |
| `store.notesImages` | Images | Images |  |  |
| `store.notesLabel` | Notes | Remarques |  |  |
| `store.notesLine_one` | {{count}} note about the store graphics | {{count}} remarque sur les visuels du store |  |  |
| `store.notesLine_other` | {{count}} notes about the store graphics | {{count}} remarques sur les visuels du store |  |  |
| `store.open` | Open {{set}}, image {{position}} | Ouvrir {{set}}, image {{position}} |  |  |
| `store.problems_one` | {{count}} problem in the store graphics | {{count}} problème dans les visuels du store |  |  |
| `store.problems_other` | {{count}} problems in the store graphics | {{count}} problèmes dans les visuels du store |  |  |
| `store.readFailed` | The store graphics could not be read | Les visuels du store n’ont pas pu être lus |  |  |
| `store.readFailedText` | The store did not answer. Check the store connection of this app and try again. | Le store n’a pas répondu. Vérifiez la connexion au store de cette app et réessayez. |  |  |
| `store.reading` | Reading the store graphics… | Lecture des visuels du store… |  |  |
| `store.refreshing` | Refreshing… | Actualisation… |  |  |
| `store.removeImage` | Remove image {{position}} | Retirer l’image {{position}} |  |  |
| `store.replace` | Replace image {{position}} | Remplacer l’image {{position}} |  |  |
| `store.replaceTitle` | Replace image {{position}} | Remplacer l’image {{position}} |  |  |
| `store.repoHidden_one` | The repository holds {{count}} graphic. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see it next to the store’s. | Le dépôt contient {{count}} visuel. Activez « Comparer les visuels du dépôt et du store » dans les réglages de l’app (Fiche du store) pour le voir à côté de ceux du store. |  | listing = fiche |
| `store.repoHidden_other` | The repository holds {{count}} graphics. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see them next to the store’s. | Le dépôt contient {{count}} visuels. Activez « Comparer les visuels du dépôt et du store » dans les réglages de l’app (Fiche du store) pour les voir à côté de ceux du store. |  | listing = fiche |
| `store.reread` | Read again | Relire |  |  |
| `store.rereadFailed` | The store graphics could not be read again. What is shown is from the last read. | Les visuels du store n’ont pas pu être relus. Ce qui s’affiche vient de la dernière lecture. |  |  |
| `store.ruleSourceShort` | Source of the rule | Source de la règle |  |  |
| `store.staged` | Staged | En attente |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `store.storeHolds_one` | The store holds {{count}} image now | Le store contient {{count}} image pour l’instant |  |  |
| `store.storeHolds_other` | The store holds {{count}} images now | Le store contient {{count}} images pour l’instant |  |  |
| `store.title` | Store graphics | Visuels du store |  |  |
| `store.tools` | Actions for image {{position}} | Actions pour l’image {{position}} |  |  |
| `store.unplaced_one` | {{count}} image has a size Kiln does not know and is not shown. | {{count}} image a une taille que Kiln ne connaît pas et n’est pas affichée. |  |  |
| `store.unplaced_other` | {{count}} images have a size Kiln does not know and are not shown. | {{count}} images ont une taille que Kiln ne connaît pas et ne sont pas affichées. |  |  |
| `store.unreadCause` | The store gives no size for these images and Kiln could not read the first bytes of the files (the image host did not answer, or the address is not one Kiln may fetch), so their size and format were not checked. Nothing is known to be wrong with them. | Le store ne donne pas la taille de ces images et Kiln n’a pas pu lire les premiers octets des fichiers (l’hébergeur d’images n’a pas répondu, ou l’adresse n’en est pas une que Kiln peut appeler) : leur taille et leur format n’ont pas été vérifiés. Rien n’indique un problème. |  |  |
| `store.unreadLabel` | Not checked | Non vérifiées |  |  |
| `store.unreadLine_one` | {{count}} image could not be checked | {{count}} image n’a pas pu être vérifiée |  |  |
| `store.unreadLine_other` | {{count}} images could not be checked | {{count}} images n’ont pas pu être vérifiées |  |  |
| `store.updatedAt` | Updated {{when}} | Mis à jour {{when}} |  |  |
| `store.uploadHint` | Files are checked against the store’s rules (pixel size, format, file size, count) before they are staged. Nothing is sent to the store until you publish from the pending cart. | Les fichiers sont vérifiés d’après les règles du store (taille en pixels, format, poids, nombre) avant d’être mis en attente. Rien n’est envoyé au store avant la publication depuis le panier. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `tab.noMedia` | No graphics in the repository | Aucun visuel dans le dépôt |  |  |
| `viewer.actions` | Image actions | Actions sur l’image |  |  |
| `viewer.alt` | {{set}} ({{locale}}), image {{position}} of {{total}} | {{set}} ({{locale}}), image {{position}} sur {{total}} |  |  |
| `viewer.bytes` | File size | Poids du fichier |  |  |
| `viewer.copied` | Image copied. | Image copiée. |  |  |
| `viewer.copy` | Copy image | Copier l’image |  |  |
| `viewer.copyFallback` | This browser could not copy the image, so it was saved as a file instead. | Ce navigateur n’a pas pu copier l’image : elle a été enregistrée comme fichier. |  |  |
| `viewer.device` | Screen size | Taille d’écran |  |  |
| `viewer.editOff` | Editing is off: {{reason}} | La modification est désactivée : {{reason}} |  |  |
| `viewer.fetchFailed` | The original image could not be fetched. Try again. | L’image originale n’a pas pu être récupérée. Réessayez. |  |  |
| `viewer.file` | File name | Nom du fichier |  |  |
| `viewer.index` | Place | Place |  |  |
| `viewer.indexValue` | {{position}} of {{total}} | {{position}} sur {{total}} |  |  |
| `viewer.keys` | The left and right arrow keys step through the images | Les flèches gauche et droite font défiler les images |  |  |
| `viewer.loadFailed` | The picture could not be loaded. | L’image n’a pas pu être chargée. |  |  |
| `viewer.locale` | Language | Langue |  |  |
| `viewer.next` | Next | Suivante |  |  |
| `viewer.pixels` | Pixel size | Taille en pixels |  |  |
| `viewer.previous` | Previous | Précédente |  |  |
| `viewer.remove` | Remove | Retirer |  |  |
| `viewer.replace` | Replace | Remplacer |  |  |
| `viewer.save` | Save | Enregistrer |  |  |
| `viewer.saved` | Saved {{name}}. | {{name}} enregistré. |  |  |
| `viewer.staged` | Staged | En attente |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `viewer.title` | Image | Image |  |  |
| `viewer.unknown` | Unknown | Inconnue |  |  |

## web/auth (1)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `stepUp.action.price` | Send price changes to a store | Envoyer des changements de prix à un store |  |  |

## web/builds (31)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `install.androidNew` | Android 8.0 and newer: when the phone asks, allow the app that opened the link (your browser) to install unknown apps. The switch is in Settings, Apps, Special app access, Install unknown apps, under that browser. | Android 8.0 et plus : quand le téléphone le demande, autorisez l'app qui a ouvert le lien (votre navigateur) à installer des applications inconnues. Le réglage se trouve dans Paramètres, Applications, Accès spécial, Installer des applications inconnues, sous ce navigateur. |  |  |
| `install.androidOld` | Android 7.1.1 and older: turn on Unknown sources in Settings, Security, then open the link again. | Android 7.1.1 et moins : activez Sources inconnues dans Paramètres, Sécurité, puis rouvrez le lien. |  |  |
| `install.blocked.expired` | Expo has deleted the file of this build. | Expo a supprimé le fichier de ce build. |  |  |
| `install.blocked.failed` | This build did not finish, so there is nothing to install. | Ce build ne s'est pas terminé, il n'y a donc rien à installer. |  |  |
| `install.blocked.noLink` | Expo gave no address for this build. | Expo n'a donné aucune adresse pour ce build. |  |  |
| `install.blocked.running` | This build has not finished yet. | Ce build n'est pas encore terminé. |  |  |
| `install.blocked.store` | A store build is sent to the store, not installed from a link. | Un build pour le store est envoyé au store, pas installé depuis un lien. |  |  |
| `install.download` | Download build | Télécharger le build |  |  |
| `install.downloadKind` | Download build ({{kind}}) | Télécharger le build ({{kind}}) |  |  |
| `install.downloadNote` | A direct link to the file at Expo. It does not pass through Kiln. | Un lien direct vers le fichier chez Expo. Il ne passe pas par Kiln. |  |  |
| `install.expires` | Expo keeps the build file until {{date}}. | Expo conserve le fichier du build jusqu'au {{date}}. |  |  |
| `install.helpAndroid` | How to install on Android | Comment installer sur Android |  |  |
| `install.helpIos` | How to install on iPhone and iPad | Comment installer sur iPhone et iPad |  |  |
| `install.iosAdHoc` | An internal build only runs on devices registered for it: an ad hoc profile lists them by UDID, an enterprise profile needs no list. A new device needs a new build. | Un build interne ne fonctionne que sur les appareils enregistrés pour lui : un profil ad hoc les liste par UDID, un profil entreprise n'a pas de liste. Un nouvel appareil demande un nouveau build. |  |  |
| `install.iosDocs` | Expo: internal distribution | Expo : distribution interne |  |  |
| `install.iosTrust` | If the phone says the developer is not trusted, trust the profile in Settings, General, VPN and Device Management. | Si le téléphone indique que le développeur n'est pas approuvé, approuvez le profil dans Réglages, Général, VPN et gestion de l'appareil. |  |  |
| `install.leadAndroid` | Open the camera on the Android phone and point it at this code, then tap the link that appears. | Ouvrez l'appareil photo du téléphone Android et visez ce code, puis touchez le lien qui s'affiche. |  |  |
| `install.leadIos` | Open the Camera app on the iPhone and point it at this code, then tap the notification that appears. | Ouvrez l'app Appareil photo de l'iPhone et visez ce code, puis touchez la notification qui s'affiche. |  |  |
| `install.leadNoCode` | The page of this build on Expo has the install link. Open it on the device. | La page de ce build sur Expo contient le lien d'installation. Ouvrez-la sur l'appareil. |  |  |
| `install.leadSimulator` | This is an iOS Simulator build. It does not install from a QR code: open it with Orbit, or download it and drop it on a running simulator. | Ceci est un build pour le simulateur iOS. Il ne s'installe pas avec un code QR : ouvrez-le avec Orbit, ou téléchargez-le et déposez-le sur un simulateur ouvert. |  |  |
| `install.linkHint` | The same address as the code: open it on the device to install. | La même adresse que le code : ouvrez-la sur l'appareil pour installer. |  |  |
| `install.linkLabel` | Send a link to a device | Envoyer un lien à un appareil |  |  |
| `install.openExpo` | Open on Expo | Ouvrir sur Expo |  |  |
| `install.orbit` | Open with Orbit | Ouvrir avec Orbit |  |  |
| `install.orbitGet` | Get Expo Orbit | Obtenir Expo Orbit |  |  |
| `install.orbitHint` | Nothing happened? Expo Orbit may not be installed. | Rien ne s'est passé ? Expo Orbit n'est peut-être pas installé. |  |  |
| `install.orbitTip` | Needs Expo Orbit installed | Nécessite Expo Orbit |  |  |
| `install.qrLabel` | QR code for the install link | Code QR du lien d'installation |  |  |
| `install.qrTooLong` | The link is too long for a QR code. Copy it below instead. | Le lien est trop long pour un code QR. Copiez-le plutôt ci-dessous. |  |  |
| `install.title` | Install on a test device | Installer sur un appareil de test |  |  |
| `install.whyBlocked` | Why this cannot be installed | Pourquoi ce build ne peut pas être installé |  |  |

## web/chat (162)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `action.delete` | Delete | Supprimer |  |  |
| `action.deleteLabel` | Delete {{name}} | Supprimer {{name}} |  |  |
| `action.edit` | Edit | Modifier |  |  |
| `action.editLabel` | Edit {{name}} | Modifier {{name}} |  |  |
| `action.log` | Deliveries | Envois |  |  |
| `action.logLabel` | Deliveries to {{name}} | Envois vers {{name}} |  |  |
| `action.routing` | Routing | Routage |  |  |
| `action.routingLabel` | Routing rules of {{name}} | Règles de routage de {{name}} |  |  |
| `action.test` | Send test message | Envoyer un message de test |  |  |
| `action.testLabel` | Send a test message to {{name}} | Envoyer un message de test à {{name}} |  |  |
| `action.testing` | Sending… | Envoi… |  |  |
| `card.anyHost` | Any host allowed | Tout hôte autorisé |  |  |
| `card.digestDaily` | Daily summary at {{hour}} ({{zone}}) | Résumé quotidien à {{hour}} ({{zone}}) |  |  |
| `card.digestOff` | Every alert is sent at once | Chaque alerte est envoyée immédiatement |  |  |
| `card.endsIn` | Address ends in {{hint}} | L’adresse se termine par {{hint}} |  |  |
| `card.language` | Messages in {{language}} | Messages en {{language}} |  |  |
| `card.lastDelivery` | Last message: {{status}}, {{when}} | Dernier message : {{status}}, {{when}} |  |  |
| `card.noDelivery` | Nothing sent yet | Rien n’a encore été envoyé |  |  |
| `card.off` | Off | Désactivée |  |  |
| `card.on` | On | Activée |  |  |
| `card.rulesOff` | off | désactivée |  |  |
| `card.rules_one` | {{count}} rule | {{count}} règle |  |  |
| `card.rules_other` | {{count}} rules | {{count}} règles |  |  |
| `delete.body` | Messages to {{name}} stop, and its routing and delivery log are removed. The channel itself is not touched. | Les messages vers {{name}} s’arrêtent, et son routage et son journal d’envois sont supprimés. Le canal lui-même n’est pas modifié. |  |  |
| `delete.title` | Delete this destination? | Supprimer cette destination ? |  |  |
| `form.anyHost` | Allow a host other than Slack or Microsoft | Autoriser un hôte autre que Slack ou Microsoft |  |  |
| `form.anyHostHint` | Only for your own gateway that forwards to Slack or Teams. Addresses inside your network are always refused. | Uniquement pour votre propre passerelle qui relaie vers Slack ou Teams. Les adresses internes à votre réseau sont toujours refusées. |  |  |
| `form.create` | Add destination | Ajouter la destination |  |  |
| `form.creating` | Adding… | Ajout… |  |  |
| `form.defaultsNote` | A new destination starts with every critical alert and every release event. Change that under Routing. | Une nouvelle destination reçoit toutes les alertes critiques et tous les événements de publication. Modifiez cela dans Routage. |  | release = publication |
| `form.description` | One Slack or Microsoft Teams channel that receives Kiln messages. | Un canal Slack ou Microsoft Teams qui reçoit les messages de Kiln. |  |  |
| `form.digest` | Daily summary | Résumé quotidien |  |  |
| `form.digestDaily` | Daily: alerts below critical wait for the summary, critical ones are sent at once | Quotidien : les alertes non critiques attendent le résumé, les alertes critiques sont envoyées immédiatement |  |  |
| `form.digestHour` | Send the summary at | Envoyer le résumé à |  |  |
| `form.digestOff` | Off: every alert is sent at once | Désactivé : chaque alerte est envoyée immédiatement |  |  |
| `form.enabled` | Send messages to this destination | Envoyer des messages à cette destination |  |  |
| `form.errors.name` | Give the destination a name. | Donnez un nom à la destination. |  |  |
| `form.errors.nameLong` | Use at most 80 characters. | Utilisez 80 caractères au plus. |  |  |
| `form.errors.timezone` | Enter a time zone for the summary. | Indiquez un fuseau horaire pour le résumé. |  |  |
| `form.errors.url` | Paste the https webhook address from Slack or Teams. | Collez l’adresse de webhook https fournie par Slack ou Teams. |  |  |
| `form.language` | Language of the messages | Langue des messages |  |  |
| `form.languageHint` | Messages are written in this language, whatever language people use in Kiln. | Les messages sont rédigés dans cette langue, quelle que soit la langue utilisée dans Kiln. |  |  |
| `form.name` | Name | Nom |  |  |
| `form.nameHint` | Only shown here, for example “#releases”. | Affiché ici uniquement, par exemple « #releases ». |  | release = publication |
| `form.provider` | Service | Service |  |  |
| `form.save` | Save changes | Enregistrer les modifications |  |  |
| `form.saving` | Saving… | Enregistrement… |  |  |
| `form.timezone` | Time zone | Fuseau horaire |  |  |
| `form.timezoneHint` | A time zone name such as Europe/Paris. | Un nom de fuseau horaire, par exemple Europe/Paris. |  |  |
| `form.titleEdit` | Edit the destination | Modifier la destination |  |  |
| `form.titleNew` | New chat destination | Nouvelle destination de discussion |  |  |
| `form.url` | Webhook address | Adresse du webhook |  |  |
| `form.urlHint` | Secret. Paste it once: it is stored encrypted and never shown again. | Secrète. Collez-la une seule fois : elle est stockée chiffrée et n’est plus jamais affichée. |  |  |
| `form.urlSaved` | The saved address ends in {{hint}}. Leave this empty to keep it, or paste a new one to replace it. | L’adresse enregistrée se termine par {{hint}}. Laissez ce champ vide pour la conserver, ou collez-en une nouvelle pour la remplacer. |  |  |
| `help.slack.step1` | Create a Slack app for your workspace at api.slack.com/apps (from scratch). | Créez une application Slack pour votre espace de travail sur api.slack.com/apps (à partir de zéro). |  |  |
| `help.slack.step2` | In the app’s settings, turn on Incoming Webhooks. | Dans les paramètres de l’application, activez Incoming Webhooks. |  |  |
| `help.slack.step3` | Choose Add New Webhook to Workspace and pick the channel. | Choisissez Add New Webhook to Workspace, puis le canal. |  |  |
| `help.slack.step4` | Copy the webhook URL, which starts with https://hooks.slack.com/services/, and paste it here. | Copiez l’URL du webhook, qui commence par https://hooks.slack.com/services/, et collez-la ici. |  |  |
| `help.teams.note` | Microsoft retired the old Office 365 connector webhooks, so a Teams destination needs a workflow. | Microsoft a retiré les anciens webhooks de connecteur Office 365 : une destination Teams nécessite donc un flux. |  |  |
| `help.teams.step1` | In Teams, open the Workflows app and create a workflow from the template that posts to a channel when a webhook request is received (it may be named “Send webhook alerts to a channel”). | Dans Teams, ouvrez l’application Workflows et créez un flux à partir du modèle qui publie dans un canal à la réception d’une requête webhook (il peut s’appeler « Send webhook alerts to a channel »). |  |  |
| `help.teams.step2` | Pick the team and channel where the messages should appear, and finish the setup. | Choisissez l’équipe et le canal où les messages doivent apparaître, puis terminez la configuration. |  |  |
| `help.teams.step3` | Copy the HTTP URL that the workflow shows for its webhook trigger. | Copiez l’URL HTTP que le flux affiche pour son déclencheur webhook. |  |  |
| `help.teams.step4` | Paste it here. It comes from powerplatform.com or logic.azure.com. | Collez-la ici. Elle provient de powerplatform.com ou de logic.azure.com. |  |  |
| `help.title` | Where do I get the address? | Où trouver l’adresse ? |  |  |
| `kind.alert` | Alert | Alerte |  |  |
| `kind.digest` | Daily summary | Résumé quotidien |  |  |
| `kind.test` | Test | Test |  |  |
| `log.answer` | Answer {{code}} | Réponse {{code}} |  |  |
| `log.attempts_one` | {{count}} attempt | {{count}} tentative |  |  |
| `log.attempts_other` | {{count}} attempts | {{count}} tentatives |  |  |
| `log.caption` | Messages sent to this destination, newest first | Messages envoyés à cette destination, les plus récents d’abord |  |  |
| `log.close` | Close | Fermer |  |  |
| `log.colKind` | Kind | Type |  |  |
| `log.colResult` | Result | Résultat |  |  |
| `log.colStatus` | Status | Statut |  |  |
| `log.colWhat` | About | Concerne |  |  |
| `log.colWhen` | When | Quand |  |  |
| `log.empty` | Nothing was sent to this destination yet. | Rien n’a encore été envoyé à cette destination. |  |  |
| `log.loadFailed` | Could not load the deliveries. | Impossible de charger les envois. |  |  |
| `log.loading` | Loading… | Chargement… |  |  |
| `log.refresh` | Refresh | Actualiser |  |  |
| `log.region` | Deliveries to {{name}} | Envois vers {{name}} |  |  |
| `log.title` | Deliveries | Envois |  |  |
| `outcome.blockedAddress` | The address points inside a network or to an address that is never allowed, so nothing was sent. | L’adresse pointe vers l’intérieur d’un réseau ou vers une adresse jamais autorisée : rien n’a été envoyé. |  |  |
| `outcome.digestSent` | Sent in the daily summary. | Envoyée dans le résumé quotidien. |  |  |
| `outcome.disabled` | The destination is switched off, so nothing was sent. | La destination est désactivée : rien n’a été envoyé. |  |  |
| `outcome.dnsFailed` | The address could not be looked up. It will be tried again. | L’adresse n’a pas pu être résolue. Un nouvel essai aura lieu. |  |  |
| `outcome.hostNotAllowed` | The address is not from Slack or Microsoft and the destination does not allow other hosts, so nothing was sent. | L’adresse ne vient ni de Slack ni de Microsoft et la destination n’autorise pas d’autres hôtes : rien n’a été envoyé. |  |  |
| `outcome.inDigest` | Held for the daily summary. | Retenue pour le résumé quotidien. |  |  |
| `outcome.networkError` | The connection failed. It will be tried again. | La connexion a échoué. Un nouvel essai aura lieu. |  |  |
| `outcome.ok` | Delivered. | Remis. |  |  |
| `outcome.payloadRejected` | The service did not accept the message. Please report this. | Le service n’a pas accepté le message. Signalez-le, s’il vous plaît. |  |  |
| `outcome.queued` | Waiting to be sent. | En attente d’envoi. |  |  |
| `outcome.rateLimited` | The service asked Kiln to slow down. It will be tried again after the wait it named. | Le service a demandé à Kiln de ralentir. Un nouvel essai aura lieu après l’attente indiquée. |  |  |
| `outcome.redirected` | The address redirects elsewhere, which Kiln does not follow. Paste the final address. | L’adresse redirige ailleurs, ce que Kiln ne suit pas. Collez l’adresse finale. |  |  |
| `outcome.rejected` | The service refused the message. | Le service a refusé le message. |  |  |
| `outcome.secretUnreadable` | The saved address could not be read. Paste it again. | L’adresse enregistrée n’a pas pu être lue. Collez-la de nouveau. |  |  |
| `outcome.serverError` | The service had a problem. It will be tried again. | Le service a rencontré un problème. Un nouvel essai aura lieu. |  |  |
| `outcome.timeout` | The service did not answer in time. It will be tried again. | Le service n’a pas répondu à temps. Un nouvel essai aura lieu. |  |  |
| `outcome.unknown` | Unknown result. | Résultat inconnu. |  |  |
| `outcome.webhookGone` | The webhook no longer exists. Create a new one and paste its address here. | Le webhook n’existe plus. Créez-en un nouveau et collez son adresse ici. |  |  |
| `outcome.webhookRejected` | The service refused the webhook. It may have been disabled or restricted; check it in Slack or Teams. | Le service a refusé le webhook. Il a peut-être été désactivé ou restreint ; vérifiez-le dans Slack ou Teams. |  |  |
| `page.deleteFailed` | Could not delete the destination. | Impossible de supprimer la destination. |  |  |
| `page.deleted` | Deleted {{name}}. | {{name}} a été supprimé. |  |  |
| `page.description` | Send alerts, release events and a daily summary to a Slack or Microsoft Teams channel. | Envoyez les alertes, les événements de publication et un résumé quotidien vers un canal Slack ou Microsoft Teams. |  | release = publication |
| `page.emptyText` | Add a Slack or Teams channel to hear about rejections, releases and credential problems where your team already talks. | Ajoutez un canal Slack ou Teams pour être informé des rejets, des publications et des problèmes d’identifiants là où votre équipe discute déjà. |  | release = publication |
| `page.emptyTitle` | No chat destination yet | Aucune destination de discussion pour l’instant |  |  |
| `page.footer` | A message is retried a few times, then marked failed. The webhook address is secret: it is stored encrypted and never shown again. | Un message est renvoyé quelques fois, puis marqué comme échoué. L’adresse du webhook est secrète : elle est stockée chiffrée et n’est plus jamais affichée. |  |  |
| `page.loadFailed` | Could not load the chat destinations. | Impossible de charger les destinations de discussion. |  |  |
| `page.loading` | Loading… | Chargement… |  |  |
| `page.new` | New destination | Nouvelle destination |  |  |
| `page.noRead` | Your role does not include chat integrations. Owners and admins manage them. | Votre rôle n’inclut pas les intégrations de discussion. Les propriétaires et les administrateurs les gèrent. |  |  |
| `page.routesSaved` | Saved the routing of {{name}}. | Le routage de {{name}} a été enregistré. |  |  |
| `page.saved` | Saved {{name}}. | {{name}} a été enregistré. |  |  |
| `page.testFailed` | Could not send the test message. | Impossible d’envoyer le message de test. |  |  |
| `page.title` | Chat | Discussion |  |  |
| `routes.add` | Add a rule | Ajouter une règle |  |  |
| `routes.allApps` | All apps | Toutes les applications |  |  |
| `routes.allAppsLabel` | All apps | Toutes les applications |  |  |
| `routes.allPlatforms` | All platforms | Toutes les plateformes |  |  |
| `routes.allPlatformsLabel` | All platforms | Toutes les plateformes |  |  |
| `routes.allTypes` | All alert types | Tous les types d’alerte |  |  |
| `routes.allTypesLabel` | All alert types | Tous les types d’alerte |  |  |
| `routes.apps` | Apps | Applications |  |  |
| `routes.caption` | Routing rules | Règles de routage |  |  |
| `routes.col.apps` | Apps | Applications |  |  |
| `routes.col.platforms` | Platforms | Plateformes |  |  |
| `routes.col.severity` | From | À partir de |  |  |
| `routes.col.types` | Alerts | Alertes |  |  |
| `routes.defaults` | Use the defaults | Utiliser les valeurs par défaut |  |  |
| `routes.description` | Which alerts go to {{name}}. An alert is sent when any rule takes it. | Quelles alertes vont vers {{name}}. Une alerte est envoyée dès qu’une règle la retient. |  |  |
| `routes.enabled` | This rule is on | Cette règle est activée |  |  |
| `routes.errors.noTypes` | Choose at least one alert type, or choose all of them. | Choisissez au moins un type d’alerte, ou choisissez-les tous. |  |  |
| `routes.errors.saveFailed` | Could not save the routing. | Impossible d’enregistrer le routage. |  |  |
| `routes.from.critical` | Critical only | Critique uniquement |  |  |
| `routes.from.info` | Everything (info and above) | Tout (information et plus) |  |  |
| `routes.from.warning` | Needs attention and critical | Demande votre attention et critique |  |  |
| `routes.minSeverity` | From severity | À partir de la gravité |  |  |
| `routes.noRules` | With no rule, nothing is sent to this destination. | Sans règle, rien n’est envoyé à cette destination. |  |  |
| `routes.platforms` | Platforms | Plateformes |  |  |
| `routes.remove` | Remove rule | Supprimer la règle |  |  |
| `routes.removeLabel` | Remove rule {{n}} | Supprimer la règle {{n}} |  |  |
| `routes.rule` | Rule {{n}} | Règle {{n}} |  |  |
| `routes.save` | Save routing | Enregistrer le routage |  |  |
| `routes.saving` | Saving… | Enregistrement… |  |  |
| `routes.someTypes_one` | {{count}} alert type | {{count}} type d’alerte |  |  |
| `routes.someTypes_other` | {{count}} alert types | {{count}} types d’alerte |  |  |
| `routes.title` | Routing | Routage |  |  |
| `routes.types` | Alert types | Types d’alerte |  |  |
| `severity.critical` | Critical | Critique |  |  |
| `severity.info` | Info | Information |  |  |
| `severity.warning` | Needs attention | Demande votre attention |  |  |
| `status.deferred` | Waiting for the summary | En attente du résumé |  |  |
| `status.failed` | Failed | Échec |  |  |
| `status.queued` | Queued | En attente |  |  |
| `status.retrying` | Retrying | Nouvel essai |  |  |
| `status.sent` | Sent | Envoyé |  |  |
| `status.skipped` | Skipped | Ignoré |  |  |
| `test.failed` | The test message did not arrive: {{reason}} | Le message de test n’est pas arrivé : {{reason}} |  |  |
| `test.noResult` | No result yet. Open the deliveries to follow it. | Pas encore de résultat. Ouvrez les envois pour le suivre. |  |  |
| `test.sent` | The test message was delivered. Look in the channel. | Le message de test a été remis. Regardez dans le canal. |  |  |
| `test.waiting` | Sending the test message… | Envoi du message de test… |  |  |

## web/connect (71)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `banner.button` | Connect your apps | Connecter vos apps |  |  |
| `banner.expo.next_one` | Your Expo token “{{label}}” is saved. {{count}} app is not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the project from app.json where it can; nothing is saved until you confirm. | Votre jeton Expo « {{label}} » est enregistré. {{count}} app n’est pas encore liée à un projet Expo : Builds n’affiche donc aucun build EAS. Kiln lit le projet dans app.json quand il le peut ; rien n’est enregistré tant que vous n’avez pas confirmé. |  |  |
| `banner.expo.next_other` | Your Expo token “{{label}}” is saved. {{count}} apps are not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the projects from app.json where it can; nothing is saved until you confirm. | Votre jeton Expo « {{label}} » est enregistré. {{count}} apps ne sont pas encore liées à un projet Expo : Builds n’affiche donc aucun build EAS. Kiln lit les projets dans app.json quand il le peut ; rien n’est enregistré tant que vous n’avez pas confirmé. |  |  |
| `banner.expo.text_one` | You have an Expo token (“{{label}}”), but {{count}} app is not linked to an Expo project yet. Link it to see its EAS builds, submissions and workflows. | Vous avez un jeton Expo (« {{label}} »), mais {{count}} app n’est pas encore liée à un projet Expo. Liez-la pour voir ses builds EAS, ses envois et ses workflows. |  | submit: soumettre vs envoyer |
| `banner.expo.text_other` | You have an Expo token (“{{label}}”), but {{count}} apps are not linked to an Expo project yet. Link them to see their EAS builds, submissions and workflows. | Vous avez un jeton Expo (« {{label}} »), mais {{count}} apps ne sont pas encore liées à un projet Expo. Liez-les pour voir leurs builds EAS, leurs envois et leurs workflows. |  | submit: soumettre vs envoyer |
| `banner.expo.title` | Connect your apps to Expo | Connecter vos apps à Expo |  |  |
| `banner.rc.next_one` | Your RevenueCat key “{{label}}” is saved. {{count}} app is not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Votre clé RevenueCat « {{label}} » est enregistrée. {{count}} app n’est pas encore liée à un projet RevenueCat : Produits n’affiche donc rien venant de RevenueCat. Kiln propose les correspondances ; rien n’est enregistré tant que vous n’avez pas confirmé. |  |  |
| `banner.rc.next_other` | Your RevenueCat key “{{label}}” is saved. {{count}} apps are not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Votre clé RevenueCat « {{label}} » est enregistrée. {{count}} apps ne sont pas encore liées à un projet RevenueCat : Produits n’affiche donc rien venant de RevenueCat. Kiln propose les correspondances ; rien n’est enregistré tant que vous n’avez pas confirmé. |  |  |
| `banner.rc.text_one` | You have a RevenueCat key (“{{label}}”), but {{count}} app is not linked to RevenueCat yet. Link it to see which products RevenueCat sells, with their entitlements and offerings. | Vous avez une clé RevenueCat (« {{label}} »), mais {{count}} app n’est pas encore liée à RevenueCat. Liez-la pour voir quels produits RevenueCat vend, avec leurs droits d’accès (entitlements) et leurs offres. |  |  |
| `banner.rc.text_other` | You have a RevenueCat key (“{{label}}”), but {{count}} apps are not linked to RevenueCat yet. Link them to see which products RevenueCat sells, with their entitlements and offerings. | Vous avez une clé RevenueCat (« {{label}} »), mais {{count}} apps ne sont pas encore liées à RevenueCat. Liez-les pour voir quels produits RevenueCat vend, avec leurs droits d’accès (entitlements) et leurs offres. |  |  |
| `banner.rc.title` | Connect your apps to RevenueCat | Connecter vos apps à RevenueCat |  |  |
| `callout.addKey` | Add a key in Credentials | Ajouter une clé dans Identifiants d’accès |  |  |
| `callout.expo.button` | Connect to Expo | Connecter à Expo |  |  |
| `callout.expo.title` | This app is not connected to Expo | Cette app n’est pas connectée à Expo |  |  |
| `callout.rc.button` | Connect to RevenueCat | Connecter à RevenueCat |  |  |
| `callout.rc.title` | This app is not connected to RevenueCat | Cette app n’est pas connectée à RevenueCat |  |  |
| `dialog.addKey` | Open Credentials | Ouvrir Identifiants d’accès |  |  |
| `dialog.askAdmin` | Only an owner or an admin can link apps. Ask one of them to connect them. | Seuls un propriétaire ou un administrateur peuvent lier des apps. Demandez à l’un d’eux de les connecter. |  |  |
| `dialog.confirm_one` | Link {{count}} app | Lier {{count}} app |  |  |
| `dialog.confirm_other` | Link {{count}} apps | Lier {{count}} apps |  |  |
| `dialog.description` | Review the matches Kiln found. Nothing is saved until you confirm. | Vérifiez les correspondances trouvées par Kiln. Rien n’est enregistré tant que vous n’avez pas confirmé. |  | review: avis (user) vs examen (App Review) |
| `dialog.expoHelp` | The project id is in app.json under extra.eas.projectId (running “eas init” adds it); you can also enter @account/slug. Kiln cannot list the projects your token sees. | L’identifiant du projet se trouve dans app.json, sous extra.eas.projectId (la commande « eas init » l’ajoute) ; vous pouvez aussi saisir @compte/slug. Kiln ne peut pas lister les projets que votre jeton voit. |  |  |
| `dialog.keyHint` | The key is only used to read. Nothing is changed. | La clé sert uniquement à lire. Rien n’est modifié. |  |  |
| `dialog.keyLabel.expo` | Expo token | Jeton Expo |  |  |
| `dialog.keyLabel.rc` | RevenueCat key | Clé RevenueCat |  |  |
| `dialog.lookUp` | Look up | Rechercher |  |  |
| `dialog.noKey.expo` | No Expo token is saved yet. Add an Expo access token first. | Aucun jeton Expo n’est encore enregistré. Ajoutez d’abord un jeton d’accès Expo. |  |  |
| `dialog.noKey.rc` | No RevenueCat key is saved yet. Add a RevenueCat secret key first. | Aucune clé RevenueCat n’est encore enregistrée. Ajoutez d’abord une clé secrète RevenueCat. |  |  |
| `dialog.nothingToDo` | Every app that {{name}} can serve is already linked. | Toutes les apps que {{name}} peut servir sont déjà liées. |  |  |
| `dialog.readingExpo` | Reading app.json of the linked repositories… | Lecture d’app.json dans les dépôts liés… |  |  |
| `dialog.readingRc` | Reading your RevenueCat projects and apps… | Lecture de vos projets et apps RevenueCat… |  |  |
| `dialog.reviewExpo` | Kiln read the Expo project id from app.json of each linked repository. Tick the apps to link, or type the project of an app yourself. | Kiln a lu l’identifiant du projet Expo dans app.json de chaque dépôt lié. Cochez les apps à lier, ou saisissez vous-même le projet d’une app. |  |  |
| `dialog.reviewRc` | Kiln matched each app to a RevenueCat app by its bundle id or package name and its store. Tick the apps to link. Where several RevenueCat apps fit, choose one: Kiln never guesses. | Kiln a associé chaque app à une app RevenueCat grâce à son identifiant de bundle ou son nom de package et à sa boutique. Cochez les apps à lier. Quand plusieurs apps RevenueCat conviennent, choisissez-en une : Kiln ne devine jamais. |  |  |
| `dialog.safeExpo` | Confirming only saves the link in Kiln. Expo is never changed. | La confirmation enregistre uniquement le lien dans Kiln. Expo n’est jamais modifié. |  |  |
| `dialog.safeRc` | Confirming only saves the link in Kiln. RevenueCat is never changed. | La confirmation enregistre uniquement le lien dans Kiln. RevenueCat n’est jamais modifié. |  |  |
| `dialog.saving` | Saving the links… | Enregistrement des liens… |  |  |
| `dialog.title` | Connect your apps to {{name}} | Connecter vos apps à {{name}} |  |  |
| `done.expo.appears` | Builds of each linked app now shows its EAS builds and submissions, and Settings offers EAS Workflows. | Builds de chaque app liée affiche désormais ses builds et envois EAS, et les Réglages proposent EAS Workflows. |  | submit: soumettre vs envoyer |
| `done.expo.empty` | The lists stay empty until Expo has been read for the first time (“Read Expo now”, or Read again on Builds), and for as long as the project has no build. | Les listes restent vides tant qu’Expo n’a pas été lu une première fois (« Lire Expo maintenant », ou Relire dans Builds), et tant que le projet n’a aucun build. |  |  |
| `done.failedRow` | Not linked: {{problem}} | Non liée : {{problem}} |  |  |
| `done.linkedRow` | Linked. | Liée. |  |  |
| `done.openBuilds` | Open Builds | Ouvrir Builds |  |  |
| `done.openProducts` | Open Products | Ouvrir Produits |  |  |
| `done.rc.appears` | Products of each linked app now has a RevenueCat column, with the entitlements and offerings that use each product, and the figures strip. | Produits de chaque app liée affiche désormais une colonne RevenueCat, avec les droits d’accès (entitlements) et les offres qui utilisent chaque produit, ainsi que la bande de chiffres. |  |  |
| `done.rc.empty` | They stay empty until the first sync: it is pending. Kiln has only saved the link; RevenueCat is read by “Sync products”. | Ils restent vides jusqu’à la première synchronisation : elle est en attente. Kiln a seulement enregistré le lien ; RevenueCat est lu par « Synchroniser les produits ». |  |  |
| `done.read.ok` | Read. | Lu. |  |  |
| `done.readExpo` | Read Expo now | Lire Expo maintenant |  |  |
| `done.syncProducts` | Sync products | Synchroniser les produits |  |  |
| `done.title_one` | {{count}} app linked to {{name}} | {{count}} app liée à {{name}} |  |  |
| `done.title_other` | {{count}} apps linked to {{name}} | {{count}} apps liées à {{name}} |  |  |
| `missing.expo.keyFound` | Kiln has your Expo token “{{label}}”, but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Link it in one step; nothing is changed in Expo. | Kiln a votre jeton Expo « {{label}} », mais cette app n’est pas liée à un projet Expo : Builds n’affiche donc ni build ni envoi EAS. Liez-la en une étape ; rien n’est modifié dans Expo. |  | submit: soumettre vs envoyer |
| `missing.expo.keyFoundAsk` | Kiln has an Expo token (“{{label}}”), but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Ask an owner or an admin to link it. | Kiln a un jeton Expo (« {{label}} »), mais cette app n’est pas liée à un projet Expo : Builds n’affiche donc ni build ni envoi EAS. Demandez à un propriétaire ou à un administrateur de la lier. |  | submit: soumettre vs envoyer |
| `missing.expo.noKey` | No Expo token is saved yet, and this app is not linked to an Expo project. Add an Expo access token in Credentials first, then link the app. | Aucun jeton Expo n’est encore enregistré, et cette app n’est pas liée à un projet Expo. Ajoutez d’abord un jeton d’accès Expo dans Identifiants d’accès, puis liez l’app. |  |  |
| `missing.expo.unknown` | This app is not linked to an Expo project, so Builds shows no EAS builds. An Expo token and the link are needed; an owner or an admin can set them up. | Cette app n’est pas liée à un projet Expo : Builds n’affiche donc aucun build EAS. Il faut un jeton Expo et le lien ; un propriétaire ou un administrateur peut les configurer. |  |  |
| `missing.rc.keyFound` | Kiln has your RevenueCat key “{{label}}”, but this app is not linked to a RevenueCat project, so the RevenueCat column, entitlements and offerings stay empty. Link it in one step; nothing is changed in RevenueCat. | Kiln a votre clé RevenueCat « {{label}} », mais cette app n’est pas liée à un projet RevenueCat : la colonne RevenueCat, les droits d’accès (entitlements) et les offres restent donc vides. Liez-la en une étape ; rien n’est modifié dans RevenueCat. |  |  |
| `missing.rc.keyFoundAsk` | Kiln has a RevenueCat key (“{{label}}”), but this app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. Ask an owner or an admin to link it. | Kiln a une clé RevenueCat (« {{label}} »), mais cette app n’est pas liée à un projet RevenueCat : rien venant de RevenueCat n’est affiché. Demandez à un propriétaire ou à un administrateur de la lier. |  |  |
| `missing.rc.noKey` | No RevenueCat key is saved yet, and this app is not linked to a RevenueCat project. Add a RevenueCat secret key in Credentials first, then link the app. | Aucune clé RevenueCat n’est encore enregistrée, et cette app n’est pas liée à un projet RevenueCat. Ajoutez d’abord une clé secrète RevenueCat dans Identifiants d’accès, puis liez l’app. |  |  |
| `missing.rc.unknown` | This app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. A RevenueCat key and the link are needed; an owner or an admin can set them up. | Cette app n’est pas liée à un projet RevenueCat : rien venant de RevenueCat n’est affiché. Il faut une clé RevenueCat et le lien ; un propriétaire ou un administrateur peut les configurer. |  |  |
| `rc.choiceInProject` | {{project}}: {{choice}} | {{project}} : {{choice}} |  |  |
| `row.checkAria` | Link {{name}} | Lier {{name}} |  |  |
| `row.expo.inputAria` | Expo project of {{name}} | Projet Expo de {{name}} |  |  |
| `row.expo.none` | No project found. Type its id or @account/slug. | Aucun projet trouvé. Saisissez son identifiant ou @compte/slug. |  |  |
| `row.expo.placeholder` | Project id or @account/slug | Identifiant du projet ou @compte/slug |  |  |
| `row.expo.proposed` | Project read from app.json. | Projet lu dans app.json. |  |  |
| `row.linked` | Already linked | Déjà liée |  |  |
| `row.rc.ambiguous` | Several RevenueCat apps fit. Choose one. | Plusieurs apps RevenueCat conviennent. Choisissez-en une. |  |  |
| `row.rc.choose` | Choose a RevenueCat app | Choisir une app RevenueCat |  |  |
| `row.rc.none` | No match by identifier. Choose a RevenueCat app, or leave the app unlinked. | Aucune correspondance par identifiant. Choisissez une app RevenueCat, ou laissez l’app non liée. |  |  |
| `row.rc.nothing` | No RevenueCat app of this store was found with this key. | Aucune app RevenueCat de cette boutique n’a été trouvée avec cette clé. |  |  |
| `row.rc.proposed` | Match found: the bundle id or package name and the store agree. | Correspondance trouvée : l’identifiant de bundle ou le nom de package et la boutique concordent. |  |  |
| `row.rc.selectAria` | RevenueCat app for {{name}} | App RevenueCat pour {{name}} |  |  |

## web/credentials (21)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `identifier.appId` | App ID | ID de l’app |  |  |
| `identifier.clientEmail` | Service account | Compte de service |  |  |
| `identifier.clientId` | Client ID | ID client |  |  |
| `identifier.copy` | Copy {{label}} | Copier {{label}} |  |  |
| `identifier.hide` | Hide identifiers | Masquer les identifiants |  |  |
| `identifier.hideAria` | Hide the identifiers of {{label}} | Masquer les identifiants de {{label}} |  |  |
| `identifier.installationId` | Installation ID | ID d’installation |  |  |
| `identifier.none` | No identifiers to show for this type of credential. | Aucun identifiant à afficher pour ce type d’identifiants. |  |  |
| `identifier.projectId` | Project ID | ID du projet |  |  |
| `identifier.region` | Region | Région |  |  |
| `identifier.serviceKeyId` | Private key ID | ID de la clé privée |  |  |
| `identifier.show` | Show identifiers | Afficher les identifiants |  |  |
| `identifier.showAria` | Show the identifiers of {{label}} | Afficher les identifiants de {{label}} |  |  |
| `identifier.title` | Identifiers (not secret) | Identifiants (non secrets) |  |  |
| `identifier.tokenKind.classic` | Personal access token (classic) | Jeton d’accès personnel (classique) |  |  |
| `identifier.tokenKind.fineGrained` | Fine-grained personal access token | Jeton d’accès personnel à granularité fine |  |  |
| `identifier.tokenKind.installation` | GitHub App installation token | Jeton d’installation d’une GitHub App |  |  |
| `identifier.tokenKind.oauth` | OAuth token | Jeton OAuth |  |  |
| `identifier.tokenKind.userToServer` | GitHub App user token | Jeton utilisateur d’une GitHub App |  |  |
| `identifier.tokenType` | Token type | Type de jeton |  |  |
| `table.rotatedAgo` | Secret replaced {{when}} | Secret remplacé {{when}} |  |  |

## web/eas (40)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `overview.aria` | Expo builds and submissions | Builds et soumissions Expo |  | submit: soumettre vs envoyer |
| `overview.latestBuild` | Latest build | Dernier build |  |  |
| `overview.latestSubmission` | Latest submission | Dernière soumission |  | submit: soumettre vs envoyer |
| `overview.link` | Link it to Expo | Le lier à Expo |  |  |
| `overview.loading` | Reading the stored builds… | Lecture des builds enregistrés… |  |  |
| `overview.noBuild` | No build yet | Aucun build pour l’instant |  |  |
| `overview.noBuilds` | No EAS build or submission is stored yet. They appear after the first build or the next refresh. | Aucun build ni aucune soumission EAS n’est encore enregistré. Ils apparaîtront après le premier build ou la prochaine actualisation. |  | submit: soumettre vs envoyer |
| `overview.noSubmission` | No submission yet | Aucune soumission pour l’instant |  | submit: soumettre vs envoyer |
| `overview.notLinked` | Not linked to an Expo project yet, so no builds or submissions show here. | Pas encore lié à un projet Expo : aucun build ni aucune soumission à afficher ici. |  | submit: soumettre vs envoyer |
| `overview.openBuilds` | Open Builds | Ouvrir Builds |  |  |
| `overview.ota.branch` | Branch {{branch}} | Branche {{branch}} |  |  |
| `overview.ota.empty` | No update is stored for this platform. | Aucune mise à jour n’est enregistrée pour cette plateforme. |  |  |
| `overview.ota.failedNever` | The updates could not be read. | Les mises à jour n’ont pas pu être lues. |  |  |
| `overview.ota.never` | The updates have not been read yet. Read again from Builds. | Les mises à jour n’ont pas encore été lues. Relisez-les depuis Builds. |  |  |
| `overview.ota.openBuilds` | EAS updates in Builds | Mises à jour EAS dans Builds |  |  |
| `overview.ota.openExpo` | Open at Expo | Ouvrir chez Expo |  |  |
| `overview.ota.rollout` | {{percentage}}% rollout | Déploiement à {{percentage}} % |  | rollout = déploiement |
| `overview.ota.title` | Current update per channel | Mise à jour en cours par canal |  |  |
| `overview.ota.updated` | Updated {{when}}. | Mis à jour {{when}}. |  |  |
| `overview.ota.updatedFailed` | The last read failed. Showing what was stored {{when}}. | La dernière lecture a échoué. Données enregistrées {{when}}. |  |  |
| `overview.unavailable` | The stored {{platform}} builds could not be read. | Les builds {{platform}} enregistrés n’ont pas pu être lus. |  |  |
| `releaseSteps.built.current` | Build running | Build en cours |  |  |
| `releaseSteps.built.done` | Build finished | Build terminé |  |  |
| `releaseSteps.built.failed` | Build failed or cancelled | Build échoué ou annulé |  |  |
| `releaseSteps.ota.channel` | channel {{channel}} | canal {{channel}} |  |  |
| `releaseSteps.ota.open` | Open at Expo | Ouvrir chez Expo |  |  |
| `releaseSteps.ota.published` | OTA update published | Mise à jour OTA publiée |  |  |
| `releaseSteps.review.current` | In store review | En revue par le store |  | review: avis (user) vs examen (App Review) |
| `releaseSteps.review.done` | Store review passed | Revue du store passée |  | review: avis (user) vs examen (App Review) |
| `releaseSteps.review.failed` | Rejected in store review | Rejeté lors de la revue du store |  | review: avis (user) vs examen (App Review) |
| `releaseSteps.review.todo` | Store review not started | Revue du store pas commencée |  | review: avis (user) vs examen (App Review) |
| `releaseSteps.submitted.current` | Submitting to the store | Soumission au store en cours |  | submit: soumettre vs envoyer |
| `releaseSteps.submitted.done` | Submitted to the store | Soumis au store |  | submit: soumettre vs envoyer |
| `releaseSteps.submitted.failed` | Submission failed or cancelled | Soumission échouée ou annulée |  | submit: soumettre vs envoyer |
| `releaseSteps.submitted.todo` | Not submitted through EAS | Non soumis via EAS |  | submit: soumettre vs envoyer |
| `releaseSteps.title` | Build and submission (Expo EAS) | Build et soumission (Expo EAS) |  | submit: soumettre vs envoyer |
| `submissions.none` | EAS has not sent a build of this app to a store yet. | EAS n’a pas encore envoyé de build de cette app à un store. |  |  |
| `submissions.noneTitle` | No submissions yet | Aucune soumission |  | submit: soumettre vs envoyer |
| `submissions.notLinked` | Link this app to an Expo project to see the builds it sent to the stores. | Liez cette app à un projet Expo pour voir les builds envoyés aux stores. |  |  |
| `submissions.notLinkedTitle` | Not linked to Expo | Non lié à Expo |  |  |

## web/errors (79)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `ads.accountMissing` | That ad account is not one the key can read. Choose one from the list. | Ce compte publicitaire n’en est pas un que la clé peut lire. Choisissez-en un dans la liste. |  |  |
| `ads.adamRequired` | Enter the Apple id of the app (the number in its App Store address, after id). It is the app's store id, which this record does not have yet. | Saisissez l’identifiant Apple de l’application (le nombre dans son adresse App Store, après id). C’est l’identifiant de l’application dans le store, que cette fiche n’a pas encore. |  |  |
| `ads.auth` | Apple did not accept the key. Check that the public key of this private key is saved in Apple Ads (Account Settings, API) and that the client ID, team ID and key ID are the ones Apple Ads showed after saving it. | Apple n’a pas accepté la clé. Vérifiez que la clé publique de cette clé privée est enregistrée dans Apple Ads (Paramètres du compte, API) et que l’ID client, l’ID d’équipe et l’ID de clé sont ceux qu’Apple Ads a affichés après l’enregistrement. |  |  |
| `ads.forbidden` | Apple Ads accepted the key, but this user may not read the ad account. Give the API user a role with read access, such as API Account Read Only, in Apple Ads. | Apple Ads a accepté la clé, mais cet utilisateur ne peut pas lire le compte publicitaire. Donnez à l’utilisateur de l’API un rôle avec accès en lecture, comme API Account Read Only, dans Apple Ads. |  |  |
| `ads.invalidInput` | That is not a valid Apple Ads request. | Ce n’est pas une requête Apple Ads valide. |  |  |
| `ads.invalidKey` | The private key could not be read. Paste the whole private-key.pem file, from -----BEGIN EC PRIVATE KEY----- to -----END EC PRIVATE KEY-----. It must be a P-256 key. | La clé privée n’a pas pu être lue. Collez le fichier private-key.pem en entier, de -----BEGIN EC PRIVATE KEY----- à -----END EC PRIVATE KEY-----. Ce doit être une clé P-256. |  |  |
| `ads.network` | Could not reach Apple Ads. Check that this server has internet access (and a proxy, if it needs one) to appleid.apple.com and api.ads.apple.com, then try again. | Impossible de joindre Apple Ads. Vérifiez que ce serveur a accès à internet (et à un proxy, s’il en faut un) vers appleid.apple.com et api.ads.apple.com, puis réessayez. |  |  |
| `ads.noAccount` | Apple Ads accepted the key, but it sees no ad account. Invite the API user to the account in Apple Ads (Account Settings, User Management). | Apple Ads a accepté la clé, mais elle ne voit aucun compte publicitaire. Invitez l’utilisateur de l’API sur le compte dans Apple Ads (Paramètres du compte, Gestion des utilisateurs). |  |  |
| `ads.notFound` | Apple Ads has no such ad account or campaign, or the key cannot see it. | Apple Ads n’a ni ce compte publicitaire ni cette campagne, ou la clé ne peut pas les voir. |  |  |
| `ads.notLinked` | This app is not linked to an Apple Ads account. Link it in the app settings first. | Cette application n’est pas liée à un compte Apple Ads. Liez-la d’abord dans les paramètres de l’application. |  |  |
| `ads.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads concerne les applications de l’App Store. Cette application n’en est pas une. |  |  |
| `ads.rateLimited` | Apple Ads asked to slow down. Try again in a minute. | Apple Ads demande de ralentir. Réessayez dans une minute. |  |  |
| `ads.requestFailed` | The Apple Ads request could not be completed. Try again in a moment. | La requête Apple Ads n’a pas pu aboutir. Réessayez dans un instant. |  |  |
| `ads.server` | Apple Ads had a problem. Try again in a few minutes. | Apple Ads a rencontré un problème. Réessayez dans quelques minutes. |  |  |
| `ads.timeout` | Apple Ads did not answer in time. Try again in a minute. | Apple Ads n’a pas répondu à temps. Réessayez dans une minute. |  |  |
| `ads.unexpected` | Apple Ads answered with something this server could not read. | Apple Ads a répondu quelque chose que ce serveur n’a pas pu lire. |  |  |
| `app.listingSettingInvalid` | A listing setting is not valid. | Un paramètre de la fiche n'est pas valide. |  | listing = fiche |
| `aso.playListingNotWatched` | Kiln does not read Google Play pages, so the listing of a Google Play competitor is not watched. | Kiln ne lit pas les pages Google Play : la fiche d’un concurrent Google Play n’est donc pas surveillée. |  | listing = fiche |
| `aso.searchAppStoreOnly` | Search by name is for App Store apps. For Google Play, paste the package name or the play.google.com address. | La recherche par nom est réservée aux apps de l’App Store. Pour Google Play, collez le nom du paquet ou l’adresse play.google.com. |  |  |
| `assetProposal.hasIssues` | Some of the selected items have errors. Confirm them to stage them anyway. | Certains éléments sélectionnés présentent des erreurs. Confirmez pour les préparer quand même. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `assetProposal.unavailable` | There is nothing to stage for this release: the app has no repository, or the repository holds no store listing for it. | Il n’y a rien à préparer pour cette version : l’application n’a pas de dépôt, ou le dépôt ne contient aucune fiche pour elle. |  | stage = prepare locally, nothing is sent: see staged glossary row; release = publication |
| `chat.hostNotAllowed` | A {{provider}} webhook address comes from {{hosts}}. Allow other hosts on the destination to use another address. | Une adresse de webhook {{provider}} provient de {{hosts}}. Autorisez d’autres hôtes sur la destination pour utiliser une autre adresse. |  |  |
| `chat.tooManyDestinations_one` | A workspace can have at most {{count}} chat destination. | Un espace de travail peut avoir au plus {{count}} destination de discussion. |  |  |
| `chat.tooManyDestinations_other` | A workspace can have at most {{count}} chat destinations. | Un espace de travail peut avoir au plus {{count}} destinations de discussion. |  |  |
| `chat.urlInvalid` | That address cannot be used. Use the https webhook address from Slack or Teams. | Cette adresse ne peut pas être utilisée. Utilisez l’adresse de webhook https fournie par Slack ou Teams. |  |  |
| `credential.notAppleAdsKind` | Apple Ads needs a credential of the Apple Ads API user key kind. | Apple Ads a besoin d’un identifiant d’accès de type clé d’utilisateur de l’API Apple Ads. |  |  |
| `experiments.datesOrder` | The end date is before the start date. | La date de fin est antérieure à la date de début. |  |  |
| `experiments.noteNotFound` | No such note. | Cette note n’existe pas. |  |  |
| `experiments.tooManyNotes` | An app can have {{limit}} notes. Delete one first. | Une application peut avoir {{limit}} notes. Supprimez-en une d’abord. |  |  |
| `experiments.unsupported` | The store of this app has no API for experiments or custom pages. Use the manual tracker and the links to its console. | Le store de cette application n’a pas d’API pour les tests ou les pages personnalisées. Utilisez le suivi manuel et les liens vers sa console. |  |  |
| `listing.fixNotAvailable` | This fix no longer applies: the text changed or it is already fixed. Reload and look again. | Cette correction ne s'applique plus : le texte a changé ou il est déjà corrigé. Rechargez et regardez à nouveau. |  |  |
| `listing.staleFix` | The text changed since you looked at this fix. Reload and review it again. | Le texte a changé depuis que vous avez vu cette correction. Rechargez et relisez-la. |  | review: avis (user) vs examen (App Review) |
| `prices.ackRequired` | This change needs an explicit acknowledgement before it can be staged or sent. | Cette modification demande une confirmation explicite avant d’être préparée ou envoyée. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `prices.ackUnknown` | Not a known acknowledgement. | Confirmation inconnue. |  |  |
| `prices.amountNotPricePoint` | Apple only sells at its price points. This amount is not one: pick the nearest. | Apple ne vend qu’à ses paliers de prix. Ce montant n’en est pas un : choisissez le plus proche. |  |  |
| `prices.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Un montant doit être en unités mineures entières, par exemple 499 pour 4,99. |  |  |
| `prices.badChoice` | Not a known choice for existing subscribers or acknowledgement. | Choix inconnu pour les abonnés actuels ou confirmation inconnue. |  |  |
| `prices.badProduct` | Not a valid product. | Produit non valide. |  |  |
| `prices.badTerritory` | Not a territory of this store. | Ce pays ou cette région n’existe pas dans cette boutique. |  |  |
| `prices.busy` | A price change for this app is in progress. Wait for it to finish. | Une modification de prix de cette application est en cours. Attendez la fin de l’opération. |  |  |
| `prices.confirmationMismatch` | The confirmation phrase is not the one for these price changes. Nothing was sent. | La phrase de confirmation ne correspond pas à ces changements de prix. Rien n’a été envoyé. |  |  |
| `prices.convertBase` | Name a base territory the plan has a price in, and an amount in minor units. | Indiquez un pays ou une région de base où le plan a un prix, et un montant en unités mineures. |  |  |
| `prices.convertNotApplicable` | Only Google Play converts one price to other regions. | Seul Google Play convertit un prix pour d’autres régions. |  |  |
| `prices.currencyMismatch` | The currency is not the currency of that territory. | Cette devise n’est pas celle de ce pays ou de cette région. |  |  |
| `prices.dateInvalid` | Not a date: use YYYY-MM-DD. | Date non valide : utilisez AAAA-MM-JJ. |  |  |
| `prices.datePast` | The date is in the past. | La date est dans le passé. |  |  |
| `prices.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Cette boutique applique un prix dès qu’il est envoyé : il ne peut pas être daté. |  |  |
| `prices.disabledServer` | Price changes are switched off on this server. Set KILN_PRICE_WRITES_ENABLED=true to turn it on (see docs/deployment.md). | Les changements de prix sont désactivés sur ce serveur. Définissez KILN_PRICE_WRITES_ENABLED=true pour les activer (voir docs/deployment.md). |  |  |
| `prices.disabledWorkspace` | Price changes are switched off for this workspace. An owner or admin can turn on the setting prices.writeEnabled. | Les changements de prix sont désactivés pour cet espace de travail. Un propriétaire ou un administrateur peut activer le réglage prices.writeEnabled. |  |  |
| `prices.duplicateTerritory` | A territory is named twice. | Un pays ou une région est indiqué deux fois. |  |  |
| `prices.noChange` | The new price is the price the store already shows. | Le nouveau prix est celui que la boutique affiche déjà. |  |  |
| `prices.noLines` | Name at least one territory. | Indiquez au moins un pays ou une région. |  |  |
| `prices.notPositive` | A price must be greater than zero. | Un prix doit être supérieur à zéro. |  |  |
| `prices.planMissing` | Name the base plan or purchase option. | Indiquez le plan de base ou l’option d’achat. |  |  |
| `prices.planNotAllowed` | This product has no such plan. | Ce produit n’a pas un tel plan. |  |  |
| `prices.pricePointMismatch` | The amount is not the amount of that price point. | Le montant n’est pas celui de ce palier de prix. |  |  |
| `prices.pricePointMissing` | Apple prices are chosen from price points: pick one. | Les prix Apple se choisissent parmi des paliers de prix : choisissez-en un. |  |  |
| `prices.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Les prix Google Play sont des montants, pas des paliers de prix. |  |  |
| `prices.pricePointTerritory` | That price point belongs to another territory. | Ce palier de prix appartient à un autre pays ou une autre région. |  |  |
| `prices.pricePointUnknown` | That price point does not exist for this product. | Ce palier de prix n’existe pas pour ce produit. |  |  |
| `prices.stale` | The price changed since you looked at it. Sync the app and review again. | Le prix a changé depuis votre consultation. Synchronisez l’application et vérifiez à nouveau. |  | review: avis (user) vs examen (App Review) |
| `prices.staleSnapshot` | The product was synced again since you opened it. Reload it and review the prices again. | Le produit a été synchronisé à nouveau depuis son ouverture. Rechargez-le et vérifiez à nouveau les prix. |  | review: avis (user) vs examen (App Review) |
| `prices.subscriberRule` | That choice for existing subscribers does not exist in this store. | Ce choix pour les abonnés actuels n’existe pas dans cette boutique. |  |  |
| `prices.tooHigh` | That price is above the highest price Kiln allows. | Ce prix dépasse le prix maximal autorisé par Kiln. |  |  |
| `prices.tooManyTerritories` | Too many territories in one change. | Trop de pays ou de régions dans une seule modification. |  |  |
| `prices.unknownState` | It is not known whether the last price change of this app reached the store. Run a dry run: it reads the store and shows where it stands. Nothing was sent. | On ne sait pas si la dernière modification de prix de cette application a atteint la boutique. Lancez une simulation : elle lit la boutique et montre où en sont les prix. Rien n’a été envoyé. |  |  |
| `prices.unknownTerritory` | The product has no price in that territory. | Le produit n’a pas de prix dans ce pays ou cette région. |  |  |
| `rate.ads_one` | Too many Apple Ads checks. Try again in {{count}} second. | Trop de vérifications Apple Ads. Réessayez dans {{count}} seconde. |  |  |
| `rate.ads_other` | Too many Apple Ads checks. Try again in {{count}} seconds. | Trop de vérifications Apple Ads. Réessayez dans {{count}} secondes. |  |  |
| `staged.metadataLocked` | Version {{version}} is live or in App Review, so its listing can no longer be changed. Prepare a new version first, then stage the change. | La version {{version}} est en ligne ou en cours d’examen : sa fiche ne peut plus être modifiée. Préparez d’abord une nouvelle version, puis préparez la modification. |  | stage = prepare locally, nothing is sent: see staged glossary row; listing = fiche |
| `staged.storeImageFormat` | Image {{position}} of this set is stored as a format that cannot be pushed (only PNG and JPEG can), so the set cannot be edited here. | L’image {{position}} de cet ensemble est dans un format qui ne peut pas être envoyé (seuls PNG et JPEG le peuvent) : l’ensemble ne peut pas être modifié ici. |  |  |
| `staged.storeImageMismatch` | Image {{position}} of this set does not match the checksum the store gave, so it was not taken. Read the store again. | L’image {{position}} de cet ensemble ne correspond pas à la somme de contrôle donnée par le store : elle n’a pas été prise. Relisez le store. |  |  |
| `testflight.assigneeNotMember` | The assignee is not a member of this workspace. | La personne assignée n’est pas membre de cet espace de travail. |  |  |
| `testflight.notFound` | No such feedback. | Ce retour n’existe pas. |  |  |
| `testflight.unsupported` | The store of this app has no TestFlight feedback. Only App Store Connect apps (iOS and macOS) have it. | Le store de cette application n’a pas de retours TestFlight. Seules les applications App Store Connect (iOS et macOS) en ont. |  |  |
| `timeline.eventNotFound` | That event no longer exists. | Cet événement n'existe plus. |  |  |
| `timeline.invalidRange` | That date range is not valid. Pick days that exist and keep the range short enough. | Cette période n'est pas valide. Choisissez des jours qui existent et une période assez courte. |  |  |
| `timeline.tooManyEvents_one` | An app can have at most {{limit}} event of its own. Delete one first. | Une app peut avoir au plus {{limit}} événement à elle. Supprimez-en un d'abord. |  |  |
| `timeline.tooManyEvents_other` | An app can have at most {{limit}} events of its own. Delete one first. | Une app peut avoir au plus {{limit}} événements à elle. Supprimez-en un d'abord. |  |  |

## web/experiments (133)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `assets.none` | No media read | Aucun média lu |  |  |
| `assets.other_one` | {{count}} other asset | {{count}} autre élément |  |  |
| `assets.other_other` | {{count}} other assets | {{count}} autres éléments |  |  |
| `assets.previews_one` | {{count}} preview | {{count}} aperçu |  |  |
| `assets.previews_other` | {{count}} previews | {{count}} aperçus |  |  |
| `assets.screenshots_one` | {{count}} screenshot | {{count}} capture d’écran |  |  |
| `assets.screenshots_other` | {{count}} screenshots | {{count}} captures d’écran |  |  |
| `assets.sets_one` | {{count}} screenshot set | {{count}} jeu de captures d’écran |  |  |
| `assets.sets_other` | {{count}} screenshot sets | {{count}} jeux de captures d’écran |  |  |
| `dates.notStarted` | Not started | Pas commencé |  |  |
| `dates.range` | {{from}} to {{to}} | Du {{from}} au {{to}} |  |  |
| `dates.since` | Since {{date}} | Depuis le {{date}} |  |  |
| `dates.until` | Until {{date}} | Jusqu’au {{date}} |  |  |
| `experiments.aria` | Product Page Optimization experiments of {{app}} | Tests d’optimisation de la page produit de {{app}} |  |  |
| `experiments.colDates` | Dates | Dates |  |  |
| `experiments.colName` | Experiment | Test |  |  |
| `experiments.colState` | Status | Statut |  |  |
| `experiments.colTraffic` | Traffic | Trafic |  |  |
| `experiments.colTreatments` | Treatments | Variantes |  |  |
| `experiments.emptyDescription` | This app has no Product Page Optimization experiment. Apple needs the app to be live on the App Store, and a test takes up to three treatments. Create one in App Store Connect, then sync again. | Cette application n’a aucun test d’optimisation de la page produit. Apple exige que l’application soit en ligne sur l’App Store, et un test accepte jusqu’à trois variantes. Créez-en un dans App Store Connect, puis synchronisez à nouveau. |  | live = en ligne |
| `experiments.emptyTitle` | No experiments | Aucun test |  |  |
| `experiments.heading` | Product Page Optimization experiments | Tests d’optimisation de la page produit |  |  |
| `experiments.neverDescription` | Sync to read the experiments of this app from App Store Connect. Nothing is changed in the store. | Synchronisez pour lire les tests de cette application depuis App Store Connect. Rien n’est modifié dans le store. |  |  |
| `experiments.neverTitle` | Experiments not read yet | Tests pas encore lus |  |  |
| `experiments.noTreatments` | No treatments read | Aucune variante lue |  |  |
| `experiments.reviewRequired` | Needs App Review | Passe par l’examen App Review |  | review: avis (user) vs examen (App Review) |
| `experiments.runningByDates` | Inside its run dates | Dans ses dates d’exécution |  |  |
| `google.body` | The Google Play developer API has no store listing experiments and no custom store listings, so Kiln cannot read or change them. Manage them in the Play Console and keep your own record below. | L’API développeur de Google Play n’a ni tests de fiche ni fiches personnalisées : Kiln ne peut ni les lire ni les modifier. Gérez-les dans la Google Play Console et tenez votre propre suivi ci-dessous. |  | listing = fiche |
| `google.limitExperiments` | One default graphics experiment, or up to five localized experiments, can run at the same time. An experiment stops by itself after 6 months. | Un test des visuels par défaut, ou jusqu’à cinq tests localisés, peuvent tourner en même temps. Un test s’arrête de lui-même après 6 mois. |  |  |
| `google.limitListings` | An app can have up to 50 custom store listings, each reached by its own address. | Une application peut avoir jusqu’à 50 fiches personnalisées, chacune accessible par sa propre adresse. |  | listing = fiche |
| `google.title` | Experiments and custom listings live in the Play Console | Les tests et les fiches personnalisées se gèrent dans la Google Play Console |  | listing = fiche; live = en ligne |
| `noteDialog.addTitle` | Add a note | Ajouter une note |  |  |
| `noteDialog.description` | Kiln keeps this note for you. Nothing is sent to a store. | Kiln garde cette note pour vous. Rien n’est envoyé à un store. |  |  |
| `noteDialog.editTitle` | Change the note | Modifier la note |  |  |
| `noteDialog.endedOn` | Ended on | Terminé le |  |  |
| `noteDialog.kind` | About | Sujet |  |  |
| `noteDialog.listing` | Listing parameter | Paramètre de la fiche |  | listing = fiche |
| `noteDialog.listingHint` | The value after listing= in the address of the custom store listing. Lowercase letters, digits and . - _ ~ | La valeur après listing= dans l’adresse de la fiche personnalisée. Minuscules, chiffres et . - _ ~ |  | listing = fiche |
| `noteDialog.name` | Name | Nom |  |  |
| `noteDialog.namePlaceholder` | For example: Icon test, spring campaign | Par exemple : test de l’icône, campagne de printemps |  |  |
| `noteDialog.note` | Notes | Notes |  |  |
| `noteDialog.noteHint` | What you tested and what you learned. Up to 2,000 characters. | Ce que vous avez testé et ce que vous avez appris. 2 000 caractères au maximum. |  |  |
| `noteDialog.saveFailed` | The note could not be saved. Try again. | La note n’a pas pu être enregistrée. Réessayez. |  |  |
| `noteDialog.saveFailedTitle` | Could not save the note | Impossible d’enregistrer la note |  |  |
| `noteDialog.startedOn` | Started on | Commencé le |  |  |
| `noteDialog.status` | Status | Statut |  |  |
| `noteDialog.url` | Link | Lien |  |  |
| `noteDialog.urlHint` | Optional: the address of the page or the console view. | Facultatif : l’adresse de la page ou de l’écran de la console. |  |  |
| `noteKind.customPage` | Custom page | Page personnalisée |  |  |
| `noteKind.experiment` | Experiment | Test |  |  |
| `noteStatus.finished` | Finished | Terminé |  |  |
| `noteStatus.planned` | Planned | Prévu |  |  |
| `noteStatus.running` | Running | En cours |  |  |
| `noteStatus.stopped` | Stopped | Arrêté |  |  |
| `notes.add` | Add a note | Ajouter une note |  |  |
| `notes.delete` | Delete | Supprimer |  |  |
| `notes.deleteFailed` | The note could not be deleted. Try again. | La note n’a pas pu être supprimée. Réessayez. |  |  |
| `notes.deleteFailedTitle` | Could not delete the note | Impossible de supprimer la note |  |  |
| `notes.deleted` | Note deleted. | Note supprimée. |  |  |
| `notes.edit` | Edit | Modifier |  |  |
| `notes.emptyDescriptionApple` | Write down what you plan to test or what you learned. Kiln does not read this from the App Store. | Notez ce que vous prévoyez de tester ou ce que vous avez appris. Kiln ne lit pas ces informations depuis l’App Store. |  |  |
| `notes.emptyDescriptionGoogle` | Google Play has no API for experiments or custom listings, so this list is the record Kiln can keep: what you test, when, and what you learned. | Google Play n’a pas d’API pour les tests ni les fiches personnalisées : cette liste est le suivi que Kiln peut tenir, avec ce que vous testez, quand, et ce que vous avez appris. |  | listing = fiche |
| `notes.emptyTitle` | No notes yet | Aucune note pour l’instant |  |  |
| `notes.heading` | Manual tracker | Suivi manuel |  |  |
| `notes.leadApple` | Your own notes about tests and pages, kept in Kiln. They are not read from or sent to the store. | Vos propres notes sur les tests et les pages, conservées dans Kiln. Elles ne sont ni lues depuis le store ni envoyées vers lui. |  |  |
| `notes.leadGoogle` | Kiln cannot read Google Play experiments or custom listings. Keep your own record here and open the Play Console to run them. | Kiln ne peut pas lire les tests ni les fiches personnalisées de Google Play. Tenez votre suivi ici et ouvrez la Google Play Console pour les lancer. |  | listing = fiche |
| `notes.openLink` | Open the link | Ouvrir le lien |  |  |
| `notes.openListing` | Open the listing on Google Play | Ouvrir la fiche sur Google Play |  | listing = fiche |
| `pages.aria` | Custom product pages of {{app}} | Pages produit personnalisées de {{app}} |  |  |
| `pages.colActions` | Actions | Actions |  |  |
| `pages.colDeepLink` | Deep link | Lien profond |  |  |
| `pages.colLanguages` | Languages | Langues |  |  |
| `pages.colName` | Page | Page |  |  |
| `pages.colState` | Status | Statut |  |  |
| `pages.copyLink` | Copy the address | Copier l’adresse |  |  |
| `pages.emptyDescription` | This app has no custom product page. An app can have up to 70, each with its own screenshots, previews and promotional text. Create them in App Store Connect, then sync again. | Cette application n’a aucune page produit personnalisée. Une application peut en avoir jusqu’à 70, chacune avec ses captures d’écran, ses aperçus et son texte promotionnel. Créez-les dans App Store Connect, puis synchronisez à nouveau. |  |  |
| `pages.emptyTitle` | No custom product pages | Aucune page produit personnalisée |  |  |
| `pages.heading` | Custom product pages | Pages produit personnalisées |  |  |
| `pages.hidden` | Not visible | Non visible |  |  |
| `pages.iosOnly` | Custom product pages are for iPhone and iPad apps: read them on the iOS record of this app. | Les pages produit personnalisées concernent les applications iPhone et iPad : lisez-les sur l’enregistrement iOS de cette application. |  |  |
| `pages.neverDescription` | Sync to read the custom product pages of this app from App Store Connect. | Synchronisez pour lire les pages produit personnalisées de cette application depuis App Store Connect. |  |  |
| `pages.neverTitle` | Custom product pages not read yet | Pages produit personnalisées pas encore lues |  |  |
| `pages.noDeepLink` | None | Aucun |  |  |
| `pages.open` | Open | Ouvrir |  |  |
| `results.body` | Apple's API does not give the results of a test (impressions, conversion, confidence) or the numbers of a custom product page. They are in App Store Connect, under App Analytics. | L’API d’Apple ne fournit ni les résultats d’un test (impressions, conversion, confiance) ni les chiffres d’une page produit personnalisée. Ils se trouvent dans App Store Connect, sous App Analytics. |  |  |
| `results.link` | Open {{console}} | Ouvrir {{console}} |  |  |
| `results.title` | Results are in App Store Connect | Les résultats se trouvent dans App Store Connect |  |  |
| `state.approved` | Approved | Approuvé |  |  |
| `state.completed` | Completed | Terminé |  |  |
| `state.draft` | Draft | Brouillon |  |  |
| `state.inReview` | In review | En cours d’examen |  | review: avis (user) vs examen (App Review) |
| `state.rejected` | Rejected | Rejeté |  |  |
| `state.replaced` | Replaced | Remplacé |  |  |
| `state.stopped` | Stopped | Arrêté |  |  |
| `state.unknown` | Unknown | Inconnu |  |  |
| `sync.failedKept` | The last sync failed. Showing what was read {{ago}}. {{error}} | La dernière synchronisation a échoué. Affichage de ce qui a été lu {{ago}}. {{error}} |  |  |
| `sync.failedNothing` | The last sync failed. {{error}} | La dernière synchronisation a échoué. {{error}} |  |  |
| `sync.never` | Not read yet. Sync to read the experiments and custom product pages. | Pas encore lu. Synchronisez pour lire les tests et les pages produit personnalisées. |  |  |
| `sync.partial` | Read {{ago}}. The lists were cut at their limit: the store may have more. | Lu {{ago}}. Les listes ont été coupées à leur limite : le store peut en avoir davantage. |  |  |
| `sync.read` | Read {{ago}}. | Lu {{ago}}. |  |  |
| `tab.about` | About experiments | À propos des tests |  |  |
| `tab.aboutApple` | Apple's Product Page Optimization tests up to three treatments of your product page against the original, and custom product pages give a campaign its own page. Kiln reads them from App Store Connect. | L’optimisation de la page produit d’Apple teste jusqu’à trois variantes de votre page produit face à l’originale, et les pages produit personnalisées donnent à une campagne sa propre page. Kiln les lit depuis App Store Connect. |  |  |
| `tab.aboutGoogle` | Google Play calls them store listing experiments and custom store listings. They are managed in the Play Console only. | Google Play les appelle tests de fiche et fiches personnalisées. Ils se gèrent uniquement dans la Google Play Console. |  | listing = fiche |
| `tab.aboutReadOnly` | Kiln reads and shows them. It cannot create, start, stop or change an experiment or a page: do that in the store's console. | Kiln les lit et les affiche. Il ne peut ni créer, ni démarrer, ni arrêter, ni modifier un test ou une page : faites-le dans la console du store. |  |  |
| `tab.headlineCount` | Experiments and custom product pages, as of the last sync | Tests et pages produit personnalisées, à la dernière synchronisation |  |  |
| `tab.headlineDefault` | Experiments and custom pages | Tests et pages personnalisées |  |  |
| `tab.headlineGoogle` | Experiments on Google Play are managed in the Play Console | Les tests sur Google Play se gèrent dans la Google Play Console |  |  |
| `tab.headlineNone` | No experiments or custom product pages read | Aucun test ni page produit personnalisée lu |  |  |
| `tab.leadHintApple` | As of the last sync. Read only. | À la dernière synchronisation. Lecture seule. |  |  |
| `tab.leadHintGoogle` | Google Play has no API for these: use the Play Console and the tracker below. | Google Play n’a pas d’API pour cela : utilisez la Google Play Console et le suivi ci-dessous. |  |  |
| `tab.loadError` | Could not load the experiments. | Impossible de charger les tests. |  |  |
| `tab.loadErrorTitle` | Could not load the experiments | Impossible de charger les tests |  |  |
| `tab.openConsole` | Open {{console}} | Ouvrir {{console}} |  |  |
| `tab.partsTitle` | Some parts could not be read | Certaines parties n’ont pas pu être lues |  |  |
| `tab.rawState` | The store's own word | Le terme du store |  |  |
| `tab.reading` | Reading the experiments | Lecture des tests |  |  |
| `tab.sync` | Sync experiments | Synchroniser les tests |  |  |
| `tab.syncDone` | Sync done. Experiments: {{experiments}}. Custom product pages: {{pages}}. | Synchronisation terminée. Tests : {{experiments}}. Pages produit personnalisées : {{pages}}. |  |  |
| `tab.syncFailedNetwork` | The sync could not be completed. Try again. | La synchronisation n’a pas pu aboutir. Réessayez. |  |  |
| `tab.syncFailedTitle` | The sync failed | La synchronisation a échoué |  |  |
| `table.localesMore` | {{list}} and {{count}} more | {{list}} et {{count}} de plus |  |  |
| `table.none` | None | Aucune |  |  |
| `traffic.percent` | {{percent}}% | {{percent}} % |  |  |
| `traffic.unknown` | Unknown | Inconnu |  |  |
| `treatment.icon` | icon {{name}} | icône {{name}} |  |  |
| `treatment.languages_one` | {{count}} language | {{count}} langue |  |  |
| `treatment.languages_other` | {{count}} languages | {{count}} langues |  |  |
| `validation.datesOrder` | The end date is before the start date. | La date de fin est antérieure à la date de début. |  |  |
| `validation.listing` | Lowercase letters, digits and . - _ ~ only. | Minuscules, chiffres et . - _ ~ uniquement. |  |  |
| `validation.nameLong` | At most 120 characters. | 120 caractères au maximum. |  |  |
| `validation.nameRequired` | Enter a name. | Saisissez un nom. |  |  |
| `validation.noteLong` | At most 2,000 characters. | 2 000 caractères au maximum. |  |  |
| `validation.url` | Enter an address that starts with https:// or http://. | Saisissez une adresse qui commence par https:// ou http://. |  |  |

## web/insights (208)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `action.addLocale` | Add a language | Ajouter une langue |  |  |
| `action.open` | Open | Ouvrir |  |  |
| `action.openChecks` | See the checks | Voir les contrôles |  |  |
| `action.openCountries` | See the countries | Voir les pays |  |  |
| `action.openGraphics` | Review the graphics | Revoir les visuels |  | review: avis (user) vs examen (App Review) |
| `action.openKeywords` | Look at keywords | Voir les mots-clés |  |  |
| `action.openOverview` | Open the overview | Ouvrir la vue d’ensemble |  |  |
| `action.openRank` | See the ranks | Voir les positions |  |  |
| `action.openReviews` | Read the reviews | Lire les avis |  | review: avis (user) vs examen (App Review) |
| `action.openText` | Review the text | Revoir le texte |  | review: avis (user) vs examen (App Review) |
| `card.complaints.explain` | {{count}} of the {{total}} complaints in the last {{days}} days are about this. Read those reviews to see what is going on. | {{count}} des {{total}} plaintes de ces {{days}} derniers jours portent là-dessus. Lisez ces avis pour comprendre ce qui se passe. |  | review: avis (user) vs examen (App Review) |
| `card.complaints.headline` | Complaints in reviews: {{theme}} | Plaintes dans les avis : {{theme}} |  | review: avis (user) vs examen (App Review) |
| `card.conversionDown.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, down from {{before}} in the 14 days before. The change is too large to be chance. Check what changed on the page: icon, screenshots, text. | Ces 14 derniers jours, {{now}} des personnes qui ont vu votre fiche ont obtenu l’application, contre {{before}} sur les 14 jours précédents. L’écart est trop grand pour être dû au hasard. Vérifiez ce qui a changé sur la fiche : icône, captures d’écran, texte. |  |  |
| `card.conversionDown.headline` | Fewer people who see the page get the app | Moins de visiteurs de la fiche obtiennent l’application |  |  |
| `card.conversionUp.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, up from {{before}} in the 14 days before. The change is too large to be chance. | Ces 14 derniers jours, {{now}} des personnes qui ont vu votre fiche ont obtenu l’application, contre {{before}} sur les 14 jours précédents. L’écart est trop grand pour être dû au hasard. |  |  |
| `card.conversionUp.headline` | More people who see the page get the app | Plus de visiteurs de la fiche obtiennent l’application |  |  |
| `card.downloadsDown.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} nouveaux téléchargements ces 14 derniers jours, contre {{previous}} sur les 14 jours précédents. |  |  |
| `card.downloadsDown.headline` | New downloads are down {{percent}} | Les nouveaux téléchargements sont en baisse de {{percent}} |  |  |
| `card.downloadsUp.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} nouveaux téléchargements ces 14 derniers jours, contre {{previous}} sur les 14 jours précédents. |  |  |
| `card.downloadsUp.headline` | New downloads are up {{percent}} | Les nouveaux téléchargements sont en hausse de {{percent}} |  |  |
| `card.featuredSpike.explain` | On {{day}} the app was shown {{count}} times while browsing, about {{times}} times a usual day. This looks like a feature in the store. It rarely lasts, so make sure the page is ready. | Le {{day}}, l’application a été affichée {{count}} fois en navigation, soit environ {{times}} fois une journée habituelle. Cela ressemble à une mise en avant dans le store. Elle dure rarement : vérifiez que la fiche est prête. |  |  |
| `card.featuredSpike.headline` | A one-day jump in browse impressions | Un pic d’affichages en navigation sur une journée |  |  |
| `card.keywordsDown.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved down: {{count}}. | « {{term}} » ({{country}}) est passé de la place {{from}} à la place {{to}}. Mots-clés suivis en baisse : {{count}}. |  |  |
| `card.keywordsDown.headline` | Keyword ranks dropped | Les positions des mots-clés reculent |  |  |
| `card.keywordsUp.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved up: {{count}}. | « {{term}} » ({{country}}) est passé de la place {{from}} à la place {{to}}. Mots-clés suivis en hausse : {{count}}. |  |  |
| `card.keywordsUp.headline` | Keyword ranks improved | Les positions des mots-clés progressent |  |  |
| `card.listingIssues.explain_one` | {{count}} problem to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} problème à corriger et {{warnings}} à revoir. La langue la plus faible est {{locale}} ; la fiche obtient {{score}} sur 100. |  | review: avis (user) vs examen (App Review) |
| `card.listingIssues.explain_other` | {{count}} problems to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} problèmes à corriger et {{warnings}} à revoir. La langue la plus faible est {{locale}} ; la fiche obtient {{score}} sur 100. |  | review: avis (user) vs examen (App Review) |
| `card.listingIssues.headline` | The store page has problems to fix | La fiche du store a des problèmes à corriger |  |  |
| `card.listingReview.explain_one` | {{count}} point to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} point à revoir, rien qui bloque une publication. La langue la plus faible est {{locale}} ; la fiche obtient {{score}} sur 100. |  | review: avis (user) vs examen (App Review) |
| `card.listingReview.explain_other` | {{count}} points to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} points à revoir, rien qui bloque une publication. La langue la plus faible est {{locale}} ; la fiche obtient {{score}} sur 100. |  | review: avis (user) vs examen (App Review) |
| `card.listingReview.headline` | The store page has points to review | La fiche du store a des points à revoir |  | review: avis (user) vs examen (App Review) |
| `card.localize.explain` | In countries such as {{countries}} people mainly speak {{language}}. There they see the page in another language. Text in their language usually helps them decide. | Dans des pays comme {{countries}}, on parle surtout {{language}}. Les gens y voient la fiche dans une autre langue. Un texte dans leur langue les aide en général à se décider. |  |  |
| `card.localize.headline` | {{percent}} of downloads come from countries that mainly speak {{language}}, but the store page has no {{language}} text | {{percent}} des téléchargements viennent de pays où l’on parle surtout {{language}}, mais la fiche n’a aucun texte dans cette langue |  |  |
| `card.unknown.explain` | This card comes from a newer version of Kiln. Update Kiln to read it. | Cette carte vient d’une version plus récente de Kiln. Mettez Kiln à jour pour la lire. |  |  |
| `card.unknown.headline` | Something changed | Quelque chose a changé |  |  |
| `card.versionRatingDrop.explain` | Reviews of {{version}} average {{now}} stars, against {{before}} for {{previous}}. Look at what changed in that version. | Les avis de la version {{version}} donnent {{now}} étoiles en moyenne, contre {{before}} pour la {{previous}}. Regardez ce qui a changé dans cette version. |  | review: avis (user) vs examen (App Review) |
| `card.versionRatingDrop.headline` | Version {{version}} is rated lower than {{previous}} | La version {{version}} est moins bien notée que la {{previous}} |  |  |
| `card.visibilityDownSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. Look at your keyword ranks first. | Ces 14 derniers jours, l’application a été affichée {{current}} fois dans le store, contre {{previous}} sur les 14 jours précédents. Regardez d’abord vos positions de mots-clés. |  |  |
| `card.visibilityDownSeen.headline` | The app is shown {{percent}} less often | Les affichages de l’application diminuent de {{percent}} |  |  |
| `card.visibilityDownVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. Look at your keyword ranks first. | Ces 14 derniers jours, la fiche du store a reçu {{current}} visiteurs, contre {{previous}} sur les 14 jours précédents. Regardez d’abord vos positions de mots-clés. |  |  |
| `card.visibilityDownVisits.headline` | Store page visits are down {{percent}} | Les visites de la fiche sont en baisse de {{percent}} |  |  |
| `card.visibilityUpSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. | Ces 14 derniers jours, l’application a été affichée {{current}} fois dans le store, contre {{previous}} sur les 14 jours précédents. |  |  |
| `card.visibilityUpSeen.headline` | The app is shown {{percent}} more often | Les affichages de l’application augmentent de {{percent}} |  |  |
| `card.visibilityUpVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. | Ces 14 derniers jours, la fiche du store a reçu {{current}} visiteurs, contre {{previous}} sur les 14 jours précédents. |  |  |
| `card.visibilityUpVisits.headline` | Store page visits are up {{percent}} | Les visites de la fiche sont en hausse de {{percent}} |  |  |
| `cards.dismiss` | Dismiss | Ignorer |  |  |
| `cards.dismissFailed` | The card could not be hidden. Try again. | Impossible de masquer la carte. Réessayez. |  |  |
| `cards.dismissed` | Card hidden until its finding changes. | Carte masquée jusqu’à ce que le constat change. |  |  |
| `cards.hiddenLine_one` | {{count}} card is hidden. | {{count}} carte est masquée. |  |  |
| `cards.hiddenLine_other` | {{count}} cards are hidden. | {{count}} cartes sont masquées. |  |  |
| `cards.loadError` | The insights could not be read. Try again. | Impossible de lire les analyses. Réessayez. |  |  |
| `cards.loadErrorTitle` | Insights unavailable | Analyses indisponibles |  |  |
| `cards.showHidden` | Show hidden cards | Afficher les cartes masquées |  |  |
| `cards.undo` | Undo | Annuler |  |  |
| `cards.undoFailed` | The card could not be brought back. Try again. | Impossible de réafficher la carte. Réessayez. |  |  |
| `category.conversion` | Conversion | Conversion |  |  |
| `category.downloads` | Downloads | Téléchargements |  |  |
| `category.keywords` | Keywords | Mots-clés |  |  |
| `category.listing` | Store page | Fiche du store |  |  |
| `category.markets` | Markets | Marchés |  |  |
| `category.reviews` | Reviews | Avis |  | review: avis (user) vs examen (App Review) |
| `category.visibility` | Visibility | Visibilité |  |  |
| `check.empty.explain` | This field has no text. Shoppers and store search get nothing from it. | Ce champ ne contient aucun texte. Ni les visiteurs ni la recherche du store n’en tirent quoi que ce soit. |  |  |
| `check.empty.title` | {{field}} is empty | {{field}} : vide |  |  |
| `check.keywordsDuplicate.explain` | The same word appears more than once ({{words}}). Each repeat wastes room. | Le même mot apparaît plusieurs fois ({{words}}). Chaque répétition fait perdre de la place. |  |  |
| `check.keywordsDuplicate.title` | Repeated keywords | Mots-clés répétés |  |  |
| `check.keywordsInTitle.explain` | These words are already searchable from the name or subtitle: {{words}}. Repeating them in the keyword field wastes room. | Ces mots sont déjà trouvables grâce au nom ou au sous-titre : {{words}}. Les répéter dans le champ des mots-clés fait perdre de la place. |  |  |
| `check.keywordsInTitle.title` | Keywords already in the name or subtitle | Mots-clés déjà dans le nom ou le sous-titre |  |  |
| `check.keywordsSpaces.explain` | Spaces around the commas use up {{saved}} bytes of the keyword field. Without them there is room for more keywords. A rewritten field is suggested below. | Les espaces autour des virgules occupent {{saved}} octets du champ des mots-clés. Sans eux, il y a de la place pour d’autres mots-clés. Un champ réécrit est proposé ci-dessous. |  |  |
| `check.keywordsSpaces.title` | The keywords waste space | Les mots-clés gaspillent de la place |  |  |
| `check.keywordsUnderused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More keywords can bring more searches. | Seulement {{used}} {{unit}} sur {{limit}} sont utilisés. Davantage de mots-clés peuvent amener davantage de recherches. |  |  |
| `check.keywordsUnderused.title` | Room left in the keyword field | Place restante dans le champ des mots-clés |  |  |
| `check.noScreenshots.explain` | Other languages have their own screenshots and this one has none. | Les autres langues ont leurs propres captures d’écran, celle-ci n’en a aucune. |  |  |
| `check.noScreenshots.title` | No screenshots of its own | Aucune capture d’écran propre |  |  |
| `check.promoMissing.explain` | Promotional text can change without a new version and shows above the description. Add some. | Le texte promotionnel peut changer sans nouvelle version et s’affiche au-dessus de la description. Ajoutez-en un. |  |  |
| `check.promoMissing.title` | No promotional text | Pas de texte promotionnel |  |  |
| `check.severity.problem` | Problem | Problème |  |  |
| `check.severity.tip` | Tip | Conseil |  |  |
| `check.severity.warning` | Warning | Avertissement |  |  |
| `check.subtitleMissing.explain` | The subtitle is searchable text that shows under the name in search results. Add one. | Le sous-titre est un texte indexé qui s’affiche sous le nom dans les résultats de recherche. Ajoutez-en un. |  |  |
| `check.subtitleMissing.title` | No subtitle | Pas de sous-titre |  |  |
| `check.subtitleRepeatsName.explain` | Every word of the subtitle is already in the name, so it adds nothing to search. Say something new about the app. | Chaque mot du sous-titre est déjà dans le nom : il n’apporte rien à la recherche. Dites quelque chose de nouveau sur l’application. |  |  |
| `check.subtitleRepeatsName.title` | The subtitle repeats the name | Le sous-titre répète le nom |  |  |
| `check.tooLong.explain` | The text uses {{used}} of {{limit}} allowed {{unit}}. The store rejects text over the limit, so shorten it before you publish. | Le texte utilise {{used}} {{unit}} sur {{limit}} autorisés. Le store refuse un texte trop long : raccourcissez-le avant de publier. |  |  |
| `check.tooLong.title` | {{field}} is {{over}} {{unit}} too long | {{field}} : {{over}} {{unit}} de trop |  |  |
| `check.underused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More room means more words people can find the app by. | Seulement {{used}} {{unit}} sur {{limit}} sont utilisés. Plus de place, c’est plus de mots par lesquels trouver l’application. |  |  |
| `check.underused.title` | {{field}} uses little of its room | {{field}} : peu de place utilisée |  |  |
| `check.unknown.explain` | This finding comes from a newer version of Kiln. Update Kiln to read it. | Ce constat vient d’une version plus récente de Kiln. Mettez Kiln à jour pour le lire. |  |  |
| `check.unknown.title` | A check found something | Une vérification a trouvé quelque chose |  |  |
| `check.untranslated.explain` | {{fields}} matches {{base}} word for word. Translate it, or people in this language read foreign text. | {{fields}} : identique à {{base}}, mot pour mot. Traduisez-le, sinon les gens de cette langue lisent un texte étranger. |  |  |
| `check.untranslated.title` | Text is the same as in {{base}} | Texte identique à celui de {{base}} |  |  |
| `checks.allGood` | No findings. The text passes every check. | Aucun constat. Le texte passe tous les contrôles. |  |  |
| `checks.clean_one` | {{count}} language has no findings: {{locales}}. | {{count}} langue sans constat : {{locales}}. |  |  |
| `checks.clean_other` | {{count}} languages have no findings: {{locales}}. | {{count}} langues sans constat : {{locales}}. |  |  |
| `checks.copied` | Copied | Copié |  |  |
| `checks.copy` | Copy | Copier |  |  |
| `checks.counts` | Problems {{problems}} · warnings {{warnings}} · tips {{tips}} | Problèmes : {{problems}} · avertissements : {{warnings}} · conseils : {{tips}} |  |  |
| `checks.findings_one` | {{count}} finding | {{count}} constat |  |  |
| `checks.findings_other` | {{count}} findings | {{count}} constats |  |  |
| `checks.loadError` | The checks could not be read. Try again. | Impossible de lire les contrôles. Réessayez. |  |  |
| `checks.loadErrorTitle` | Checks unavailable | Contrôles indisponibles |  |  |
| `checks.noListing` | Kiln needs the live text of your store page to check it. Use Sync now in the status menu of the page header, then come back. | Kiln a besoin du texte publié de votre fiche pour la contrôler. Utilisez Synchroniser maintenant dans le menu d’état de l’en-tête de la page, puis revenez. |  | live = en ligne |
| `checks.noListingTitle` | The store page has not been read yet | La fiche du store n’a pas encore été lue |  |  |
| `checks.openLocale` | Open {{locale}} | Ouvrir {{locale}} |  |  |
| `checks.pasteHint` | Nothing is sent to a store. Paste it in the field editor and stage it. | Rien n’est envoyé à un store. Collez-le dans l’éditeur du champ et mettez-le en attente. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `checks.score` | Score {{score}} | Score {{score}} |  |  |
| `checks.suggested` | Suggested text for {{field}} | Texte proposé pour {{field}} |  |  |
| `checks.summary` | Score {{score}} out of 100 | Score de {{score}} sur 100 |  |  |
| `checks.title` | Store page checks | Contrôles de la fiche du store |  |  |
| `countries.addLanguage` | Add it in the store listing | L’ajouter dans la fiche de l’application |  | listing = fiche |
| `countries.byLanguage` | Downloads by main language | Téléchargements par langue principale |  |  |
| `countries.colCountry` | Country or region | Pays ou région |  |  |
| `countries.colDownloads` | New downloads | Nouveaux téléchargements |  |  |
| `countries.colLanguage` | Main language | Langue principale |  |  |
| `countries.colPage` | Store page | Fiche du store |  |  |
| `countries.colShare` | Share | Part |  |  |
| `countries.hint` | New downloads of the last 28 days: {{total}}. The main language of a country is the one most people there speak; many speak others too. | Nouveaux téléchargements des 28 derniers jours : {{total}}. La langue principale d’un pays est celle que la plupart des gens y parlent ; beaucoup en parlent aussi d’autres. |  |  |
| `countries.languageUnknown` | Unknown | Inconnue |  |  |
| `countries.leadCovered` | Your store page covers the main language of every country that downloads your app | Votre fiche du store couvre la langue principale de chaque pays qui télécharge votre application |  |  |
| `countries.leadUncovered` | {{percent}} of new downloads come from countries whose language your store page lacks | {{percent}} des nouveaux téléchargements viennent de pays dont la langue manque à votre fiche du store |  |  |
| `countries.loadError` | The countries could not be read. Try again. | Impossible de lire les pays. Réessayez. |  |  |
| `countries.loadErrorTitle` | Countries unavailable | Pays indisponibles |  |  |
| `countries.moreLanguages_one` | {{count}} more language with fewer downloads is not shown. | {{count}} autre langue, avec moins de téléchargements, n’est pas affichée. |  |  |
| `countries.moreLanguages_other` | {{count}} more languages with fewer downloads are not shown. | {{count}} autres langues, avec moins de téléchargements, ne sont pas affichées. |  |  |
| `countries.notOnPage` | Not on your store page | Pas sur votre fiche |  |  |
| `countries.onPage` | On your store page ({{locale}}) | Sur votre fiche ({{locale}}) |  |  |
| `countries.table` | Countries | Pays |  |  |
| `countries.unavailable.noAccess` | Your role may not read the store page, so the languages on it cannot be compared. | Votre rôle ne peut pas lire la fiche du store : les langues qu’elle contient ne peuvent donc pas être comparées. |  |  |
| `countries.unavailable.noCountries` | The store sends no downloads by country for this app (Google Play reports carry none), or none are stored yet. Sync the analytics to read them. | Le store n’envoie pas de téléchargements par pays pour cette application (les rapports Google Play n’en contiennent pas), ou aucun n’est encore enregistré. Synchronisez les statistiques pour les lire. |  |  |
| `countries.unavailable.noListing` | Kiln has not read your live store page yet, so it cannot tell which languages it covers. Use Sync now in the status menu of the page header. | Kiln n’a pas encore lu votre fiche publiée dans le store : il ne peut donc pas dire quelles langues elle couvre. Utilisez Synchroniser maintenant dans le menu d’état de l’en-tête de la page. |  | live = en ligne |
| `countries.unavailableTitle` | No table of countries | Pas de tableau des pays |  |  |
| `countries.unknown_one` | {{count}} download came from a country whose main language is not known. | {{count}} téléchargement vient d’un pays dont la langue principale n’est pas connue. |  |  |
| `countries.unknown_other` | {{count}} downloads came from countries whose main language is not known. | {{count}} téléchargements viennent de pays dont la langue principale n’est pas connue. |  |  |
| `empty.hiddenTitle` | Every card is dismissed | Toutes les cartes sont ignorées |  |  |
| `empty.hidden_one` | The {{count}} card Kiln found is hidden. Show it again below, or wait: a hidden card returns when its finding changes. | Kiln a trouvé {{count}} carte, et elle est masquée. Réaffichez-la ci-dessous, ou patientez : une carte masquée revient quand son constat change. |  |  |
| `empty.hidden_other` | The {{count}} cards Kiln found are hidden. Show them again below, or wait: a hidden card returns when its finding changes. | Les {{count}} cartes trouvées par Kiln sont masquées. Réaffichez-les ci-dessous, ou patientez : une carte masquée revient quand son constat change. |  |  |
| `empty.nodata` | Some checks could not run, so there is nothing to show. The notes below say what each one is missing. | Certaines vérifications n’ont pas pu s’exécuter, il n’y a donc rien à montrer. Les notes ci-dessous disent ce qui manque à chacune. |  |  |
| `empty.nodataTitle` | Not enough data yet | Pas encore assez de données |  |  |
| `empty.quiet` | Every check ran and found nothing worth your time. Kiln looks again after the next sync. | Toutes les vérifications ont été faites et n’ont rien trouvé qui mérite votre temps. Kiln regarde de nouveau après la prochaine synchronisation. |  |  |
| `empty.quietTitle` | Nothing stands out | Rien ne ressort |  |  |
| `evidence.browseDay` | That day | Ce jour-là |  |  |
| `evidence.browseUsual` | Usual day | Jour habituel |  |  |
| `evidence.complaints` | All complaints | Toutes les plaintes |  |  |
| `evidence.current` | Last 14 days | 14 derniers jours |  |  |
| `evidence.day` | Day | Jour |  |  |
| `evidence.downloads` | New downloads | Nouveaux téléchargements |  |  |
| `evidence.issues` | Problems | Problèmes |  |  |
| `evidence.mentions` | Mentions | Mentions |  |  |
| `evidence.previous` | 14 days before | 14 jours précédents |  |  |
| `evidence.rateNow` | Rate now | Taux actuel |  |  |
| `evidence.ratePrevious` | Rate before | Taux précédent |  |  |
| `evidence.ratingNow` | Rating now | Note actuelle |  | rating = note |
| `evidence.ratingPrevious` | Rating before | Note précédente |  | rating = note |
| `evidence.score` | Score | Score |  |  |
| `evidence.share` | Share of downloads | Part des téléchargements |  |  |
| `evidence.unranked` | Not ranked | Non classé |  |  |
| `evidence.warnings` | To review | À revoir |  | review: avis (user) vs examen (App Review) |
| `field.description` | Description | Description |  |  |
| `field.fullDescription` | Full description | Description complète |  |  |
| `field.keywords` | Keywords | Mots-clés |  |  |
| `field.name` | Name | Nom |  |  |
| `field.promotionalText` | Promotional text | Texte promotionnel |  |  |
| `field.shortDescription` | Short description | Description courte |  |  |
| `field.subtitle` | Subtitle | Sous-titre |  |  |
| `field.title` | Title | Titre |  |  |
| `filter.all` | All | Tout |  |  |
| `filter.empty` | Nothing in this topic. | Rien dans ce thème. |  |  |
| `filter.label` | Filter by topic | Filtrer par thème |  |  |
| `lead.headline_one` | {{count}} thing to look at | {{count}} point à examiner |  |  |
| `lead.headline_other` | {{count}} things to look at | {{count}} points à examiner |  |  |
| `lead.hint` | Worked out from what Kiln has already stored: analytics, reviews, keyword ranks and your live store page. Nothing is sent to a store. | Calculé à partir de ce que Kiln a déjà enregistré : statistiques, avis, positions des mots-clés et fiche publiée dans le store. Rien n’est envoyé à un store. |  | review: avis (user) vs examen (App Review); live = en ligne |
| `lead.none` | Nothing needs your attention | Rien ne demande votre attention |  |  |
| `notes.title` | Checks that did not run | Vérifications non exécutées |  |  |
| `reason.noAccess` | your role may not read the data it needs. | votre rôle ne peut pas lire les données dont elle a besoin. |  |  |
| `reason.noCountries` | the store sends no downloads by country (Google Play does not), or none are stored yet. | le store n’envoie pas de téléchargements par pays (Google Play n’en envoie pas), ou aucun n’est encore enregistré. |  |  |
| `reason.noData` | no data is stored yet. Sync the app, or turn on analytics. | aucune donnée n’est encore enregistrée. Synchronisez l’application ou activez les statistiques. |  |  |
| `reason.noKeywords` | no keywords are tracked yet. | aucun mot-clé n’est encore suivi. |  |  |
| `reason.noListing` | the live store page has not been read yet. Sync the app first. | la fiche publiée dans le store n’a pas encore été lue. Synchronisez d’abord l’application. |  | live = en ligne |
| `reason.noReviews` | no reviews are stored. Read the reviews first. | aucun avis n’est enregistré. Lisez d’abord les avis. |  | review: avis (user) vs examen (App Review) |
| `reason.notForStore` | it does not apply to this store. | elle ne s’applique pas à ce store. |  |  |
| `reason.other` | it could not run. | elle n’a pas pu s’exécuter. |  |  |
| `reason.tooLittleData` | there are not enough days of data to compare two weeks yet. | il n’y a pas encore assez de jours de données pour comparer deux semaines. |  |  |
| `severity.good` | Good news | Bonne nouvelle |  |  |
| `severity.info` | Information | Information |  |  |
| `severity.problem` | Problem | Problème |  |  |
| `severity.warning` | Warning | Avertissement |  |  |
| `skip.complaints` | Review complaints | Plaintes dans les avis |  | review: avis (user) vs examen (App Review) |
| `skip.conversion` | Conversion | Conversion |  |  |
| `skip.downloads` | Downloads | Téléchargements |  |  |
| `skip.featured` | Store featuring | Mise en avant dans le store |  |  |
| `skip.keywords` | Keyword ranks | Positions des mots-clés |  |  |
| `skip.line` | {{rule}}: {{reason}} | {{rule}} : {{reason}} |  |  |
| `skip.listing` | Store page checks | Contrôles de la fiche du store |  |  |
| `skip.localize` | Languages of your countries | Langues de vos pays |  |  |
| `skip.other` | Another check | Autre vérification |  |  |
| `skip.versionRating` | Rating of the latest version | Note de la dernière version |  | rating = note |
| `skip.visibility` | Visibility | Visibilité |  |  |
| `theme.ads` | ads | publicités |  |  |
| `theme.bug` | bugs | bugs |  |  |
| `theme.crash` | crashes | plantages |  |  |
| `theme.data` | lost or missing data | données perdues ou manquantes |  |  |
| `theme.login` | signing in | connexion |  |  |
| `theme.performance` | slow performance | lenteur |  |  |
| `theme.price` | the price | prix |  |  |
| `theme.update` | the latest update | dernière mise à jour |  |  |
| `unit.bytes` | bytes | octets |  |  |
| `unit.characters` | characters | caractères |  |  |

## web/listing (58)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `compare.discard` | Discard | Abandonner |  |  |
| `compare.discardFor` | Discard the staged {{label}} ({{locale}}) | Abandonner la modification en attente de {{label}} ({{locale}}) |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.after` | After | Après |  |  |
| `fix.afterPending` | After pending changes: {{problems}} problems, {{warnings}} warnings, {{tips}} tips. Score {{score}}. | Après les modifications en attente : {{problems}} problèmes, {{warnings}} avertissements, {{tips}} conseils. Score {{score}}. |  | cart = "Modifications en attente" |
| `fix.all_one` | Fix all that can be fixed ({{count}}) | Tout corriger ce qui peut l'être ({{count}}) |  |  |
| `fix.all_other` | Fix all that can be fixed ({{count}}) | Tout corriger ce qui peut l'être ({{count}}) |  |  |
| `fix.barTitle` | Fixes for this language | Corrections pour cette langue |  |  |
| `fix.before` | Before | Avant |  |  |
| `fix.button` | Fix | Corriger |  |  |
| `fix.bytes` | bytes | octets |  |  |
| `fix.cannot` | Cannot be fixed automatically. | Ne peut pas être corrigé automatiquement. |  |  |
| `fix.characters` | characters | caractères |  |  |
| `fix.discard` | Discard | Annuler |  |  |
| `fix.drops_one` | Removes {{count}} whole term. No word is cut. | Retire {{count}} terme entier. Aucun mot n'est coupé. |  |  |
| `fix.drops_other` | Removes {{count}} whole terms. No word is cut. | Retire {{count}} termes entiers. Aucun mot n'est coupé. |  |  |
| `fix.editField` | Edit | Modifier |  |  |
| `fix.emptyHint` | A required field is empty. Nothing is invented: write it in the editor. | Un champ obligatoire est vide. Rien n'est inventé : écrivez-le dans l'éditeur. |  |  |
| `fix.failed` | The fix could not be staged. Reload and try again. | La correction n'a pas pu être préparée. Rechargez et réessayez. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.keywordsDropInTitle` | Remove terms already in the name or subtitle | Retirer les termes déjà dans le nom ou le sous-titre |  |  |
| `fix.keywordsFit` | Drop terms to fit the limit | Retirer des termes pour respecter la limite |  |  |
| `fix.keywordsTidy` | Tidy the keyword field | Nettoyer le champ de mots-clés |  |  |
| `fix.locked` | This version is live or in review, so its text is read-only here. | Cette version est en ligne ou en cours d’examen : son texte est en lecture seule ici. |  | review: avis (user) vs examen (App Review); live = en ligne |
| `fix.noMeaning` | Only spaces, empty terms and repeats change. Nothing a shopper reads. | Seuls les espaces, les termes vides et les doublons changent. Rien que l'utilisateur lise. |  |  |
| `fix.noRight` | Your role cannot stage changes. | Votre rôle ne permet pas de préparer des modifications. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.notPublished` | Nothing is sent to a store from here. | Rien n'est envoyé à une boutique d'ici. |  |  |
| `fix.openEditor` | Open the {{field}} editor | Ouvrir l'éditeur : {{field}} |  |  |
| `fix.partial` | {{done}} of {{total}} were staged. | {{done}} sur {{total}} ont été préparées. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.removedList` | Removed: {{terms}} | Retiré : {{terms}} |  |  |
| `fix.removedTerm` | removed:  | retiré :  |  |  |
| `fix.reviewDescription` | Check the text before and after. Staging adds it to the pending changes; nothing is published until you review and send them. | Vérifiez le texte avant et après. La préparation l'ajoute aux modifications en attente ; rien n'est publié avant que vous les relisiez et les envoyiez. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.reviewTitleOne` | Review the fix | Vérifier la correction |  | review: avis (user) vs examen (App Review) |
| `fix.reviewTitle_one` | Review {{count}} fix | Vérifier {{count}} correction |  | review: avis (user) vs examen (App Review) |
| `fix.reviewTitle_other` | Review {{count}} fixes | Vérifier {{count}} corrections |  | review: avis (user) vs examen (App Review) |
| `fix.riskReview` | Read before staging | À lire avant de préparer |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.riskSafe` | Changes no wording | Ne change aucun texte |  |  |
| `fix.shortenAi` | Shorten with AI | Raccourcir avec l'IA |  |  |
| `fix.shortenHint` | Shortening changes the wording, so it is never automatic. The editor shows the limit as you type. | Raccourcir change la formulation, ce n'est donc jamais automatique. L'éditeur montre la limite pendant la saisie. |  |  |
| `fix.stage` | Stage fix | Préparer la correction |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.stageMany_one` | Stage {{count}} fix | Préparer {{count}} correction |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.stageMany_other` | Stage {{count}} fixes | Préparer {{count}} corrections |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.staged` | Fix staged | Correction préparée |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `fix.textTidy` | Collapse extra spaces | Réduire les espaces superflus |  |  |
| `fix.whiteSpace` | Only extra spaces and blank lines change. Every word stays. | Seuls les espaces superflus et les lignes vides changent. Tous les mots restent. |  |  |
| `matrix.cell.fine` | No problems | Aucun problème |  |  |
| `matrix.cellShort.fine` | No problems | Aucun problème |  |  |
| `matrix.status.noProblems` | No problems found | Aucun problème trouvé |  |  |
| `matrixView.cellAriaStaged` | {{column}}, {{locale}}: {{summary}}. {{staged}}. Open the locale. | {{column}}, {{locale}} : {{summary}}. {{staged}}. Ouvrir la langue. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.compareOff` | The repository is not compared with the store. Turn on “Compare repository and store” in the app settings to see differences. | Le dépôt n’est pas comparé au store. Activez « Comparer le dépôt et le store » dans les réglages de l’app pour voir les différences. |  |  |
| `matrixView.discardFailed` | Could not discard the staged change. Try again. | Impossible d’abandonner la modification en attente. Réessayez. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.localeStagedAria_one` | {{count}} staged change in {{locale}}. Open it in the pending changes. | {{count}} modification en attente en {{locale}}. L’ouvrir dans les modifications en attente. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.localeStagedAria_other` | {{count}} staged changes in {{locale}}. Open them in the pending changes. | {{count}} modifications en attente en {{locale}}. Les ouvrir dans les modifications en attente. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.localeStaged_one` | {{count}} staged | {{count}} en attente |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.localeStaged_other` | {{count}} staged | {{count}} en attente |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.stagedChange` | Staged: {{before}} → {{after}} | En attente : {{before}} → {{after}} |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.stagedEdited` | Edited | Modifié |  |  |
| `matrixView.stagedMark` | Edited: a staged value waits in the pending changes. Point at the marker to read the change. | Modifié : une valeur en attente figure dans les modifications en attente. Survolez le repère pour lire le changement. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `matrixView.stagedNothing` | (nothing) | (rien) |  |  |
| `matrixView.unstagedAnnounce` | Discarded the staged {{label}} ({{locale}}). | Modification en attente abandonnée : {{label}} ({{locale}}). |  | stage = prepare locally, nothing is sent: see staged glossary row |

## web/portfolio (8)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `activity.feed.analytics` | analytics | statistiques |  |  |
| `activity.feed.other` | other data | autres données |  |  |
| `activity.feed.releases` | release state | état des versions |  | release = publication |
| `activity.feed.reviews` | reviews | avis |  | review: avis (user) vs examen (App Review) |
| `activity.queued_one` | {{count}} more waiting | {{count}} autre en attente |  |  |
| `activity.queued_other` | {{count}} more waiting | {{count}} autres en attente |  |  |
| `activity.title` | Syncing now | Synchronisation en cours |  |  |
| `activity.unknownApp` | Another app | Autre app |  |  |

## web/products (95)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `price.ack.existingSubscribers` | I know existing subscribers will be moved to the new price. | Je sais que les abonnés existants passeront au nouveau prix. |  |  |
| `price.ack.largeAbsolute` | I know a price changes by a large amount of money (limit: {{amount}} units of the currency, more for currencies with small units). | Je sais qu'un prix change d'une grosse somme (limite : {{amount}} unités de la devise, davantage pour les devises à petite unité). |  |  |
| `price.ack.largeChange` | I know a price changes by more than {{percent}}%. | Je sais qu'un prix change de plus de {{percent}} %. |  |  |
| `price.acks` | Confirm each of these | Confirmez chacun de ces points |  |  |
| `price.alreadyStaged_one` | A price change for {{count}} territory is staged and waiting in the pending changes. | Un changement de prix pour {{count}} territoire est en attente dans les changements en attente. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `price.alreadyStaged_other` | A price change for {{count}} territories is staged and waiting in the pending changes. | Un changement de prix pour {{count}} territoires est en attente dans les changements en attente. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `price.blockRole` | Only an owner or admin can change prices. | Seul un propriétaire ou un administrateur peut modifier les prix. |  |  |
| `price.blockServer` | Price changes are switched off on this server. An operator can turn them on with {{env}}. | Les changements de prix sont désactivés sur ce serveur. Un opérateur peut les activer avec {{env}}. |  |  |
| `price.blockWorkspace` | Price changes are switched off for this workspace. Turn on the setting {{setting}}. | Les changements de prix sont désactivés pour cet espace de travail. Activez le réglage {{setting}}. |  |  |
| `price.caption` | New prices of {{id}} by territory | Nouveaux prix de {{id}} par territoire |  |  |
| `price.changedCount_one` | {{count}} territory changed (at most {{max}}). | {{count}} territoire modifié (au plus {{max}}). |  |  |
| `price.changedCount_other` | {{count}} territories changed (at most {{max}}). | {{count}} territoires modifiés (au plus {{max}}). |  |  |
| `price.colChange` | Change | Variation |  |  |
| `price.colCurrent` | Now | Actuel |  |  |
| `price.colNew` | New price | Nouveau prix |  |  |
| `price.convert.amount` | Base price | Prix de base |  |  |
| `price.convert.base` | Base region | Région de base |  |  |
| `price.convert.done_one` | Filled {{count}} region from Google Play. Check each price. | {{count}} région remplie depuis Google Play. Vérifiez chaque prix. |  |  |
| `price.convert.done_other` | Filled {{count}} regions from Google Play. Check each price. | {{count}} régions remplies depuis Google Play. Vérifiez chaque prix. |  |  |
| `price.convert.go` | Convert | Convertir |  |  |
| `price.convert.help` | Google Play can work out the price of every region from one base price. The numbers are a start: check and edit each one. | Google Play peut calculer le prix de chaque région depuis un prix de base. Ces chiffres sont un point de départ : vérifiez et modifiez chacun. |  |  |
| `price.convert.needBase` | Type a different base price first. | Saisissez d'abord un prix de base différent. |  |  |
| `price.convert.title` | Convert from one base price | Convertir depuis un prix de base |  |  |
| `price.date` | Effective date (optional) | Date d'effet (facultatif) |  |  |
| `price.dateHelp` | Leave empty for as soon as the store allows. Kiln never deletes a price that is already scheduled. | Laissez vide pour dès que le store le permet. Kiln ne supprime jamais un prix déjà programmé. |  |  |
| `price.default` | Default | Par défaut |  |  |
| `price.delay` | Stores can take a while to show a new price everywhere. Nothing is sent from here: the change is staged, and you review and confirm it in the pending changes. | Les stores peuvent mettre du temps à afficher un nouveau prix partout. Rien n'est envoyé d'ici : le changement est mis en attente, puis vous le vérifiez et le confirmez dans les changements en attente. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `price.direction.decrease` | down | baisse |  |  |
| `price.direction.increase` | up | hausse |  |  |
| `price.direction.same` | no change | inchangé |  |  |
| `price.edit` | Edit price | Modifier le prix |  |  |
| `price.failure.network` | Could not reach the server. Nothing was changed. | Le serveur est injoignable. Rien n'a été modifié. |  |  |
| `price.failure.stale` | The product was synced again since you opened it. Reload it and review the prices again. | Le produit a été synchronisé de nouveau depuis son ouverture. Rechargez-le et vérifiez les prix. |  | review: avis (user) vs examen (App Review) |
| `price.failure.withNothing` | {{message}} Nothing was sent to the store. | {{message}} Rien n'a été envoyé au store. |  |  |
| `price.formAria` | Edit the price of {{id}} | Modifier le prix de {{id}} |  |  |
| `price.fromTo` | {{from}} to {{to}} | {{from}} vers {{to}} |  |  |
| `price.issue.ackRequired` | This change needs an explicit acknowledgement. | Ce changement demande une confirmation explicite. |  |  |
| `price.issue.ackUnknown` | Not a known acknowledgement. | Confirmation inconnue. |  |  |
| `price.issue.amountNotPricePoint` | Apple only sells at its price points. This amount is not one. | Apple ne vend qu'à ses paliers de prix. Ce montant n'en est pas un. |  |  |
| `price.issue.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Un montant doit être en unités mineures entières, par exemple 499 pour 4,99. |  |  |
| `price.issue.badProduct` | Not a valid product. | Produit non valide. |  |  |
| `price.issue.badTerritory` | Not a territory of this store. | Ce n'est pas un territoire de ce store. |  |  |
| `price.issue.currencyMismatch` | The currency is not the currency of that territory. | La devise n'est pas celle de ce territoire. |  |  |
| `price.issue.dateInvalid` | Not a date: use YYYY-MM-DD. | Ce n'est pas une date : utilisez AAAA-MM-JJ. |  |  |
| `price.issue.datePast` | The date is in the past. | La date est passée. |  |  |
| `price.issue.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Ce store applique un prix dès l'envoi : il ne peut pas être daté. |  |  |
| `price.issue.duplicateTerritory` | A territory is named twice. | Un territoire est cité deux fois. |  |  |
| `price.issue.noChange` | The new price is the price the store already shows. | Le nouveau prix est celui que le store affiche déjà. |  |  |
| `price.issue.noLines` | Name at least one territory. | Indiquez au moins un territoire. |  |  |
| `price.issue.notPositive` | A price must be greater than zero. | Un prix doit être supérieur à zéro. |  |  |
| `price.issue.other` | This change has an error. | Ce changement contient une erreur. |  |  |
| `price.issue.planMissing` | Name the base plan or purchase option. | Indiquez le forfait de base ou l'option d'achat. |  |  |
| `price.issue.planNotAllowed` | This product has no such plan. | Ce produit n'a pas un tel forfait. |  |  |
| `price.issue.pricePointMismatch` | The amount is not the amount of that price point. | Le montant n'est pas celui de ce palier de prix. |  |  |
| `price.issue.pricePointMissing` | Apple prices are chosen from price points: pick one. | Les prix Apple se choisissent parmi des paliers de prix : choisissez-en un. |  |  |
| `price.issue.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Les prix Google Play sont des montants, pas des paliers. |  |  |
| `price.issue.pricePointTerritory` | That price point belongs to another territory. | Ce palier de prix appartient à un autre territoire. |  |  |
| `price.issue.pricePointUnknown` | That price point does not exist for this product. | Ce palier de prix n'existe pas pour ce produit. |  |  |
| `price.issue.stalePrice` | The price changed since you looked at it. Sync the app and review again. | Le prix a changé depuis votre consultation. Synchronisez l'app et vérifiez de nouveau. |  | review: avis (user) vs examen (App Review) |
| `price.issue.subscriberRule` | That choice for existing subscribers does not exist in this store. | Ce choix pour les abonnés existants n'existe pas dans ce store. |  |  |
| `price.issue.tooHigh` | That price is above the highest price Kiln allows. | Ce prix dépasse le maximum autorisé par Kiln. |  |  |
| `price.issue.tooManyTerritories` | Too many territories in one change. | Trop de territoires dans un seul changement. |  |  |
| `price.issue.unknownTerritory` | The product has no price in that territory. | Le produit n'a pas de prix dans ce territoire. |  |  |
| `price.loadingPoints` | Reading Apple price points... | Lecture des paliers de prix Apple... |  |  |
| `price.nearest` | Nearest price points: {{list}}. | Paliers les plus proches : {{list}}. |  |  |
| `price.newFor` | New price for {{territory}} in {{currency}} | Nouveau prix pour {{territory}} en {{currency}} |  |  |
| `price.noDate` | Google Play applies a price as soon as it is sent. It cannot be dated. | Google Play applique un prix dès l'envoi. Il ne peut pas être daté. |  |  |
| `price.notPoint` | Not an Apple price point. | Pas un palier de prix Apple. |  |  |
| `price.openCart` | Open pending changes | Ouvrir les changements en attente |  | cart = "Modifications en attente" |
| `price.plan` | Plan | Forfait |  |  |
| `price.problem.empty` | Type a price. | Saisissez un prix. |  |  |
| `price.problem.format` | Not a price. Use digits, for example 4.99. | Ce n'est pas un prix. Utilisez des chiffres, par exemple 4,99. |  |  |
| `price.problem.precision` | {{currency}} does not have that many decimals. Kiln does not round prices. | {{currency}} n'a pas autant de décimales. Kiln n'arrondit jamais un prix. |  |  |
| `price.problem.zero` | A price must be greater than zero. | Un prix doit être supérieur à zéro. |  |  |
| `price.reload` | Reload the product | Recharger le produit |  |  |
| `price.replaces` | A price change for this product is already staged. Saving replaces it. | Un changement de prix est déjà en attente pour ce produit. L'enregistrer le remplace. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `price.revenueCatNote` | RevenueCat shows these prices read only. Prices are changed in the store, and RevenueCat picks them up from there. | RevenueCat affiche ces prix en lecture seule. Les prix se changent dans le store, et RevenueCat les reprend de là. |  |  |
| `price.rule.apply` | Move existing subscribers to the new price | Faire passer les abonnés existants au nouveau prix |  |  |
| `price.rule.notApplicable` | Not a subscription | Pas un abonnement |  |  |
| `price.rule.optIn` | Ask existing subscribers to accept the new price | Demander aux abonnés existants d'accepter le nouveau prix |  |  |
| `price.rule.optOut` | Move existing subscribers unless they decline | Faire passer les abonnés existants sauf refus |  |  |
| `price.rule.preserve` | Keep existing subscribers at their current price | Garder les abonnés existants à leur prix actuel |  |  |
| `price.ruleHelp.apply` | Existing subscribers move to the new price. The store may notify them or ask for their consent, and some may cancel. | Les abonnés existants passent au nouveau prix. Le store peut les prévenir ou demander leur accord, et certains peuvent résilier. |  |  |
| `price.ruleHelp.optIn` | Existing subscribers keep their price until they accept the new one. Google Play sends the request. | Les abonnés existants gardent leur prix jusqu'à ce qu'ils acceptent le nouveau. Google Play envoie la demande. |  |  |
| `price.ruleHelp.optOut` | Existing subscribers move to the new price after Google Play tells them, unless they decline or cancel. | Les abonnés existants passent au nouveau prix après notification de Google Play, sauf refus ou résiliation. |  |  |
| `price.ruleHelp.preserve` | Only new subscribers pay the new price. This is the safe choice. | Seuls les nouveaux abonnés paient le nouveau prix. C'est le choix le plus sûr. |  |  |
| `price.stage` | Add to pending changes | Ajouter aux changements en attente |  | cart = "Modifications en attente" |
| `price.stageHelp` | Nothing is sent to the store yet. | Rien n'est encore envoyé au store. |  |  |
| `price.staged` | Added to pending changes. Nothing is sent to the store until you confirm there. | Ajouté aux changements en attente. Rien n'est envoyé au store avant votre confirmation. |  | cart = "Modifications en attente" |
| `price.subscribers` | Existing subscribers | Abonnés existants |  |  |
| `price.switchOff` | Turn off price changes for this workspace | Désactiver les changements de prix pour cet espace de travail |  |  |
| `price.switchOn` | Turn on price changes for this workspace | Activer les changements de prix pour cet espace de travail |  |  |
| `price.tooMany` | More than {{max}} territories in one change. | Plus de {{max}} territoires dans un seul changement. |  |  |
| `price.usePoint` | Use {{amount}} | Utiliser {{amount}} |  |  |
| `tab.revenueInInsights` | Subscriptions, MRR and revenue are in Insights. | Abonnements, MRR et revenus sont dans Analyses. |  |  |

## web/ratings (101)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `change.noData` | No ratings in this period | Aucune note sur cette période |  | rating = note |
| `change.noPrevious` | Nothing recorded before this period to compare with | Rien d’enregistré avant cette période pour comparer |  |  |
| `change.notEnough` | Not enough days with numbers to compare | Pas assez de jours avec des chiffres pour comparer |  |  |
| `change.oneReading` | Only one reading so far: no change to show yet | Une seule lecture pour l’instant : pas encore de variation à montrer |  |  |
| `change.points` | {{text}} points | {{text}} points |  |  |
| `change.same_one` | About the same as the previous day | À peu près identique au jour précédent |  |  |
| `change.same_other` | About the same as the previous {{count}} days | À peu près identique aux {{count}} jours précédents |  |  |
| `change.sinceDay` | {{text}} since {{date}} | {{text}} depuis le {{date}} |  |  |
| `change.vsPrevious_one` | {{text}} vs previous day | {{text}} par rapport au jour précédent |  |  |
| `change.vsPrevious_other` | {{text}} vs previous {{count}} days | {{text}} par rapport aux {{count}} jours précédents |  |  |
| `chart.average` | Average rating | Note moyenne |  | rating = note |
| `chart.lowReviews` | Low-star reviews per day | Avis à faible note par jour |  | review: avis (user) vs examen (App Review) |
| `compare.average` | Average rating | Note moyenne |  | rating = note |
| `compare.caption_one` | Ratings and stability by platform, against the previous day | Notes et stabilité par plateforme, par rapport au jour précédent |  | rating = note |
| `compare.caption_other` | Ratings and stability by platform, against the previous {{count}} days | Notes et stabilité par plateforme, par rapport aux {{count}} jours précédents |  | rating = note |
| `compare.change` | Change | Évolution |  |  |
| `compare.count` | Ratings | Notes |  | rating = note |
| `compare.crash` | Crash rate | Taux de plantage |  |  |
| `compare.freeze` | ANR rate | Taux d’ANR |  |  |
| `compare.lowReviews` | Low-star reviews | Avis à faible note |  | review: avis (user) vs examen (App Review) |
| `compare.measure` | Measure | Mesure |  |  |
| `count.lowSample` | Low sample: read this with care | Petit échantillon : à lire avec prudence |  |  |
| `count.notGiven` | This store does not give the number of ratings. | Ce store ne donne pas le nombre de notes. |  | rating = note |
| `count.ratings_one` | {{number}} rating | {{number}} note |  | rating = note |
| `count.ratings_other` | {{number}} ratings | {{number}} notes |  | rating = note |
| `count.unknown` | Count not provided | Nombre non fourni |  |  |
| `countries.caption` | Ratings by country for {{platform}} | Notes par pays pour {{platform}} |  | rating = note |
| `countries.country` | Country | Pays |  |  |
| `countries.note` | Kiln reads a few countries per sync, so this is not every country. An average over a small count can swing a lot. | Kiln lit quelques pays à chaque synchronisation : ce n’est pas la liste de tous les pays. Une moyenne sur un petit nombre peut beaucoup varier. |  |  |
| `countries.read` | Last read | Dernière lecture |  |  |
| `empty.android` | Google Play gives the average rating in its reports, but no count and no stars. Turn on the Google Play reports in Overview, Data sources, then Sync. | Google Play donne la note moyenne dans ses rapports, mais ni le nombre ni les étoiles. Activez les rapports Google Play dans Vue d’ensemble, Sources de données, puis synchronisez. |  | rating = note |
| `empty.error` | Could not read the {{platform}} ratings. Try Sync again. | Impossible de lire les notes {{platform}}. Relancez la synchronisation. |  | rating = note |
| `empty.ios` | Apple does not provide rating history. Kiln records one point each time it syncs, so the trend starts with the first sync: run Sync (top right) to begin. | Apple ne fournit pas d’historique des notes. Kiln enregistre un point à chaque synchronisation : la courbe commence à la première. Lancez la synchronisation (en haut à droite). |  | rating = note |
| `empty.loading` | Reading the {{platform}} ratings… | Lecture des notes {{platform}}… |  | rating = note |
| `finding.better` | {{measure}} went down in version {{version}} | {{measure}} en baisse dans la version {{version}} |  |  |
| `finding.detail` | Against version {{previous}}: {{before}}, then {{after}} (from {{from}}). | Par rapport à la version {{previous}} : {{before}}, puis {{after}} (depuis le {{from}}). |  |  |
| `finding.mentions_one` | {{count}} review since then mentions crashes. | {{count}} avis depuis évoque des plantages. |  | review: avis (user) vs examen (App Review) |
| `finding.mentions_other` | {{count}} reviews since then mention crashes. | {{count}} avis depuis évoquent des plantages. |  | review: avis (user) vs examen (App Review) |
| `finding.worse` | {{measure}} went up in version {{version}} | {{measure}} en hausse dans la version {{version}} |  |  |
| `note.countDropped` | The number of ratings fell between two readings: stores can remove ratings. That is not counted as new ratings. | Le nombre de notes a baissé entre deux lectures : les stores peuvent retirer des notes. Ce n’est pas compté comme de nouvelles notes. |  | rating = note |
| `note.gap` | Some days have no reading (no sync): a change between two readings is counted on the later day. | Certains jours n’ont pas de lecture (pas de synchronisation) : un changement entre deux lectures est compté le jour de la seconde. |  |  |
| `note.newUnknown` | New ratings need two readings: they appear after the next sync. | Les nouvelles notes demandent deux lectures : elles apparaîtront après la prochaine synchronisation. |  | rating = note |
| `note.noCount` | This store gives neither the number of ratings nor their stars. | Ce store ne donne ni le nombre de notes ni leurs étoiles. |  | rating = note |
| `note.reset` | The store reset the summary rating in this period: the count starts again from that day. | Le store a réinitialisé la note globale sur la période : le compte repart de ce jour. |  | rating = note |
| `rail.countries` | Countries | Pays |  |  |
| `rail.group` | Ratings and health | Notes et santé |  | rating = note |
| `rail.label` | Sections of ratings and health | Sections de notes et santé |  | rating = note |
| `rail.ratings` | Ratings | Notes |  | rating = note |
| `rail.releases` | Release impact | Effet des versions |  | release = publication |
| `rail.reviews` | Reviews signal | Signal des avis |  | review: avis (user) vs examen (App Review) |
| `rail.stability` | Stability | Stabilité |  |  |
| `releases.better` | Lower | Plus bas |  |  |
| `releases.caption` | Releases of {{platform}} | Versions de {{platform}} |  | release = publication |
| `releases.crash` | Crash rate | Taux de plantage |  |  |
| `releases.crashReviews_one` | {{count}} mentions a crash | {{count}} évoque un plantage |  |  |
| `releases.crashReviews_other` | {{count}} mention crashes | {{count}} évoquent des plantages |  |  |
| `releases.day` | First seen | Vue le |  |  |
| `releases.lead` | How stability and the rating moved around each release. A before and after comparison, never proof of cause: other things change at the same time. | Comment la stabilité et la note ont bougé autour de chaque version. Une comparaison avant et après, jamais une preuve de cause : d’autres choses changent en même temps. |  | release = publication; rating = note |
| `releases.legend` | Crash rate: the previous version, then this one. Rating: the 14 days before the release, then 7 to 14 days after it. | Taux de plantage : la version précédente, puis celle-ci. Note : les 14 jours avant la version, puis 7 à 14 jours après. |  | release = publication; rating = note |
| `releases.noHistory` | No readings | Aucune lecture |  |  |
| `releases.noHistoryTitle` | No readings around this day | Aucune lecture autour de ce jour |  |  |
| `releases.rating` | Rating | Note |  | rating = note |
| `releases.reviews` | Reviews | Avis |  | review: avis (user) vs examen (App Review) |
| `releases.tooEarly` | Too early | Trop tôt |  |  |
| `releases.tooEarlyTitle` | Too early: the release is under 7 days old | Trop tôt : la version a moins de 7 jours |  | release = publication |
| `releases.version` | Version | Version |  |  |
| `releases.worse` | Higher | Plus élevé |  |  |
| `reviews.empty` | No written reviews in this period for {{platform}}. Sync reviews to read new ones. | Aucun avis écrit sur la période pour {{platform}}. Synchronisez les avis pour lire les nouveaux. |  | review: avis (user) vs examen (App Review) |
| `reviews.lead` | The written reviews Kiln stored in this period. Low means {{max}} stars or fewer. These are reviews with text, not every rating. | Les avis écrits que Kiln a enregistrés sur la période. Faible veut dire {{max}} étoiles ou moins. Ce sont des avis avec texte, pas toutes les notes. |  | review: avis (user) vs examen (App Review); rating = note |
| `reviews.lowOf_one` | {{low}} of {{count}} review | {{low}} sur {{count}} avis |  | review: avis (user) vs examen (App Review) |
| `reviews.lowOf_other` | {{low}} of {{count}} reviews | {{low}} sur {{count}} avis |  | review: avis (user) vs examen (App Review) |
| `reviews.open` | Open the low-star reviews | Ouvrir les avis à faible note |  | review: avis (user) vs examen (App Review) |
| `since.android` | Google Play gives no rating history through its API: this trend comes from its daily reports, as recorded since {{date}}. | Google Play ne donne pas d’historique par son API : cette courbe vient de ses rapports quotidiens, enregistrés depuis le {{date}}. |  | rating = note |
| `since.ios` | Apple gives no rating history: Kiln records one point per sync, from {{date}}. Earlier days are not available. | Apple ne donne pas d’historique : Kiln enregistre un point par synchronisation, depuis le {{date}}. Les jours précédents ne sont pas disponibles. |  | rating = note |
| `since.oneReading` | Only one reading so far, so there is no trend yet. A point is added at each sync. | Une seule lecture pour l’instant, donc pas encore de courbe. Un point s’ajoute à chaque synchronisation. |  |  |
| `stability.coverage_one` | Only {{days}} of the last day has numbers. | Seulement {{days}} jour sur le dernier a des chiffres. |  |  |
| `stability.coverage_other` | Only {{days}} of the last {{count}} days have numbers. | Seulement {{days}} jours sur les {{count}} derniers ont des chiffres. |  |  |
| `stability.error` | The last read of the {{platform}} crash numbers failed. Open data sources for the reason, then Sync. | La dernière lecture des chiffres de plantage de {{platform}} a échoué. Ouvrez les sources de données pour voir pourquoi, puis synchronisez. |  |  |
| `stability.noneAndroid` | No crash or ANR numbers for {{platform}} yet. They come from Android vitals (the Play Developer Reporting API): turn them on in data sources, then Sync. | Pas encore de chiffres de plantage ou d’ANR pour {{platform}}. Ils viennent d’Android vitals (API Play Developer Reporting) : activez-les dans les sources de données, puis synchronisez. |  |  |
| `stability.noneIos` | No crash numbers for {{platform}} yet. Apple sends them with App Analytics, for people who opted in, and only for days with at least five crashing users. Turn on analytics, then Sync. | Pas encore de chiffres de plantage pour {{platform}}. Apple les envoie avec App Analytics, pour les personnes qui ont accepté, et seulement les jours avec au moins cinq utilisateurs touchés. Activez les analyses, puis synchronisez. |  |  |
| `stability.noteAndroid` | Google Play reports the share of users with a crash or an ANR, for users who opted in. | Google Play indique la part des utilisateurs touchés par un plantage ou un ANR, parmi ceux qui ont accepté. |  |  |
| `stability.noteIos` | Apple counts only people who shared analytics, and sends crash numbers only for days with at least five crashing users: a day without a number is not a day without crashes. | Apple ne compte que les personnes qui partagent leurs analyses et n’envoie les plantages que pour les jours avec au moins cinq utilisateurs touchés : un jour sans chiffre n’est pas un jour sans plantage. |  |  |
| `stability.openSources` | Open data sources | Ouvrir les sources de données |  |  |
| `stability.setup` | Crash numbers for {{platform}} are not set up yet: the store source behind them is off or needs a permission. | Les chiffres de plantage de {{platform}} ne sont pas encore configurés : la source du store est désactivée ou demande une autorisation. |  |  |
| `stars.label_one` | {{count}} star | {{count}} étoile |  |  |
| `stars.label_other` | {{count}} stars | {{count}} étoiles |  |  |
| `stars.title_one` | New ratings by stars ({{count}} rating) | Nouvelles notes par étoiles ({{count}} note) |  | rating = note |
| `stars.title_other` | New ratings by stars ({{count}} ratings) | Nouvelles notes par étoiles ({{count}} notes) |  | rating = note |
| `tile.average` | Average rating | Note moyenne |  | rating = note |
| `tile.averageTitle` | The rating the store shows now, from the latest reading Kiln made | La note affichée par le store, d’après la dernière lecture de Kiln |  | rating = note |
| `tile.count` | Ratings | Notes |  | rating = note |
| `tile.countTitle` | How many people rated the app, from the latest reading | Combien de personnes ont noté l’app, d’après la dernière lecture |  |  |
| `tile.crash` | Crash rate | Taux de plantage |  |  |
| `tile.freeze` | ANR rate | Taux d’ANR |  |  |
| `tile.lowReviews` | Low-star reviews | Avis à faible note |  | review: avis (user) vs examen (App Review) |
| `tile.lowTitle` | Written reviews with {{max}} stars or fewer | Avis écrits de {{max}} étoiles ou moins |  | review: avis (user) vs examen (App Review) |
| `tile.new` | New ratings | Nouvelles notes |  | rating = note |
| `tile.newTitle` | Ratings added in this period: the difference between two readings of the store | Notes ajoutées sur la période : la différence entre deux lectures du store |  | rating = note |
| `tile.rateTitle` | Mean of the {{days}} days with numbers in this period | Moyenne des {{days}} jours avec des chiffres sur la période |  |  |
| `tile.reviews` | Written reviews | Avis écrits |  | review: avis (user) vs examen (App Review) |
| `tile.reviewsTitle` | Reviews with text that Kiln stored in this period (not the same as ratings) | Avis avec texte enregistrés par Kiln sur la période (différent des notes) |  | review: avis (user) vs examen (App Review); rating = note |

## web/release-stepper (57)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `ap.allStaged` | All the store asset changes of the repository are in your pending changes. | Toutes les modifications de la fiche présentes dans le dépôt sont dans vos modifications en attente. |  | cart = "Modifications en attente" |
| `ap.checking` | Checking the repository for changed store assets | Recherche des éléments de la fiche modifiés dans le dépôt |  |  |
| `ap.confirm.body_one` | {{count}} of the selected items has errors. A store may refuse it when the changes are published. Stage it anyway? | {{count}} des éléments sélectionnés présente des erreurs. Une boutique peut le refuser lors de la publication des modifications. Le préparer quand même ? |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.confirm.body_other` | {{count}} of the selected items have errors. A store may refuse them when the changes are published. Stage them anyway? | {{count}} des éléments sélectionnés présentent des erreurs. Une boutique peut les refuser lors de la publication des modifications. Les préparer quand même ? |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.confirm.title` | Stage items that have errors? | Préparer des éléments qui présentent des erreurs ? |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.confirm.yes` | Stage anyway | Préparer quand même |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.doneFailed_one` | {{count}} item could not be staged. | {{count}} élément n’a pas pu être préparé. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.doneFailed_other` | {{count}} items could not be staged. | {{count}} éléments n’ont pas pu être préparés. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.doneLeft_one` | {{count}} item was already staged and was left as it is. | {{count}} élément était déjà préparé et a été laissé tel quel. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.doneLeft_other` | {{count}} items were already staged and were left as they are. | {{count}} éléments étaient déjà préparés et ont été laissés tels quels. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.done_one` | {{count}} item staged. Nothing was sent to a store. | {{count}} élément préparé. Rien n’a été envoyé à une boutique. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.done_other` | {{count}} items staged. Nothing was sent to a store. | {{count}} éléments préparés. Rien n’a été envoyé à une boutique. |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.issues.errorWord` | Error | Erreur |  |  |
| `ap.issues.errors_one` | {{count}} error | {{count}} erreur |  |  |
| `ap.issues.errors_other` | {{count}} errors | {{count}} erreurs |  |  |
| `ap.issues.none` | No problems found in these texts and graphics. | Aucun problème trouvé dans ces textes et ces visuels. |  |  |
| `ap.issues.tipWord` | Tip | Conseil |  |  |
| `ap.issues.tips_one` | {{count}} tip | {{count}} conseil |  |  |
| `ap.issues.tips_other` | {{count}} tips | {{count}} conseils |  |  |
| `ap.issues.title` | Checked before you stage | Vérifié avant de préparer |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.issues.warningWord` | Warning | Avertissement |  |  |
| `ap.issues.warnings_one` | {{count}} warning | {{count}} avertissement |  |  |
| `ap.issues.warnings_other` | {{count}} warnings | {{count}} avertissements |  |  |
| `ap.item.empty` | nothing | rien |  |  |
| `ap.item.hasIssues` | Has issues | Présente des problèmes |  |  |
| `ap.item.repo` | Repository | Dépôt |  |  |
| `ap.item.selectAria` | Stage {{item}} ({{locale}}) | Préparer {{item}} ({{locale}}) |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.item.store` | Store | Boutique |  |  |
| `ap.items.title` | Changes to stage | Modifications à préparer |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.later` | Remind me later | Me le rappeler plus tard |  |  |
| `ap.laterLine_one` | {{count}} store asset change is waiting for your decision. | {{count}} modification de la fiche attend votre décision. |  |  |
| `ap.laterLine_other` | {{count}} store asset changes are waiting for your decision. | {{count}} modifications de la fiche attendent votre décision. |  |  |
| `ap.lead` | Texts and graphics that changed in the repository since the previous release and still differ from the store. Staging only adds them to your pending changes: nothing is sent to a store. | Textes et visuels modifiés dans le dépôt depuis la version précédente et qui diffèrent encore de la boutique. Les préparer les ajoute seulement à vos modifications en attente : rien n’est envoyé à une boutique. |  | cart = "Modifications en attente"; stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.loadFailed` | Could not check the repository for changed store assets | Impossible de chercher dans le dépôt les éléments de la fiche modifiés |  |  |
| `ap.locked` | The listing is locked: a version is live or in App Review. Prepare a new version first, then these changes can be staged. | La fiche est verrouillée : une version est en ligne ou en cours d’examen. Préparez d’abord une nouvelle version, puis ces modifications pourront être préparées. |  | stage = prepare locally, nothing is sent: see staged glossary row; listing = fiche |
| `ap.notListed` | Not listed: {{unchanged}} unchanged since the last release, {{same}} identical to the store, {{other}} that cannot be staged (for example the App Store name and subtitle). | Non listés : {{unchanged}} inchangés depuis la dernière version, {{same}} identiques à la boutique, {{other}} impossibles à préparer (par exemple le nom et le sous-titre App Store). |  | stage = prepare locally, nothing is sent: see staged glossary row; release = publication |
| `ap.openCart` | Open pending changes | Ouvrir les modifications en attente |  | cart = "Modifications en attente" |
| `ap.refs` | Compared: the previous release ({{base}}) with this release ({{target}}). | Comparé : la version précédente ({{base}}) et cette version ({{target}}). |  | release = publication |
| `ap.refsBranch` | Compared: the previous release ({{base}}) with the default branch ({{target}}), because no build is chosen for this release yet. | Comparé : la version précédente ({{base}}) et la branche par défaut ({{target}}), car aucun build n’est encore choisi pour cette version. |  | release = publication |
| `ap.refsNoBase` | No previous release found: everything in the repository ({{target}}) that differs from the store is listed. | Aucune version précédente trouvée : tout ce que le dépôt ({{target}}) contient de différent de la boutique est listé. |  | release = publication |
| `ap.review` | Review | Examiner |  | review: avis (user) vs examen (App Review) |
| `ap.show` | Show again | Afficher de nouveau |  |  |
| `ap.skip` | Skip for this release | Ignorer pour cette version |  | release = publication |
| `ap.skippedLine` | Store asset changes skipped for this release. | Modifications de la fiche ignorées pour cette version. |  | release = publication |
| `ap.stage` | Stage selected ({{count}}) | Préparer la sélection ({{count}}) |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.staged.edited` | Already staged with your edit, kept as it is | Déjà préparé avec votre modification, conservé tel quel |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.staged.same` | Already staged | Déjà préparé |  | stage = prepare locally, nothing is sent: see staged glossary row |
| `ap.staged.title` | Already in your pending changes | Déjà dans vos modifications en attente |  | cart = "Modifications en attente" |
| `ap.storeUnread` | The graphics in the store could not be read, so graphics are listed by what changed in the repository alone. | Les visuels de la boutique n’ont pas pu être lus : les visuels sont donc listés d’après les seules modifications du dépôt. |  |  |
| `ap.sum.graphics_one` | {{count}} graphics set | {{count}} série de visuels |  |  |
| `ap.sum.graphics_other` | {{count}} graphics sets | {{count}} séries de visuels |  |  |
| `ap.sum.locales_one` | in {{count}} language | dans {{count}} langue |  |  |
| `ap.sum.locales_other` | in {{count}} languages | dans {{count}} langues |  |  |
| `ap.sum.texts_one` | {{count}} text | {{count}} texte |  |  |
| `ap.sum.texts_other` | {{count}} texts | {{count}} textes |  |  |
| `ap.title` | Store assets changed in the repository | Éléments de la fiche modifiés dans le dépôt |  |  |
| `ap.truncated` | Only the first items are listed. | Seuls les premiers éléments sont listés. |  |  |

## web/reviews (24)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `ai.regenerate` | Summarise again | Résumer à nouveau |  |  |
| `ai.staleMany_one` | More than {{count}} review came in after this summary. Summarise again to include them. | Plus de {{count}} avis sont arrivés après ce résumé. Résumez à nouveau pour les inclure. |  | review: avis (user) vs examen (App Review) |
| `ai.staleMany_other` | {{count}} or more reviews came in after this summary. Summarise again to include them. | {{count}} avis ou plus sont arrivés après ce résumé. Résumez à nouveau pour les inclure. |  | review: avis (user) vs examen (App Review) |
| `ai.stale_one` | {{count}} review came in after this summary. Summarise again to include it. | {{count}} avis est arrivé après ce résumé. Résumez à nouveau pour l’inclure. |  | review: avis (user) vs examen (App Review) |
| `ai.stale_other` | {{count}} reviews came in after this summary. Summarise again to include them. | {{count}} avis sont arrivés après ce résumé. Résumez à nouveau pour les inclure. |  | review: avis (user) vs examen (App Review) |
| `ai.summaryNotice` | A summary reads at most {{reviews}} reviews of the period (the newest and some of the lowest-rated), {{chars}} characters each. Names, emails, links and phone numbers are removed; the reviewer, the device and the country are never sent. The same reviews reuse the stored summary. | Un résumé lit au plus {{reviews}} avis de la période (les plus récents et quelques-uns des moins bien notés), {{chars}} caractères chacun. Les noms, e-mails, liens et numéros de téléphone sont retirés ; l’auteur, l’appareil et le pays ne sont jamais envoyés. Les mêmes avis réutilisent le résumé enregistré. |  | review: avis (user) vs examen (App Review) |
| `competitors.actions` | Actions | Actions |  |  |
| `competitors.app` | App | Application |  |  |
| `competitors.average` | Average | Moyenne |  |  |
| `competitors.caption` | Reviews of this app and of the followed competitors | Avis de cette application et des concurrents suivis |  | review: avis (user) vs examen (App Review) |
| `competitors.count` | Reviews | Avis |  | review: avis (user) vs examen (App Review) |
| `competitors.lead` | Public App Store reviews of the competitors you follow, read from Apple's customer reviews feed when you press Read and kept for {{days}} days. The reviewer is never stored. Nothing here is sent to an AI model. | Avis publics de l’App Store des concurrents que vous suivez, lus depuis le flux d’avis clients d’Apple quand vous appuyez sur Lire et conservés {{days}} jours. L’auteur n’est jamais enregistré. Rien n’est envoyé à un modèle d’IA ici. |  | review: avis (user) vs examen (App Review) |
| `competitors.noneFollowed` | No competitors followed yet. Follow an App Store app in the ASO competitors list, then read its reviews here. | Aucun concurrent suivi pour l’instant. Suivez une application de l’App Store dans la liste des concurrents ASO, puis lisez ses avis ici. |  | review: avis (user) vs examen (App Review) |
| `competitors.periodLabel` | Period of the comparison | Période de la comparaison |  |  |
| `competitors.playNote` | Google Play competitors are not available: Google offers no official way to read the reviews of an app you do not own, and Kiln does not scrape its pages. | Les concurrents Google Play ne sont pas disponibles : Google ne propose aucun moyen officiel de lire les avis d’une application qui n’est pas la vôtre, et Kiln n’extrait pas ses pages. |  | review: avis (user) vs examen (App Review) |
| `competitors.read` | Read | Lire |  |  |
| `competitors.readAt` | read {{time}} | lu {{time}} |  |  |
| `competitors.readDone_one` | {{count}} review stored. | {{count}} avis enregistré. |  | review: avis (user) vs examen (App Review) |
| `competitors.readDone_other` | {{count}} reviews stored. | {{count}} avis enregistrés. |  | review: avis (user) vs examen (App Review) |
| `competitors.recent` | Read a few minutes ago: nothing new was asked of the App Store. | Lu il y a quelques minutes : rien de nouveau n’a été demandé à l’App Store. |  |  |
| `competitors.thisApp` | This app | Cette application |  |  |
| `competitors.title` | Competitors | Concurrents |  |  |
| `competitors.trend` | First half, second half | Première moitié, seconde moitié |  |  |
| `competitors.unavailable` | Not available for Google Play. | Non disponible pour Google Play. |  |  |

## web/settings (31)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `group.ai` | AI | IA |  |  |
| `group.integrations` | Integrations | Intégrations |  |  |
| `group.personal` | Just for you | Pour vous |  |  |
| `group.security` | Security | Sécurité |  |  |
| `group.workspace` | Workspace | Espace de travail |  |  |
| `keywords.ai` | assistant model key provider monthly limit openai anthropic | assistant modèle clé fournisseur limite mensuelle openai anthropic |  |  |
| `keywords.analytics` | opt-in vendor number apple play bucket reports | opt-in numéro fournisseur apple play bucket rapports |  |  |
| `keywords.chat` | slack teams webhook channel notifications digest alerts routing | slack teams webhook canal notifications résumé alertes routage |  |  |
| `keywords.confirm` | hard actions step-up password recovery codes confirm | actions critiques réauthentification mot de passe codes de récupération confirmer |  |  |
| `keywords.language` | locale french spanish german english display | langue locale français espagnol allemand anglais affichage |  |  |
| `keywords.mail` | smtp email server host port sender | smtp e-mail serveur hôte port expéditeur |  |  |
| `keywords.mcp` | mcp connect assistant claude tools token | mcp connecter assistant claude outils jeton |  |  |
| `keywords.releases` | unfinished release days stuck reminder | version inachevée jours bloquée rappel |  | release = publication |
| `keywords.reviews` | ratings low rating threshold reminder unanswered replies | notes avis seuil note basse rappel sans réponse réponses |  | rating = note |
| `keywords.secondFactor` | two-factor 2fa authenticator totp email code | double authentification 2fa authentificateur totp e-mail code |  |  |
| `keywords.storeRefresh` | sync interval schedule refresh stores alerts review state | synchronisation intervalle planification actualisation stores alertes état de revue |  | review: avis (user) vs examen (App Review) |
| `keywords.translation` | translate provider deepl google target language budget | traduction fournisseur deepl google langue cible budget |  |  |
| `keywords.webhooks` | http callback events signing endpoint | http rappel événements signature point de terminaison |  |  |
| `nav.label` | Settings sections | Sections des paramètres |  |  |
| `nav.noMatch` | No section matches “{{query}}”. | Aucune section ne correspond à « {{query}} ». |  |  |
| `nav.search` | Search settings | Rechercher un paramètre |  |  |
| `nav.searchLabel` | Search the settings sections | Rechercher dans les sections des paramètres |  |  |
| `nav.unsaved` | Unsaved changes | Modifications non enregistrées |  |  |
| `nav.unsavedWithLink` | You have unsaved workspace changes. They stay until you save or discard them there. <link>Go to the workspace settings</link>. | Vous avez des modifications non enregistrées de l’espace de travail. Elles sont conservées jusqu’à ce que vous les enregistriez ou les annuliez à cet endroit. <link>Aller aux paramètres de l’espace de travail</link>. |  |  |
| `page.otherSectionAnalytics` | A value in Analytics is not valid. Fix it there, then save. | Une valeur de la section Analytics n’est pas valide. Corrigez-la à cet endroit, puis enregistrez. |  |  |
| `page.otherSectionWorkspace` | A value in another workspace section is not valid. Fix it there, then save. | Une valeur d’une autre section de l’espace de travail n’est pas valide. Corrigez-la à cet endroit, puis enregistrez. |  |  |
| `section.ai` | AI assistant | Assistant IA |  |  |
| `section.analytics` | Analytics | Analytics |  |  |
| `section.chat` | Slack and Teams | Slack et Teams |  |  |
| `section.language` | Language | Langue |  |  |
| `section.mcp` | Connect an AI assistant | Connecter un assistant IA |  |  |

## web/shell (4)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `nav.chat` | Slack and Teams | Slack et Teams |  |  |
| `nav.collapse` | Collapse the navigation to icons | Réduire la navigation en icônes |  |  |
| `nav.expand` | Expand the navigation | Déplier la navigation |  |  |
| `shortcut.any.sidebar` | Fold or unfold the left panel | Replier ou déplier le panneau de gauche |  |  |

## web/testflight (130)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `build.both` | {{version}} (build {{build}}) | {{version}} (build {{build}}) |  |  |
| `build.number` | Build {{build}} | Build {{build}} |  |  |
| `build.unknown` | Unknown build | Build inconnu |  |  |
| `connection.mobileData` | Mobile data | Données mobiles |  |  |
| `connection.none` | No connection | Aucune connexion |  |  |
| `connection.unknown` | Unknown | Inconnue |  |  |
| `connection.wifi` | Wi-Fi | Wi-Fi |  |  |
| `connection.wire` | Wired | Filaire |  |  |
| `console.body` | Screenshots are not shown here (the page does not load images from other sites). Open them from the detail, or in App Store Connect, under TestFlight, Feedback. | Les captures d’écran ne s’affichent pas ici (la page ne charge pas d’images d’autres sites). Ouvrez-les depuis le détail, ou dans App Store Connect, sous TestFlight, Feedback. |  |  |
| `console.title` | The full list is also in App Store Connect | La liste complète est aussi dans App Store Connect |  |  |
| `crash.copy` | Copy the log | Copier le journal |  |  |
| `crash.heading` | Crash log | Journal de plantage |  |  |
| `crash.hide` | Hide the log | Masquer le journal |  |  |
| `crash.missing` | Apple has no crash log for this submission. | Apple n’a pas de journal de plantage pour cette soumission. |  | submit: soumettre vs envoyer |
| `crash.noLog` | The crash log has not been read yet. It is read by the next sync. | Le journal de plantage n’a pas encore été lu. La prochaine synchronisation le lira. |  |  |
| `crash.noteAddresses` | The first frame is an address, not a name: this log is probably not symbolicated. Symbolicate it with the dSYM of the build. | La première trame est une adresse, pas un nom : ce journal n’est probablement pas symbolisé. Symbolisez-le avec le dSYM du build. |  |  |
| `crash.noteSymbols` | The first frame has a name. The rest of the log is shown as Apple gave it; Kiln does not check whether every frame is symbolicated. | La première trame a un nom. Le reste du journal est affiché tel qu’Apple l’a donné ; Kiln ne vérifie pas si chaque trame est symbolisée. |  |  |
| `crash.noteUnknown` | Kiln could not read the layout of this log. It is shown as Apple gave it, and may or may not be symbolicated. | Kiln n’a pas pu lire la structure de ce journal. Il est affiché tel qu’Apple l’a donné et peut être symbolisé ou non. |  |  |
| `crash.show` | Show the log | Afficher le journal |  |  |
| `crash.signature` | Signature | Signature |  |  |
| `crash.signatureHint` | Kiln groups crashes by the exception and the first frame of the crashed thread. | Kiln regroupe les plantages par exception et par première trame du fil planté. |  |  |
| `crash.truncated` | The log was cut at 64 KB. | Le journal a été coupé à 64 Ko. |  |  |
| `detail.assignee` | Assignee | Assigné à |  |  |
| `detail.changedBy` | Changed {{ago}} | Modifié {{ago}} |  |  |
| `detail.close` | Close | Fermer |  |  |
| `detail.comment` | Comment | Commentaire |  |  |
| `detail.deviceHeading` | Tester and device | Testeur et appareil |  |  |
| `detail.emailHidden` | The email address is shown to administrators only. | L’adresse e-mail n’est visible que des administrateurs. |  |  |
| `detail.formerMember` | A former member | Un ancien membre |  |  |
| `detail.loadError` | The details could not be read. | Les détails n’ont pas pu être lus. |  |  |
| `detail.loading` | Reading the details | Lecture des détails |  |  |
| `detail.nobody` | Nobody | Personne |  |  |
| `detail.note` | Internal note | Note interne |  |  |
| `detail.noteHint` | Only your team sees it. It is never sent to Apple. | Seule votre équipe la voit. Elle n’est jamais envoyée à Apple. |  |  |
| `detail.save` | Save | Enregistrer |  |  |
| `detail.saveFailed` | The change could not be saved. | La modification n’a pas pu être enregistrée. |  |  |
| `detail.saved` | Saved. | Enregistré. |  |  |
| `detail.screenshotsCount_one` | {{count}} screenshot. Apple's links expire after a short time, so they are read when you ask. | {{count}} capture d’écran. Les liens d’Apple expirent après peu de temps : ils sont lus à votre demande. |  |  |
| `detail.screenshotsCount_other` | {{count}} screenshots. Apple's links expire after a short time, so they are read when you ask. | {{count}} captures d’écran. Les liens d’Apple expirent après peu de temps : ils sont lus à votre demande. |  |  |
| `detail.screenshotsExpire` | The links expire {{when}}. Ask again if they stopped working. | Les liens expirent {{when}}. Redemandez-les s’ils ne fonctionnent plus. |  |  |
| `detail.screenshotsFailed` | The screenshot links could not be read. | Les liens des captures n’ont pas pu être lus. |  |  |
| `detail.screenshotsHeading` | Screenshots | Captures d’écran |  |  |
| `detail.screenshotsLoad` | Get the screenshot links | Obtenir les liens des captures |  |  |
| `detail.screenshotsNoLinks` | Apple gave no link for this feedback. It may have been deleted in App Store Connect. | Apple n’a donné aucun lien pour ce retour. Il a peut-être été supprimé dans App Store Connect. |  |  |
| `detail.screenshotsNone` | This feedback has no screenshot. | Ce retour n’a pas de capture d’écran. |  |  |
| `detail.screenshotsOpen` | Open screenshot {{number}} | Ouvrir la capture {{number}} |  |  |
| `detail.status` | Status | Statut |  |  |
| `detail.tester` | Tester | Testeur |  |  |
| `detail.title` | Details | Détails |  |  |
| `detail.triageHeading` | Triage | Tri |  |  |
| `empty.crashDescription` | No tester has sent a crash report yet, or none matches the filters. Good news, if you have testers. | Aucun testeur n’a envoyé de rapport de plantage, ou aucun ne correspond aux filtres. Bonne nouvelle, si vous avez des testeurs. |  |  |
| `empty.crashTitle` | No crashes | Aucun plantage |  |  |
| `empty.feedbackDescription` | No tester has sent feedback with a screenshot yet, or none matches the filters. Testers send it from TestFlight: take a screenshot, then Share Beta Feedback. | Aucun testeur n’a envoyé de retour avec capture d’écran, ou aucun ne correspond aux filtres. Les testeurs l’envoient depuis TestFlight : capture d’écran, puis Partager le feedback bêta. |  |  |
| `empty.feedbackTitle` | No feedback | Aucun retour |  |  |
| `empty.neverDescription` | Sync to read the feedback and crashes your testers sent from TestFlight. The app must have been distributed with TestFlight, and the App Store Connect key needs the Admin, App Manager or Developer role. | Synchronisez pour lire les retours et les plantages que vos testeurs ont envoyés depuis TestFlight. L’application doit avoir été distribuée avec TestFlight et la clé App Store Connect doit avoir le rôle Admin, App Manager ou Developer. |  |  |
| `empty.neverTitle` | Nothing read yet | Rien de lu pour l’instant |  |  |
| `fact.architecture` | Architecture | Architecture |  |  |
| `fact.battery` | Battery | Batterie |  |  |
| `fact.bundle` | Bundle id | Identifiant de bundle |  |  |
| `fact.connection` | Connection | Connexion |  |  |
| `fact.device` | Device | Appareil |  |  |
| `fact.disk` | Free disk space | Espace disque libre |  |  |
| `fact.diskValue` | {{free}} of {{total}} | {{free}} sur {{total}} |  |  |
| `fact.family` | Device family | Famille d’appareils |  |  |
| `fact.locale` | Language | Langue |  |  |
| `fact.screen` | Screen (points) | Écran (points) |  |  |
| `fact.sent` | Sent | Envoyé |  |  |
| `fact.timeZone` | Time zone | Fuseau horaire |  |  |
| `fact.uptime` | App uptime | Durée d’exécution de l’app |  |  |
| `fact.watch` | Paired watch | Montre associée |  |  |
| `filter.all` | All | Tous |  |  |
| `filter.build` | Build | Build |  |  |
| `filter.clear` | Clear filters | Effacer les filtres |  |  |
| `filter.label` | Filters | Filtres |  |  |
| `filter.open` | Open | Ouverts |  |  |
| `filter.signature` | Showing one crash group | Un seul groupe de plantages affiché |  |  |
| `filter.status` | Status | Statut |  |  |
| `filter.tester` | Tester | Testeur |  |  |
| `filter.version` | Version | Version |  |  |
| `groups.builds` | Builds: {{builds}} | Builds : {{builds}} |  |  |
| `groups.byBuild` | By build | Par build |  |  |
| `groups.bySignature` | By signature | Par signature |  |  |
| `groups.count_one` | {{count}} crash | {{count}} plantage |  |  |
| `groups.count_other` | {{count}} crashes | {{count}} plantages |  |  |
| `groups.heading` | Crashes by build and by signature | Plantages par build et par signature |  |  |
| `groups.loadError` | The groups could not be read. | Les groupes n’ont pas pu être lus. |  |  |
| `groups.open` | {{count}} open | {{count}} ouverts |  |  |
| `groups.show` | Show these crashes | Afficher ces plantages |  |  |
| `groups.unknown` | No signature (log not read, or an unknown layout) | Sans signature (journal non lu, ou structure inconnue) |  |  |
| `kind.crash` | Crashes | Plantages |  |  |
| `kind.feedback` | Feedback | Retours |  |  |
| `list.colBuild` | Build | Build |  |  |
| `list.colComment` | Comment | Commentaire |  |  |
| `list.colSent` | Sent | Envoyé |  |  |
| `list.colStatus` | Status | Statut |  |  |
| `list.colTester` | Tester | Testeur |  |  |
| `list.more` | Load more | Charger la suite |  |  |
| `list.noComment` | No comment | Pas de commentaire |  |  |
| `list.screenshots_one` | {{count}} screenshot | {{count}} capture d’écran |  |  |
| `list.screenshots_other` | {{count}} screenshots | {{count}} captures d’écran |  |  |
| `status.ignored` | Ignored | Ignoré |  |  |
| `status.inProgress` | In progress | En cours |  |  |
| `status.new` | New | Nouveau |  |  |
| `status.resolved` | Resolved | Résolu |  |  |
| `status.seen` | Seen | Vu |  |  |
| `sync.failedKept` | The last read failed ({{error}}). What is shown was read {{ago}}. | La dernière lecture a échoué ({{error}}). Ce qui est affiché a été lu {{ago}}. |  |  |
| `sync.failedNothing` | The last read failed: {{error}} | La dernière lecture a échoué : {{error}} |  |  |
| `sync.never` | Never read. Sync to read the TestFlight feedback. | Jamais lu. Synchronisez pour lire les retours TestFlight. |  |  |
| `sync.partial` | Read {{ago}}, but only the newest submissions: Apple may have older ones. | Lu {{ago}}, mais seulement les soumissions les plus récentes : Apple en a peut-être d’autres, plus anciennes. |  | submit: soumettre vs envoyer |
| `sync.read` | Read {{ago}}. | Lu {{ago}}. |  |  |
| `tab.about` | About this view | À propos de cette vue |  |  |
| `tab.aboutBody` | Kiln reads the feedback and crash reports your testers send from TestFlight, keeps a copy here, and lets your team triage them. It never deletes or changes anything in App Store Connect. | Kiln lit les retours et les rapports de plantage que vos testeurs envoient depuis TestFlight, en garde une copie ici et permet à votre équipe de les trier. Il ne supprime ni ne modifie rien dans App Store Connect. |  |  |
| `tab.aboutRequirements` | Needed: the app has been distributed with TestFlight, and its App Store Connect key has the Admin, App Manager or Developer role. | Prérequis : l’application a été distribuée avec TestFlight et la clé App Store Connect a le rôle Admin, App Manager ou Developer. |  |  |
| `tab.aboutRetention` | Apple keeps feedback for about a year and crash logs for 120 days; Kiln keeps what it has read until the retention of the workspace. | Apple garde les retours environ un an et les journaux de plantage 120 jours ; Kiln garde ce qu’il a lu jusqu’à la durée de conservation de l’espace de travail. |  |  |
| `tab.headlineCount` | {{feedback}} feedback and {{crashes}} crashes from your testers | {{feedback}} retours et {{crashes}} plantages de vos testeurs |  |  |
| `tab.headlineDefault` | TestFlight feedback and crashes | Retours et plantages TestFlight |  |  |
| `tab.headlineNone` | No TestFlight feedback yet | Aucun retour TestFlight pour l’instant |  |  |
| `tab.kinds` | Kind of submission | Type de soumission |  | submit: soumettre vs envoyer |
| `tab.leadHint` | What your beta testers send from TestFlight, next to the customer reviews. | Ce que vos testeurs envoient depuis TestFlight, à côté des avis clients. |  | review: avis (user) vs examen (App Review) |
| `tab.listLabel` | {{kind}} of {{app}} | {{kind}} de {{app}} |  |  |
| `tab.loadError` | The feedback could not be read. | Les retours n’ont pas pu être lus. |  |  |
| `tab.loadErrorTitle` | The feedback could not be read | Les retours n’ont pas pu être lus |  |  |
| `tab.openConsole` | Open in App Store Connect | Ouvrir dans App Store Connect |  |  |
| `tab.partsTitle` | Some of it could not be read | Une partie n’a pas pu être lue |  |  |
| `tab.reading` | Reading the feedback | Lecture des retours |  |  |
| `tab.syncFailedTitle` | The sync failed | La synchronisation a échoué |  |  |
| `tester.anonymous` | Anonymous tester | Testeur anonyme |  |  |
| `tester.code` | Tester {{code}} | Testeur {{code}} |  |  |
| `unsupported.body` | Google Play has no TestFlight. Beta feedback of Android testers is read in the Play Console. | Google Play n’a pas de TestFlight. Les retours des testeurs Android se lisent dans la Play Console. |  |  |
| `unsupported.title` | TestFlight is for App Store Connect apps | TestFlight est réservé aux applications App Store Connect |  |  |

## web/timeline (150)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `add.app` | Platform | Plateforme |  |  |
| `add.day` | Day | Jour |  |  |
| `add.description` | A note marks a day: an ad campaign, a price change, press. It is only text for your team; nothing is sent to a store. | Une note marque un jour : campagne publicitaire, changement de prix, presse. C’est un simple texte pour votre équipe ; rien n’est envoyé à un store. |  |  |
| `add.failed` | The note could not be saved. | La note n’a pas pu être enregistrée. |  |  |
| `add.kind` | Type | Type |  |  |
| `add.name` | Title | Titre |  |  |
| `add.nameHint` | Up to 120 characters. | 120 caractères au maximum. |  |  |
| `add.note` | Details (optional) | Détails (facultatif) |  |  |
| `add.noteHint` | Up to {{max}} characters. | {{max}} caractères au maximum. |  |  |
| `add.open` | Add note | Ajouter une note |  |  |
| `add.save` | Add note | Ajouter la note |  |  |
| `add.saved` | Note added. | Note ajoutée. |  |  |
| `add.title` | Add a note to the timeline | Ajouter une note à la chronologie |  |  |
| `event.competitorChange` | {{name}} changed its App Store listing: {{what}} | {{name}} a modifié sa fiche App Store : {{what}} |  | listing = fiche |
| `event.competitorKind.category` | category | catégorie |  |  |
| `event.competitorKind.description` | description | description |  |  |
| `event.competitorKind.icon` | icon | icône |  |  |
| `event.competitorKind.name` | name | nom |  |  |
| `event.competitorKind.price` | price | prix |  |  |
| `event.competitorKind.releaseNotes` | release notes | notes de version |  | release = publication |
| `event.competitorKind.screenshots` | screenshots | captures d’écran |  |  |
| `event.competitorKind.version` | version | version |  |  |
| `event.experimentEnded` | Experiment ended: {{name}} | Test terminé : {{name}} |  |  |
| `event.experimentStarted` | Experiment started: {{name}} | Test démarré : {{name}} |  |  |
| `event.graphics_one` | {{count}} graphics set pushed to the store draft | {{count}} jeu de visuels envoyé au brouillon du store |  |  |
| `event.graphics_other` | {{count}} graphics sets pushed to the store draft | {{count}} jeux de visuels envoyés au brouillon du store |  |  |
| `event.listingDrift_one` | {{count}} change to the live store listing that Kiln did not make | {{count}} modification de la fiche en ligne non faite par Kiln |  | listing = fiche; live = en ligne |
| `event.listingDrift_other` | {{count}} changes to the live store listing that Kiln did not make | {{count}} modifications de la fiche en ligne non faites par Kiln |  | listing = fiche; live = en ligne |
| `event.listingText_one` | {{count}} listing text change pushed to the store draft | {{count}} texte de fiche envoyé au brouillon du store |  | listing = fiche |
| `event.listingText_other` | {{count}} listing text changes pushed to the store draft | {{count}} textes de fiche envoyés au brouillon du store |  | listing = fiche |
| `event.release` | Version {{version}} released | Version {{version}} publiée |  |  |
| `event.releaseRollingOut` | Version {{version}} started a staged rollout | La version {{version}} a démarré un déploiement progressif |  | stage = prepare locally, nothing is sent: see staged glossary row; rollout = déploiement |
| `event.releaseTrack` | Version {{version}} released on {{track}} | Version {{version}} publiée sur {{track}} |  | track = piste (Play) / suivre (keyword) |
| `event.rolloutStep` | Rollout of {{version}} reached {{percent}}% | Le déploiement de {{version}} a atteint {{percent}} % |  | rollout = déploiement |
| `filter.all` | All | Tous |  |  |
| `filter.clear` | Show all types | Afficher tous les types |  |  |
| `filter.label` | Filter by type | Filtrer par type |  |  |
| `kind.adCampaign` | Ad campaign | Campagne publicitaire |  |  |
| `kind.competitorChange` | Competitor listing changed | Fiche d’un concurrent modifiée |  | listing = fiche |
| `kind.experimentEnded` | Experiment ended | Test terminé |  |  |
| `kind.experimentStarted` | Experiment started | Test démarré |  |  |
| `kind.graphics` | Graphics | Visuels |  |  |
| `kind.listingDrift` | Store listing changed | Fiche modifiée dans le store |  | listing = fiche |
| `kind.listingText` | Listing text | Texte de la fiche |  | listing = fiche |
| `kind.other` | Note | Note |  |  |
| `kind.press` | Press | Presse |  |  |
| `kind.priceChange` | Price change | Changement de prix |  |  |
| `kind.release` | Release | Publication |  | release = publication |
| `kind.rollout` | Rollout step | Étape de déploiement |  | rollout = déploiement |
| `list.byKiln` | Recorded by Kiln | Enregistré par Kiln |  |  |
| `list.byPerson` | Note added by a person | Note ajoutée par une personne |  |  |
| `list.cut` | The range is longer than the timeline reads at once: it shows the days since {{date}}. | La période est plus longue que ce que la chronologie lit en une fois : elle montre les jours depuis le {{date}}. |  |  |
| `list.empty` | No events in this range. Kiln records releases, rollout steps, pushes to the store draft, experiments and changes of the live listing; add a note for anything else, such as an ad campaign or a price change. | Aucun événement sur cette période. Kiln enregistre les publications, les étapes de déploiement, les envois au brouillon du store, les tests et les changements de la fiche en ligne ; ajoutez une note pour le reste, comme une campagne publicitaire ou un changement de prix. |  | release = publication; rollout = déploiement |
| `list.failed_one` | The timeline of {{count}} platform could not be read | La chronologie de {{count}} plateforme n’a pas pu être lue |  |  |
| `list.failed_other` | The timeline of {{count}} platforms could not be read | La chronologie de {{count}} plateformes n’a pas pu être lue |  |  |
| `list.label` | Events by day, newest first | Événements par jour, du plus récent au plus ancien |  |  |
| `list.liveOn` | live in the store on {{date}} | en ligne dans le store le {{date}} |  | live = en ligne |
| `list.loading` | Reading the timeline | Lecture de la chronologie |  |  |
| `list.more_one` | Show {{count}} more | Afficher {{count}} de plus |  |  |
| `list.more_other` | Show {{count}} more | Afficher {{count}} de plus |  |  |
| `list.noMatch` | No events of the chosen types in this range. | Aucun événement de ces types sur cette période. |  |  |
| `list.remove` | Delete note: {{name}} | Supprimer la note : {{name}} |  |  |
| `list.removeFailed` | The note could not be deleted. | La note n’a pas pu être supprimée. |  |  |
| `list.removed` | Note deleted. | Note supprimée. |  |  |
| `list.result_one` | {{count}} event shown | {{count}} événement affiché |  |  |
| `list.result_other` | {{count}} events shown | {{count}} événements affichés |  |  |
| `list.shown` | Showing {{shown}} of {{total}} | {{shown}} affichés sur {{total}} |  |  |
| `list.waits` | goes live with the next release | sera en ligne avec la prochaine version |  | release = publication; live = en ligne |
| `marker.caption` | Diamonds on the axis mark days with events; a number is how many that day had. Point at a day to read them. | Les losanges sur l’axe marquent les jours avec des événements ; un nombre indique combien il y en avait ce jour-là. Pointez un jour pour les lire. |  |  |
| `marker.failed` | The events could not be read, so no markers are drawn. | Les événements n’ont pas pu être lus : aucun repère n’est affiché. |  |  |
| `marker.hidden_one` | {{count}} more day with events is not marked. | {{count}} autre jour avec des événements n’est pas marqué. |  |  |
| `marker.hidden_other` | {{count}} more days with events are not marked. | {{count}} autres jours avec des événements ne sont pas marqués. |  |  |
| `marker.hide` | Hide events | Masquer les événements |  |  |
| `marker.label` | Events of this day | Événements de ce jour |  |  |
| `marker.more_one` | + {{count}} more | + {{count}} autre |  |  |
| `marker.more_other` | + {{count}} more | + {{count}} autres |  |  |
| `marker.show` | Show events | Afficher les événements |  |  |
| `marker.spoken_one` | {{count}} event this day: {{events}} | {{count}} événement ce jour : {{events}} |  |  |
| `marker.spoken_other` | {{count}} events this day: {{events}} | {{count}} événements ce jour : {{events}} |  |  |
| `metric.downloadRate` | Download rate (per impression) | Taux de téléchargement (par impression) |  |  |
| `metric.downloadsFirstTime` | Downloads (first time) | Téléchargements (premier) |  |  |
| `metric.downloadsRedownload` | Redownloads | Retéléchargements |  |  |
| `metric.impressions` | Impressions | Impressions |  |  |
| `metric.installsUser` | Installs (users) | Installations (utilisateurs) |  |  |
| `metric.productPageConversion` | Conversion rate (product page) | Taux de conversion (page produit) |  |  |
| `metric.productPageViews` | Product page views | Vues de la page produit |  |  |
| `metric.salesGross` | Gross sales | Ventes brutes |  |  |
| `metric.salesProceeds` | Proceeds | Revenus nets |  |  |
| `metric.salesUnits` | Units sold | Unités vendues |  |  |
| `metric.storeListingAcquisitions` | Store listing acquisitions | Acquisitions de la fiche |  | listing = fiche |
| `metric.storeListingVisitors` | Store listing visitors | Visiteurs de la fiche |  | listing = fiche |
| `rail.events` | Timeline | Chronologie |  |  |
| `rail.group` | Timeline and reports | Chronologie et rapports |  |  |
| `rail.label` | Timeline sections | Sections de la chronologie |  |  |
| `rail.reports` | Reports | Rapports |  |  |
| `report.col.change` | Change | Évolution |  |  |
| `report.col.figure` | Figure | Indicateur |  |  |
| `report.col.previous` | Before | Avant |  |  |
| `report.col.value` | This period | Cette période |  |  |
| `report.compare` | {{current}}, compared with {{previous}}. | {{current}}, comparé à {{previous}}. |  |  |
| `report.copied` | Copied | Copié |  |  |
| `report.copyMarkdown` | Copy as Markdown | Copier en Markdown |  |  |
| `report.countries.title` | Countries (downloads) | Pays (téléchargements) |  |  |
| `report.downloadCsv` | Download CSV | Télécharger le CSV |  |  |
| `report.empty` | Nothing was recorded for this period: no figures, no written reviews and no events. | Rien n’a été enregistré pour cette période : ni chiffres, ni avis écrits, ni événements. |  | review: avis (user) vs examen (App Review) |
| `report.events.more_one` | {{count}} more event is not listed. | {{count}} autre événement n’est pas listé. |  |  |
| `report.events.more_other` | {{count}} more events are not listed. | {{count}} autres événements ne sont pas listés. |  |  |
| `report.events.none` | No events in this period. | Aucun événement sur cette période. |  |  |
| `report.events.title` | Events of the period | Événements de la période |  |  |
| `report.failed` | The report of {{platform}} could not be read. | Le rapport de {{platform}} n’a pas pu être lu. |  |  |
| `report.figuresCaption` | Figures for {{period}} against the period before | Chiffres de {{period}} par rapport à la période précédente |  |  |
| `report.kind.month` | Month | Mois |  |  |
| `report.kind.week` | Week | Semaine |  |  |
| `report.kind.year` | Year | Année |  |  |
| `report.kindLabel` | Report period | Période du rapport |  |  |
| `report.loading` | Reading the report | Lecture du rapport |  |  |
| `report.localOnly` | Made in your browser from what Kiln stored; nothing is shared or sent. | Créé dans votre navigateur à partir de ce que Kiln a stocké ; rien n’est partagé ni envoyé. |  |  |
| `report.next` | Next period | Période suivante |  |  |
| `report.noValue` | no data | pas de données |  |  |
| `report.note.lengths` | The periods have different lengths ({{current}} days against {{previous}}), so totals are not like for like. | Les périodes n’ont pas la même durée ({{current}} jours contre {{previous}}) : les totaux ne sont pas comparables à durée égale. |  |  |
| `report.note.lowReviews_one` | Only {{count}} written review: the average is not reliable. | {{count}} seul avis écrit : la moyenne n’est pas fiable. |  | review: avis (user) vs examen (App Review) |
| `report.note.lowReviews_other` | Only {{count}} written reviews: the average is not reliable. | Seulement {{count}} avis écrits : la moyenne n’est pas fiable. |  | review: avis (user) vs examen (App Review) |
| `report.note.missingDays_one` | {{count}} day of this period has no numbers yet; the stores publish with a delay. | {{count}} jour de cette période n’a pas encore de chiffres ; les stores publient avec un délai. |  |  |
| `report.note.missingDays_other` | {{count}} days of this period have no numbers yet; the stores publish with a delay. | {{count}} jours de cette période n’ont pas encore de chiffres ; les stores publient avec un délai. |  |  |
| `report.note.noCountries` | There is no split by country for this period. | Aucune répartition par pays pour cette période. |  |  |
| `report.note.noFiguresAndroid` | No analytics numbers are stored for this period. Connect the Play Console reports and sync, or the store has not published them yet. | Aucun chiffre d’analytics n’est stocké pour cette période. Connectez les rapports de la Play Console et synchronisez, ou le store ne les a pas encore publiés. |  |  |
| `report.note.noFiguresIos` | No analytics numbers are stored for this period. Connect App Store analytics and sync, or the store has not published them yet. | Aucun chiffre d’analytics n’est stocké pour cette période. Connectez les analytics App Store et synchronisez, ou le store ne les a pas encore publiés. |  |  |
| `report.note.noReviews` | No written reviews are stored for this period or the one before. Sync reviews to read them. | Aucun avis écrit n’est stocké pour cette période ni la précédente. Synchronisez les avis pour les lire. |  | review: avis (user) vs examen (App Review) |
| `report.note.noSourcesAndroid` | Google Play does not give downloads by source, so there is no split. | Google Play ne fournit pas les téléchargements par source : il n’y a donc pas de répartition. |  |  |
| `report.note.noSourcesIos` | There is no split by source for this period. | Aucune répartition par source pour cette période. |  |  |
| `report.note.notStarted` | This period has not started: there are no numbers yet. | Cette période n’a pas commencé : il n’y a pas encore de chiffres. |  |  |
| `report.note.partial_one` | This period is still running. The figures cover its first {{count}} day (until {{through}}) and are compared with the same number of days before it. | Cette période est en cours. Les chiffres couvrent {{count}} jour (jusqu’au {{through}}) et sont comparés au même nombre de jours avant elle. |  |  |
| `report.note.partial_other` | This period is still running. The figures cover its first {{count}} days (until {{through}}) and are compared with the same number of days before it. | Cette période est en cours. Les chiffres couvrent ses {{count}} premiers jours (jusqu’au {{through}}) et sont comparés au même nombre de jours avant elle. |  |  |
| `report.note.uncompared_one` | {{count}} figure has no comparison because too many days are missing in one of the two periods. | {{count}} indicateur n’est pas comparé car trop de jours manquent dans l’une des deux périodes. |  |  |
| `report.note.uncompared_other` | {{count}} figures have no comparison because too many days are missing in one of the two periods. | {{count}} indicateurs ne sont pas comparés car trop de jours manquent dans l’une des deux périodes. |  |  |
| `report.notes.title` | About the data | À propos des données |  |  |
| `report.periodLabel` | Choose a period | Choisir une période |  |  |
| `report.prev` | Previous period | Période précédente |  |  |
| `report.print` | Print | Imprimer |  |  |
| `report.range` | {{from}} to {{to}} | {{from}} au {{to}} |  |  |
| `report.reason.currentIncomplete` | Not compared: this period has too many days without numbers | Non comparé : cette période compte trop de jours sans chiffres |  |  |
| `report.reason.noData` | No numbers this period | Pas de chiffres sur cette période |  |  |
| `report.reason.previousIncomplete` | Not compared: the period before has too many days without numbers | Non comparé : la période précédente compte trop de jours sans chiffres |  |  |
| `report.reviews.line_one` | {{count}} written review, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} avis écrit, moyenne {{average}} (avant : {{previous}}). Ce sont les avis stockés par Kiln, pas la note du store. |  | review: avis (user) vs examen (App Review); rating = note |
| `report.reviews.line_other` | {{count}} written reviews, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} avis écrits, moyenne {{average}} (avant : {{previous}}). Ce sont les avis stockés par Kiln, pas la note du store. |  | review: avis (user) vs examen (App Review); rating = note |
| `report.reviews.title` | Written reviews | Avis écrits |  | review: avis (user) vs examen (App Review) |
| `report.reviews.unanswered_one` | {{count}} review of 1 or 2 stars has no reply. | {{count}} avis de 1 ou 2 étoiles sans réponse. |  | review: avis (user) vs examen (App Review) |
| `report.reviews.unanswered_other` | {{count}} reviews of 1 or 2 stars have no reply. | {{count}} avis de 1 ou 2 étoiles sans réponse. |  | review: avis (user) vs examen (App Review) |
| `report.sources.title` | How people found the app (downloads) | Comment les gens ont trouvé l’app (téléchargements) |  |  |
| `report.title` | Report: {{period}} | Rapport : {{period}} |  |  |

## web/workspace (8)

| Key | English | French | OK/Fix | Notes |
|---|---|---|---|---|
| `token.action.monetizationPrice` | Change prices of in-app products | Modifier les prix des produits intégrés |  |  |
| `webhook.event.asoCompetitorListingChanged` | A followed App Store competitor changed its screenshots, icon, name, description or release notes (ids and the kinds of change only) | Un concurrent App Store suivi a modifié ses captures, son icône, son nom, sa description ou ses notes de version (identifiants et types de changement uniquement) |  | release = publication |
| `webhook.event.easBuildFailed` | An EAS build was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Un build EAS a été enregistré comme échoué (identifiants, plateforme, version et un code court uniquement ; jamais le message d’Expo) |  |  |
| `webhook.event.easSubmissionFailed` | An EAS store submission was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Une soumission EAS au store a été enregistrée comme échouée (identifiants, plateforme, version et un code court uniquement ; jamais le message d’Expo) |  | submit: soumettre vs envoyer |
| `webhook.event.easUpdateRolloutStuck` | An EAS Update rollout stayed at the same percentage below 100% for longer than the limit (ids, platform, channel and percentage only; never the update message) | Un déploiement EAS Update est resté au même pourcentage, sous 100 %, plus longtemps que la limite (identifiants, plateforme, canal et pourcentage seulement ; jamais le message de la mise à jour) |  | rollout = déploiement |
| `webhook.event.healthCrashRegression` | A version crashes clearly more than the one before it (ids, version names and two rates only) | Une version plante nettement plus que la précédente (identifiants, noms de version et deux taux seulement) |  |  |
| `webhook.event.testflightCrash` | A tester sent a TestFlight crash that was stored (ids, build and platform only; never the log) | Un plantage TestFlight d’un testeur a été enregistré (identifiants, build et plateforme uniquement ; jamais le journal) |  |  |
| `webhook.event.testflightFeedback` | A tester sent TestFlight feedback that was stored (ids, build and platform only; never the comment) | Un retour TestFlight d’un testeur a été enregistré (identifiants, build et plateforme uniquement ; jamais le commentaire) |  |  |
