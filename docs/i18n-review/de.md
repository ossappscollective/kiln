# German (de) review sheet

Status: UNREVIEWED machine-quality translation. Every row below was added or changed after commit 550fb83. Mark each row OK or Fix (and write the correction in the notes). See [README](README.md).

Plural `_many` forms (French and Spanish only) are derived mechanically from `_other` ("de" or "d’" inserted after the number: "1 million de ...") and are not listed.
Keys identical in every language (brand names, units, numbers) are skipped. Placeholders such as `{{count}}` must stay exactly as they are.

## Glossary

| English term | Translation in the catalog | Flag |
|---|---|---|
| release | Release | kept in English |
| build | Build | kept |
| rollout | Einführung (Rollout in 8 places) | mixed; "Einführung" is established |
| listing (store page) | Store-Eintrag / Eintrag | "Produktseite" in 31 places (experiments); check |
| cart / pending changes | Ausstehende Änderungen | consistent |
| staged / stage | vorgemerkt / vormerken / vorbereitet | "vorbereitet" also appears; pick one |
| draft | Entwurf | consistent |
| track (Google Play) | Track | vs "Kanal" for EAS channel |
| in review (App Review) | Prüfung | "Review" in 5 places |
| reviews | Rezensionen | consistent |
| rating | Bewertung | consistent |
| submit | einreichen / senden | consistent: einreichen for App Review |
| keyword | Keyword | kept; "Schlüsselwort" once |
| workflow | Workflow | kept |
| workspace | Arbeitsbereich | consistent |
| tester | Tester | consistent |
| screenshot | Screenshot | kept |
| token | Token | kept |
| territory / region | Region / Gebiet | both used |
| competitor | Wettbewerber | consistent |
| register | Sie | a few "du" strings were changed to Sie |
| store | Store | kept |

## server/alerts (39)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `action.openHealth` | Open the ratings and app health | Bewertungen und App-Gesundheit öffnen |  | rating = Bewertung |
| `action.openTestflight` | Open the TestFlight feedback | TestFlight-Feedback öffnen |  |  |
| `competitor.listingChanged.body` | A followed competitor changed: {{what}}. | Ein beobachteter Wettbewerber hat geändert: {{what}}. |  |  |
| `competitor.listingChanged.body.noKinds` | A followed competitor changed its public App Store listing. | Ein beobachteter Wettbewerber hat seinen öffentlichen App-Store-Eintrag geändert. |  | listing = Store-Eintrag |
| `competitor.listingChanged.kind.category` | category | Kategorie |  |  |
| `competitor.listingChanged.kind.description` | description | Beschreibung |  |  |
| `competitor.listingChanged.kind.icon` | icon | Icon |  |  |
| `competitor.listingChanged.kind.name` | name | Name |  |  |
| `competitor.listingChanged.kind.price` | price | Preis |  |  |
| `competitor.listingChanged.kind.releaseNotes` | release notes | Versionshinweise |  | release = Release |
| `competitor.listingChanged.kind.screenshots` | screenshots | Screenshots |  |  |
| `competitor.listingChanged.kind.version` | version | Version |  |  |
| `competitor.listingChanged.title` | A competitor of {{app}} changed its App Store listing | Ein Wettbewerber von {{app}} hat seinen App-Store-Eintrag geändert |  | listing = Store-Eintrag |
| `eas.buildFailed.body` | Build {{build}} ({{platform}}) of {{app}} failed at Expo. Open Builds to read Expo’s reason. | Build {{build}} ({{platform}}) von {{app}} ist bei Expo fehlgeschlagen. Öffnen Sie Builds, um den Grund von Expo zu lesen. |  |  |
| `eas.buildFailed.body.noBuild` | A build of {{app}} failed at Expo. Open Builds to read Expo’s reason. | Ein Build von {{app}} ist bei Expo fehlgeschlagen. Öffnen Sie Builds, um den Grund von Expo zu lesen. |  |  |
| `eas.buildFailed.title` | The EAS build of {{app}} failed | Der EAS-Build von {{app}} ist fehlgeschlagen |  |  |
| `eas.submissionFailed.body` | The submission of build {{build}} ({{platform}}) of {{app}} to the store failed. Open Builds to read Expo’s reason. | Die Einreichung von Build {{build}} ({{platform}}) von {{app}} beim Store ist fehlgeschlagen. Öffnen Sie Builds, um den Grund von Expo zu lesen. |  | submit = einreichen / senden |
| `eas.submissionFailed.body.noBuild` | A store submission of {{app}} failed. Open Builds to read Expo’s reason. | Eine Einreichung von {{app}} beim Store ist fehlgeschlagen. Öffnen Sie Builds, um den Grund von Expo zu lesen. |  | submit = einreichen / senden |
| `eas.submissionFailed.title` | The EAS submission of {{app}} failed | Die EAS-Einreichung von {{app}} ist fehlgeschlagen |  | submit = einreichen / senden |
| `eas.updateRolloutStuck.body` | An over-the-air update of {{app}} on the {{channel}} channel has been at {{percentage}}% for {{hours}} hours. Open Builds, EAS updates, to raise it or end it. | Ein Over-the-Air-Update von {{app}} im Kanal {{channel}} steht seit {{hours}} Stunden bei {{percentage}} %. Öffnen Sie Builds, EAS-Updates, um es zu erhöhen oder zu beenden. |  |  |
| `eas.updateRolloutStuck.body.short` | An over-the-air update rollout of {{app}} has been at the same percentage for a long time. Open Builds, EAS updates, to raise it or end it. | Der Rollout eines Over-the-Air-Updates von {{app}} steht seit langer Zeit auf demselben Prozentsatz. Öffnen Sie Builds, EAS-Updates, um ihn zu erhöhen oder zu beenden. |  | rollout = Einführung |
| `eas.updateRolloutStuck.title` | The EAS Update rollout of {{app}} is stuck | Der EAS-Update-Rollout von {{app}} steckt fest |  | rollout = Einführung |
| `health.crashRegression.body.perSessions` | {{app}} {{version}} crashes {{after}} times for every 1,000 sessions, up from {{before}} in {{previous}}. Only people who share analytics with developers are counted. | {{app}} {{version}} stürzt {{after}}-mal pro 1.000 Sitzungen ab, gegenüber {{before}} in {{previous}}. Gezählt werden nur Personen, die Analysedaten mit Entwicklern teilen. |  |  |
| `health.crashRegression.body.share` | {{after}}% of the people using {{app}} {{version}} had a crash, up from {{before}}% in {{previous}}. | {{after}} % der Nutzer von {{app}} {{version}} hatten einen Absturz, gegenüber {{before}} % in {{previous}}. |  |  |
| `health.crashRegression.title` | {{app}} {{version}} crashes more | {{app}} {{version}} stürzt häufiger ab |  |  |
| `testflight.crash.body` | A tester sent a crash report for build {{build}} of {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Ein Tester hat einen Absturzbericht zu Build {{build}} von {{app}} gesendet. Öffnen Sie die TestFlight-Ansicht, um ihn samt Protokoll zu lesen; das Protokoll wird hier nicht gesendet. |  |  |
| `testflight.crash.body.grouped_one` | {{count}} more crash report of {{app}} was stored. Open the TestFlight view to read it and its log; the log is not sent here. | {{count}} weiterer Absturzbericht zu {{app}} wurde gespeichert. Öffnen Sie die TestFlight-Ansicht, um ihn samt Protokoll zu lesen; das Protokoll wird hier nicht gesendet. |  |  |
| `testflight.crash.body.grouped_other` | {{count}} more crash reports of {{app}} were stored. Open the TestFlight view to read them and their logs; the logs are not sent here. | {{count}} weitere Absturzberichte zu {{app}} wurden gespeichert. Öffnen Sie die TestFlight-Ansicht, um sie samt Protokollen zu lesen; die Protokolle werden hier nicht gesendet. |  |  |
| `testflight.crash.body.noBuild` | A tester sent a crash report for {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Ein Tester hat einen Absturzbericht zu {{app}} gesendet. Öffnen Sie die TestFlight-Ansicht, um ihn samt Protokoll zu lesen; das Protokoll wird hier nicht gesendet. |  |  |
| `testflight.crash.title` | New TestFlight crash in {{app}} | Neuer TestFlight-Absturz in {{app}} |  |  |
| `testflight.crash.title.grouped_one` | {{count}} more TestFlight crash in {{app}} | {{count}} weiterer TestFlight-Absturz in {{app}} |  |  |
| `testflight.crash.title.grouped_other` | {{count}} more TestFlight crashes in {{app}} | {{count}} weitere TestFlight-Abstürze in {{app}} |  |  |
| `testflight.feedback.body` | A tester sent feedback on build {{build}} of {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Ein Tester hat Feedback zu Build {{build}} von {{app}} gesendet. Öffnen Sie die TestFlight-Ansicht, um es zu lesen; der Kommentar wird hier nicht gesendet. |  |  |
| `testflight.feedback.body.grouped_one` | {{count}} more feedback of {{app}} was stored. Open the TestFlight view to read it; the comment is not sent here. | {{count}} weiteres Feedback zu {{app}} wurde gespeichert. Öffnen Sie die TestFlight-Ansicht, um es zu lesen; der Kommentar wird hier nicht gesendet. |  |  |
| `testflight.feedback.body.grouped_other` | {{count}} more feedback items of {{app}} were stored. Open the TestFlight view to read them; the comments are not sent here. | {{count}} weitere Feedbacks zu {{app}} wurden gespeichert. Öffnen Sie die TestFlight-Ansicht, um sie zu lesen; die Kommentare werden hier nicht gesendet. |  |  |
| `testflight.feedback.body.noBuild` | A tester sent feedback on {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Ein Tester hat Feedback zu {{app}} gesendet. Öffnen Sie die TestFlight-Ansicht, um es zu lesen; der Kommentar wird hier nicht gesendet. |  |  |
| `testflight.feedback.title` | New TestFlight feedback for {{app}} | Neues TestFlight-Feedback für {{app}} |  |  |
| `testflight.feedback.title.grouped_one` | {{count}} more TestFlight feedback for {{app}} | {{count}} weiteres TestFlight-Feedback für {{app}} |  |  |
| `testflight.feedback.title.grouped_other` | {{count}} more TestFlight feedback items for {{app}} | {{count}} weitere TestFlight-Feedbacks für {{app}} |  |  |

## server/chat (23)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `digest.heading_one` | {{count}} alert since the last summary | {{count}} Warnung seit der letzten Zusammenfassung |  |  |
| `digest.heading_other` | {{count}} alerts since the last summary | {{count}} Warnungen seit der letzten Zusammenfassung |  |  |
| `digest.more_one` | and {{count}} more alert. Open Kiln to see all of them. | und {{count}} weitere Warnung. Öffnen Sie Kiln, um alle zu sehen. |  |  |
| `digest.more_other` | and {{count}} more alerts. Open Kiln to see all of them. | und {{count}} weitere Warnungen. Öffnen Sie Kiln, um alle zu sehen. |  |  |
| `digest.title` | Alert summary | Zusammenfassung der Warnungen |  |  |
| `field.app` | App | App |  |  |
| `field.platform` | Platform | Plattform |  |  |
| `field.version` | Version | Version |  |  |
| `footer.digest` | Kiln · daily summary | Kiln · tägliche Zusammenfassung |  |  |
| `footer.test` | Kiln · test message | Kiln · Testnachricht |  |  |
| `item.repeated_one` | {{title}} ({{count}} time) | {{title}} ({{count}}-mal) |  |  |
| `item.repeated_other` | {{title}} ({{count}} times) | {{title}} ({{count}}-mal) |  |  |
| `noLink` | Open Kiln: {{where}}. | Öffnen Sie Kiln: {{where}}. |  |  |
| `openKiln` | Open Kiln | Kiln öffnen |  |  |
| `repeated_one` | Happened {{count}} time. | {{count}}-mal aufgetreten. |  |  |
| `repeated_other` | Happened {{count}} times. | {{count}}-mal aufgetreten. |  |  |
| `severity.critical` | Critical | Kritisch |  |  |
| `severity.info` | For your information | Zur Information |  |  |
| `severity.warning` | Needs attention | Erfordert Aufmerksamkeit |  |  |
| `test.body` | If you can read this, the destination “{{name}}” works. Alerts and summaries routed to it will appear here. | Wenn Sie das lesen können, funktioniert das Ziel „{{name}}“. Warnungen und Zusammenfassungen für dieses Ziel erscheinen hier. |  |  |
| `test.hint` | Nothing is wrong. This message was sent because someone pressed “Send test message” in Kiln. | Es ist nichts passiert. Diese Nachricht wurde gesendet, weil jemand in Kiln auf „Testnachricht senden“ geklickt hat. |  |  |
| `test.title` | Kiln test message | Kiln-Testnachricht |  |  |
| `whatToDo` | What to do | Was zu tun ist |  |  |

## web/ads (100)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `account.neverSynced` | Nothing has been read from Apple Ads yet. Press Sync. | Aus Apple Ads wurde noch nichts gelesen. Tippen Sie auf Synchronisieren. |  |  |
| `account.partial` | The last read was cut short, so some rows may be missing. | Das letzte Lesen wurde vorzeitig beendet, daher können Zeilen fehlen. |  |  |
| `account.synced` | The last read covered {{campaigns}} campaigns, from {{from}} to {{to}}. | Das letzte Lesen umfasste {{campaigns}} Kampagnen, vom {{from}} bis {{to}}. |  |  |
| `campaigns.days_one` | {{count}} day with data | {{count}} Tag mit Daten |  |  |
| `campaigns.days_other` | {{count}} days with data | {{count}} Tage mit Daten |  |  |
| `campaigns.empty` | No campaign promoting this app has data in this range. | Keine Kampagne, die diese App bewirbt, hat Daten in diesem Zeitraum. |  |  |
| `col.campaign` | Campaign | Kampagne |  |  |
| `col.conversion` | Conversion rate | Conversion-Rate |  |  |
| `col.country` | Country | Land |  |  |
| `col.cpi` | Cost per install | Kosten pro Installation |  |  |
| `col.cpt` | Cost per tap | Kosten pro Tipp |  |  |
| `col.day` | Day | Tag |  |  |
| `col.impressions` | Impressions | Impressionen |  |  |
| `col.installs` | Installs | Installationen |  |  |
| `col.spend` | Spend | Ausgaben |  |  |
| `col.taps` | Taps | Tipps |  |  |
| `col.ttr` | Tap-through rate | Tipp-Rate |  |  |
| `err.credentialKind` | Choose an Apple Ads API user key credential. | Wählen Sie Zugangsdaten vom Typ Apple-Ads-API-Benutzerschlüssel. |  |  |
| `err.credentialNotFound` | That credential does not exist in this workspace. | Diese Zugangsdaten gibt es in diesem Arbeitsbereich nicht. |  |  |
| `err.forbidden` | Your role cannot do this. | Ihre Rolle darf das nicht. |  |  |
| `err.notFound` | This app was not found. | Diese App wurde nicht gefunden. |  |  |
| `err.notLinked` | This app is not linked to an Apple Ads account. Link it first. | Diese App ist nicht mit einem Apple-Ads-Konto verknüpft. Verknüpfen Sie sie zuerst. |  |  |
| `err.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads gilt für App-Store-Apps. Diese App ist keine. |  |  |
| `err.rateLimited` | Too many requests. Try again in a minute. | Zu viele Anfragen. Versuchen Sie es in einer Minute erneut. |  |  |
| `link.account` | Ad account | Werbekonto |  |  |
| `link.accountHint` | Only accounts the key can read are listed. Loading them asks Apple Ads once. | Es werden nur Konten aufgelistet, die der Schlüssel lesen kann. Das Laden fragt Apple Ads einmal ab. |  |  |
| `link.adamHint` | The number after id in the App Store address of the app. Kiln uses the store id of the record when you leave it empty. | Die Zahl nach id in der App-Store-Adresse der App. Kiln nutzt die Store-ID des Eintrags, wenn Sie das Feld leer lassen. |  |  |
| `link.adamId` | Apple id of the app | Apple-ID der App |  |  |
| `link.adamInvalid` | Use only digits: 5 to 15 of them. | Nur Ziffern verwenden: 5 bis 15. |  |  |
| `link.adamPlaceholder` | For example 1234567890 | Zum Beispiel 1234567890 |  |  |
| `link.askAdmin` | Ask an admin to link this app to an Apple Ads account. | Bitten Sie einen Admin, diese App mit einem Apple-Ads-Konto zu verknüpfen. |  |  |
| `link.badgeLinked` | Linked | Verknüpft |  |  |
| `link.badgeNeedsCredential` | Needs a credential | Benötigt Zugangsdaten |  |  |
| `link.checked` | Checked {{when}}. | Geprüft {{when}}. |  |  |
| `link.chooseAccount` | Choose an ad account | Werbekonto wählen |  |  |
| `link.chooseCredential` | Choose a credential | Zugangsdaten wählen |  |  |
| `link.credential` | Apple Ads credential | Apple-Ads-Zugangsdaten |  |  |
| `link.credentialDeleted` | The credential of this link was deleted. Choose another. | Die Zugangsdaten dieser Verknüpfung wurden gelöscht. Wählen Sie andere. |  |  |
| `link.credentialsHint` | Add an Apple Ads API user key under <link>Credentials</link> first. It only needs read access. | Fügen Sie zuerst unter <link>Zugangsdaten</link> einen Apple-Ads-API-Benutzerschlüssel hinzu. Lesezugriff genügt. |  |  |
| `link.currency` | Currency | Währung |  |  |
| `link.linkAccount` | Link ad account | Werbekonto verknüpfen |  |  |
| `link.linked` | Linked to {{account}}. | Mit {{account}} verknüpft. |  |  |
| `link.loadAccounts` | Load ad accounts | Werbekonten laden |  |  |
| `link.loadFirst` | Load the ad accounts first | Laden Sie zuerst die Werbekonten |  |  |
| `link.noAccounts` | This key sees no ad account. Invite its API user to the account in Apple Ads. | Dieser Schlüssel sieht kein Werbekonto. Laden Sie seinen API-Benutzer in Apple Ads zum Konto ein. |  |  |
| `link.notLinked` | This app is not linked to an Apple Ads account. | Diese App ist nicht mit einem Apple-Ads-Konto verknüpft. |  |  |
| `link.readOnly` | Read only: Kiln reads reports and never changes a campaign, a budget or a bid. | Nur Lesen: Kiln liest Berichte und ändert nie eine Kampagne, ein Budget oder ein Gebot. |  |  |
| `link.remove` | Remove link | Verknüpfung entfernen |  |  |
| `link.removed` | The link was removed. The stored reports of this app were kept until they age out. | Die Verknüpfung wurde entfernt. Die gespeicherten Berichte dieser App bleiben, bis sie verfallen. |  |  |
| `link.saveChanges` | Save changes | Änderungen speichern |  |  |
| `noApple` | Apple Ads is for App Store apps. This app has no App Store record. | Apple Ads gilt für App-Store-Apps. Diese App hat keinen App-Store-Eintrag. |  |  |
| `overview.compare` | Compared with {{from}} to {{to}}. | Verglichen mit {{from}} bis {{to}}. |  |  |
| `overview.coverage` | Days with data: {{days}}. Campaigns: {{campaigns}}. Amounts in {{currency}}. | Tage mit Daten: {{days}}. Kampagnen: {{campaigns}}. Beträge in {{currency}}. |  |  |
| `overview.daily` | Per day | Pro Tag |  |  |
| `overview.dailyAria` | {{metric}} per day over {{days}} days | {{metric}} pro Tag über {{days}} Tage |  |  |
| `overview.dailyOf` | Show | Anzeigen |  |  |
| `overview.deltaAria` | Before: {{previous}} | Vorher: {{previous}} |  |  |
| `overview.empty` | No Apple Ads data from {{from}} to {{to}}. Press Sync to read it, or choose another range. | Keine Apple-Ads-Daten vom {{from}} bis {{to}}. Tippen Sie auf Synchronisieren oder wählen Sie einen anderen Zeitraum. |  |  |
| `overview.noCompare` | Nothing to compare with | Nichts zum Vergleichen |  |  |
| `overview.table` | Show the days as a table | Tage als Tabelle anzeigen |  |  |
| `overview.totals` | Totals of the range | Summen des Zeitraums |  |  |
| `pick` | App Store record | App-Store-Eintrag |  |  |
| `rail.account` | Account | Konto |  |  |
| `rail.campaigns` | Campaigns | Kampagnen |  |  |
| `rail.keywords` | Keywords | Keywords |  |  |
| `rail.label` | Apple Ads sections | Bereiche von Apple Ads |  |  |
| `rail.overview` | Overview | Übersicht |  |  |
| `rail.terms` | Search terms | Suchbegriffe |  |  |
| `rangeClamped` | Apple Ads is read one year at a time: the last year of this range is shown. | Apple Ads wird ein Jahr auf einmal gelesen: Es wird das letzte Jahr dieses Zeitraums gezeigt. |  |  |
| `settings.description` | Which Apple Ads ad account reports on this app. Read only: nothing is changed in Apple Ads. | Welches Apple-Ads-Werbekonto über diese App berichtet. Nur Lesen: In Apple Ads wird nichts geändert. |  |  |
| `settings.platformLabel` | Apple Ads of the {{platform}} record | Apple Ads des Eintrags {{platform}} |  |  |
| `setup.lead` | Link an Apple Ads account to see what your campaigns spent and which search terms led to taps and installs. Kiln only reads reports. | Verknüpfen Sie ein Apple-Ads-Konto, um zu sehen, was Ihre Kampagnen ausgegeben haben und welche Suchbegriffe zu Tipps und Installationen führten. Kiln liest nur Berichte. |  |  |
| `setup.needsCredential` | No Apple Ads credential exists yet. Add one under Credentials: the guide there explains the key. | Es gibt noch keine Apple-Ads-Zugangsdaten. Fügen Sie unter Zugangsdaten welche hinzu: Die Anleitung dort erklärt den Schlüssel. |  |  |
| `setup.step1` | In Apple Ads, create an API user with a read-only role and a key pair, and save the public key. | Erstellen Sie in Apple Ads einen API-Benutzer mit einer Nur-Lese-Rolle und einem Schlüsselpaar und speichern Sie den öffentlichen Schlüssel. |  |  |
| `setup.step2` | Add the private key and its ids under Credentials, as an Apple Ads API user key. | Fügen Sie den privaten Schlüssel und seine IDs unter Zugangsdaten als Apple-Ads-API-Benutzerschlüssel hinzu. |  |  |
| `setup.step3` | Choose the credential and the ad account below, then press Link ad account. | Wählen Sie unten die Zugangsdaten und das Werbekonto und tippen Sie auf Werbekonto verknüpfen. |  |  |
| `setup.title` | Link Apple Ads | Apple Ads verknüpfen |  |  |
| `terms.col.keyword` | Keyword | Keyword |  |  |
| `terms.col.term` | Search term | Suchbegriff |  |  |
| `terms.count_one` | {{count}} row | {{count}} Zeile |  |  |
| `terms.count_other` | {{count}} rows | {{count}} Zeilen |  |  |
| `terms.empty` | No search term in this range. Apple hides terms with very few impressions, so a small campaign may show none. | Keine Suchbegriffe in diesem Zeitraum. Apple blendet Begriffe mit sehr wenigen Impressionen aus, daher zeigt eine kleine Kampagne vielleicht keine. |  |  |
| `terms.emptyKeywords` | No keyword has data in this range. | Kein Keyword hat Daten in diesem Zeitraum. |  |  |
| `terms.filter` | Filter the list | Liste filtern |  |  |
| `terms.hiddenNote` | Apple hides search terms with very few impressions, so this is not every search. | Apple blendet Suchbegriffe mit sehr wenigen Impressionen aus, dies sind also nicht alle Suchen. |  |  |
| `terms.isTracked` | Tracked | Verfolgt |  |  |
| `terms.matched` | Matched your keyword: {{keyword}} | Passte zu Ihrem Keyword: {{keyword}} |  |  |
| `terms.next` | Next | Weiter |  |  |
| `terms.noMatch` | Nothing matches that filter. | Nichts passt zu diesem Filter. |  |  |
| `terms.prev` | Previous | Zurück |  |  |
| `terms.range` | {{from}} to {{to}} of {{total}} | {{from}} bis {{to}} von {{total}} |  |  |
| `terms.track` | Track keyword | Keyword verfolgen |  | track = Track (Play) / verfolgen (keyword) |
| `terms.tracked` | {{term}} is now a tracked keyword. | {{term}} ist jetzt ein verfolgtes Keyword. |  |  |
| `warn.capCampaigns` | Only the campaigns with the most impressions were read. | Es wurden nur die Kampagnen mit den meisten Impressionen gelesen. |  |  |
| `warn.currencyMismatch` | Some days were left out because they were not in the currency of the ad account. | Einige Tage wurden ausgelassen, weil sie nicht in der Währung des Werbekontos waren. |  |  |
| `warn.noCampaign` | No campaign promotes this app. Check the Apple id of the app. | Keine Kampagne bewirbt diese App. Prüfen Sie die Apple-ID der App. |  |  |
| `warn.popularityFailed` | Apple’s own popularity could not be read this time. The rest was read. | Apples eigene Beliebtheit konnte diesmal nicht gelesen werden. Der Rest wurde gelesen. |  |  |
| `warn.popularityPartial` | Apple’s own popularity was read for some of your keywords only. | Apples eigene Beliebtheit wurde nur für einige Ihrer Keywords gelesen. |  |  |
| `warn.readCut` | A read was cut short to stay within limits. Press Sync again later. | Ein Lesevorgang wurde abgebrochen, um die Grenzen einzuhalten. Tippen Sie später erneut auf Synchronisieren. |  |  |
| `warn.unknown` | The last read reported something this version does not know. | Das letzte Lesen meldete etwas, das diese Version nicht kennt. |  |  |

## web/ai (10)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `insight.changesSince` | Since the last summary: | Seit der letzten Zusammenfassung: |  |  |
| `insight.generatedFrom_one` | Generated {{time}} from {{count}} review. | Erstellt {{time}} aus {{count}} Rezension. |  | review: Rezension (user) vs Prüfung (App Review) |
| `insight.generatedFrom_other` | Generated {{time}} from {{count}} reviews. | Erstellt {{time}} aus {{count}} Rezensionen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `insight.madeWith` | {{provider}}, {{model}}, {{tokens}} tokens | {{provider}}, {{model}}, {{tokens}} Tokens |  |  |
| `insight.shareTitle` | Counted from the reviews that were read, which include some extra low-rated ones: an approximate share, not a share of all reviews. | Gezählt über die gelesenen Rezensionen, die einige zusätzliche schlecht bewertete enthalten: ein ungefährer Anteil, nicht von allen Rezensionen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `insight.themeShare` | about {{percent}} of the reviews read | etwa {{percent}} der gelesenen Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `insight.trend` | Average rating: {{earlier}} in the first half of the period, {{recent}} in the second half ({{direction}}). | Durchschnittsbewertung: {{earlier}} in der ersten Hälfte des Zeitraums, {{recent}} in der zweiten ({{direction}}). |  | rating = Bewertung |
| `insight.trendDown` | falling | fallend |  |  |
| `insight.trendFlat` | steady | stabil |  |  |
| `insight.trendUp` | rising | steigend |  |  |

## web/analytics (78)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `bucketField.empty` | Enter the bucket of this app, or switch back to the workspace default. | Gib den Bucket dieser App ein oder wechsle zurück zum Standard des Arbeitsbereichs. |  |  |
| `bucketField.invalid` | That is not a Play reports bucket. Paste pubsite_prod_rev_ followed by digits, a gs:// address or a Cloud Storage link. | Das ist kein Play-Berichts-Bucket. Füge pubsite_prod_rev_ mit Ziffern, eine gs://-Adresse oder einen Cloud-Storage-Link ein. |  |  |
| `bucketField.normalized` | Will be saved as {{bucket}}. | Wird gespeichert als {{bucket}}. |  |  |
| `error.bucketForbidden` | Google refused the service account the Cloud Storage bucket of the Play Console reports (403). Either the bucket belongs to another Play developer account than this app, or the service account was not invited in Play Console with "View app information and download bulk reports (read-only)". Check the bucket id, then the invitation. | Google hat dem Dienstkonto den Cloud-Storage-Bucket der Play-Console-Berichte verweigert (403). Entweder gehört der Bucket zu einem anderen Play-Entwicklerkonto als diese App, oder das Dienstkonto wurde in der Play Console nicht mit „App-Informationen ansehen und Massenberichte herunterladen (schreibgeschützt)“ eingeladen. Prüfe die Bucket-ID, dann die Einladung. |  |  |
| `error.bucketNotFound` | Google Cloud Storage has no bucket with this id. Copy it again from Play Console, Download reports, Statistics, Copy Cloud Storage URI: it is pubsite_prod_rev_ followed by your developer account number. | Google Cloud Storage kennt keinen Bucket mit dieser ID. Kopieren Sie sie erneut aus der Play Console, Berichte herunterladen, Statistiken, Cloud-Storage-URI kopieren: sie lautet pubsite_prod_rev_ gefolgt von der Nummer Ihres Entwicklerkontos. |  |  |
| `error.playSalesForbidden` | Google refused the service account the financial reports (sales, earnings, subscription statistics) while the statistics of the same bucket can be read. In Play Console, Users and permissions, the service account needs "View financial data, orders and cancellation survey responses" set to Global (all apps), not for one app only. A new permission can take 24 to 48 hours to apply. | Google hat dem Dienstkonto die Finanzberichte (Verkäufe, Einnahmen, Abo-Statistiken) verweigert, obwohl die Statistiken im selben Bucket lesbar sind. In der Play Console braucht das Dienstkonto unter Nutzer und Berechtigungen „Finanzdaten, Bestellungen und Antworten auf Kündigungsumfragen ansehen“ global (alle Apps), nicht nur für eine App. Eine neue Berechtigung kann 24 bis 48 Stunden brauchen. |  |  |
| `error.salesForbidden` | Apple refused the API key the Sales and Trends reports (HTTP 403). The key needs the role Sales, Finance, Admin or Account Holder (roles without access to sales, such as Developer or Marketing, are refused), and the vendor number must belong to the same team as the key. Check both in App Store Connect, then test access again. | Apple hat dem API-Schlüssel die Berichte „Verkäufe und Trends“ verweigert (HTTP 403). Der Schlüssel braucht die Rolle Vertrieb, Finanzen, Admin oder Account Holder (Rollen ohne Zugriff auf Verkäufe, etwa Developer oder Marketing, werden abgelehnt), und die Lieferantennummer muss zum selben Team wie der Schlüssel gehören. Prüfe beides in App Store Connect und teste den Zugriff erneut. |  |  |
| `error.storeRejected` | The store refused the request (this is not an outage). Check the credential, the vendor number and the bucket id of the data sources, then test access. | Der Store hat die Anfrage abgelehnt (das ist kein Ausfall). Prüfe die Zugangsdaten, die Lieferantennummer und die Bucket-ID der Datenquellen und teste dann den Zugriff. |  |  |
| `guide.account` | Invite this address | Lade diese Adresse ein |  |  |
| `guide.accountUnknown` | The client_email in the JSON key of this service account | Die client_email im JSON-Schlüssel dieses Dienstkontos |  |  |
| `guide.bucket.cause` | Google refused the service account the bucket of the Play Console reports. Either this bucket belongs to another Play developer account than this app, or the service account was not invited in the Play Console of this account. | Google hat dem Dienstkonto den Bucket der Play-Console-Berichte verweigert. Entweder gehört dieser Bucket zu einem anderen Play-Entwicklerkonto als diese App, oder das Dienstkonto wurde in der Play Console dieses Kontos nicht eingeladen. |  |  |
| `guide.bucket.step1` | In Play Console, open Users and permissions of the Play account that owns this app and invite the address below. | Öffne in der Play Console Nutzer und Berechtigungen des Play-Kontos, dem diese App gehört, und lade die Adresse unten ein. |  |  |
| `guide.bucket.step2` | Give it the account permission “View app information and download bulk reports (read-only)”. | Gib ihm die Kontoberechtigung „App-Informationen ansehen und Massenberichte herunterladen (schreibgeschützt)“. |  |  |
| `guide.bucket.step3` | Still refused? Open the bucket in Google Cloud. If you can see its permissions, the service account must be listed with Storage Object Viewer. Google manages this bucket for most accounts, so the invitation above is normally enough. | Immer noch verweigert? Öffnen Sie den Bucket in Google Cloud. Wenn Sie seine Berechtigungen sehen, muss das Dienstkonto dort mit Storage Object Viewer stehen. Google verwaltet diesen Bucket bei den meisten Konten selbst, die Einladung oben genügt also normalerweise. |  |  |
| `guide.bucket.step4` | Wait: a new permission can take 24 to 48 hours to apply. Then press Test access. | Warte: Eine neue Berechtigung kann 24 bis 48 Stunden brauchen. Drücke dann auf Zugriff testen. |  |  |
| `guide.bucketId.cause` | Copy the Cloud Storage URI from Play Console, Download reports, Statistics, and set it for the Play account that owns this app. | Kopiere den Cloud-Storage-URI aus der Play Console, Berichte herunterladen, Statistiken, und gib ihn für das Play-Konto an, dem diese App gehört. |  |  |
| `guide.finance.cause` | Google lets the service account read the statistics but refuses the financial reports (sales, earnings, subscriptions). The missing piece is a Play Console permission, not Cloud Storage. | Google lässt das Dienstkonto die Statistiken lesen, verweigert aber die Finanzberichte (Verkäufe, Einnahmen, Abos). Es fehlt eine Berechtigung der Play Console, nicht von Cloud Storage. |  |  |
| `guide.finance.step1` | In Play Console, open Users and permissions, then the service account with the address below. | Öffne in der Play Console Nutzer und Berechtigungen und dann das Dienstkonto mit der Adresse unten. |  |  |
| `guide.finance.step2` | Under Account permissions, tick “View financial data, orders and cancellation survey responses”. It must apply to the whole account (Global, all apps), not to one app. | Aktiviere unter Kontoberechtigungen „Finanzdaten, Bestellungen und Antworten auf Kündigungsumfragen ansehen“. Sie muss für das ganze Konto gelten (global, alle Apps), nicht für eine einzelne App. |  |  |
| `guide.finance.step3` | Save, wait up to 24 to 48 hours, then press Test access. | Speichere, warte bis zu 24 bis 48 Stunden und drücke dann auf Zugriff testen. |  |  |
| `guide.heading` | How to fix this | So beheben Sie es |  |  |
| `guide.link.bucket` | Open the bucket permissions | Bucket-Berechtigungen öffnen |  |  |
| `guide.link.playConsole` | Open Play Console | Play Console öffnen |  |  |
| `guide.link.usersAndAccess` | Open Users and Access | Benutzer und Zugriff öffnen |  |  |
| `guide.link.usersAndPermissions` | Open Users and permissions | Nutzer und Berechtigungen öffnen |  |  |
| `guide.link.vendor` | Open Payments and Financial Reports | Zahlungen und Finanzberichte öffnen |  |  |
| `guide.opensNew` | (opens in a new tab) | (öffnet in einem neuen Tab) |  |  |
| `guide.otherAccount` | This app reads the bucket set for the whole workspace, and the workspace has several Play accounts. That bucket is probably the one of another account: set the bucket of this app’s own account below. | Diese App liest den Bucket, der für den ganzen Arbeitsbereich gesetzt ist, und der Arbeitsbereich hat mehrere Play-Konten. Dieser Bucket gehört vermutlich zu einem anderen Konto: Gib unten den Bucket des Kontos dieser App an. |  |  |
| `guide.role.cause` | Apple refused the API key the Sales and Trends reports (403). Two things cause this: the role of the key, or a vendor number that belongs to another Apple team. | Apple hat dem API-Schlüssel die Berichte „Verkäufe und Trends“ verweigert (403). Zwei Ursachen: die Rolle des Schlüssels oder eine Lieferantennummer eines anderen Apple-Teams. |  |  |
| `guide.role.step1` | In App Store Connect, Users and Access, Integrations: the key needs the role Sales, Finance, Admin or Account Holder. Roles without access to sales, such as Developer or Marketing, are refused. Create a key with the right role and replace it under Credentials. | In App Store Connect unter Benutzer und Zugriff, Integrationen: Der Schlüssel braucht die Rolle Vertrieb, Finanzen, Admin oder Account Holder. Rollen ohne Zugriff auf Verkäufe, etwa Developer oder Marketing, werden abgelehnt. Erstelle einen Schlüssel mit der richtigen Rolle und ersetze ihn unter Zugangsdaten. |  |  |
| `guide.role.step2` | Check that the vendor number below is the one of the same team as the key. | Prüfe, dass die Lieferantennummer unten die des Teams ist, zu dem der Schlüssel gehört. |  |  |
| `guide.testAccess` | Test access | Zugriff testen |  |  |
| `guide.testNoReport` | Access works. The store has no file for the period asked yet, which is normal for a new app or a new month. | Der Zugriff funktioniert. Der Store hat für den angefragten Zeitraum noch keine Datei, was bei einer neuen App oder einem neuen Monat normal ist. |  |  |
| `guide.testOk` | Access works. Nothing is missing for this source. | Der Zugriff funktioniert. Für diese Quelle fehlt nichts. |  |  |
| `guide.testing` | Testing… | Teste … |  |  |
| `guide.vendor.causeInvalid` | Apple does not accept this vendor number. Check it against App Store Connect. | Apple akzeptiert diese Lieferantennummer nicht. Vergleiche sie mit App Store Connect. |  |  |
| `guide.vendor.causeMissing` | Sales and Trends and the subscription reports need the vendor number of your Apple team. | „Verkäufe und Trends“ und die Abo-Berichte brauchen die Lieferantennummer Ihres Apple-Teams. |  |  |
| `guide.vendor.hint` | Digits only, 5 to 12. | Nur Ziffern, 5 bis 12. |  |  |
| `guide.vendor.invalid` | Enter digits only, 5 to 12 of them. | Gib nur Ziffern ein, 5 bis 12. |  |  |
| `guide.vendor.label` | Vendor number | Lieferantennummer |  |  |
| `guide.vendor.saved` | Vendor number saved. | Lieferantennummer gespeichert. |  |  |
| `guide.vendor.step1` | Open Payments and Financial Reports in App Store Connect. The vendor number is shown at the top left, next to the team name (about 8 digits). | Öffne in App Store Connect Zahlungen und Finanzberichte. Die Lieferantennummer steht oben links neben dem Teamnamen (etwa 8 Ziffern). |  |  |
| `guide.vendor.step2` | Enter it here. It is kept for this Apple team, so apps of another team can have their own number. | Gib sie hier ein. Sie wird für dieses Apple-Team gespeichert, Apps eines anderen Teams können eine eigene Nummer haben. |  |  |
| `guide.vendor.usingWorkspace` | Now using the workspace default. Saving a number here keeps it for this Apple team only. | Es gilt der Standard des Arbeitsbereichs. Eine hier gespeicherte Nummer gilt nur für dieses Apple-Team. |  |  |
| `metric.anrRatePerceived` | User-perceived ANR rate | Von Nutzern wahrgenommene ANR-Rate |  |  |
| `metric.anrUsers` | Users behind the ANR rate | Nutzer hinter der ANR-Rate |  |  |
| `metric.crashRatePerceived` | User-perceived crash rate | Von Nutzern wahrgenommene Absturzrate |  |  |
| `metric.crashUsers` | Users behind the crash rate | Nutzer hinter der Absturzrate |  |  |
| `overview.empty.error` | No {{platform}} numbers: they could not be read. | Keine {{platform}}-Zahlen: Sie konnten nicht gelesen werden. |  |  |
| `overview.empty.loading` | Reading {{platform}} data… | {{platform}}-Daten werden gelesen… |  |  |
| `overview.empty.never` | No {{platform}} data yet. Nothing has been read: use Sync in the header, or check the data sources. | Noch keine {{platform}}-Daten. Es wurde nichts gelesen: Nutze Synchronisieren oben oder prüfe die Datenquellen. |  |  |
| `overview.empty.off` | No {{platform}} data yet. Analytics is off, so nothing is read. | Noch keine {{platform}}-Daten. Analysedaten sind aus, daher wird nichts gelesen. |  |  |
| `overview.measure` | Measure | Messgröße |  |  |
| `overview.noValue` | No data | Keine Daten |  |  |
| `overview.openSources` | Open Data sources | Datenquellen öffnen |  |  |
| `rail.acquisition` | Acquisition | Akquise |  |  |
| `rail.groupMore` | More | Mehr |  |  |
| `rail.groupNumbers` | Numbers | Zahlen |  |  |
| `rail.label` | Sections of Insights | Bereiche von Insights |  |  |
| `rail.next` | Next steps | Nächste Schritte |  |  |
| `rail.nothingStored` | Nothing stored for this yet. See Data sources. | Dazu ist noch nichts gespeichert. Siehe Datenquellen. |  |  |
| `rail.overview` | Overview | Überblick |  |  |
| `rail.quality` | Quality | Qualität |  |  |
| `rail.revenue` | Revenue | Umsatz |  |  |
| `rail.sources` | Data sources | Datenquellen |  |  |
| `rail.sourcesFailed_one` | {{count}} source could not be read | {{count}} Quelle konnte nicht gelesen werden |  |  |
| `rail.sourcesFailed_other` | {{count}} sources could not be read | {{count}} Quellen konnten nicht gelesen werden |  |  |
| `revenue.openProducts` | Products and sync | Produkte und Synchronisierung |  |  |
| `revenue.title` | Revenue | Umsatz |  |  |
| `revenue.waiting` | The RevenueCat figures are not read yet. Open Products and choose “Sync products” to read them. | Die RevenueCat-Zahlen sind noch nicht gelesen. Öffnen Sie Produkte und wählen Sie „Produkte synchronisieren“, um sie zu lesen. |  |  |
| `setup.bucketForbidden` | Google refuses the service account the Play Console reports bucket. See the steps below. | Google verweigert dem Dienstkonto den Bucket der Play-Console-Berichte. Siehe die Schritte unten. |  |  |
| `setup.bucketNotFound` | Google Cloud Storage has no bucket with this id. Set the bucket of this app’s Play account. | Google Cloud Storage kennt keinen Bucket mit dieser ID. Gib den Bucket des Play-Kontos dieser App an. |  |  |
| `setup.packageNotInBucket` | This bucket can be read but holds no report of this app: it is probably the bucket of another Play account. Set the bucket of the account that owns this app. | Dieser Bucket ist lesbar, enthält aber keinen Bericht dieser App: vermutlich ist es der Bucket eines anderen Play-Kontos. Gib den Bucket des Kontos an, dem diese App gehört. |  |  |
| `setup.playSalesForbidden` | Google reads the statistics but refuses the financial reports (sales, earnings, subscriptions). One Play Console permission is missing. See the steps below. | Google liest die Statistiken, verweigert aber die Finanzberichte (Verkäufe, Einnahmen, Abos). Eine Berechtigung der Play Console fehlt. Siehe die Schritte unten. |  |  |
| `setup.salesForbidden` | Apple refuses the key the Sales and Trends reports. Its role or the vendor number is wrong. See the steps below. | Apple verweigert dem Schlüssel die Berichte „Verkäufe und Trends“. Seine Rolle oder die Lieferantennummer stimmt nicht. Siehe die Schritte unten. |  |  |
| `setup.vendorNumberInvalid` | Apple does not accept this vendor number. It must be the one of the same Apple team as this app’s key. | Apple akzeptiert diese Lieferantennummer nicht. Es muss die des Apple-Teams sein, zu dem der Schlüssel dieser App gehört. |  |  |
| `setup.vendorNumberMissing` | Optional: enter the Apple vendor number of this app’s team to read daily units and proceeds, also by product, and subscription counts. | Optional: Gib die Apple-Lieferantennummer des Teams dieser App ein, um tägliche Stückzahlen und Erlöse, auch je Produkt, sowie Abo-Zahlen zu lesen. |  |  |
| `sources.retryStillFailed` | {{source}} could not be read again. The reason is in the list. | {{source}} konnte nicht erneut gelesen werden. Der Grund steht in der Liste. |  |  |

## web/app (211)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `builds.group.automation` | Automation | Automatisierung |  |  |
| `builds.navLabel` | Sections of Builds | Bereiche von Builds |  |  |
| `builds.section.config` | EAS configuration | EAS-Konfiguration |  |  |
| `builds.section.submissions` | EAS submissions | EAS-Einreichungen |  | submit = einreichen / senden |
| `builds.section.tests` | Test builds | Test-Builds |  |  |
| `builds.section.updates` | EAS updates | EAS-Updates |  |  |
| `builds.section.workflows` | Workflows | Workflows |  |  |
| `cart.added` | Added to pending changes | Zu den ausstehenden Änderungen hinzugefügt |  | cart = "Ausstehende Änderungen" |
| `cart.bundleNote` | Staged changes are sent to the store together as one draft, so selecting one selects them all. | Vorbereitete Änderungen gehen gemeinsam als ein Entwurf an den Store: Wer eine wählt, wählt alle. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `cart.confirm.approval` | You will be asked to confirm again. | Sie werden erneut um eine Bestätigung gebeten. |  |  |
| `cart.confirm.discardBody` | This removes the draft here only. The store is not touched and nothing is sent. | Dies entfernt nur den Entwurf hier. Der Store wird nicht berührt, und nichts wird gesendet. |  |  |
| `cart.confirm.discardGo` | Discard | Verwerfen |  |  |
| `cart.confirm.discardTitle_one` | Discard {{count}} item? | {{count}} Eintrag verwerfen? |  |  |
| `cart.confirm.discardTitle_other` | Discard {{count}} items? | {{count}} Einträge verwerfen? |  |  |
| `cart.confirm.drafts_one` | {{count}} staged change will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} vorbereitete Änderung wird als Entwurf in {{stores}} geschrieben. Nichts wird zur Prüfung eingereicht. |  | stage = vormerken / vorbereiten (nothing is sent); review: Rezension (user) vs Prüfung (App Review) |
| `cart.confirm.drafts_other` | {{count}} staged changes will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} vorbereitete Änderungen werden als Entwurf in {{stores}} geschrieben. Nichts wird zur Prüfung eingereicht. |  | stage = vormerken / vorbereiten (nothing is sent); review: Rezension (user) vs Prüfung (App Review) |
| `cart.confirm.go` | Publish | Veröffentlichen |  |  |
| `cart.confirm.pricesDelay` | Stores can take a while to show a new price everywhere. If an answer is lost, Kiln reads the store back instead of sending again. | Stores brauchen oft eine Weile, bis ein neuer Preis überall erscheint. Geht eine Antwort verloren, liest Kiln den Store zurück, statt erneut zu senden. |  |  |
| `cart.confirm.prices_one` | {{count}} price change goes live in the store. It changes what customers pay. | {{count}} Preisänderung wird im Store wirksam. Sie ändert, was Kunden zahlen. |  | live = live |
| `cart.confirm.prices_other` | {{count}} price changes go live in the store. They change what customers pay. | {{count}} Preisänderungen werden im Store wirksam. Sie ändern, was Kunden zahlen. |  | live = live |
| `cart.confirm.publishTitle_one` | Publish {{count}} item? | {{count}} Eintrag veröffentlichen? |  |  |
| `cart.confirm.publishTitle_other` | Publish {{count}} items? | {{count}} Einträge veröffentlichen? |  |  |
| `cart.confirm.replies_one` | {{count}} reply will be public on {{stores}} right away. | {{count}} Antwort wird sofort öffentlich in {{stores}} sichtbar. |  |  |
| `cart.confirm.replies_other` | {{count}} replies will be public on {{stores}} right away. | {{count}} Antworten werden sofort öffentlich in {{stores}} sichtbar. |  |  |
| `cart.confirm.type` | To confirm, type | Zum Bestätigen eingeben |  |  |
| `cart.confirm.typeFor` | For {{platform}}, type | Für {{platform}} eingeben |  |  |
| `cart.countAnnounce_one` | {{count}} pending change | {{count}} ausstehende Änderung |  |  |
| `cart.countAnnounce_other` | {{count}} pending changes | {{count}} ausstehende Änderungen |  | cart = "Ausstehende Änderungen" |
| `cart.diffNew` | New: {{after}} | Neu: {{after}} |  |  |
| `cart.discard` | Discard selected | Auswahl verwerfen |  |  |
| `cart.dryRun.button` | Check prices with the store (dry run) | Preise mit dem Store prüfen (Probelauf) |  |  |
| `cart.dryRun.error` | Could not check | Prüfung nicht möglich |  |  |
| `cart.dryRun.noStoreCheck` | This store has no check of its own. These requests would be sent: | Dieser Store hat keine eigene Prüfung. Diese Anfragen würden gesendet: |  |  |
| `cart.dryRun.note` | Kiln read the store and checked each change. Nothing was sent. | Kiln hat den Store gelesen und jede Änderung geprüft. Es wurde nichts gesendet. |  |  |
| `cart.dryRun.refused` | Would be refused | Würde abgelehnt |  |  |
| `cart.dryRun.storeChecked` | The store's own check accepted it. | Die eigene Prüfung des Stores hat es akzeptiert. |  |  |
| `cart.dryRun.switchOff` | Sending is switched off: this check works, but a send would be refused. | Das Senden ist ausgeschaltet: Diese Prüfung funktioniert, ein Senden würde aber abgelehnt. |  |  |
| `cart.dryRun.title` | Dry run of the price changes | Probelauf der Preisänderungen |  |  |
| `cart.dryRun.wouldSend` | Would be sent | Würde gesendet |  |  |
| `cart.empty` | Nothing is waiting. Changes you stage and replies you draft appear here. | Nichts ist ausstehend. Vorbereitete Änderungen und Antwortentwürfe erscheinen hier. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `cart.fabLabel` | Pending | Ausstehend |  |  |
| `cart.files_one` | {{count}} file | {{count}} Datei |  |  |
| `cart.files_other` | {{count}} files | {{count}} Dateien |  |  |
| `cart.fixFirst` | Fix this first: {{message}} | Zuerst beheben: {{message}} |  |  |
| `cart.graphicsDiff` | {{before}} → {{after}} images | {{before}} → {{after}} Bilder |  |  |
| `cart.group.graphics` | Graphics | Grafiken |  |  |
| `cart.group.listing` | Store listing | Store-Eintrag |  | listing = Store-Eintrag |
| `cart.group.price` | Price changes | Preisänderungen |  |  |
| `cart.group.release` | Release details | Versionsdetails |  | release = Release |
| `cart.group.reviewReply` | Review replies | Antworten auf Bewertungen |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.intro` | Nothing is published until you review it here and send it. | Nichts wird veröffentlicht, bis Sie es hier prüfen und senden. |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.loadFailed` | Could not load the pending changes. | Die ausstehenden Änderungen konnten nicht geladen werden. |  | cart = "Ausstehende Änderungen" |
| `cart.open` | Open | Öffnen |  |  |
| `cart.openAria_one` | Open pending changes: {{count}} item waiting | Ausstehende Änderungen öffnen: {{count}} Eintrag |  | cart = "Ausstehende Änderungen" |
| `cart.openAria_other` | Open pending changes: {{count}} items waiting | Ausstehende Änderungen öffnen: {{count}} Einträge |  | cart = "Ausstehende Änderungen" |
| `cart.openRow` | Open {{title}} where it was made | {{title}} dort öffnen, wo es erstellt wurde |  |  |
| `cart.price.acks` | Confirmed: | Bestätigt: |  |  |
| `cart.price.asap` | As soon as the store allows | Sobald der Store es erlaubt |  |  |
| `cart.price.caption` | Price changes of {{id}} | Preisänderungen von {{id}} |  |  |
| `cart.price.colChange` | Price | Preis |  |  |
| `cart.price.colPercent` | Change | Änderung |  |  |
| `cart.price.confirmed` | Confirmed by the store | Vom Store bestätigt |  |  |
| `cart.price.from` | From {{date}} | Ab {{date}} |  |  |
| `cart.price.lineFailed` | {{territory}}: {{amount}} {{outcome}} | {{territory}}: {{amount}} {{outcome}} |  |  |
| `cart.price.lineRefused` | was not changed | wurde nicht geändert |  |  |
| `cart.price.lineUnknown` | may not have reached the store | ist möglicherweise nicht beim Store angekommen |  |  |
| `cart.price.noPrice` | no price | keinen Preis |  |  |
| `cart.price.notSent` | Nothing was sent. | Es wurde nichts gesendet. |  |  |
| `cart.price.perCurrency` | {{currency}}: {{up}} up, {{down}} down | {{currency}}: {{up}} höher, {{down}} niedriger |  |  |
| `cart.price.storeShows` | Store shows {{actual}} for {{territory}}, not {{expected}}. | Der Store zeigt für {{territory}} {{actual}}, nicht {{expected}}. |  |  |
| `cart.price.storeShowsOther` | The store shows other prices than the ones asked. | Der Store zeigt andere Preise als angefordert. |  |  |
| `cart.price.summary_one` | Price change in {{count}} territory. | Preisänderung in {{count}} Gebiet. |  |  |
| `cart.price.summary_other` | Price change in {{count}} territories. | Preisänderung in {{count}} Gebieten. |  |  |
| `cart.price.territories_one` | Show {{count}} territory | {{count}} Gebiet anzeigen |  |  |
| `cart.price.territories_other` | Show {{count}} territories | {{count}} Gebiete anzeigen |  |  |
| `cart.price.unverified` | Not verified: the store's prices could not be read back. | Nicht geprüft: Die Preise des Stores konnten nicht zurückgelesen werden. |  |  |
| `cart.publishPage` | Open the full publish page | Vollständige Veröffentlichungsseite öffnen |  |  |
| `cart.publishPageHint` | Submitting, releasing and rollout steps are done there. | Dort erfolgen Einreichung zur Prüfung, Freigabe und gestaffelte Auslieferung. |  | rollout = Einführung; submit = einreichen / senden |
| `cart.publish_one` | Publish {{count}} selected | {{count}} Ausgewähltes veröffentlichen |  |  |
| `cart.publish_other` | Publish {{count}} selected | {{count}} Ausgewählte veröffentlichen |  |  |
| `cart.reason.bundleBlocked` | Another staged change has an error, and they are sent together. | Eine andere vorbereitete Änderung hat einen Fehler, und sie werden gemeinsam gesendet. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `cart.reason.inProgress` | A send is already running. | Ein Versand läuft bereits. |  |  |
| `cart.reason.invalid` | This change has an error and cannot be sent yet. | Diese Änderung hat einen Fehler und kann noch nicht gesendet werden. |  |  |
| `cart.reason.metadataLocked` | This version is live or in review, so its listing is locked. Prepare a new version first. | Diese Version ist live oder in Prüfung, ihr Eintrag ist daher gesperrt. Bereiten Sie zuerst eine neue Version vor. |  | listing = Store-Eintrag; review: Rezension (user) vs Prüfung (App Review) |
| `cart.reason.noRight` | You do not have the right to send this. | Sie haben nicht das Recht, dies zu senden. |  |  |
| `cart.reason.other` | It cannot be sent right now. | Kann gerade nicht gesendet werden. |  |  |
| `cart.reason.outcomeUnknown` | The last send did not answer. Check the store first. | Der letzte Versand hat nicht geantwortet. Prüfen Sie zuerst den Store. |  |  |
| `cart.reason.switchOff` | Sending this to the store is switched off for this server. | Das Senden an den Store ist auf diesem Server abgeschaltet. |  |  |
| `cart.reason.workspaceOff` | Price changes are switched off for this workspace. | Preisänderungen sind für diesen Arbeitsbereich ausgeschaltet. |  |  |
| `cart.report.dismiss` | Dismiss | Schließen |  |  |
| `cart.report.summary` | {{ok}} done, {{failed}} failed, {{skipped}} skipped | {{ok}} erledigt, {{failed}} fehlgeschlagen, {{skipped}} übersprungen |  |  |
| `cart.result.blocked` | The store check blocks this change. | Die Store-Prüfung blockiert diese Änderung. |  |  |
| `cart.result.bundleIncomplete` | Staged changes are sent together. Select all of them. | Vorbereitete Änderungen werden gemeinsam gesendet. Wählen Sie alle aus. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `cart.result.changedSinceReview` | It changed after you opened this list. Review it again. | Nach dem Öffnen dieser Liste geändert. Bitte erneut prüfen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.result.confirmationMismatch` | The typed phrase was not the right one. Nothing was sent. | Der eingegebene Satz war nicht der richtige. Es wurde nichts gesendet. |  |  |
| `cart.result.network` | Could not reach the server. | Der Server ist nicht erreichbar. |  |  |
| `cart.result.notPending` | Already sent or removed. | Bereits gesendet oder entfernt. |  |  |
| `cart.result.other` | It could not be sent. | Konnte nicht gesendet werden. |  |  |
| `cart.result.priceAck` | An acknowledgement is missing. | Eine Bestätigung fehlt. |  |  |
| `cart.result.priceCurrency` | The currency of a territory changed in the store. Nothing was changed. | Die Währung eines Gebiets hat sich im Store geändert. Es wurde nichts geändert. |  |  |
| `cart.result.priceInvalid` | The change has an error and was not sent. | Die Änderung enthält einen Fehler und wurde nicht gesendet. |  |  |
| `cart.result.priceNotAllowed` | The store does not allow this price change now (for example, one is already scheduled). | Der Store erlaubt diese Preisänderung jetzt nicht (zum Beispiel ist schon eine geplant). |  |  |
| `cart.result.pricePartial` | Some territories were changed and some were not. See below. | Einige Gebiete wurden geändert, andere nicht. Siehe unten. |  |  |
| `cart.result.pricePoint` | An amount is not an Apple price point. | Ein Betrag ist keine Apple-Preisstufe. |  |  |
| `cart.result.priceProduct` | The product no longer exists in the store. | Das Produkt gibt es im Store nicht mehr. |  |  |
| `cart.result.priceRejected` | The store rejected the price change. | Der Store hat die Preisänderung abgelehnt. |  |  |
| `cart.result.priceStale` | The price in the store changed since you reviewed it. Nothing was changed. Sync and review again. | Der Preis im Store hat sich seit Ihrer Prüfung geändert. Es wurde nichts geändert. Synchronisieren und erneut prüfen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.result.priceSubscribers` | The store does not accept that choice for existing subscribers. | Der Store akzeptiert diese Wahl für bestehende Abonnenten nicht. |  |  |
| `cart.result.priceTerritory` | The store does not support a price in one of these territories. | Der Store unterstützt in einem dieser Gebiete keinen Preis. |  |  |
| `cart.result.rateLimited` | The store asked for a pause. Nothing more was sent. Review again in a moment. | Der Store hat um eine Pause gebeten. Es wurde nichts mehr gesendet. Prüfen Sie gleich erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.result.stagedInvalid` | A staged change has an error. | Eine vorbereitete Änderung hat einen Fehler. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `cart.result.stateChanged` | The store changed since it was checked. Review again. | Der Store hat sich seit der Prüfung geändert. Bitte erneut prüfen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.result.stepUpRequired` | The confirmation was not completed. | Die Bestätigung wurde nicht abgeschlossen. |  |  |
| `cart.review` | Review | Prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.reviewLine` | Review, {{stars}}: {{excerpt}} | Bewertung, {{stars}}: {{excerpt}} |  | review: Rezension (user) vs Prüfung (App Review) |
| `cart.risk.financial` | Changes what customers pay | Ändert, was Kunden zahlen |  |  |
| `cart.risk.publicReply` | Public reply | Öffentliche Antwort |  |  |
| `cart.risk.storeDraft` | Store draft | Store-Entwurf |  |  |
| `cart.selectAll` | Select all | Alle auswählen |  |  |
| `cart.selectedCount` | {{selected}} of {{total}} selected | {{selected}} von {{total}} ausgewählt |  |  |
| `cart.stars_one` | {{count}} star | {{count}} Stern |  |  |
| `cart.stars_other` | {{count}} stars | {{count}} Sterne |  |  |
| `cart.status.failed` | Failed | Fehlgeschlagen |  |  |
| `cart.status.ok` | Done | Erledigt |  |  |
| `cart.status.running` | Sending | Wird gesendet |  |  |
| `cart.status.skipped` | Skipped | Übersprungen |  |  |
| `cart.title` | Pending changes | Ausstehende Änderungen |  | cart = "Ausstehende Änderungen" |
| `listingSettings.compareMedia` | Compare repository and store graphics | Grafiken von Repository und Store vergleichen |  |  |
| `listingSettings.compareMediaHint` | Compares the screenshots and icons in the repository with the store's; the store's own graphics are listed either way. | Vergleicht Screenshots und Icons im Repository mit denen des Stores; die Grafiken des Stores werden in jedem Fall aufgelistet. |  |  |
| `listingSettings.compareRepo` | Compare repository and store | Repository und Store vergleichen |  |  |
| `listingSettings.compareRepoHint` | Shows where the repository text and the store text differ and offers to stage the repository text; leave it off if this app keeps no fastlane files. | Zeigt, wo Repository-Text und Store-Text abweichen, und bietet an, den Repository-Text vorzumerken; ausgeschaltet lassen, wenn diese App keine fastlane-Dateien hat. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `listingSettings.description` | Choose whether Kiln compares your repository with the store; the store page is always checked on its own. | Legen Sie fest, ob Kiln Ihr Repository mit dem Store vergleicht; der Store-Eintrag wird immer für sich geprüft. |  |  |
| `listingSettings.forbidden` | Only an admin can change this setting. | Nur ein Admin kann diese Einstellung ändern. |  |  |
| `listingSettings.notSaved` | Not saved | Nicht gespeichert |  |  |
| `listingSettings.readOnly` | You can see these settings; an admin changes them. | Sie können diese Einstellungen sehen; ein Admin ändert sie. |  |  |
| `listingSettings.saveFailed` | The setting could not be saved. Try again. | Die Einstellung konnte nicht gespeichert werden. Versuchen Sie es erneut. |  |  |
| `listingSettings.saved` | Listing setting saved. | Einstellung des Eintrags gespeichert. |  | listing = Store-Eintrag |
| `nav.badgeInsights_one` | {{count}} insight to look at | {{count}} Punkt zum Ansehen in den Auswertungen |  |  |
| `nav.badgeInsights_other` | {{count}} insights to look at | {{count}} Punkte zum Ansehen in den Auswertungen |  |  |
| `nav.expandToSwitch` | {{name}}: expand the navigation to switch apps | {{name}}: Navigation aufklappen, um die App zu wechseln |  |  |
| `settings.group.connections` | Connections | Verbindungen |  |  |
| `settings.group.danger` | Removal | Entfernen |  |  |
| `settings.group.data` | Data and alerts | Daten und Benachrichtigungen |  |  |
| `settings.group.releases` | Releases | Releases |  | release = Release |
| `settings.integrationsNone` | Nothing here applies to this app yet: no Expo project and no RevenueCat link are available for it. | Hier trifft noch nichts auf diese App zu: Es ist weder ein Expo-Projekt noch eine RevenueCat-Verknüpfung verfügbar. |  |  |
| `settings.navLabel` | Sections of the app settings | Bereiche der App-Einstellungen |  |  |
| `settings.part.integrations` | Expo and RevenueCat | Expo und RevenueCat |  |  |
| `settings.part.listing` | Store listing | Store-Eintrag |  | listing = Store-Eintrag |
| `stores.effective.bucket` | Play reports bucket | Play-Berichts-Bucket |  |  |
| `stores.effective.fromAccount` | from this Play account | aus diesem Play-Konto |  |  |
| `stores.effective.fromApp` | set on this app | für diese App festgelegt |  |  |
| `stores.effective.fromCredential` | from this credential | aus diesem Zugang |  |  |
| `stores.effective.fromWorkspace` | from the workspace default | Standard des Arbeitsbereichs |  |  |
| `stores.effective.vendorNumber` | Vendor number | Vendor-Nummer |  |  |
| `stores.identifiers` | Identifiers | Kennungen |  |  |
| `sync.couldNotRead` | Could not read: {{what}}. | Nicht lesbar: {{what}}. |  |  |
| `sync.hint.ads` | Press Sync. If it keeps failing, check the Apple Ads key under Credentials. | Tippen Sie auf Synchronisieren. Schlägt es weiter fehl, prüfen Sie den Apple-Ads-Schlüssel unter Zugangsdaten. |  |  |
| `sync.hint.analytics` | Open Insights, Data sources, and follow the next step of that source. | Öffne Insights, Datenquellen, und folge dem nächsten Schritt dieser Quelle. |  |  |
| `sync.hint.app` | Check the store credential in the app settings, then press Sync. | Prüfe die Store-Zugangsdaten in den App-Einstellungen und drücke dann Synchronisieren. |  |  |
| `sync.hint.eas` | Press Sync. If it keeps failing, check the Expo access token under Credentials. | Drücke Synchronisieren. Schlägt es weiter fehl, prüfe das Expo-Zugriffstoken unter Zugangsdaten. |  |  |
| `sync.hint.products` | Press Sync. Check that the store credential may read in-app products. | Drücke Synchronisieren. Prüfe, ob die Store-Zugangsdaten In-App-Produkte lesen dürfen. |  |  |
| `sync.hint.reviews` | Press Sync. If it keeps failing, check that the store credential may read reviews. | Drücke Synchronisieren. Schlägt es weiter fehl, prüfe, ob die Store-Zugangsdaten Bewertungen lesen dürfen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `sync.hint.testflight` | Press Sync. Check that the App Store Connect key may read beta feedback. | Drücke Synchronisieren. Prüfe, ob der App-Store-Connect-Schlüssel Beta-Feedback lesen darf. |  |  |
| `sync.kind.ads` | Apple Ads reports | Apple-Ads-Berichte |  |  |
| `sync.kind.analytics` | Analytics | Analytics |  |  |
| `sync.kind.app` | Store listing and releases | Store-Eintrag und Releases |  | release = Release; listing = Store-Eintrag |
| `sync.kind.eas` | EAS builds and submissions | EAS-Builds und -Einreichungen |  | submit = einreichen / senden |
| `sync.kind.products` | In-app products and RevenueCat | In-App-Produkte und RevenueCat |  |  |
| `sync.kind.reviews` | Reviews | Bewertungen |  | review: Rezension (user) vs Prüfung (App Review) |
| `sync.kind.testflight` | TestFlight feedback | TestFlight-Feedback |  |  |
| `sync.lastRead` | Read {{ago}} | Gelesen {{ago}} |  |  |
| `sync.neverRead` | Never read | Nie gelesen |  |  |
| `sync.none` | Nothing to sync yet. Connect a store in the app settings. | Noch nichts zu synchronisieren. Verbinde einen Store in den App-Einstellungen. |  |  |
| `sync.notReadYet` | Not read yet. Use Sync at the top of the page. | Noch nicht gelesen. Nutze Synchronisieren oben auf der Seite. |  |  |
| `sync.problem` | Some sources could not be queued: {{message}} | Einige Quellen konnten nicht eingereiht werden: {{message}} |  |  |
| `sync.running` | Syncing… | Synchronisiert… |  |  |
| `sync.seeStatus` | See Status | Status ansehen |  |  |
| `sync.sourcesLabel` | What this app is synced from | Woraus diese App synchronisiert wird |  |  |
| `sync.sourcesTitle` | Sources | Quellen |  |  |
| `sync.state.failed` | Could not read | Nicht lesbar |  |  |
| `sync.state.never` | Not read yet | Noch nicht gelesen |  |  |
| `sync.state.ok` | Up to date | Aktuell |  |  |
| `sync.state.running` | Syncing | Synchronisiert |  |  |
| `sync.updated` | Updated {{ago}} | Aktualisiert {{ago}} |  |  |
| `syncButton.everything` | Sync everything | Alles synchronisieren |  |  |
| `syncButton.label.ads` | Sync Apple Ads | Apple Ads synchronisieren |  |  |
| `syncButton.label.analytics` | Sync analytics | Analysedaten synchronisieren |  |  |
| `syncButton.label.builds` | Sync builds | Builds synchronisieren |  |  |
| `syncButton.label.health` | Sync ratings and health | Bewertungen und Stabilität synchronisieren |  | rating = Bewertung |
| `syncButton.label.listing` | Sync listing | Eintrag synchronisieren |  | listing = Store-Eintrag |
| `syncButton.label.products` | Sync products | Produkte synchronisieren |  |  |
| `syncButton.label.reviews` | Sync reviews | Bewertungen synchronisieren |  | review: Rezension (user) vs Prüfung (App Review) |
| `syncButton.label.timeline` | Sync timeline data | Zeitleisten-Daten synchronisieren |  |  |
| `syncButton.menuTitle` | Sync | Synchronisierung |  |  |
| `syncButton.more` | More sync options | Weitere Synchronisierungsoptionen |  |  |
| `syncButton.noPage` | Nothing on this page needs a sync. Sync everything reads the rest. | Auf dieser Seite muss nichts synchronisiert werden. „Alles synchronisieren“ liest den Rest. |  |  |
| `syncButton.none` | Nothing to sync yet. | Noch nichts zu synchronisieren. |  |  |
| `syncButton.onlyFailed` | Only failed ({{failed}}) | Nur fehlgeschlagene ({{failed}}) |  |  |
| `syncButton.progress` | Syncing {{done}} of {{total}} | Synchronisiere {{done}} von {{total}} |  |  |
| `syncButton.retry` | Retry failed ({{failed}}) | Fehlgeschlagene wiederholen ({{failed}}) |  |  |
| `syncButton.retrySource` | Retry | Erneut versuchen |  |  |
| `syncButton.run` | Sync | Synchronisieren |  |  |
| `syncButton.runKind` | Sync: {{kind}} | Synchronisieren: {{kind}} |  |  |
| `syncButton.upToDate` | Everything on this page was read recently. This reads it again. | Alles auf dieser Seite wurde kürzlich gelesen. Das liest es erneut. |  |  |
| `view.ads` | Ads | Anzeigen |  |  |
| `view.countries` | Countries | Länder |  |  |
| `view.experiments` | Experiments | Tests |  |  |
| `view.highlights` | Highlights | Auffälligkeiten |  |  |
| `view.ratings` | Ratings and health | Bewertungen und Stabilität |  | rating = Bewertung |
| `view.reviews` | Reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `view.timeline` | Timeline and reports | Zeitleiste und Berichte |  |  |

## web/aso (161)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `changes.category` | Category: {{from}} to {{to}} | Kategorie: von {{from}} zu {{to}} |  |  |
| `changes.checkFailed` | The check failed. | Die Prüfung ist fehlgeschlagen. |  |  |
| `changes.checkNow` | Check now | Jetzt prüfen |  |  |
| `changes.checkedAgo` | Last checked {{ago}}. | Zuletzt geprüft: {{ago}}. |  |  |
| `changes.checkedNone` | Checked: no new changes. | Geprüft: keine neuen Änderungen. |  |  |
| `changes.checkedNotFound` | The store no longer lists this app in that country. | Der Store listet diese App in diesem Land nicht mehr. |  |  |
| `changes.checkedRecent` | Checked a moment ago. Kiln does not read the store again within 5 minutes. | Gerade geprüft. Kiln liest den Store nicht innerhalb von 5 Minuten erneut. |  |  |
| `changes.checked_one` | Checked: {{count}} new change found. | Geprüft: {{count}} neue Änderung gefunden. |  |  |
| `changes.checked_other` | Checked: {{count}} new changes found. | Geprüft: {{count}} neue Änderungen gefunden. |  |  |
| `changes.description` | Description changed | Beschreibung geändert |  |  |
| `changes.firstOnly` | Kiln saved the first look on {{date}}. Changes show from the next check on. | Kiln hat den ersten Stand am {{date}} gespeichert. Änderungen erscheinen ab der nächsten Prüfung. |  |  |
| `changes.icon` | Icon changed | Icon geändert |  |  |
| `changes.iconAlt` | Icon, {{side}} | Icon, {{side}} |  |  |
| `changes.listLabel` | Listing changes of {{name}} | Änderungen am Eintrag von {{name}} |  | listing = Store-Eintrag |
| `changes.loadFailed` | The changes could not be loaded. | Die Änderungen konnten nicht geladen werden. |  |  |
| `changes.name` | Name changed | Name geändert |  |  |
| `changes.noneSince` | Checked {{ago}}, no changes since we started watching on {{date}}. | Geprüft {{ago}}, keine Änderungen seit Beginn der Beobachtung am {{date}}. |  |  |
| `changes.notChecked` | Not checked yet. Changes show from the first check on. | Noch nicht geprüft. Änderungen erscheinen ab der ersten Prüfung. |  |  |
| `changes.notWatched` | Not watched: Kiln does not read Google Play pages, so changes to this listing are not tracked. | Nicht beobachtet: Kiln liest keine Google-Play-Seiten, daher werden Änderungen an diesem Eintrag nicht verfolgt. |  | listing = Store-Eintrag |
| `changes.older` | Show older changes | Ältere Änderungen anzeigen |  |  |
| `changes.part.added_one` | {{count}} added | {{count}} hinzugefügt |  |  |
| `changes.part.added_other` | {{count}} added | {{count}} hinzugefügt |  |  |
| `changes.part.removed_one` | {{count}} removed | {{count}} entfernt |  |  |
| `changes.part.removed_other` | {{count}} removed | {{count}} entfernt |  |  |
| `changes.part.reordered` | reordered | neu angeordnet |  |  |
| `changes.part.replaced_one` | {{count}} replaced | {{count}} ersetzt |  |  |
| `changes.part.replaced_other` | {{count}} replaced | {{count}} ersetzt |  |  |
| `changes.price` | Price: {{from}} to {{to}} | Preis: von {{from}} zu {{to}} |  |  |
| `changes.rating` | Average rating: {{from}} to {{to}} stars | Durchschnittsbewertung: von {{from}} zu {{to}} Sternen |  | rating = Bewertung |
| `changes.ratingCount` | Number of ratings: {{from}} to {{to}} | Anzahl der Bewertungen: von {{from}} zu {{to}} |  | rating = Bewertung |
| `changes.releaseNotes` | Release notes changed | Versionshinweise geändert |  | release = Release |
| `changes.retention` | Kept for {{days}} days, at most 200 changes per competitor. | {{days}} Tage gespeichert, höchstens 200 Änderungen pro Wettbewerber. |  |  |
| `changes.screenshots` | {{device}} screenshots: {{parts}} | {{device}}-Screenshots: {{parts}} |  |  |
| `changes.shotAlt` | Screenshot {{n}} of {{total}}, {{side}} ({{device}}) | Screenshot {{n}} von {{total}}, {{side}} ({{device}}) |  |  |
| `changes.showDiff` | Show the difference | Unterschied anzeigen |  |  |
| `changes.side.after` | after | danach |  |  |
| `changes.side.before` | before | davor |  |  |
| `changes.sr.added` | Added: | Hinzugefügt: |  |  |
| `changes.sr.removed` | Removed: | Entfernt: |  |  |
| `changes.status.new` | new | neu |  |  |
| `changes.status.removed` | removed | entfernt |  |  |
| `changes.stripLabel` | {{device}} screenshots, {{side}} | {{device}}-Screenshots, {{side}} |  |  |
| `changes.summaryNone` | Listing changes: none seen yet | Änderungen am Eintrag: bisher keine |  | listing = Store-Eintrag |
| `changes.summaryNotWatched` | Listing changes: not watched | Änderungen am Eintrag: nicht beobachtet |  | listing = Store-Eintrag |
| `changes.summary_one` | Listing changes ({{count}}{{more}}) | Änderungen am Eintrag ({{count}}{{more}}) |  | listing = Store-Eintrag |
| `changes.summary_other` | Listing changes ({{count}}{{more}}) | Änderungen am Eintrag ({{count}}{{more}}) |  | listing = Store-Eintrag |
| `changes.version` | Version: {{from}} to {{to}} | Version: von {{from}} zu {{to}} |  |  |
| `changes.watchingSince` | Watching since {{date}}: Kiln only sees changes from then on. | Beobachtet seit {{date}}: Kiln sieht nur Änderungen ab diesem Tag. |  |  |
| `est.col.details` | Details | Details |  |  |
| `est.col.difficulty` | Difficulty (est.) | Schwierigkeit (gesch.) |  |  |
| `est.col.keyword` | Keyword | Keyword |  |  |
| `est.col.opportunity` | Opportunity (est.) | Chance (gesch.) |  |  |
| `est.col.popularity` | Popularity (est.) | Popularität (gesch.) |  |  |
| `est.col.rank` | Rank | Position |  |  |
| `est.confidence.high` | High confidence | Hohe Sicherheit |  |  |
| `est.confidence.low` | Low confidence | Geringe Sicherheit |  |  |
| `est.confidence.medium` | Medium confidence | Mittlere Sicherheit |  |  |
| `est.detail.appleAdsCampaigns` | Your campaigns: {{impressions}} impressions, {{taps}} taps, {{installs}} installs in {{days}} days. | Ihre Kampagnen: {{impressions}} Impressionen, {{taps}} Tipps, {{installs}} Installationen in {{days}} Tagen. |  |  |
| `est.detail.appleAdsIntro` | Apple’s own numbers, shown beside the estimate and never mixed into it. | Apples eigene Zahlen, neben der Schätzung gezeigt und nie in sie eingerechnet. |  |  |
| `est.detail.appleAdsNoScore` | {{genre}}: Apple gave no popularity | {{genre}}: Apple nannte keine Beliebtheit |  |  |
| `est.detail.appleAdsRank` | rank {{rank}} in the genre | Rang {{rank}} im Genre |  |  |
| `est.detail.appleAdsScore` | {{genre}}: Apple popularity {{score}} of 100 | {{genre}}: Apple-Beliebtheit {{score}} von 100 |  |  |
| `est.detail.close` | Close | Schließen |  |  |
| `est.detail.col.ratings` | Ratings | Bewertungen |  | rating = Bewertung |
| `est.detail.competing` | Apps in the first results | Apps in den ersten Ergebnissen |  |  |
| `est.detail.competingNone` | No search results have been read yet. | Es wurden noch keine Suchergebnisse gelesen. |  |  |
| `est.detail.difficulty` | Difficulty inputs | Eingaben der Schwierigkeit |  |  |
| `est.detail.hints` | Search hints | Suchvorschläge |  |  |
| `est.detail.hintsIntro` | What the App Store suggests while this term is typed, in its order. | Was der App Store beim Tippen dieses Begriffs vorschlägt, in seiner Reihenfolge. |  |  |
| `est.detail.hintsNone` | No hints have been read yet. | Es wurden noch keine Vorschläge gelesen. |  |  |
| `est.detail.line` | {{points}} of 100, share {{share}}% | {{points}} von 100, Anteil {{share}} % |  |  |
| `est.detail.noRead` | No public signal has been read yet. Model {{model}}. | Es wurde noch kein öffentliches Signal gelesen. Modell {{model}}. |  |  |
| `est.detail.opportunity` | Opportunity: your current rank leaves {{percent}}% of the room. | Chance: Ihre aktuelle Position lässt {{percent}} % Spielraum. |  |  |
| `est.detail.popularity` | Popularity inputs | Eingaben der Popularität |  |  |
| `est.detail.read` | Public signals read {{when}}. Model {{model}}. | Öffentliche Signale gelesen {{when}}. Modell {{model}}. |  |  |
| `est.detail.title` | Why this estimate: {{term}} | Warum diese Schätzung: {{term}} |  |  |
| `est.detail.trend` | Trend of the estimate | Verlauf der Schätzung |  |  |
| `est.detail.trendDifficulty` | Difficulty estimate over {{count}} days, latest {{latest}} | Schwierigkeitsschätzung über {{count}} Tage, zuletzt {{latest}} |  |  |
| `est.detail.trendLabel` | Popularity estimate over {{count}} days, latest {{latest}} | Popularitätsschätzung über {{count}} Tage, zuletzt {{latest}} |  |  |
| `est.detail.trendNone` | The trend needs readings from at least two days. | Der Verlauf braucht Messwerte von mindestens zwei Tagen. |  |  |
| `est.empty` | Estimates appear after the keywords have been checked. | Schätzungen erscheinen, nachdem die Keywords geprüft wurden. |  |  |
| `est.filter.all` | All keywords | Alle Keywords |  |  |
| `est.filter.estimated` | With an estimate | Mit Schätzung |  |  |
| `est.filter.label` | Show | Anzeigen |  |  |
| `est.filter.none` | No estimate | Ohne Schätzung |  |  |
| `est.filter.own` | From your data | Aus Ihren Daten |  |  |
| `est.how.confidence` | Confidence says how much evidence is behind a number: one dot is low, two medium, three high. Public signals alone never reach high, and difficulty never does. | Die Sicherheit zeigt, wie viele Belege hinter einer Zahl stehen: ein Punkt niedrig, zwei mittel, drei hoch. Öffentliche Signale allein erreichen nie „hoch“, die Schwierigkeit ebenfalls nicht. |  |  |
| `est.how.demand` | Popularity: how many ratings the first results have, a weak sign of how big the niche is. | Popularität: wie viele Bewertungen die ersten Ergebnisse haben, ein schwacher Hinweis auf die Größe der Nische. |  | rating = Bewertung |
| `est.how.difficulty` | Difficulty: how strong the first results are (their ratings), how many have every word of the term in their name, how crowded the results are, and how much your own rank moves between checks. | Schwierigkeit: wie stark die ersten Ergebnisse sind (ihre Bewertungen), wie viele alle Wörter des Begriffs im Namen tragen, wie voll die Ergebnisse sind und wie stark sich Ihre Position zwischen Prüfungen bewegt. |  | rating = Bewertung |
| `est.how.hints` | Popularity: where the App Store suggests the term while someone types it (its search hints). | Popularität: an welcher Stelle der App Store den Begriff beim Tippen vorschlägt (seine Suchvorschläge). |  |  |
| `est.how.intro` | Apple and Google publish no search volume for a term. Kiln combines what it can see: | Apple und Google veröffentlichen kein Suchvolumen für einen Begriff. Kiln kombiniert, was sich beobachten lässt: |  |  |
| `est.how.label` | How this is estimated | So wird geschätzt |  |  |
| `est.how.limits` | Limits: the hints and the results are what Apple’s public services show and may differ from the App Store app. Each term is read once a day, at most {{count}} terms per check, only for keywords you track. Nothing is sent to an AI. | Grenzen: Die Vorschläge und Ergebnisse stammen aus den öffentlichen Diensten von Apple und können von der App-Store-App abweichen. Jeder Begriff wird einmal am Tag gelesen, höchstens {{count}} Begriffe pro Prüfung und nur für Keywords, die Sie verfolgen. Nichts wird an eine KI gesendet. |  | track = Track (Play) / verfolgen (keyword) |
| `est.how.none` | With no signal there is “No estimate”, never 0. Google Play keywords get an estimate only from your own search terms file. | Ohne Signal steht dort „Keine Schätzung“, nie 0. Für Google-Play-Keywords gibt es nur mit Ihrer eigenen Datei mit Suchbegriffen eine Schätzung. |  |  |
| `est.how.own` | Popularity: your own visitors for the term (the Google Play search terms file). This is the strongest input and it is marked “from your data”. It is a lower bound: only people who reached your listing. | Popularität: Ihre eigenen Besucher für den Begriff (die Datei mit den Suchbegriffen von Google Play). Das ist die stärkste Angabe und wird mit „aus Ihren Daten“ gekennzeichnet. Es ist ein Mindestwert: Nur Personen, die Ihren Eintrag erreicht haben, zählen. |  | listing = Store-Eintrag |
| `est.lead` | Popularity and difficulty are estimates that Kiln works out from public signals and from your own data. They are not Apple’s popularity score and not a Google Play number. | Popularität und Schwierigkeit sind Schätzungen, die Kiln aus öffentlichen Signalen und aus Ihren eigenen Daten berechnet. Es ist weder der Popularitätswert von Apple noch eine Zahl von Google Play. |  |  |
| `est.loadFailed` | The estimates could not be loaded. | Die Schätzungen konnten nicht geladen werden. |  |  |
| `est.noMatch` | No keyword matches this filter. | Kein Keyword passt zu diesem Filter. |  |  |
| `est.none` | No estimate | Keine Schätzung |  |  |
| `est.noneWhy` | Why there is no estimate | Warum es keine Schätzung gibt |  |  |
| `est.opportunity.tip` | Opportunity is an estimate too: popularity, times how easy the term looks, times how much room your current rank leaves. It is a place to look, not a promise. | Die Chance ist ebenfalls eine Schätzung: Popularität, mal wie leicht der Begriff wirkt, mal wie viel Spielraum Ihre aktuelle Position lässt. Sie ist ein Ansatzpunkt, kein Versprechen. |  |  |
| `est.origin.adsData` | from your data (Apple Ads) | aus Ihren Daten (Apple Ads) |  |  |
| `est.origin.ownData` | from your data | aus Ihren Daten |  |  |
| `est.origin.publicSignals` | from public signals | aus öffentlichen Signalen |  |  |
| `est.reason.adsImpressions` | Your Apple Ads campaigns showed this search term {{impressions}} times, with {{taps}} taps and {{installs}} installs, in {{days}} days. Only searches that reached one of your ads are counted. | Ihre Apple-Ads-Kampagnen haben diesen Suchbegriff {{impressions}} Mal gezeigt, mit {{taps}} Tipps und {{installs}} Installationen, in {{days}} Tagen. Es zählen nur Suchen, die eine Ihrer Anzeigen erreicht haben. |  |  |
| `est.reason.hintsAbsent` | The App Store suggests {{size}} other terms but not this one. | Der App Store schlägt {{size}} andere Begriffe vor, aber nicht diesen. |  |  |
| `est.reason.hintsEmpty` | The App Store suggests nothing for this term. | Der App Store schlägt für diesen Begriff nichts vor. |  |  |
| `est.reason.hintsPosition` | The App Store suggests this term in place {{position}} of {{size}} while it is typed. | Der App Store schlägt diesen Begriff beim Tippen an Stelle {{position}} von {{size}} vor. |  |  |
| `est.reason.noSignal` | No signal has been read yet. Check the keywords to read the App Store. | Es wurde noch kein Signal gelesen. Prüfen Sie die Keywords, um den App Store zu lesen. |  |  |
| `est.reason.ownVisitors` | {{visitors}} visitors and {{installs}} installs in {{days}} days, from your search terms file. Only people who reached your listing are counted. | {{visitors}} Besucher und {{installs}} Installationen in {{days}} Tagen, aus Ihrer Datei mit Suchbegriffen. Es zählen nur Personen, die Ihren Eintrag erreicht haben. |  | listing = Store-Eintrag |
| `est.reason.playNeedsOwnData` | Google Play has no public signal. Import your Play Console search terms file to get an estimate. | Google Play hat kein öffentliches Signal. Importieren Sie Ihre Datei mit Suchbegriffen aus der Play Console, um eine Schätzung zu erhalten. |  |  |
| `est.reason.playNoCompetitionData` | Kiln does not read Google Play, so there is no difficulty estimate. | Kiln liest Google Play nicht, daher gibt es keine Schwierigkeitsschätzung. |  |  |
| `est.reason.rankVolatility` | Your rank moved {{meanMove}} places per check on average over {{checks}} checks. | Ihre Position hat sich im Schnitt um {{meanMove}} Plätze pro Prüfung bewegt, über {{checks}} Prüfungen. |  |  |
| `est.reason.resultsCrowding` | The search returned {{total}} apps out of up to {{limit}}. | Die Suche lieferte {{total}} Apps von höchstens {{limit}}. |  |  |
| `est.reason.resultsDemand` | The first {{apps}} results have {{ratings}} ratings together. | Die ersten {{apps}} Ergebnisse haben zusammen {{ratings}} Bewertungen. |  | rating = Bewertung |
| `est.reason.resultsEmpty` | The search returned no apps. | Die Suche lieferte keine Apps. |  |  |
| `est.reason.resultsStrength` | The first {{apps}} results have a median of {{medianRatings}} ratings. | Die ersten {{apps}} Ergebnisse haben im Median {{medianRatings}} Bewertungen. |  | rating = Bewertung |
| `est.reason.resultsTitleMatch` | {{matching}} of the first {{apps}} results have every word of the term in their name. | {{matching}} der ersten {{apps}} Ergebnisse haben alle Wörter des Begriffs im Namen. |  |  |
| `est.reason.tooFewResults` | Only {{apps}} results show a rating count, too few to estimate. | Nur {{apps}} Ergebnisse zeigen eine Bewertungszahl, zu wenig für eine Schätzung. |  | rating = Bewertung |
| `est.reason.unknown` | Another input of the estimate. | Eine weitere Eingabe der Schätzung. |  |  |
| `est.showDetails` | Why this estimate for {{term}} | Warum diese Schätzung für {{term}} |  |  |
| `est.sort.difficulty` | Easiest first | Leichteste zuerst |  |  |
| `est.sort.label` | Sort the estimates | Schätzungen sortieren |  |  |
| `est.sort.opportunity` | Opportunity first | Größte Chance zuerst |  |  |
| `est.sort.popularity` | Most popular first | Beliebteste zuerst |  |  |
| `est.sort.term` | Keyword A to Z | Keyword A bis Z |  |  |
| `est.suggest.failed` | The keyword could not be tracked. | Das Keyword konnte nicht verfolgt werden. |  |  |
| `est.suggest.from` | from {{terms}} | von {{terms}} |  |  |
| `est.suggest.lead` | Terms the App Store suggests for the keywords you track. Weigh them yourself: a suggestion does not promise traffic. | Begriffe, die der App Store zu den Keywords vorschlägt, die Sie verfolgen. Bewerten Sie sie selbst: Ein Vorschlag verspricht keinen Traffic. |  | track = Track (Play) / verfolgen (keyword) |
| `est.suggest.none` | No related terms yet. Check the keywords to read the App Store’s hints. | Noch keine verwandten Begriffe. Prüfen Sie die Keywords, um die Vorschläge des App Stores zu lesen. |  |  |
| `est.suggest.title` | Related terms | Verwandte Begriffe |  |  |
| `est.suggest.track` | Track | Verfolgen |  | track = Track (Play) / verfolgen (keyword) |
| `est.suggest.trackFor` | Track {{term}} | {{term}} verfolgen |  | track = Track (Play) / verfolgen (keyword) |
| `est.suggest.tracked` | Now tracking {{term}}. Check the keywords to read its estimate. | {{term}} wird jetzt verfolgt. Prüfen Sie die Keywords, um die Schätzung zu lesen. |  |  |
| `est.title` | Keyword estimates | Schätzungen für Keywords |  |  |
| `est.value` | {{score}} of 100, estimate | {{score}} von 100, Schätzung |  |  |
| `follow.adding` | Following… | Wird verfolgt … |  |  |
| `follow.badPackage` | That is not a package name. It looks like com.example.app, with at least two parts. | Das ist kein Paketname. Er sieht aus wie com.example.app, mit mindestens zwei Teilen. |  |  |
| `follow.count_one` | {{count}} app found | {{count}} App gefunden |  |  |
| `follow.count_other` | {{count}} apps found | {{count}} Apps gefunden |  |  |
| `follow.empty` | No apps found for “{{term}}” in {{country}}. Try another spelling or storefront, or paste the link or id. | Keine Apps für „{{term}}“ in {{country}} gefunden. Versuchen Sie eine andere Schreibweise oder einen anderen Store, oder fügen Sie den Link oder die ID ein. |  |  |
| `follow.emptyShort` | No apps found | Keine Apps gefunden |  |  |
| `follow.free` | Free | Kostenlos |  |  |
| `follow.hintAppStore` | Type at least 2 letters to search the App Store, or paste an apps.apple.com link or an id. | Geben Sie mindestens 2 Buchstaben ein, um im App Store zu suchen, oder fügen Sie einen apps.apple.com-Link oder eine ID ein. |  |  |
| `follow.hintPackage` | Google Play cannot be searched by name. Paste the package name (such as com.example.app) or the play.google.com address: the package is the text after id= in the address. | Google Play lässt sich nicht nach Namen durchsuchen. Fügen Sie den Paketnamen (etwa com.example.app) oder die play.google.com-Adresse ein: Das Paket ist der Text nach id= in der Adresse. |  |  |
| `follow.keys` | Use the arrow keys to move through the results, Enter to follow, Escape to close. | Mit den Pfeiltasten durch die Ergebnisse gehen, mit der Eingabetaste folgen, mit Esc schließen. |  |  |
| `follow.noRating` | No ratings | Keine Bewertungen |  | rating = Bewertung |
| `follow.offline` | The server cannot be reached. Check your connection and try again. | Der Server ist nicht erreichbar. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut. |  |  |
| `follow.packageLabel` | Package name or Play Store link | Paketname oder Play-Store-Link |  |  |
| `follow.ratings_one` | {{count}} rating | {{count}} Bewertung |  | rating = Bewertung |
| `follow.ratings_other` | {{count}} ratings | {{count}} Bewertungen |  | rating = Bewertung |
| `follow.resolvedId` | App Store id {{id}} ({{country}}) recognised. Following reads it once. | App-Store-ID {{id}} ({{country}}) erkannt. Beim Folgen wird sie einmal gelesen. |  |  |
| `follow.resolvedPackage` | Package {{id}} recognised. Following reads it once. | Paket {{id}} erkannt. Beim Folgen wird es einmal gelesen. |  |  |
| `follow.results` | Search results | Suchergebnisse |  |  |
| `follow.searchFailed` | The search did not work. Try again. | Die Suche hat nicht funktioniert. Versuchen Sie es erneut. |  |  |
| `follow.searchLabel` | Search by name, or paste a store link or id | Nach Namen suchen oder einen Store-Link oder eine ID einfügen |  |  |
| `follow.searching` | Searching the App Store… | Suche im App Store … |  |  |
| `follow.stateFollowed` | Already followed | Bereits verfolgt |  |  |
| `follow.stateOwn` | This is your app | Das ist Ihre App |  |  |
| `follow.wrongStoreApple` | That is an App Store link or id, but this app is on Google Play. Choose the matching store. | Das ist ein App-Store-Link oder eine App-Store-ID, diese App ist aber bei Google Play. Wählen Sie den passenden Store. |  |  |
| `follow.wrongStorePlay` | That is a Google Play link or package, but this app is on the App Store. Choose the matching store. | Das ist ein Google-Play-Link oder -Paket, diese App ist aber im App Store. Wählen Sie den passenden Store. |  |  |

## web/assets (80)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `device.unrecognised` | Device not recognised | Gerät nicht erkannt |  |  |
| `filter.noDevice` | No device | Kein Gerät |  |  |
| `lightbox.altNoDevice` | {{kind}} {{order}}, {{locale}}: {{name}} | {{kind}} {{order}}, {{locale}}: {{name}} |  |  |
| `store.add` | Add images | Bilder hinzufügen |  |  |
| `store.addTitle` | Add images | Bilder hinzufügen |  |  |
| `store.announceMoved` | Moved image {{from}} of {{set}} to place {{to}} (staged). | Bild {{from}} von {{set}} an Position {{to}} verschoben (vorgemerkt). |  | stage = vormerken / vorbereiten (nothing is sent) |
| `store.announceRemoved` | Removed image {{position}} of {{set}} (staged). | Bild {{position}} von {{set}} entfernt (vorgemerkt). |  | stage = vormerken / vorbereiten (nothing is sent) |
| `store.announceStaged` | Staged {{set}}. | {{set}} vorgemerkt. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `store.dragHint` | Drag to reorder | Zum Umsortieren ziehen |  |  |
| `store.editFailed` | The change could not be staged | Die Änderung konnte nicht vorgemerkt werden |  | stage = vormerken / vorbereiten (nothing is sent) |
| `store.emptyText` | Nothing is uploaded to the store page of this app, in any language. | Auf der Store-Seite dieser App ist in keiner Sprache etwas hochgeladen. |  |  |
| `store.emptyTitle` | The store has no graphics yet | Der Store hat noch keine Grafiken |  |  |
| `store.fullReason` | This set holds at most {{max}} images. | Dieser Satz enthält höchstens {{max}} Bilder. |  |  |
| `store.groupCount_one` | {{count}} image | {{count}} Bild |  |  |
| `store.groupCount_other` | {{count}} images | {{count}} Bilder |  |  |
| `store.imageAlt` | {{set}}, image {{position}} | {{set}}, Bild {{position}} |  |  |
| `store.images_one` | {{count}} image | {{count}} Bild |  |  |
| `store.images_other` | {{count}} images | {{count}} Bilder |  |  |
| `store.lockedReason` | The version in the store is live or in review, so its listing and graphics are locked. Create a new version to change them. | Die Version im Store ist live oder in Prüfung, daher sind Eintrag und Grafiken gesperrt. Legen Sie eine neue Version an, um sie zu ändern. |  | listing = Store-Eintrag; review: Rezension (user) vs Prüfung (App Review) |
| `store.moveEarlier` | Move image {{position}} earlier | Bild {{position}} nach vorn |  |  |
| `store.moveLater` | Move image {{position}} later | Bild {{position}} nach hinten |  |  |
| `store.noPreview` | No preview | Keine Vorschau |  |  |
| `store.notesImages` | Images | Bilder |  |  |
| `store.notesLabel` | Notes | Hinweise |  |  |
| `store.notesLine_one` | {{count}} note about the store graphics | {{count}} Hinweis zu den Store-Grafiken |  |  |
| `store.notesLine_other` | {{count}} notes about the store graphics | {{count}} Hinweise zu den Store-Grafiken |  |  |
| `store.open` | Open {{set}}, image {{position}} | {{set}}, Bild {{position}} öffnen |  |  |
| `store.problems_one` | {{count}} problem in the store graphics | {{count}} Problem bei den Store-Grafiken |  |  |
| `store.problems_other` | {{count}} problems in the store graphics | {{count}} Probleme bei den Store-Grafiken |  |  |
| `store.readFailed` | The store graphics could not be read | Die Store-Grafiken konnten nicht gelesen werden |  |  |
| `store.readFailedText` | The store did not answer. Check the store connection of this app and try again. | Der Store hat nicht geantwortet. Prüfe die Store-Verbindung dieser App und versuche es erneut. |  |  |
| `store.reading` | Reading the store graphics… | Store-Grafiken werden gelesen… |  |  |
| `store.refreshing` | Refreshing… | Wird aktualisiert … |  |  |
| `store.removeImage` | Remove image {{position}} | Bild {{position}} entfernen |  |  |
| `store.replace` | Replace image {{position}} | Bild {{position}} ersetzen |  |  |
| `store.replaceTitle` | Replace image {{position}} | Bild {{position}} ersetzen |  |  |
| `store.repoHidden_one` | The repository holds {{count}} graphic. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see it next to the store’s. | Das Repository enthält {{count}} Grafik. Aktiviere „Grafiken von Repository und Store vergleichen“ in den App-Einstellungen (Store-Eintrag), um sie neben der des Stores zu sehen. |  | listing = Store-Eintrag |
| `store.repoHidden_other` | The repository holds {{count}} graphics. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see them next to the store’s. | Das Repository enthält {{count}} Grafiken. Aktiviere „Grafiken von Repository und Store vergleichen“ in den App-Einstellungen (Store-Eintrag), um sie neben denen des Stores zu sehen. |  | listing = Store-Eintrag |
| `store.reread` | Read again | Erneut lesen |  |  |
| `store.rereadFailed` | The store graphics could not be read again. What is shown is from the last read. | Die Store-Grafiken konnten nicht erneut gelesen werden. Angezeigt wird der Stand der letzten Abfrage. |  |  |
| `store.ruleSourceShort` | Source of the rule | Quelle der Regel |  |  |
| `store.staged` | Staged | Vorgemerkt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `store.storeHolds_one` | The store holds {{count}} image now | Der Store enthält derzeit {{count}} Bild |  |  |
| `store.storeHolds_other` | The store holds {{count}} images now | Der Store enthält derzeit {{count}} Bilder |  |  |
| `store.title` | Store graphics | Store-Grafiken |  |  |
| `store.tools` | Actions for image {{position}} | Aktionen für Bild {{position}} |  |  |
| `store.unplaced_one` | {{count}} image has a size Kiln does not know and is not shown. | {{count}} Bild hat eine Größe, die Kiln nicht kennt, und wird nicht angezeigt. |  |  |
| `store.unplaced_other` | {{count}} images have a size Kiln does not know and are not shown. | {{count}} Bilder haben eine Größe, die Kiln nicht kennt, und werden nicht angezeigt. |  |  |
| `store.unreadCause` | The store gives no size for these images and Kiln could not read the first bytes of the files (the image host did not answer, or the address is not one Kiln may fetch), so their size and format were not checked. Nothing is known to be wrong with them. | Der Store nennt für diese Bilder keine Größe, und Kiln konnte die ersten Bytes der Dateien nicht lesen (der Bilderserver antwortete nicht, oder die Adresse darf Kiln nicht abrufen); Größe und Format wurden daher nicht geprüft. Es ist nichts Falsches bekannt. |  |  |
| `store.unreadLabel` | Not checked | Nicht geprüft |  |  |
| `store.unreadLine_one` | {{count}} image could not be checked | {{count}} Bild konnte nicht geprüft werden |  |  |
| `store.unreadLine_other` | {{count}} images could not be checked | {{count}} Bilder konnten nicht geprüft werden |  |  |
| `store.updatedAt` | Updated {{when}} | Aktualisiert {{when}} |  |  |
| `store.uploadHint` | Files are checked against the store’s rules (pixel size, format, file size, count) before they are staged. Nothing is sent to the store until you publish from the pending cart. | Dateien werden vor dem Vormerken gegen die Regeln des Stores geprüft (Pixelgröße, Format, Dateigröße, Anzahl). Nichts wird an den Store gesendet, bis Sie aus dem Warenkorb veröffentlichen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `tab.noMedia` | No graphics in the repository | Keine Grafiken im Repository |  |  |
| `viewer.actions` | Image actions | Bildaktionen |  |  |
| `viewer.alt` | {{set}} ({{locale}}), image {{position}} of {{total}} | {{set}} ({{locale}}), Bild {{position}} von {{total}} |  |  |
| `viewer.bytes` | File size | Dateigröße |  |  |
| `viewer.copied` | Image copied. | Bild kopiert. |  |  |
| `viewer.copy` | Copy image | Bild kopieren |  |  |
| `viewer.copyFallback` | This browser could not copy the image, so it was saved as a file instead. | Dieser Browser konnte das Bild nicht kopieren, es wurde stattdessen als Datei gespeichert. |  |  |
| `viewer.device` | Screen size | Bildschirmgröße |  |  |
| `viewer.editOff` | Editing is off: {{reason}} | Bearbeiten ist aus: {{reason}} |  |  |
| `viewer.fetchFailed` | The original image could not be fetched. Try again. | Das Originalbild konnte nicht abgerufen werden. Versuchen Sie es erneut. |  |  |
| `viewer.file` | File name | Dateiname |  |  |
| `viewer.index` | Place | Position |  |  |
| `viewer.indexValue` | {{position}} of {{total}} | {{position}} von {{total}} |  |  |
| `viewer.keys` | The left and right arrow keys step through the images | Mit den Pfeiltasten links und rechts wechseln Sie das Bild |  |  |
| `viewer.loadFailed` | The picture could not be loaded. | Das Bild konnte nicht geladen werden. |  |  |
| `viewer.locale` | Language | Sprache |  |  |
| `viewer.next` | Next | Weiter |  |  |
| `viewer.pixels` | Pixel size | Pixelgröße |  |  |
| `viewer.previous` | Previous | Zurück |  |  |
| `viewer.remove` | Remove | Entfernen |  |  |
| `viewer.replace` | Replace | Ersetzen |  |  |
| `viewer.save` | Save | Speichern |  |  |
| `viewer.saved` | Saved {{name}}. | {{name}} gespeichert. |  |  |
| `viewer.staged` | Staged | Vorgemerkt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `viewer.title` | Image | Bild |  |  |
| `viewer.unknown` | Unknown | Unbekannt |  |  |

## web/auth (1)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `stepUp.action.price` | Send price changes to a store | Preisänderungen an einen Store senden |  |  |

## web/builds (31)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `install.androidNew` | Android 8.0 and newer: when the phone asks, allow the app that opened the link (your browser) to install unknown apps. The switch is in Settings, Apps, Special app access, Install unknown apps, under that browser. | Android 8.0 und neuer: Erlauben Sie auf Nachfrage der App, die den Link geöffnet hat (Ihrem Browser), unbekannte Apps zu installieren. Die Einstellung finden Sie unter Einstellungen, Apps, Spezieller App-Zugriff, Unbekannte Apps installieren, bei diesem Browser. |  |  |
| `install.androidOld` | Android 7.1.1 and older: turn on Unknown sources in Settings, Security, then open the link again. | Android 7.1.1 und älter: Aktiviere Unbekannte Quellen unter Einstellungen, Sicherheit, und öffne den Link erneut. |  |  |
| `install.blocked.expired` | Expo has deleted the file of this build. | Expo hat die Datei dieses Builds gelöscht. |  |  |
| `install.blocked.failed` | This build did not finish, so there is nothing to install. | Dieser Build wurde nicht fertig, daher gibt es nichts zu installieren. |  |  |
| `install.blocked.noLink` | Expo gave no address for this build. | Expo hat für diesen Build keine Adresse geliefert. |  |  |
| `install.blocked.running` | This build has not finished yet. | Dieser Build ist noch nicht fertig. |  |  |
| `install.blocked.store` | A store build is sent to the store, not installed from a link. | Ein Store-Build geht an den Store und wird nicht über einen Link installiert. |  |  |
| `install.download` | Download build | Build herunterladen |  |  |
| `install.downloadKind` | Download build ({{kind}}) | Build herunterladen ({{kind}}) |  |  |
| `install.downloadNote` | A direct link to the file at Expo. It does not pass through Kiln. | Ein direkter Link zur Datei bei Expo. Er läuft nicht über Kiln. |  |  |
| `install.expires` | Expo keeps the build file until {{date}}. | Expo bewahrt die Build-Datei bis {{date}} auf. |  |  |
| `install.helpAndroid` | How to install on Android | So installieren Sie auf Android |  |  |
| `install.helpIos` | How to install on iPhone and iPad | So installieren Sie auf iPhone und iPad |  |  |
| `install.iosAdHoc` | An internal build only runs on devices registered for it: an ad hoc profile lists them by UDID, an enterprise profile needs no list. A new device needs a new build. | Ein interner Build läuft nur auf Geräten, die dafür registriert sind: Ein Ad-hoc-Profil listet sie per UDID auf, ein Enterprise-Profil braucht keine Liste. Für ein neues Gerät ist ein neuer Build nötig. |  |  |
| `install.iosDocs` | Expo: internal distribution | Expo: interne Verteilung |  |  |
| `install.iosTrust` | If the phone says the developer is not trusted, trust the profile in Settings, General, VPN and Device Management. | Meldet das Telefon, dass dem Entwickler nicht vertraut wird, vertraue dem Profil unter Einstellungen, Allgemein, VPN und Geräteverwaltung. |  |  |
| `install.leadAndroid` | Open the camera on the Android phone and point it at this code, then tap the link that appears. | Öffne die Kamera auf dem Android-Telefon, richte sie auf diesen Code und tippe auf den Link, der erscheint. |  |  |
| `install.leadIos` | Open the Camera app on the iPhone and point it at this code, then tap the notification that appears. | Öffne die Kamera-App auf dem iPhone, richte sie auf diesen Code und tippe auf die Mitteilung, die erscheint. |  |  |
| `install.leadNoCode` | The page of this build on Expo has the install link. Open it on the device. | Die Seite dieses Builds bei Expo enthält den Installationslink. Öffne sie auf dem Gerät. |  |  |
| `install.leadSimulator` | This is an iOS Simulator build. It does not install from a QR code: open it with Orbit, or download it and drop it on a running simulator. | Das ist ein Build für den iOS-Simulator. Er lässt sich nicht per QR-Code installieren: Öffne ihn mit Orbit oder lade ihn herunter und ziehe ihn auf einen laufenden Simulator. |  |  |
| `install.linkHint` | The same address as the code: open it on the device to install. | Dieselbe Adresse wie im Code: Öffne sie auf dem Gerät, um zu installieren. |  |  |
| `install.linkLabel` | Send a link to a device | Link an ein Gerät senden |  |  |
| `install.openExpo` | Open on Expo | Bei Expo öffnen |  |  |
| `install.orbit` | Open with Orbit | Mit Orbit öffnen |  |  |
| `install.orbitGet` | Get Expo Orbit | Expo Orbit holen |  |  |
| `install.orbitHint` | Nothing happened? Expo Orbit may not be installed. | Nichts passiert? Vielleicht ist Expo Orbit nicht installiert. |  |  |
| `install.orbitTip` | Needs Expo Orbit installed | Erfordert installiertes Expo Orbit |  |  |
| `install.qrLabel` | QR code for the install link | QR-Code für den Installationslink |  |  |
| `install.qrTooLong` | The link is too long for a QR code. Copy it below instead. | Der Link ist für einen QR-Code zu lang. Kopiere ihn stattdessen unten. |  |  |
| `install.title` | Install on a test device | Auf einem Testgerät installieren |  |  |
| `install.whyBlocked` | Why this cannot be installed | Warum sich das nicht installieren lässt |  |  |

## web/chat (162)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `action.delete` | Delete | Löschen |  |  |
| `action.deleteLabel` | Delete {{name}} | {{name}} löschen |  |  |
| `action.edit` | Edit | Bearbeiten |  |  |
| `action.editLabel` | Edit {{name}} | {{name}} bearbeiten |  |  |
| `action.log` | Deliveries | Zustellungen |  |  |
| `action.logLabel` | Deliveries to {{name}} | Zustellungen an {{name}} |  |  |
| `action.routing` | Routing | Routing |  |  |
| `action.routingLabel` | Routing rules of {{name}} | Routing-Regeln von {{name}} |  |  |
| `action.test` | Send test message | Testnachricht senden |  |  |
| `action.testLabel` | Send a test message to {{name}} | Testnachricht an {{name}} senden |  |  |
| `action.testing` | Sending… | Wird gesendet … |  |  |
| `card.anyHost` | Any host allowed | Beliebiger Host erlaubt |  |  |
| `card.digestDaily` | Daily summary at {{hour}} ({{zone}}) | Tägliche Zusammenfassung um {{hour}} ({{zone}}) |  |  |
| `card.digestOff` | Every alert is sent at once | Jede Warnung wird sofort gesendet |  |  |
| `card.endsIn` | Address ends in {{hint}} | Adresse endet auf {{hint}} |  |  |
| `card.language` | Messages in {{language}} | Nachrichten auf {{language}} |  |  |
| `card.lastDelivery` | Last message: {{status}}, {{when}} | Letzte Nachricht: {{status}}, {{when}} |  |  |
| `card.noDelivery` | Nothing sent yet | Noch nichts gesendet |  |  |
| `card.off` | Off | Inaktiv |  |  |
| `card.on` | On | Aktiv |  |  |
| `card.rulesOff` | off | inaktiv |  |  |
| `card.rules_one` | {{count}} rule | {{count}} Regel |  |  |
| `card.rules_other` | {{count}} rules | {{count}} Regeln |  |  |
| `delete.body` | Messages to {{name}} stop, and its routing and delivery log are removed. The channel itself is not touched. | Nachrichten an {{name}} werden eingestellt, und Routing sowie Zustellprotokoll werden entfernt. Der Kanal selbst bleibt unberührt. |  |  |
| `delete.title` | Delete this destination? | Dieses Ziel löschen? |  |  |
| `form.anyHost` | Allow a host other than Slack or Microsoft | Anderen Host als Slack oder Microsoft erlauben |  |  |
| `form.anyHostHint` | Only for your own gateway that forwards to Slack or Teams. Addresses inside your network are always refused. | Nur für Ihr eigenes Gateway, das an Slack oder Teams weiterleitet. Adressen im eigenen Netzwerk werden immer abgelehnt. |  |  |
| `form.create` | Add destination | Ziel hinzufügen |  |  |
| `form.creating` | Adding… | Wird hinzugefügt … |  |  |
| `form.defaultsNote` | A new destination starts with every critical alert and every release event. Change that under Routing. | Ein neues Ziel erhält zunächst alle kritischen Warnungen und alle Release-Ereignisse. Ändern Sie das unter Routing. |  | release = Release |
| `form.description` | One Slack or Microsoft Teams channel that receives Kiln messages. | Ein Slack- oder Microsoft-Teams-Kanal, der Kiln-Nachrichten empfängt. |  |  |
| `form.digest` | Daily summary | Tägliche Zusammenfassung |  |  |
| `form.digestDaily` | Daily: alerts below critical wait for the summary, critical ones are sent at once | Täglich: Warnungen unterhalb von kritisch warten auf die Zusammenfassung, kritische werden sofort gesendet |  |  |
| `form.digestHour` | Send the summary at | Zusammenfassung senden um |  |  |
| `form.digestOff` | Off: every alert is sent at once | Aus: Jede Warnung wird sofort gesendet |  |  |
| `form.enabled` | Send messages to this destination | Nachrichten an dieses Ziel senden |  |  |
| `form.errors.name` | Give the destination a name. | Geben Sie dem Ziel einen Namen. |  |  |
| `form.errors.nameLong` | Use at most 80 characters. | Verwenden Sie höchstens 80 Zeichen. |  |  |
| `form.errors.timezone` | Enter a time zone for the summary. | Geben Sie eine Zeitzone für die Zusammenfassung an. |  |  |
| `form.errors.url` | Paste the https webhook address from Slack or Teams. | Fügen Sie die https-Webhook-Adresse von Slack oder Teams ein. |  |  |
| `form.language` | Language of the messages | Sprache der Nachrichten |  |  |
| `form.languageHint` | Messages are written in this language, whatever language people use in Kiln. | Nachrichten werden in dieser Sprache verfasst, unabhängig von der Sprache, die in Kiln verwendet wird. |  |  |
| `form.name` | Name | Name |  |  |
| `form.nameHint` | Only shown here, for example “#releases”. | Wird nur hier angezeigt, zum Beispiel „#releases“. |  | release = Release |
| `form.provider` | Service | Dienst |  |  |
| `form.save` | Save changes | Änderungen speichern |  |  |
| `form.saving` | Saving… | Wird gespeichert … |  |  |
| `form.timezone` | Time zone | Zeitzone |  |  |
| `form.timezoneHint` | A time zone name such as Europe/Paris. | Ein Zeitzonenname wie Europe/Paris. |  |  |
| `form.titleEdit` | Edit the destination | Ziel bearbeiten |  |  |
| `form.titleNew` | New chat destination | Neues Chat-Ziel |  |  |
| `form.url` | Webhook address | Webhook-Adresse |  |  |
| `form.urlHint` | Secret. Paste it once: it is stored encrypted and never shown again. | Geheim. Fügen Sie sie einmal ein: Sie wird verschlüsselt gespeichert und nie wieder angezeigt. |  |  |
| `form.urlSaved` | The saved address ends in {{hint}}. Leave this empty to keep it, or paste a new one to replace it. | Die gespeicherte Adresse endet auf {{hint}}. Lassen Sie das Feld leer, um sie zu behalten, oder fügen Sie eine neue ein, um sie zu ersetzen. |  |  |
| `help.slack.step1` | Create a Slack app for your workspace at api.slack.com/apps (from scratch). | Erstellen Sie unter api.slack.com/apps eine Slack-App für Ihren Arbeitsbereich (von Grund auf). |  |  |
| `help.slack.step2` | In the app’s settings, turn on Incoming Webhooks. | Aktivieren Sie in den Einstellungen der App Incoming Webhooks. |  |  |
| `help.slack.step3` | Choose Add New Webhook to Workspace and pick the channel. | Wählen Sie Add New Webhook to Workspace und den Kanal aus. |  |  |
| `help.slack.step4` | Copy the webhook URL, which starts with https://hooks.slack.com/services/, and paste it here. | Kopieren Sie die Webhook-URL, die mit https://hooks.slack.com/services/ beginnt, und fügen Sie sie hier ein. |  |  |
| `help.teams.note` | Microsoft retired the old Office 365 connector webhooks, so a Teams destination needs a workflow. | Microsoft hat die alten Office-365-Connector-Webhooks eingestellt, daher braucht ein Teams-Ziel einen Workflow. |  |  |
| `help.teams.step1` | In Teams, open the Workflows app and create a workflow from the template that posts to a channel when a webhook request is received (it may be named “Send webhook alerts to a channel”). | Öffnen Sie in Teams die App Workflows und erstellen Sie einen Workflow aus der Vorlage, die bei einer Webhook-Anfrage in einen Kanal postet (sie kann „Send webhook alerts to a channel“ heißen). |  |  |
| `help.teams.step2` | Pick the team and channel where the messages should appear, and finish the setup. | Wählen Sie das Team und den Kanal, in dem die Nachrichten erscheinen sollen, und schließen Sie die Einrichtung ab. |  |  |
| `help.teams.step3` | Copy the HTTP URL that the workflow shows for its webhook trigger. | Kopieren Sie die HTTP-URL, die der Workflow für seinen Webhook-Trigger anzeigt. |  |  |
| `help.teams.step4` | Paste it here. It comes from powerplatform.com or logic.azure.com. | Fügen Sie sie hier ein. Sie stammt von powerplatform.com oder logic.azure.com. |  |  |
| `help.title` | Where do I get the address? | Wo finde ich die Adresse? |  |  |
| `kind.alert` | Alert | Warnung |  |  |
| `kind.digest` | Daily summary | Tägliche Zusammenfassung |  |  |
| `kind.test` | Test | Test |  |  |
| `log.answer` | Answer {{code}} | Antwort {{code}} |  |  |
| `log.attempts_one` | {{count}} attempt | {{count}} Versuch |  |  |
| `log.attempts_other` | {{count}} attempts | {{count}} Versuche |  |  |
| `log.caption` | Messages sent to this destination, newest first | An dieses Ziel gesendete Nachrichten, neueste zuerst |  |  |
| `log.close` | Close | Schließen |  |  |
| `log.colKind` | Kind | Art |  |  |
| `log.colResult` | Result | Ergebnis |  |  |
| `log.colStatus` | Status | Status |  |  |
| `log.colWhat` | About | Betrifft |  |  |
| `log.colWhen` | When | Wann |  |  |
| `log.empty` | Nothing was sent to this destination yet. | An dieses Ziel wurde noch nichts gesendet. |  |  |
| `log.loadFailed` | Could not load the deliveries. | Die Zustellungen konnten nicht geladen werden. |  |  |
| `log.loading` | Loading… | Wird geladen … |  |  |
| `log.refresh` | Refresh | Aktualisieren |  |  |
| `log.region` | Deliveries to {{name}} | Zustellungen an {{name}} |  |  |
| `log.title` | Deliveries | Zustellungen |  |  |
| `outcome.blockedAddress` | The address points inside a network or to an address that is never allowed, so nothing was sent. | Die Adresse zeigt in ein Netzwerk oder auf eine nie erlaubte Adresse, daher wurde nichts gesendet. |  |  |
| `outcome.digestSent` | Sent in the daily summary. | In der täglichen Zusammenfassung gesendet. |  |  |
| `outcome.disabled` | The destination is switched off, so nothing was sent. | Das Ziel ist ausgeschaltet, daher wurde nichts gesendet. |  |  |
| `outcome.dnsFailed` | The address could not be looked up. It will be tried again. | Die Adresse konnte nicht aufgelöst werden. Es wird erneut versucht. |  |  |
| `outcome.hostNotAllowed` | The address is not from Slack or Microsoft and the destination does not allow other hosts, so nothing was sent. | Die Adresse stammt weder von Slack noch von Microsoft und das Ziel erlaubt keine anderen Hosts, daher wurde nichts gesendet. |  |  |
| `outcome.inDigest` | Held for the daily summary. | Für die tägliche Zusammenfassung zurückgehalten. |  |  |
| `outcome.networkError` | The connection failed. It will be tried again. | Die Verbindung ist fehlgeschlagen. Es wird erneut versucht. |  |  |
| `outcome.ok` | Delivered. | Zugestellt. |  |  |
| `outcome.payloadRejected` | The service did not accept the message. Please report this. | Der Dienst hat die Nachricht nicht akzeptiert. Bitte melden Sie das. |  |  |
| `outcome.queued` | Waiting to be sent. | Wartet auf den Versand. |  |  |
| `outcome.rateLimited` | The service asked Kiln to slow down. It will be tried again after the wait it named. | Der Dienst hat Kiln gebeten, langsamer zu senden. Nach der genannten Wartezeit gibt es einen neuen Versuch. |  |  |
| `outcome.redirected` | The address redirects elsewhere, which Kiln does not follow. Paste the final address. | Die Adresse leitet weiter, was Kiln nicht folgt. Fügen Sie die endgültige Adresse ein. |  |  |
| `outcome.rejected` | The service refused the message. | Der Dienst hat die Nachricht abgelehnt. |  |  |
| `outcome.secretUnreadable` | The saved address could not be read. Paste it again. | Die gespeicherte Adresse konnte nicht gelesen werden. Fügen Sie sie erneut ein. |  |  |
| `outcome.serverError` | The service had a problem. It will be tried again. | Beim Dienst ist ein Problem aufgetreten. Es wird erneut versucht. |  |  |
| `outcome.timeout` | The service did not answer in time. It will be tried again. | Der Dienst hat nicht rechtzeitig geantwortet. Es wird erneut versucht. |  |  |
| `outcome.unknown` | Unknown result. | Unbekanntes Ergebnis. |  |  |
| `outcome.webhookGone` | The webhook no longer exists. Create a new one and paste its address here. | Der Webhook existiert nicht mehr. Erstellen Sie einen neuen und fügen Sie seine Adresse hier ein. |  |  |
| `outcome.webhookRejected` | The service refused the webhook. It may have been disabled or restricted; check it in Slack or Teams. | Der Dienst hat den Webhook abgelehnt. Er wurde möglicherweise deaktiviert oder eingeschränkt; prüfen Sie ihn in Slack oder Teams. |  |  |
| `page.deleteFailed` | Could not delete the destination. | Das Ziel konnte nicht gelöscht werden. |  |  |
| `page.deleted` | Deleted {{name}}. | {{name}} wurde gelöscht. |  |  |
| `page.description` | Send alerts, release events and a daily summary to a Slack or Microsoft Teams channel. | Senden Sie Warnungen, Release-Ereignisse und eine tägliche Zusammenfassung an einen Slack- oder Microsoft-Teams-Kanal. |  | release = Release |
| `page.emptyText` | Add a Slack or Teams channel to hear about rejections, releases and credential problems where your team already talks. | Fügen Sie einen Slack- oder Teams-Kanal hinzu, um von Ablehnungen, Releases und Problemen mit Zugangsdaten dort zu erfahren, wo Ihr Team ohnehin spricht. |  | release = Release |
| `page.emptyTitle` | No chat destination yet | Noch kein Chat-Ziel |  |  |
| `page.footer` | A message is retried a few times, then marked failed. The webhook address is secret: it is stored encrypted and never shown again. | Eine Nachricht wird mehrmals erneut versucht und dann als fehlgeschlagen markiert. Die Webhook-Adresse ist geheim: Sie wird verschlüsselt gespeichert und nie wieder angezeigt. |  |  |
| `page.loadFailed` | Could not load the chat destinations. | Die Chat-Ziele konnten nicht geladen werden. |  |  |
| `page.loading` | Loading… | Wird geladen … |  |  |
| `page.new` | New destination | Neues Ziel |  |  |
| `page.noRead` | Your role does not include chat integrations. Owners and admins manage them. | Ihre Rolle umfasst keine Chat-Integrationen. Inhaber und Administratoren verwalten sie. |  |  |
| `page.routesSaved` | Saved the routing of {{name}}. | Das Routing von {{name}} wurde gespeichert. |  |  |
| `page.saved` | Saved {{name}}. | {{name}} wurde gespeichert. |  |  |
| `page.testFailed` | Could not send the test message. | Die Testnachricht konnte nicht gesendet werden. |  |  |
| `page.title` | Chat | Chat |  |  |
| `routes.add` | Add a rule | Regel hinzufügen |  |  |
| `routes.allApps` | All apps | Alle Apps |  |  |
| `routes.allAppsLabel` | All apps | Alle Apps |  |  |
| `routes.allPlatforms` | All platforms | Alle Plattformen |  |  |
| `routes.allPlatformsLabel` | All platforms | Alle Plattformen |  |  |
| `routes.allTypes` | All alert types | Alle Warnungstypen |  |  |
| `routes.allTypesLabel` | All alert types | Alle Warnungstypen |  |  |
| `routes.apps` | Apps | Apps |  |  |
| `routes.caption` | Routing rules | Routing-Regeln |  |  |
| `routes.col.apps` | Apps | Apps |  |  |
| `routes.col.platforms` | Platforms | Plattformen |  |  |
| `routes.col.severity` | From | Ab |  |  |
| `routes.col.types` | Alerts | Warnungen |  |  |
| `routes.defaults` | Use the defaults | Standardwerte verwenden |  |  |
| `routes.description` | Which alerts go to {{name}}. An alert is sent when any rule takes it. | Welche Warnungen an {{name}} gehen. Eine Warnung wird gesendet, sobald eine Regel sie aufnimmt. |  |  |
| `routes.enabled` | This rule is on | Diese Regel ist aktiv |  |  |
| `routes.errors.noTypes` | Choose at least one alert type, or choose all of them. | Wählen Sie mindestens einen Warnungstyp oder wählen Sie alle. |  |  |
| `routes.errors.saveFailed` | Could not save the routing. | Das Routing konnte nicht gespeichert werden. |  |  |
| `routes.from.critical` | Critical only | Nur kritisch |  |  |
| `routes.from.info` | Everything (info and above) | Alles (Information und höher) |  |  |
| `routes.from.warning` | Needs attention and critical | Erfordert Aufmerksamkeit und kritisch |  |  |
| `routes.minSeverity` | From severity | Ab Schweregrad |  |  |
| `routes.noRules` | With no rule, nothing is sent to this destination. | Ohne Regel wird nichts an dieses Ziel gesendet. |  |  |
| `routes.platforms` | Platforms | Plattformen |  |  |
| `routes.remove` | Remove rule | Regel entfernen |  |  |
| `routes.removeLabel` | Remove rule {{n}} | Regel {{n}} entfernen |  |  |
| `routes.rule` | Rule {{n}} | Regel {{n}} |  |  |
| `routes.save` | Save routing | Routing speichern |  |  |
| `routes.saving` | Saving… | Wird gespeichert … |  |  |
| `routes.someTypes_one` | {{count}} alert type | {{count}} Warnungstyp |  |  |
| `routes.someTypes_other` | {{count}} alert types | {{count}} Warnungstypen |  |  |
| `routes.title` | Routing | Routing |  |  |
| `routes.types` | Alert types | Warnungstypen |  |  |
| `severity.critical` | Critical | Kritisch |  |  |
| `severity.info` | Info | Information |  |  |
| `severity.warning` | Needs attention | Erfordert Aufmerksamkeit |  |  |
| `status.deferred` | Waiting for the summary | Wartet auf die Zusammenfassung |  |  |
| `status.failed` | Failed | Fehlgeschlagen |  |  |
| `status.queued` | Queued | In Warteschlange |  |  |
| `status.retrying` | Retrying | Neuer Versuch |  |  |
| `status.sent` | Sent | Gesendet |  |  |
| `status.skipped` | Skipped | Übersprungen |  |  |
| `test.failed` | The test message did not arrive: {{reason}} | Die Testnachricht ist nicht angekommen: {{reason}} |  |  |
| `test.noResult` | No result yet. Open the deliveries to follow it. | Noch kein Ergebnis. Öffnen Sie die Zustellungen, um es zu verfolgen. |  |  |
| `test.sent` | The test message was delivered. Look in the channel. | Die Testnachricht wurde zugestellt. Schauen Sie im Kanal nach. |  |  |
| `test.waiting` | Sending the test message… | Testnachricht wird gesendet … |  |  |

## web/connect (71)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `banner.button` | Connect your apps | Apps verbinden |  |  |
| `banner.expo.next_one` | Your Expo token “{{label}}” is saved. {{count}} app is not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the project from app.json where it can; nothing is saved until you confirm. | Ihr Expo-Token „{{label}}“ ist gespeichert. {{count}} App ist noch mit keinem Expo-Projekt verknüpft, daher zeigt Builds keine EAS-Builds. Kiln liest das Projekt aus der app.json, wo es kann; gespeichert wird erst nach Ihrer Bestätigung. |  |  |
| `banner.expo.next_other` | Your Expo token “{{label}}” is saved. {{count}} apps are not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the projects from app.json where it can; nothing is saved until you confirm. | Ihr Expo-Token „{{label}}“ ist gespeichert. {{count}} Apps sind noch mit keinem Expo-Projekt verknüpft, daher zeigt Builds keine EAS-Builds. Kiln liest die Projekte aus der app.json, wo es kann; gespeichert wird erst nach Ihrer Bestätigung. |  |  |
| `banner.expo.text_one` | You have an Expo token (“{{label}}”), but {{count}} app is not linked to an Expo project yet. Link it to see its EAS builds, submissions and workflows. | Sie haben ein Expo-Token („{{label}}“), aber {{count}} App ist noch mit keinem Expo-Projekt verknüpft. Verknüpfen Sie sie, um ihre EAS-Builds, Einreichungen und Workflows zu sehen. |  | submit = einreichen / senden |
| `banner.expo.text_other` | You have an Expo token (“{{label}}”), but {{count}} apps are not linked to an Expo project yet. Link them to see their EAS builds, submissions and workflows. | Sie haben ein Expo-Token („{{label}}“), aber {{count}} Apps sind noch mit keinem Expo-Projekt verknüpft. Verknüpfen Sie sie, um ihre EAS-Builds, Einreichungen und Workflows zu sehen. |  | submit = einreichen / senden |
| `banner.expo.title` | Connect your apps to Expo | Apps mit Expo verbinden |  |  |
| `banner.rc.next_one` | Your RevenueCat key “{{label}}” is saved. {{count}} app is not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Ihr RevenueCat-Key „{{label}}“ ist gespeichert. {{count}} App ist noch mit keinem RevenueCat-Projekt verknüpft, daher zeigt Produkte nichts aus RevenueCat. Kiln schlägt die Zuordnungen vor; gespeichert wird erst nach Ihrer Bestätigung. |  |  |
| `banner.rc.next_other` | Your RevenueCat key “{{label}}” is saved. {{count}} apps are not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Ihr RevenueCat-Key „{{label}}“ ist gespeichert. {{count}} Apps sind noch mit keinem RevenueCat-Projekt verknüpft, daher zeigt Produkte nichts aus RevenueCat. Kiln schlägt die Zuordnungen vor; gespeichert wird erst nach Ihrer Bestätigung. |  |  |
| `banner.rc.text_one` | You have a RevenueCat key (“{{label}}”), but {{count}} app is not linked to RevenueCat yet. Link it to see which products RevenueCat sells, with their entitlements and offerings. | Sie haben einen RevenueCat-Key („{{label}}“), aber {{count}} App ist noch nicht mit RevenueCat verknüpft. Verknüpfen Sie sie, um zu sehen, welche Produkte RevenueCat verkauft, samt Entitlements und Offerings. |  |  |
| `banner.rc.text_other` | You have a RevenueCat key (“{{label}}”), but {{count}} apps are not linked to RevenueCat yet. Link them to see which products RevenueCat sells, with their entitlements and offerings. | Sie haben einen RevenueCat-Key („{{label}}“), aber {{count}} Apps sind noch nicht mit RevenueCat verknüpft. Verknüpfen Sie sie, um zu sehen, welche Produkte RevenueCat verkauft, samt Entitlements und Offerings. |  |  |
| `banner.rc.title` | Connect your apps to RevenueCat | Apps mit RevenueCat verbinden |  |  |
| `callout.addKey` | Add a key in Credentials | Key unter Zugangsdaten hinzufügen |  |  |
| `callout.expo.button` | Connect to Expo | Mit Expo verbinden |  |  |
| `callout.expo.title` | This app is not connected to Expo | Diese App ist nicht mit Expo verbunden |  |  |
| `callout.rc.button` | Connect to RevenueCat | Mit RevenueCat verbinden |  |  |
| `callout.rc.title` | This app is not connected to RevenueCat | Diese App ist nicht mit RevenueCat verbunden |  |  |
| `dialog.addKey` | Open Credentials | Zugangsdaten öffnen |  |  |
| `dialog.askAdmin` | Only an owner or an admin can link apps. Ask one of them to connect them. | Nur Eigentümer oder Administratoren können Apps verknüpfen. Bitten Sie eine dieser Personen, sie zu verbinden. |  |  |
| `dialog.confirm_one` | Link {{count}} app | {{count}} App verknüpfen |  |  |
| `dialog.confirm_other` | Link {{count}} apps | {{count}} Apps verknüpfen |  |  |
| `dialog.description` | Review the matches Kiln found. Nothing is saved until you confirm. | Prüfen Sie die Zuordnungen, die Kiln gefunden hat. Gespeichert wird erst nach Ihrer Bestätigung. |  | review: Rezension (user) vs Prüfung (App Review) |
| `dialog.expoHelp` | The project id is in app.json under extra.eas.projectId (running “eas init” adds it); you can also enter @account/slug. Kiln cannot list the projects your token sees. | Die Projekt-ID steht in der app.json unter extra.eas.projectId („eas init“ trägt sie ein); Sie können auch @konto/slug eingeben. Kiln kann die Projekte, die Ihr Token sieht, nicht auflisten. |  |  |
| `dialog.keyHint` | The key is only used to read. Nothing is changed. | Der Key wird nur zum Lesen verwendet. Es wird nichts geändert. |  |  |
| `dialog.keyLabel.expo` | Expo token | Expo-Token |  |  |
| `dialog.keyLabel.rc` | RevenueCat key | RevenueCat-Key |  |  |
| `dialog.lookUp` | Look up | Abfragen |  |  |
| `dialog.noKey.expo` | No Expo token is saved yet. Add an Expo access token first. | Es ist noch kein Expo-Token gespeichert. Fügen Sie zuerst ein Expo-Zugriffstoken hinzu. |  |  |
| `dialog.noKey.rc` | No RevenueCat key is saved yet. Add a RevenueCat secret key first. | Es ist noch kein RevenueCat-Key gespeichert. Fügen Sie zuerst einen RevenueCat-Secret-Key hinzu. |  |  |
| `dialog.nothingToDo` | Every app that {{name}} can serve is already linked. | Alle Apps, die {{name}} bedienen kann, sind bereits verknüpft. |  |  |
| `dialog.readingExpo` | Reading app.json of the linked repositories… | app.json der verknüpften Repositorys wird gelesen … |  |  |
| `dialog.readingRc` | Reading your RevenueCat projects and apps… | Ihre RevenueCat-Projekte und -Apps werden gelesen … |  |  |
| `dialog.reviewExpo` | Kiln read the Expo project id from app.json of each linked repository. Tick the apps to link, or type the project of an app yourself. | Kiln hat die Expo-Projekt-ID aus der app.json jedes verknüpften Repositorys gelesen. Haken Sie die Apps an, die verknüpft werden sollen, oder geben Sie das Projekt einer App selbst ein. |  |  |
| `dialog.reviewRc` | Kiln matched each app to a RevenueCat app by its bundle id or package name and its store. Tick the apps to link. Where several RevenueCat apps fit, choose one: Kiln never guesses. | Kiln hat jede App einer RevenueCat-App zugeordnet, anhand von Bundle-ID oder Paketname und Store. Haken Sie die Apps an, die verknüpft werden sollen. Passen mehrere RevenueCat-Apps, wählen Sie eine aus: Kiln rät nie. |  |  |
| `dialog.safeExpo` | Confirming only saves the link in Kiln. Expo is never changed. | Die Bestätigung speichert nur die Verknüpfung in Kiln. Expo wird nie verändert. |  |  |
| `dialog.safeRc` | Confirming only saves the link in Kiln. RevenueCat is never changed. | Die Bestätigung speichert nur die Verknüpfung in Kiln. RevenueCat wird nie verändert. |  |  |
| `dialog.saving` | Saving the links… | Verknüpfungen werden gespeichert … |  |  |
| `dialog.title` | Connect your apps to {{name}} | Apps mit {{name}} verbinden |  |  |
| `done.expo.appears` | Builds of each linked app now shows its EAS builds and submissions, and Settings offers EAS Workflows. | Builds jeder verknüpften App zeigt jetzt ihre EAS-Builds und Einreichungen, und die Einstellungen bieten EAS Workflows. |  | submit = einreichen / senden |
| `done.expo.empty` | The lists stay empty until Expo has been read for the first time (“Read Expo now”, or Read again on Builds), and for as long as the project has no build. | Die Listen bleiben leer, bis Expo zum ersten Mal gelesen wurde („Expo jetzt lesen“ oder Erneut lesen unter Builds), und solange das Projekt keinen Build hat. |  |  |
| `done.failedRow` | Not linked: {{problem}} | Nicht verknüpft: {{problem}} |  |  |
| `done.linkedRow` | Linked. | Verknüpft. |  |  |
| `done.openBuilds` | Open Builds | Builds öffnen |  |  |
| `done.openProducts` | Open Products | Produkte öffnen |  |  |
| `done.rc.appears` | Products of each linked app now has a RevenueCat column, with the entitlements and offerings that use each product, and the figures strip. | Produkte jeder verknüpften App zeigt jetzt eine RevenueCat-Spalte mit den Entitlements und Offerings, die jedes Produkt verwenden, sowie die Kennzahlenleiste. |  |  |
| `done.rc.empty` | They stay empty until the first sync: it is pending. Kiln has only saved the link; RevenueCat is read by “Sync products”. | Sie bleiben leer bis zur ersten Synchronisierung: Sie steht noch aus. Kiln hat nur die Verknüpfung gespeichert; RevenueCat wird mit „Produkte synchronisieren“ gelesen. |  |  |
| `done.read.ok` | Read. | Gelesen. |  |  |
| `done.readExpo` | Read Expo now | Expo jetzt lesen |  |  |
| `done.syncProducts` | Sync products | Produkte synchronisieren |  |  |
| `done.title_one` | {{count}} app linked to {{name}} | {{count}} App mit {{name}} verknüpft |  |  |
| `done.title_other` | {{count}} apps linked to {{name}} | {{count}} Apps mit {{name}} verknüpft |  |  |
| `missing.expo.keyFound` | Kiln has your Expo token “{{label}}”, but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Link it in one step; nothing is changed in Expo. | Kiln hat Ihr Expo-Token „{{label}}“, aber diese App ist mit keinem Expo-Projekt verknüpft, daher zeigt Builds keine EAS-Builds oder Einreichungen. Verknüpfen Sie sie in einem Schritt; in Expo wird nichts verändert. |  | submit = einreichen / senden |
| `missing.expo.keyFoundAsk` | Kiln has an Expo token (“{{label}}”), but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Ask an owner or an admin to link it. | Kiln hat ein Expo-Token („{{label}}“), aber diese App ist mit keinem Expo-Projekt verknüpft, daher zeigt Builds keine EAS-Builds oder Einreichungen. Bitten Sie einen Eigentümer oder Administrator, sie zu verknüpfen. |  | submit = einreichen / senden |
| `missing.expo.noKey` | No Expo token is saved yet, and this app is not linked to an Expo project. Add an Expo access token in Credentials first, then link the app. | Es ist noch kein Expo-Token gespeichert, und diese App ist mit keinem Expo-Projekt verknüpft. Fügen Sie zuerst unter Zugangsdaten ein Expo-Zugriffstoken hinzu und verknüpfen Sie dann die App. |  |  |
| `missing.expo.unknown` | This app is not linked to an Expo project, so Builds shows no EAS builds. An Expo token and the link are needed; an owner or an admin can set them up. | Diese App ist mit keinem Expo-Projekt verknüpft, daher zeigt Builds keine EAS-Builds. Es braucht ein Expo-Token und die Verknüpfung; ein Eigentümer oder Administrator kann beides einrichten. |  |  |
| `missing.rc.keyFound` | Kiln has your RevenueCat key “{{label}}”, but this app is not linked to a RevenueCat project, so the RevenueCat column, entitlements and offerings stay empty. Link it in one step; nothing is changed in RevenueCat. | Kiln hat Ihren RevenueCat-Key „{{label}}“, aber diese App ist mit keinem RevenueCat-Projekt verknüpft, daher bleiben die RevenueCat-Spalte, Entitlements und Offerings leer. Verknüpfen Sie sie in einem Schritt; in RevenueCat wird nichts verändert. |  |  |
| `missing.rc.keyFoundAsk` | Kiln has a RevenueCat key (“{{label}}”), but this app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. Ask an owner or an admin to link it. | Kiln hat einen RevenueCat-Key („{{label}}“), aber diese App ist mit keinem RevenueCat-Projekt verknüpft, daher wird nichts aus RevenueCat gezeigt. Bitten Sie einen Eigentümer oder Administrator, sie zu verknüpfen. |  |  |
| `missing.rc.noKey` | No RevenueCat key is saved yet, and this app is not linked to a RevenueCat project. Add a RevenueCat secret key in Credentials first, then link the app. | Es ist noch kein RevenueCat-Key gespeichert, und diese App ist mit keinem RevenueCat-Projekt verknüpft. Fügen Sie zuerst unter Zugangsdaten einen RevenueCat-Secret-Key hinzu und verknüpfen Sie dann die App. |  |  |
| `missing.rc.unknown` | This app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. A RevenueCat key and the link are needed; an owner or an admin can set them up. | Diese App ist mit keinem RevenueCat-Projekt verknüpft, daher wird nichts aus RevenueCat gezeigt. Es braucht einen RevenueCat-Key und die Verknüpfung; ein Eigentümer oder Administrator kann beides einrichten. |  |  |
| `rc.choiceInProject` | {{project}}: {{choice}} | {{project}}: {{choice}} |  |  |
| `row.checkAria` | Link {{name}} | {{name}} verknüpfen |  |  |
| `row.expo.inputAria` | Expo project of {{name}} | Expo-Projekt von {{name}} |  |  |
| `row.expo.none` | No project found. Type its id or @account/slug. | Kein Projekt gefunden. Geben Sie seine ID oder @konto/slug ein. |  |  |
| `row.expo.placeholder` | Project id or @account/slug | Projekt-ID oder @konto/slug |  |  |
| `row.expo.proposed` | Project read from app.json. | Projekt aus der app.json gelesen. |  |  |
| `row.linked` | Already linked | Bereits verknüpft |  |  |
| `row.rc.ambiguous` | Several RevenueCat apps fit. Choose one. | Mehrere RevenueCat-Apps passen. Wählen Sie eine aus. |  |  |
| `row.rc.choose` | Choose a RevenueCat app | RevenueCat-App wählen |  |  |
| `row.rc.none` | No match by identifier. Choose a RevenueCat app, or leave the app unlinked. | Keine Übereinstimmung bei der Kennung. Wählen Sie eine RevenueCat-App oder lassen Sie die App unverknüpft. |  |  |
| `row.rc.nothing` | No RevenueCat app of this store was found with this key. | Mit diesem Key wurde keine RevenueCat-App dieses Stores gefunden. |  |  |
| `row.rc.proposed` | Match found: the bundle id or package name and the store agree. | Übereinstimmung gefunden: Bundle-ID oder Paketname und Store passen zusammen. |  |  |
| `row.rc.selectAria` | RevenueCat app for {{name}} | RevenueCat-App für {{name}} |  |  |

## web/credentials (21)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `identifier.appId` | App ID | App-ID |  |  |
| `identifier.clientEmail` | Service account | Dienstkonto |  |  |
| `identifier.clientId` | Client ID | Client-ID |  |  |
| `identifier.copy` | Copy {{label}} | {{label}} kopieren |  |  |
| `identifier.hide` | Hide identifiers | Kennungen ausblenden |  |  |
| `identifier.hideAria` | Hide the identifiers of {{label}} | Kennungen von {{label}} ausblenden |  |  |
| `identifier.installationId` | Installation ID | Installations-ID |  |  |
| `identifier.none` | No identifiers to show for this type of credential. | Für diesen Zugangstyp gibt es keine Kennungen zum Anzeigen. |  |  |
| `identifier.projectId` | Project ID | Projekt-ID |  |  |
| `identifier.region` | Region | Region |  |  |
| `identifier.serviceKeyId` | Private key ID | ID des privaten Schlüssels |  |  |
| `identifier.show` | Show identifiers | Kennungen anzeigen |  |  |
| `identifier.showAria` | Show the identifiers of {{label}} | Kennungen von {{label}} anzeigen |  |  |
| `identifier.title` | Identifiers (not secret) | Kennungen (nicht geheim) |  |  |
| `identifier.tokenKind.classic` | Personal access token (classic) | Persönliches Zugriffstoken (klassisch) |  |  |
| `identifier.tokenKind.fineGrained` | Fine-grained personal access token | Fein abgestuftes persönliches Zugriffstoken |  |  |
| `identifier.tokenKind.installation` | GitHub App installation token | Installations-Token einer GitHub App |  |  |
| `identifier.tokenKind.oauth` | OAuth token | OAuth-Token |  |  |
| `identifier.tokenKind.userToServer` | GitHub App user token | Benutzer-Token einer GitHub App |  |  |
| `identifier.tokenType` | Token type | Token-Typ |  |  |
| `table.rotatedAgo` | Secret replaced {{when}} | Geheimnis ersetzt {{when}} |  |  |

## web/eas (40)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `overview.aria` | Expo builds and submissions | Expo-Builds und -Einreichungen |  | submit = einreichen / senden |
| `overview.latestBuild` | Latest build | Letzter Build |  |  |
| `overview.latestSubmission` | Latest submission | Letzte Einreichung |  | submit = einreichen / senden |
| `overview.link` | Link it to Expo | Mit Expo verknüpfen |  |  |
| `overview.loading` | Reading the stored builds… | Gespeicherte Builds werden gelesen … |  |  |
| `overview.noBuild` | No build yet | Noch kein Build |  |  |
| `overview.noBuilds` | No EAS build or submission is stored yet. They appear after the first build or the next refresh. | Noch kein EAS-Build und keine Einreichung gespeichert. Sie erscheinen nach dem ersten Build oder der nächsten Aktualisierung. |  | submit = einreichen / senden |
| `overview.noSubmission` | No submission yet | Noch keine Einreichung |  | submit = einreichen / senden |
| `overview.notLinked` | Not linked to an Expo project yet, so no builds or submissions show here. | Noch nicht mit einem Expo-Projekt verknüpft, daher erscheinen hier keine Builds oder Einreichungen. |  | submit = einreichen / senden |
| `overview.openBuilds` | Open Builds | Builds öffnen |  |  |
| `overview.ota.branch` | Branch {{branch}} | Branch {{branch}} |  |  |
| `overview.ota.empty` | No update is stored for this platform. | Für diese Plattform ist kein Update gespeichert. |  |  |
| `overview.ota.failedNever` | The updates could not be read. | Die Updates konnten nicht gelesen werden. |  |  |
| `overview.ota.never` | The updates have not been read yet. Read again from Builds. | Die Updates wurden noch nicht gelesen. Lesen Sie sie unter Builds erneut. |  |  |
| `overview.ota.openBuilds` | EAS updates in Builds | EAS-Updates in Builds |  |  |
| `overview.ota.openExpo` | Open at Expo | Bei Expo öffnen |  |  |
| `overview.ota.rollout` | {{percentage}}% rollout | Rollout bei {{percentage}} % |  | rollout = Einführung |
| `overview.ota.title` | Current update per channel | Aktuelles Update je Kanal |  |  |
| `overview.ota.updated` | Updated {{when}}. | Aktualisiert {{when}}. |  |  |
| `overview.ota.updatedFailed` | The last read failed. Showing what was stored {{when}}. | Das letzte Lesen ist fehlgeschlagen. Gespeicherter Stand {{when}}. |  |  |
| `overview.unavailable` | The stored {{platform}} builds could not be read. | Die gespeicherten {{platform}}-Builds konnten nicht gelesen werden. |  |  |
| `releaseSteps.built.current` | Build running | Build läuft |  |  |
| `releaseSteps.built.done` | Build finished | Build abgeschlossen |  |  |
| `releaseSteps.built.failed` | Build failed or cancelled | Build fehlgeschlagen oder abgebrochen |  |  |
| `releaseSteps.ota.channel` | channel {{channel}} | Kanal {{channel}} |  |  |
| `releaseSteps.ota.open` | Open at Expo | Bei Expo öffnen |  |  |
| `releaseSteps.ota.published` | OTA update published | OTA-Update veröffentlicht |  |  |
| `releaseSteps.review.current` | In store review | In der Store-Prüfung |  | review: Rezension (user) vs Prüfung (App Review) |
| `releaseSteps.review.done` | Store review passed | Store-Prüfung bestanden |  | review: Rezension (user) vs Prüfung (App Review) |
| `releaseSteps.review.failed` | Rejected in store review | In der Store-Prüfung abgelehnt |  | review: Rezension (user) vs Prüfung (App Review) |
| `releaseSteps.review.todo` | Store review not started | Store-Prüfung noch nicht begonnen |  | review: Rezension (user) vs Prüfung (App Review) |
| `releaseSteps.submitted.current` | Submitting to the store | Übermittlung an den Store läuft |  | submit = einreichen / senden |
| `releaseSteps.submitted.done` | Submitted to the store | An den Store übermittelt |  | submit = einreichen / senden |
| `releaseSteps.submitted.failed` | Submission failed or cancelled | Einreichung fehlgeschlagen oder abgebrochen |  | submit = einreichen / senden |
| `releaseSteps.submitted.todo` | Not submitted through EAS | Nicht über EAS eingereicht |  | submit = einreichen / senden |
| `releaseSteps.title` | Build and submission (Expo EAS) | Build und Einreichung (Expo EAS) |  | submit = einreichen / senden |
| `submissions.none` | EAS has not sent a build of this app to a store yet. | EAS hat noch keinen Build dieser App an einen Store gesendet. |  |  |
| `submissions.noneTitle` | No submissions yet | Noch keine Einreichungen |  | submit = einreichen / senden |
| `submissions.notLinked` | Link this app to an Expo project to see the builds it sent to the stores. | Verknüpfe diese App mit einem Expo-Projekt, um die an die Stores gesendeten Builds zu sehen. |  |  |
| `submissions.notLinkedTitle` | Not linked to Expo | Nicht mit Expo verknüpft |  |  |

## web/errors (79)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `ads.accountMissing` | That ad account is not one the key can read. Choose one from the list. | Dieses Werbekonto kann der Schlüssel nicht lesen. Wählen Sie eines aus der Liste. |  |  |
| `ads.adamRequired` | Enter the Apple id of the app (the number in its App Store address, after id). It is the app's store id, which this record does not have yet. | Geben Sie die Apple-ID der App ein (die Zahl in ihrer App-Store-Adresse nach id). Es ist die Store-ID der App, die dieser Eintrag noch nicht hat. |  |  |
| `ads.auth` | Apple did not accept the key. Check that the public key of this private key is saved in Apple Ads (Account Settings, API) and that the client ID, team ID and key ID are the ones Apple Ads showed after saving it. | Apple hat den Schlüssel nicht akzeptiert. Prüfen Sie, dass der öffentliche Schlüssel dieses privaten Schlüssels in Apple Ads gespeichert ist (Kontoeinstellungen, API) und dass Client-ID, Team-ID und Schlüssel-ID die sind, die Apple Ads nach dem Speichern angezeigt hat. |  |  |
| `ads.forbidden` | Apple Ads accepted the key, but this user may not read the ad account. Give the API user a role with read access, such as API Account Read Only, in Apple Ads. | Apple Ads hat den Schlüssel akzeptiert, aber dieser Benutzer darf das Werbekonto nicht lesen. Geben Sie dem API-Benutzer in Apple Ads eine Rolle mit Lesezugriff, etwa API Account Read Only. |  |  |
| `ads.invalidInput` | That is not a valid Apple Ads request. | Das ist keine gültige Apple-Ads-Anfrage. |  |  |
| `ads.invalidKey` | The private key could not be read. Paste the whole private-key.pem file, from -----BEGIN EC PRIVATE KEY----- to -----END EC PRIVATE KEY-----. It must be a P-256 key. | Der private Schlüssel konnte nicht gelesen werden. Fügen Sie die ganze Datei private-key.pem ein, von -----BEGIN EC PRIVATE KEY----- bis -----END EC PRIVATE KEY-----. Es muss ein P-256-Schlüssel sein. |  |  |
| `ads.network` | Could not reach Apple Ads. Check that this server has internet access (and a proxy, if it needs one) to appleid.apple.com and api.ads.apple.com, then try again. | Apple Ads war nicht erreichbar. Prüfen Sie, ob dieser Server Internetzugang (und ggf. einen Proxy) zu appleid.apple.com und api.ads.apple.com hat, und versuchen Sie es erneut. |  |  |
| `ads.noAccount` | Apple Ads accepted the key, but it sees no ad account. Invite the API user to the account in Apple Ads (Account Settings, User Management). | Apple Ads hat den Schlüssel akzeptiert, sieht aber kein Werbekonto. Laden Sie den API-Benutzer in Apple Ads zum Konto ein (Kontoeinstellungen, Benutzerverwaltung). |  |  |
| `ads.notFound` | Apple Ads has no such ad account or campaign, or the key cannot see it. | Apple Ads kennt dieses Werbekonto oder diese Kampagne nicht, oder der Schlüssel kann sie nicht sehen. |  |  |
| `ads.notLinked` | This app is not linked to an Apple Ads account. Link it in the app settings first. | Diese App ist nicht mit einem Apple-Ads-Konto verknüpft. Verknüpfen Sie sie zuerst in den App-Einstellungen. |  |  |
| `ads.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads gilt für App-Store-Apps. Diese App ist keine. |  |  |
| `ads.rateLimited` | Apple Ads asked to slow down. Try again in a minute. | Apple Ads bittet darum, langsamer zu sein. Versuchen Sie es in einer Minute erneut. |  |  |
| `ads.requestFailed` | The Apple Ads request could not be completed. Try again in a moment. | Die Apple-Ads-Anfrage konnte nicht abgeschlossen werden. Versuchen Sie es gleich noch einmal. |  |  |
| `ads.server` | Apple Ads had a problem. Try again in a few minutes. | Apple Ads hatte ein Problem. Versuchen Sie es in einigen Minuten erneut. |  |  |
| `ads.timeout` | Apple Ads did not answer in time. Try again in a minute. | Apple Ads hat nicht rechtzeitig geantwortet. Versuchen Sie es in einer Minute erneut. |  |  |
| `ads.unexpected` | Apple Ads answered with something this server could not read. | Apple Ads hat etwas geantwortet, das dieser Server nicht lesen konnte. |  |  |
| `app.listingSettingInvalid` | A listing setting is not valid. | Eine Einstellung des Eintrags ist nicht gültig. |  | listing = Store-Eintrag |
| `aso.playListingNotWatched` | Kiln does not read Google Play pages, so the listing of a Google Play competitor is not watched. | Kiln liest keine Google-Play-Seiten, daher wird der Eintrag eines Google-Play-Wettbewerbers nicht beobachtet. |  | listing = Store-Eintrag |
| `aso.searchAppStoreOnly` | Search by name is for App Store apps. For Google Play, paste the package name or the play.google.com address. | Die Suche nach Namen gibt es nur für App-Store-Apps. Bei Google Play fügen Sie den Paketnamen oder die play.google.com-Adresse ein. |  |  |
| `assetProposal.hasIssues` | Some of the selected items have errors. Confirm them to stage them anyway. | Einige der ausgewählten Einträge haben Fehler. Bestätigen Sie, um sie trotzdem bereitzustellen. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `assetProposal.unavailable` | There is nothing to stage for this release: the app has no repository, or the repository holds no store listing for it. | Für diese Version gibt es nichts bereitzustellen: Die App hat kein Repository, oder das Repository enthält keinen Store-Eintrag dafür. |  | stage = vormerken / vorbereiten (nothing is sent); release = Release |
| `chat.hostNotAllowed` | A {{provider}} webhook address comes from {{hosts}}. Allow other hosts on the destination to use another address. | Eine Webhook-Adresse von {{provider}} stammt von {{hosts}}. Erlauben Sie andere Hosts am Ziel, um eine andere Adresse zu verwenden. |  |  |
| `chat.tooManyDestinations_one` | A workspace can have at most {{count}} chat destination. | Ein Arbeitsbereich kann höchstens {{count}} Chat-Ziel haben. |  |  |
| `chat.tooManyDestinations_other` | A workspace can have at most {{count}} chat destinations. | Ein Arbeitsbereich kann höchstens {{count}} Chat-Ziele haben. |  |  |
| `chat.urlInvalid` | That address cannot be used. Use the https webhook address from Slack or Teams. | Diese Adresse kann nicht verwendet werden. Verwenden Sie die https-Webhook-Adresse von Slack oder Teams. |  |  |
| `credential.notAppleAdsKind` | Apple Ads needs a credential of the Apple Ads API user key kind. | Apple Ads benötigt eine Zugangsdaten-Art vom Typ Apple-Ads-API-Benutzerschlüssel. |  |  |
| `experiments.datesOrder` | The end date is before the start date. | Das Enddatum liegt vor dem Startdatum. |  |  |
| `experiments.noteNotFound` | No such note. | Diese Notiz gibt es nicht. |  |  |
| `experiments.tooManyNotes` | An app can have {{limit}} notes. Delete one first. | Eine App kann {{limit}} Notizen haben. Löschen Sie zuerst eine. |  |  |
| `experiments.unsupported` | The store of this app has no API for experiments or custom pages. Use the manual tracker and the links to its console. | Der Store dieser App hat keine API für Tests oder benutzerdefinierte Produktseiten. Nutzen Sie die manuelle Verfolgung und die Links zu seiner Konsole. |  |  |
| `listing.fixNotAvailable` | This fix no longer applies: the text changed or it is already fixed. Reload and look again. | Diese Korrektur gilt nicht mehr: Der Text hat sich geändert oder ist bereits korrigiert. Laden Sie neu und prüfen Sie erneut. |  |  |
| `listing.staleFix` | The text changed since you looked at this fix. Reload and review it again. | Der Text hat sich geändert, seit Sie diese Korrektur angesehen haben. Laden Sie neu und prüfen Sie sie erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `prices.ackRequired` | This change needs an explicit acknowledgement before it can be staged or sent. | Diese Änderung braucht eine ausdrückliche Bestätigung, bevor sie vorbereitet oder gesendet werden kann. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `prices.ackUnknown` | Not a known acknowledgement. | Unbekannte Bestätigung. |  |  |
| `prices.amountNotPricePoint` | Apple only sells at its price points. This amount is not one: pick the nearest. | Apple verkauft nur zu seinen Preisstufen. Dieser Betrag ist keine: Wählen Sie die nächstliegende. |  |  |
| `prices.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Ein Betrag muss in ganzen Nebeneinheiten angegeben werden, zum Beispiel 499 für 4,99. |  |  |
| `prices.badChoice` | Not a known choice for existing subscribers or acknowledgement. | Unbekannte Auswahl für bestehende Abonnenten oder unbekannte Bestätigung. |  |  |
| `prices.badProduct` | Not a valid product. | Kein gültiges Produkt. |  |  |
| `prices.badTerritory` | Not a territory of this store. | Kein Land oder keine Region dieses Stores. |  |  |
| `prices.busy` | A price change for this app is in progress. Wait for it to finish. | Eine Preisänderung dieser App läuft gerade. Warten Sie, bis sie abgeschlossen ist. |  |  |
| `prices.confirmationMismatch` | The confirmation phrase is not the one for these price changes. Nothing was sent. | Der Bestätigungssatz passt nicht zu diesen Preisänderungen. Es wurde nichts gesendet. |  |  |
| `prices.convertBase` | Name a base territory the plan has a price in, and an amount in minor units. | Nennen Sie ein Basisland, in dem der Tarif einen Preis hat, und einen Betrag in Nebeneinheiten. |  |  |
| `prices.convertNotApplicable` | Only Google Play converts one price to other regions. | Nur Google Play rechnet einen Preis in andere Regionen um. |  |  |
| `prices.currencyMismatch` | The currency is not the currency of that territory. | Diese Währung ist nicht die Währung dieses Landes oder dieser Region. |  |  |
| `prices.dateInvalid` | Not a date: use YYYY-MM-DD. | Kein Datum: Verwenden Sie JJJJ-MM-TT. |  |  |
| `prices.datePast` | The date is in the past. | Das Datum liegt in der Vergangenheit. |  |  |
| `prices.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Dieser Store übernimmt einen Preis, sobald er gesendet wird: Er kann nicht datiert werden. |  |  |
| `prices.disabledServer` | Price changes are switched off on this server. Set KILN_PRICE_WRITES_ENABLED=true to turn it on (see docs/deployment.md). | Preisänderungen sind auf diesem Server abgeschaltet. Setzen Sie KILN_PRICE_WRITES_ENABLED=true, um sie einzuschalten (siehe docs/deployment.md). |  |  |
| `prices.disabledWorkspace` | Price changes are switched off for this workspace. An owner or admin can turn on the setting prices.writeEnabled. | Preisänderungen sind für diesen Arbeitsbereich abgeschaltet. Eine Inhaberin, ein Inhaber oder ein Admin kann die Einstellung prices.writeEnabled einschalten. |  |  |
| `prices.duplicateTerritory` | A territory is named twice. | Ein Land oder eine Region ist doppelt genannt. |  |  |
| `prices.noChange` | The new price is the price the store already shows. | Der neue Preis ist der Preis, den der Store bereits zeigt. |  |  |
| `prices.noLines` | Name at least one territory. | Nennen Sie mindestens ein Land oder eine Region. |  |  |
| `prices.notPositive` | A price must be greater than zero. | Ein Preis muss größer als null sein. |  |  |
| `prices.planMissing` | Name the base plan or purchase option. | Nennen Sie den Basistarif oder die Kaufoption. |  |  |
| `prices.planNotAllowed` | This product has no such plan. | Dieses Produkt hat keinen solchen Tarif. |  |  |
| `prices.pricePointMismatch` | The amount is not the amount of that price point. | Der Betrag ist nicht der Betrag dieser Preisstufe. |  |  |
| `prices.pricePointMissing` | Apple prices are chosen from price points: pick one. | Apple-Preise werden aus Preisstufen gewählt: Wählen Sie eine aus. |  |  |
| `prices.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Google-Play-Preise sind Beträge, keine Preisstufen. |  |  |
| `prices.pricePointTerritory` | That price point belongs to another territory. | Diese Preisstufe gehört zu einem anderen Land oder einer anderen Region. |  |  |
| `prices.pricePointUnknown` | That price point does not exist for this product. | Diese Preisstufe gibt es für dieses Produkt nicht. |  |  |
| `prices.stale` | The price changed since you looked at it. Sync the app and review again. | Der Preis hat sich geändert, seit Sie ihn angesehen haben. Synchronisieren Sie die App und prüfen Sie erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `prices.staleSnapshot` | The product was synced again since you opened it. Reload it and review the prices again. | Das Produkt wurde seit dem Öffnen erneut synchronisiert. Laden Sie es neu und prüfen Sie die Preise erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `prices.subscriberRule` | That choice for existing subscribers does not exist in this store. | Diese Auswahl für bestehende Abonnenten gibt es in diesem Store nicht. |  |  |
| `prices.tooHigh` | That price is above the highest price Kiln allows. | Dieser Preis liegt über dem höchsten Preis, den Kiln erlaubt. |  |  |
| `prices.tooManyTerritories` | Too many territories in one change. | Zu viele Länder oder Regionen in einer Änderung. |  |  |
| `prices.unknownState` | It is not known whether the last price change of this app reached the store. Run a dry run: it reads the store and shows where it stands. Nothing was sent. | Es ist nicht bekannt, ob die letzte Preisänderung dieser App den Store erreicht hat. Starten Sie einen Testlauf: Er liest den Store und zeigt den Stand. Es wurde nichts gesendet. |  |  |
| `prices.unknownTerritory` | The product has no price in that territory. | Das Produkt hat in diesem Land oder dieser Region keinen Preis. |  |  |
| `rate.ads_one` | Too many Apple Ads checks. Try again in {{count}} second. | Zu viele Apple-Ads-Prüfungen. Versuchen Sie es in {{count}} Sekunde erneut. |  |  |
| `rate.ads_other` | Too many Apple Ads checks. Try again in {{count}} seconds. | Zu viele Apple-Ads-Prüfungen. Versuchen Sie es in {{count}} Sekunden erneut. |  |  |
| `staged.metadataLocked` | Version {{version}} is live or in App Review, so its listing can no longer be changed. Prepare a new version first, then stage the change. | Version {{version}} ist live oder in der App-Prüfung, ihr Eintrag lässt sich nicht mehr ändern. Bereiten Sie zuerst eine neue Version vor und stellen Sie die Änderung dann bereit. |  | stage = vormerken / vorbereiten (nothing is sent); listing = Store-Eintrag |
| `staged.storeImageFormat` | Image {{position}} of this set is stored as a format that cannot be pushed (only PNG and JPEG can), so the set cannot be edited here. | Bild {{position}} dieses Satzes liegt in einem Format vor, das nicht gesendet werden kann (nur PNG und JPEG), daher lässt sich der Satz hier nicht bearbeiten. |  |  |
| `staged.storeImageMismatch` | Image {{position}} of this set does not match the checksum the store gave, so it was not taken. Read the store again. | Bild {{position}} dieses Satzes passt nicht zur Prüfsumme des Stores und wurde nicht übernommen. Lesen Sie den Store erneut. |  |  |
| `testflight.assigneeNotMember` | The assignee is not a member of this workspace. | Die zugewiesene Person ist kein Mitglied dieses Arbeitsbereichs. |  |  |
| `testflight.notFound` | No such feedback. | Dieses Feedback gibt es nicht. |  |  |
| `testflight.unsupported` | The store of this app has no TestFlight feedback. Only App Store Connect apps (iOS and macOS) have it. | Der Store dieser App hat kein TestFlight-Feedback. Nur Apps von App Store Connect (iOS und macOS) haben es. |  |  |
| `timeline.eventNotFound` | That event no longer exists. | Dieses Ereignis existiert nicht mehr. |  |  |
| `timeline.invalidRange` | That date range is not valid. Pick days that exist and keep the range short enough. | Dieser Zeitraum ist ungültig. Wählen Sie vorhandene Tage und einen kürzeren Zeitraum. |  |  |
| `timeline.tooManyEvents_one` | An app can have at most {{limit}} event of its own. Delete one first. | Eine App kann höchstens {{limit}} eigenes Ereignis haben. Löschen Sie zuerst eines. |  |  |
| `timeline.tooManyEvents_other` | An app can have at most {{limit}} events of its own. Delete one first. | Eine App kann höchstens {{limit}} eigene Ereignisse haben. Löschen Sie zuerst eines. |  |  |

## web/experiments (133)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `assets.none` | No media read | Keine Medien gelesen |  |  |
| `assets.other_one` | {{count}} other asset | {{count}} weiteres Asset |  |  |
| `assets.other_other` | {{count}} other assets | {{count}} weitere Assets |  |  |
| `assets.previews_one` | {{count}} preview | {{count}} Vorschau |  |  |
| `assets.previews_other` | {{count}} previews | {{count}} Vorschauen |  |  |
| `assets.screenshots_one` | {{count}} screenshot | {{count}} Screenshot |  |  |
| `assets.screenshots_other` | {{count}} screenshots | {{count}} Screenshots |  |  |
| `assets.sets_one` | {{count}} screenshot set | {{count}} Screenshot-Satz |  |  |
| `assets.sets_other` | {{count}} screenshot sets | {{count}} Screenshot-Sätze |  |  |
| `dates.notStarted` | Not started | Nicht gestartet |  |  |
| `dates.range` | {{from}} to {{to}} | {{from}} bis {{to}} |  |  |
| `dates.since` | Since {{date}} | Seit {{date}} |  |  |
| `dates.until` | Until {{date}} | Bis {{date}} |  |  |
| `experiments.aria` | Product Page Optimization experiments of {{app}} | Tests zur Optimierung der Produktseite von {{app}} |  |  |
| `experiments.colDates` | Dates | Zeitraum |  |  |
| `experiments.colName` | Experiment | Test |  |  |
| `experiments.colState` | Status | Status |  |  |
| `experiments.colTraffic` | Traffic | Traffic |  |  |
| `experiments.colTreatments` | Treatments | Varianten |  |  |
| `experiments.emptyDescription` | This app has no Product Page Optimization experiment. Apple needs the app to be live on the App Store, and a test takes up to three treatments. Create one in App Store Connect, then sync again. | Diese App hat keinen Test zur Optimierung der Produktseite. Apple verlangt, dass die App im App Store verfügbar ist, und ein Test nimmt bis zu drei Varianten auf. Legen Sie einen in App Store Connect an und synchronisieren Sie dann erneut. |  | live = live |
| `experiments.emptyTitle` | No experiments | Keine Tests |  |  |
| `experiments.heading` | Product Page Optimization experiments | Tests zur Optimierung der Produktseite |  |  |
| `experiments.neverDescription` | Sync to read the experiments of this app from App Store Connect. Nothing is changed in the store. | Synchronisieren Sie, um die Tests dieser App aus App Store Connect zu lesen. Im Store wird nichts geändert. |  |  |
| `experiments.neverTitle` | Experiments not read yet | Tests noch nicht gelesen |  |  |
| `experiments.noTreatments` | No treatments read | Keine Varianten gelesen |  |  |
| `experiments.reviewRequired` | Needs App Review | Braucht App Review |  | review: Rezension (user) vs Prüfung (App Review) |
| `experiments.runningByDates` | Inside its run dates | Innerhalb des Laufzeitraums |  |  |
| `google.body` | The Google Play developer API has no store listing experiments and no custom store listings, so Kiln cannot read or change them. Manage them in the Play Console and keep your own record below. | Die Google-Play-Entwickler-API kennt weder Store-Eintrag-Tests noch benutzerdefinierte Store-Einträge, daher kann Kiln sie weder lesen noch ändern. Verwalten Sie sie in der Google Play Console und führen Sie unten Ihre eigene Übersicht. |  | listing = Store-Eintrag |
| `google.limitExperiments` | One default graphics experiment, or up to five localized experiments, can run at the same time. An experiment stops by itself after 6 months. | Ein Test der Standardgrafiken oder bis zu fünf lokalisierte Tests können gleichzeitig laufen. Ein Test endet nach 6 Monaten von selbst. |  |  |
| `google.limitListings` | An app can have up to 50 custom store listings, each reached by its own address. | Eine App kann bis zu 50 benutzerdefinierte Store-Einträge haben, jeder mit eigener Adresse. |  | listing = Store-Eintrag |
| `google.title` | Experiments and custom listings live in the Play Console | Tests und benutzerdefinierte Einträge werden in der Google Play Console verwaltet |  | listing = Store-Eintrag; live = live |
| `noteDialog.addTitle` | Add a note | Notiz hinzufügen |  |  |
| `noteDialog.description` | Kiln keeps this note for you. Nothing is sent to a store. | Kiln bewahrt diese Notiz für Sie auf. Es wird nichts an einen Store gesendet. |  |  |
| `noteDialog.editTitle` | Change the note | Notiz ändern |  |  |
| `noteDialog.endedOn` | Ended on | Beendet am |  |  |
| `noteDialog.kind` | About | Betrifft |  |  |
| `noteDialog.listing` | Listing parameter | Eintrag-Parameter |  | listing = Store-Eintrag |
| `noteDialog.listingHint` | The value after listing= in the address of the custom store listing. Lowercase letters, digits and . - _ ~ | Der Wert nach listing= in der Adresse des benutzerdefinierten Store-Eintrags. Kleinbuchstaben, Ziffern und . - _ ~ |  | listing = Store-Eintrag |
| `noteDialog.name` | Name | Name |  |  |
| `noteDialog.namePlaceholder` | For example: Icon test, spring campaign | Zum Beispiel: Icon-Test, Frühjahrskampagne |  |  |
| `noteDialog.note` | Notes | Notizen |  |  |
| `noteDialog.noteHint` | What you tested and what you learned. Up to 2,000 characters. | Was Sie getestet und was Sie gelernt haben. Bis zu 2.000 Zeichen. |  |  |
| `noteDialog.saveFailed` | The note could not be saved. Try again. | Die Notiz konnte nicht gespeichert werden. Versuchen Sie es erneut. |  |  |
| `noteDialog.saveFailedTitle` | Could not save the note | Notiz konnte nicht gespeichert werden |  |  |
| `noteDialog.startedOn` | Started on | Gestartet am |  |  |
| `noteDialog.status` | Status | Status |  |  |
| `noteDialog.url` | Link | Link |  |  |
| `noteDialog.urlHint` | Optional: the address of the page or the console view. | Optional: die Adresse der Seite oder der Konsolenansicht. |  |  |
| `noteKind.customPage` | Custom page | Benutzerdefinierte Seite |  |  |
| `noteKind.experiment` | Experiment | Test |  |  |
| `noteStatus.finished` | Finished | Abgeschlossen |  |  |
| `noteStatus.planned` | Planned | Geplant |  |  |
| `noteStatus.running` | Running | Läuft |  |  |
| `noteStatus.stopped` | Stopped | Gestoppt |  |  |
| `notes.add` | Add a note | Notiz hinzufügen |  |  |
| `notes.delete` | Delete | Löschen |  |  |
| `notes.deleteFailed` | The note could not be deleted. Try again. | Die Notiz konnte nicht gelöscht werden. Versuchen Sie es erneut. |  |  |
| `notes.deleteFailedTitle` | Could not delete the note | Notiz konnte nicht gelöscht werden |  |  |
| `notes.deleted` | Note deleted. | Notiz gelöscht. |  |  |
| `notes.edit` | Edit | Bearbeiten |  |  |
| `notes.emptyDescriptionApple` | Write down what you plan to test or what you learned. Kiln does not read this from the App Store. | Halten Sie fest, was Sie testen wollen oder was Sie gelernt haben. Kiln liest dies nicht aus dem App Store. |  |  |
| `notes.emptyDescriptionGoogle` | Google Play has no API for experiments or custom listings, so this list is the record Kiln can keep: what you test, when, and what you learned. | Google Play hat keine API für Tests oder benutzerdefinierte Einträge, daher ist diese Liste die Übersicht, die Kiln führen kann: was Sie testen, wann und was Sie gelernt haben. |  | listing = Store-Eintrag |
| `notes.emptyTitle` | No notes yet | Noch keine Notizen |  |  |
| `notes.heading` | Manual tracker | Manuelle Verfolgung |  |  |
| `notes.leadApple` | Your own notes about tests and pages, kept in Kiln. They are not read from or sent to the store. | Ihre eigenen Notizen zu Tests und Seiten, in Kiln gespeichert. Sie werden weder aus dem Store gelesen noch dorthin gesendet. |  |  |
| `notes.leadGoogle` | Kiln cannot read Google Play experiments or custom listings. Keep your own record here and open the Play Console to run them. | Kiln kann die Tests und benutzerdefinierten Einträge von Google Play nicht lesen. Führen Sie hier Ihre eigene Übersicht und öffnen Sie die Google Play Console, um sie auszuführen. |  | listing = Store-Eintrag |
| `notes.openLink` | Open the link | Link öffnen |  |  |
| `notes.openListing` | Open the listing on Google Play | Eintrag auf Google Play öffnen |  | listing = Store-Eintrag |
| `pages.aria` | Custom product pages of {{app}} | Benutzerdefinierte Produktseiten von {{app}} |  |  |
| `pages.colActions` | Actions | Aktionen |  |  |
| `pages.colDeepLink` | Deep link | Deep Link |  |  |
| `pages.colLanguages` | Languages | Sprachen |  |  |
| `pages.colName` | Page | Seite |  |  |
| `pages.colState` | Status | Status |  |  |
| `pages.copyLink` | Copy the address | Adresse kopieren |  |  |
| `pages.emptyDescription` | This app has no custom product page. An app can have up to 70, each with its own screenshots, previews and promotional text. Create them in App Store Connect, then sync again. | Diese App hat keine benutzerdefinierte Produktseite. Eine App kann bis zu 70 haben, jede mit eigenen Screenshots, Vorschauen und Werbetext. Legen Sie sie in App Store Connect an und synchronisieren Sie dann erneut. |  |  |
| `pages.emptyTitle` | No custom product pages | Keine benutzerdefinierten Produktseiten |  |  |
| `pages.heading` | Custom product pages | Benutzerdefinierte Produktseiten |  |  |
| `pages.hidden` | Not visible | Nicht sichtbar |  |  |
| `pages.iosOnly` | Custom product pages are for iPhone and iPad apps: read them on the iOS record of this app. | Benutzerdefinierte Produktseiten gibt es für iPhone- und iPad-Apps: Lesen Sie sie am iOS-Eintrag dieser App. |  |  |
| `pages.neverDescription` | Sync to read the custom product pages of this app from App Store Connect. | Synchronisieren Sie, um die benutzerdefinierten Produktseiten dieser App aus App Store Connect zu lesen. |  |  |
| `pages.neverTitle` | Custom product pages not read yet | Benutzerdefinierte Produktseiten noch nicht gelesen |  |  |
| `pages.noDeepLink` | None | Keiner |  |  |
| `pages.open` | Open | Öffnen |  |  |
| `results.body` | Apple's API does not give the results of a test (impressions, conversion, confidence) or the numbers of a custom product page. They are in App Store Connect, under App Analytics. | Die API von Apple liefert weder die Ergebnisse eines Tests (Impressionen, Conversion, Konfidenz) noch die Zahlen einer benutzerdefinierten Produktseite. Sie stehen in App Store Connect unter App Analytics. |  |  |
| `results.link` | Open {{console}} | {{console}} öffnen |  |  |
| `results.title` | Results are in App Store Connect | Die Ergebnisse stehen in App Store Connect |  |  |
| `state.approved` | Approved | Genehmigt |  |  |
| `state.completed` | Completed | Abgeschlossen |  |  |
| `state.draft` | Draft | Entwurf |  |  |
| `state.inReview` | In review | In Prüfung |  | review: Rezension (user) vs Prüfung (App Review) |
| `state.rejected` | Rejected | Abgelehnt |  |  |
| `state.replaced` | Replaced | Ersetzt |  |  |
| `state.stopped` | Stopped | Gestoppt |  |  |
| `state.unknown` | Unknown | Unbekannt |  |  |
| `sync.failedKept` | The last sync failed. Showing what was read {{ago}}. {{error}} | Die letzte Synchronisierung ist fehlgeschlagen. Angezeigt wird, was {{ago}} gelesen wurde. {{error}} |  |  |
| `sync.failedNothing` | The last sync failed. {{error}} | Die letzte Synchronisierung ist fehlgeschlagen. {{error}} |  |  |
| `sync.never` | Not read yet. Sync to read the experiments and custom product pages. | Noch nicht gelesen. Synchronisieren Sie, um die Tests und benutzerdefinierten Produktseiten zu lesen. |  |  |
| `sync.partial` | Read {{ago}}. The lists were cut at their limit: the store may have more. | Gelesen {{ago}}. Die Listen wurden an ihrer Grenze abgeschnitten: Der Store hat womöglich mehr. |  |  |
| `sync.read` | Read {{ago}}. | Gelesen {{ago}}. |  |  |
| `tab.about` | About experiments | Über Tests |  |  |
| `tab.aboutApple` | Apple's Product Page Optimization tests up to three treatments of your product page against the original, and custom product pages give a campaign its own page. Kiln reads them from App Store Connect. | Die Optimierung der Produktseite von Apple testet bis zu drei Varianten Ihrer Produktseite gegen das Original, und benutzerdefinierte Produktseiten geben einer Kampagne eine eigene Seite. Kiln liest sie aus App Store Connect. |  |  |
| `tab.aboutGoogle` | Google Play calls them store listing experiments and custom store listings. They are managed in the Play Console only. | Google Play nennt sie Store-Eintrag-Tests und benutzerdefinierte Store-Einträge. Sie werden nur in der Google Play Console verwaltet. |  | listing = Store-Eintrag |
| `tab.aboutReadOnly` | Kiln reads and shows them. It cannot create, start, stop or change an experiment or a page: do that in the store's console. | Kiln liest und zeigt sie. Kiln kann keinen Test und keine Seite anlegen, starten, stoppen oder ändern: Tun Sie das in der Konsole des Stores. |  |  |
| `tab.headlineCount` | Experiments and custom product pages, as of the last sync | Tests und benutzerdefinierte Produktseiten, Stand der letzten Synchronisierung |  |  |
| `tab.headlineDefault` | Experiments and custom pages | Tests und benutzerdefinierte Seiten |  |  |
| `tab.headlineGoogle` | Experiments on Google Play are managed in the Play Console | Tests auf Google Play werden in der Google Play Console verwaltet |  |  |
| `tab.headlineNone` | No experiments or custom product pages read | Keine Tests oder benutzerdefinierten Produktseiten gelesen |  |  |
| `tab.leadHintApple` | As of the last sync. Read only. | Stand der letzten Synchronisierung. Nur lesend. |  |  |
| `tab.leadHintGoogle` | Google Play has no API for these: use the Play Console and the tracker below. | Google Play hat dafür keine API: Nutzen Sie die Google Play Console und die Verfolgung unten. |  |  |
| `tab.loadError` | Could not load the experiments. | Die Tests konnten nicht geladen werden. |  |  |
| `tab.loadErrorTitle` | Could not load the experiments | Tests konnten nicht geladen werden |  |  |
| `tab.openConsole` | Open {{console}} | {{console}} öffnen |  |  |
| `tab.partsTitle` | Some parts could not be read | Einige Teile konnten nicht gelesen werden |  |  |
| `tab.rawState` | The store's own word | Der Begriff des Stores |  |  |
| `tab.reading` | Reading the experiments | Tests werden gelesen |  |  |
| `tab.sync` | Sync experiments | Tests synchronisieren |  |  |
| `tab.syncDone` | Sync done. Experiments: {{experiments}}. Custom product pages: {{pages}}. | Synchronisierung abgeschlossen. Tests: {{experiments}}. Benutzerdefinierte Produktseiten: {{pages}}. |  |  |
| `tab.syncFailedNetwork` | The sync could not be completed. Try again. | Die Synchronisierung konnte nicht abgeschlossen werden. Versuchen Sie es erneut. |  |  |
| `tab.syncFailedTitle` | The sync failed | Die Synchronisierung ist fehlgeschlagen |  |  |
| `table.localesMore` | {{list}} and {{count}} more | {{list}} und {{count}} weitere |  |  |
| `table.none` | None | Keine |  |  |
| `traffic.percent` | {{percent}}% | {{percent}} % |  |  |
| `traffic.unknown` | Unknown | Unbekannt |  |  |
| `treatment.icon` | icon {{name}} | Icon {{name}} |  |  |
| `treatment.languages_one` | {{count}} language | {{count}} Sprache |  |  |
| `treatment.languages_other` | {{count}} languages | {{count}} Sprachen |  |  |
| `validation.datesOrder` | The end date is before the start date. | Das Enddatum liegt vor dem Startdatum. |  |  |
| `validation.listing` | Lowercase letters, digits and . - _ ~ only. | Nur Kleinbuchstaben, Ziffern und . - _ ~. |  |  |
| `validation.nameLong` | At most 120 characters. | Höchstens 120 Zeichen. |  |  |
| `validation.nameRequired` | Enter a name. | Geben Sie einen Namen ein. |  |  |
| `validation.noteLong` | At most 2,000 characters. | Höchstens 2.000 Zeichen. |  |  |
| `validation.url` | Enter an address that starts with https:// or http://. | Geben Sie eine Adresse ein, die mit https:// oder http:// beginnt. |  |  |

## web/insights (208)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `action.addLocale` | Add a language | Sprache hinzufügen |  |  |
| `action.open` | Open | Öffnen |  |  |
| `action.openChecks` | See the checks | Prüfungen ansehen |  |  |
| `action.openCountries` | See the countries | Länder ansehen |  |  |
| `action.openGraphics` | Review the graphics | Grafiken prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `action.openKeywords` | Look at keywords | Keywords ansehen |  |  |
| `action.openOverview` | Open the overview | Übersicht öffnen |  |  |
| `action.openRank` | See the ranks | Platzierungen ansehen |  |  |
| `action.openReviews` | Read the reviews | Rezensionen lesen |  | review: Rezension (user) vs Prüfung (App Review) |
| `action.openText` | Review the text | Text prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.complaints.explain` | {{count}} of the {{total}} complaints in the last {{days}} days are about this. Read those reviews to see what is going on. | {{count}} der {{total}} Beschwerden der letzten {{days}} Tage betreffen das. Lesen Sie diese Rezensionen, um zu sehen, was los ist. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.complaints.headline` | Complaints in reviews: {{theme}} | Beschwerden in Rezensionen: {{theme}} |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.conversionDown.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, down from {{before}} in the 14 days before. The change is too large to be chance. Check what changed on the page: icon, screenshots, text. | In den letzten 14 Tagen haben {{now}} der Personen, die Ihren Store-Eintrag gesehen haben, die App geladen, gegenüber {{before}} in den 14 Tagen davor. Der Unterschied ist zu groß für einen Zufall. Prüfen Sie, was sich am Eintrag geändert hat: Symbol, Screenshots, Text. |  |  |
| `card.conversionDown.headline` | Fewer people who see the page get the app | Weniger Besucher des Eintrags laden die App |  |  |
| `card.conversionUp.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, up from {{before}} in the 14 days before. The change is too large to be chance. | In den letzten 14 Tagen haben {{now}} der Personen, die Ihren Store-Eintrag gesehen haben, die App geladen, gegenüber {{before}} in den 14 Tagen davor. Der Unterschied ist zu groß für einen Zufall. |  |  |
| `card.conversionUp.headline` | More people who see the page get the app | Mehr Besucher des Eintrags laden die App |  |  |
| `card.downloadsDown.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} neue Downloads in den letzten 14 Tagen, gegenüber {{previous}} in den 14 Tagen davor. |  |  |
| `card.downloadsDown.headline` | New downloads are down {{percent}} | Neue Downloads sinken um {{percent}} |  |  |
| `card.downloadsUp.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} neue Downloads in den letzten 14 Tagen, gegenüber {{previous}} in den 14 Tagen davor. |  |  |
| `card.downloadsUp.headline` | New downloads are up {{percent}} | Neue Downloads steigen um {{percent}} |  |  |
| `card.featuredSpike.explain` | On {{day}} the app was shown {{count}} times while browsing, about {{times}} times a usual day. This looks like a feature in the store. It rarely lasts, so make sure the page is ready. | Am {{day}} wurde die App {{count}}-mal beim Stöbern angezeigt, etwa das {{times}}-Fache eines üblichen Tages. Das sieht nach einer Hervorhebung im Store aus. Sie hält selten an, sorgen Sie also dafür, dass der Eintrag bereit ist. |  |  |
| `card.featuredSpike.headline` | A one-day jump in browse impressions | Ein Tagessprung bei den Anzeigen beim Stöbern |  |  |
| `card.keywordsDown.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved down: {{count}}. | „{{term}}“ in {{country}} ist von Platz {{from}} auf Platz {{to}} gefallen. Verfolgte Keywords, die gefallen sind: {{count}}. |  |  |
| `card.keywordsDown.headline` | Keyword ranks dropped | Keyword-Platzierungen sind gefallen |  |  |
| `card.keywordsUp.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved up: {{count}}. | „{{term}}“ in {{country}} ist von Platz {{from}} auf Platz {{to}} gestiegen. Verfolgte Keywords, die gestiegen sind: {{count}}. |  |  |
| `card.keywordsUp.headline` | Keyword ranks improved | Keyword-Platzierungen haben sich verbessert |  |  |
| `card.listingIssues.explain_one` | {{count}} problem to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} Problem zu beheben und {{warnings}} zu prüfen. Die schwächste Sprache ist {{locale}}; der Eintrag erreicht {{score}} von 100. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.listingIssues.explain_other` | {{count}} problems to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} Probleme zu beheben und {{warnings}} zu prüfen. Die schwächste Sprache ist {{locale}}; der Eintrag erreicht {{score}} von 100. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.listingIssues.headline` | The store page has problems to fix | Der Store-Eintrag hat Probleme, die zu beheben sind |  |  |
| `card.listingReview.explain_one` | {{count}} point to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} Punkt zu prüfen, nichts, was eine Übertragung blockiert. Die schwächste Sprache ist {{locale}}; der Eintrag erreicht {{score}} von 100. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.listingReview.explain_other` | {{count}} points to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} Punkte zu prüfen, nichts, was eine Übertragung blockiert. Die schwächste Sprache ist {{locale}}; der Eintrag erreicht {{score}} von 100. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.listingReview.headline` | The store page has points to review | Der Store-Eintrag hat Punkte zu prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.localize.explain` | In countries such as {{countries}} people mainly speak {{language}}. There they see the page in another language. Text in their language usually helps them decide. | In Ländern wie {{countries}} wird überwiegend {{language}} gesprochen. Dort sehen die Leute den Eintrag in einer anderen Sprache. Ein Text in ihrer Sprache hilft ihnen meist bei der Entscheidung. |  |  |
| `card.localize.headline` | {{percent}} of downloads come from countries that mainly speak {{language}}, but the store page has no {{language}} text | {{percent}} der Downloads kommen aus Ländern, in denen überwiegend {{language}} gesprochen wird, aber der Store-Eintrag hat keinen Text in dieser Sprache |  |  |
| `card.unknown.explain` | This card comes from a newer version of Kiln. Update Kiln to read it. | Diese Karte stammt aus einer neueren Version von Kiln. Aktualisieren Sie Kiln, um sie zu lesen. |  |  |
| `card.unknown.headline` | Something changed | Etwas hat sich geändert |  |  |
| `card.versionRatingDrop.explain` | Reviews of {{version}} average {{now}} stars, against {{before}} for {{previous}}. Look at what changed in that version. | Die Rezensionen von {{version}} liegen im Schnitt bei {{now}} Sternen, gegenüber {{before}} bei {{previous}}. Sehen Sie sich an, was sich in dieser Version geändert hat. |  | review: Rezension (user) vs Prüfung (App Review) |
| `card.versionRatingDrop.headline` | Version {{version}} is rated lower than {{previous}} | Version {{version}} ist schlechter bewertet als {{previous}} |  |  |
| `card.visibilityDownSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. Look at your keyword ranks first. | In den letzten 14 Tagen wurde die App {{current}}-mal im Store angezeigt, gegenüber {{previous}} in den 14 Tagen davor. Sehen Sie sich zuerst Ihre Keyword-Platzierungen an. |  |  |
| `card.visibilityDownSeen.headline` | The app is shown {{percent}} less often | Die App wird {{percent}} seltener angezeigt |  |  |
| `card.visibilityDownVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. Look at your keyword ranks first. | In den letzten 14 Tagen hatte der Store-Eintrag {{current}} Besucher, gegenüber {{previous}} in den 14 Tagen davor. Sehen Sie sich zuerst Ihre Keyword-Platzierungen an. |  |  |
| `card.visibilityDownVisits.headline` | Store page visits are down {{percent}} | Die Besuche des Store-Eintrags sinken um {{percent}} |  |  |
| `card.visibilityUpSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. | In den letzten 14 Tagen wurde die App {{current}}-mal im Store angezeigt, gegenüber {{previous}} in den 14 Tagen davor. |  |  |
| `card.visibilityUpSeen.headline` | The app is shown {{percent}} more often | Die App wird {{percent}} häufiger angezeigt |  |  |
| `card.visibilityUpVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. | In den letzten 14 Tagen hatte der Store-Eintrag {{current}} Besucher, gegenüber {{previous}} in den 14 Tagen davor. |  |  |
| `card.visibilityUpVisits.headline` | Store page visits are up {{percent}} | Die Besuche des Store-Eintrags steigen um {{percent}} |  |  |
| `cards.dismiss` | Dismiss | Ausblenden |  |  |
| `cards.dismissFailed` | The card could not be hidden. Try again. | Die Karte konnte nicht ausgeblendet werden. Versuchen Sie es erneut. |  |  |
| `cards.dismissed` | Card hidden until its finding changes. | Karte ausgeblendet, bis sich der Befund ändert. |  |  |
| `cards.hiddenLine_one` | {{count}} card is hidden. | {{count}} Karte ist ausgeblendet. |  |  |
| `cards.hiddenLine_other` | {{count}} cards are hidden. | {{count}} Karten sind ausgeblendet. |  |  |
| `cards.loadError` | The insights could not be read. Try again. | Die Auswertungen konnten nicht gelesen werden. Versuchen Sie es erneut. |  |  |
| `cards.loadErrorTitle` | Insights unavailable | Auswertungen nicht verfügbar |  |  |
| `cards.showHidden` | Show hidden cards | Ausgeblendete Karten anzeigen |  |  |
| `cards.undo` | Undo | Rückgängig |  |  |
| `cards.undoFailed` | The card could not be brought back. Try again. | Die Karte konnte nicht zurückgeholt werden. Versuchen Sie es erneut. |  |  |
| `category.conversion` | Conversion | Conversion |  |  |
| `category.downloads` | Downloads | Downloads |  |  |
| `category.keywords` | Keywords | Keywords |  |  |
| `category.listing` | Store page | Store-Eintrag |  |  |
| `category.markets` | Markets | Märkte |  |  |
| `category.reviews` | Reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `category.visibility` | Visibility | Sichtbarkeit |  |  |
| `check.empty.explain` | This field has no text. Shoppers and store search get nothing from it. | Dieses Feld enthält keinen Text. Weder Besucher noch die Suche des Stores haben etwas davon. |  |  |
| `check.empty.title` | {{field}} is empty | {{field}}: leer |  |  |
| `check.keywordsDuplicate.explain` | The same word appears more than once ({{words}}). Each repeat wastes room. | Dasselbe Wort kommt mehrfach vor ({{words}}). Jede Wiederholung verschwendet Platz. |  |  |
| `check.keywordsDuplicate.title` | Repeated keywords | Wiederholte Keywords |  |  |
| `check.keywordsInTitle.explain` | These words are already searchable from the name or subtitle: {{words}}. Repeating them in the keyword field wastes room. | Diese Wörter sind über Namen oder Untertitel schon auffindbar: {{words}}. Sie im Keyword-Feld zu wiederholen verschwendet Platz. |  |  |
| `check.keywordsInTitle.title` | Keywords already in the name or subtitle | Keywords, die schon im Namen oder Untertitel stehen |  |  |
| `check.keywordsSpaces.explain` | Spaces around the commas use up {{saved}} bytes of the keyword field. Without them there is room for more keywords. A rewritten field is suggested below. | Leerzeichen um die Kommas belegen {{saved}} Bytes des Keyword-Felds. Ohne sie ist Platz für weitere Keywords. Unten wird ein umgeschriebenes Feld vorgeschlagen. |  |  |
| `check.keywordsSpaces.title` | The keywords waste space | Die Keywords verschwenden Platz |  |  |
| `check.keywordsUnderused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More keywords can bring more searches. | Nur {{used}} von {{limit}} {{unit}} sind belegt. Mehr Keywords können mehr Suchen bringen. |  |  |
| `check.keywordsUnderused.title` | Room left in the keyword field | Freier Platz im Keyword-Feld |  |  |
| `check.noScreenshots.explain` | Other languages have their own screenshots and this one has none. | Andere Sprachen haben eigene Screenshots, diese hat keine. |  |  |
| `check.noScreenshots.title` | No screenshots of its own | Keine eigenen Screenshots |  |  |
| `check.promoMissing.explain` | Promotional text can change without a new version and shows above the description. Add some. | Der Werbetext kann sich ohne neue Version ändern und steht über der Beschreibung. Fügen Sie einen hinzu. |  |  |
| `check.promoMissing.title` | No promotional text | Kein Werbetext |  |  |
| `check.severity.problem` | Problem | Problem |  |  |
| `check.severity.tip` | Tip | Tipp |  |  |
| `check.severity.warning` | Warning | Warnung |  |  |
| `check.subtitleMissing.explain` | The subtitle is searchable text that shows under the name in search results. Add one. | Der Untertitel ist durchsuchbarer Text, der in den Suchergebnissen unter dem Namen steht. Fügen Sie einen hinzu. |  |  |
| `check.subtitleMissing.title` | No subtitle | Kein Untertitel |  |  |
| `check.subtitleRepeatsName.explain` | Every word of the subtitle is already in the name, so it adds nothing to search. Say something new about the app. | Jedes Wort des Untertitels steht schon im Namen, er bringt also nichts für die Suche. Sagen Sie etwas Neues über die App. |  |  |
| `check.subtitleRepeatsName.title` | The subtitle repeats the name | Der Untertitel wiederholt den Namen |  |  |
| `check.tooLong.explain` | The text uses {{used}} of {{limit}} allowed {{unit}}. The store rejects text over the limit, so shorten it before you publish. | Der Text nutzt {{used}} von {{limit}} erlaubten {{unit}}. Der Store lehnt Text über dem Limit ab: Kürzen Sie ihn vor dem Veröffentlichen. |  |  |
| `check.tooLong.title` | {{field}} is {{over}} {{unit}} too long | {{field}}: {{over}} {{unit}} zu lang |  |  |
| `check.underused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More room means more words people can find the app by. | Nur {{used}} von {{limit}} {{unit}} sind belegt. Mehr Platz bedeutet mehr Wörter, über die man die App findet. |  |  |
| `check.underused.title` | {{field}} uses little of its room | {{field}}: wenig Platz genutzt |  |  |
| `check.unknown.explain` | This finding comes from a newer version of Kiln. Update Kiln to read it. | Dieser Befund stammt aus einer neueren Version von Kiln. Aktualisieren Sie Kiln, um ihn zu lesen. |  |  |
| `check.unknown.title` | A check found something | Eine Prüfung hat etwas gefunden |  |  |
| `check.untranslated.explain` | {{fields}} matches {{base}} word for word. Translate it, or people in this language read foreign text. | {{fields}}: Wort für Wort wie in {{base}}. Übersetzen Sie ihn, sonst lesen die Leute in dieser Sprache einen fremden Text. |  |  |
| `check.untranslated.title` | Text is the same as in {{base}} | Text ist derselbe wie in {{base}} |  |  |
| `checks.allGood` | No findings. The text passes every check. | Keine Befunde. Der Text besteht alle Prüfungen. |  |  |
| `checks.clean_one` | {{count}} language has no findings: {{locales}}. | {{count}} Sprache ohne Befunde: {{locales}}. |  |  |
| `checks.clean_other` | {{count}} languages have no findings: {{locales}}. | {{count}} Sprachen ohne Befunde: {{locales}}. |  |  |
| `checks.copied` | Copied | Kopiert |  |  |
| `checks.copy` | Copy | Kopieren |  |  |
| `checks.counts` | Problems {{problems}} · warnings {{warnings}} · tips {{tips}} | Probleme: {{problems}} · Warnungen: {{warnings}} · Tipps: {{tips}} |  |  |
| `checks.findings_one` | {{count}} finding | {{count}} Befund |  |  |
| `checks.findings_other` | {{count}} findings | {{count}} Befunde |  |  |
| `checks.loadError` | The checks could not be read. Try again. | Die Prüfungen konnten nicht gelesen werden. Versuchen Sie es erneut. |  |  |
| `checks.loadErrorTitle` | Checks unavailable | Prüfungen nicht verfügbar |  |  |
| `checks.noListing` | Kiln needs the live text of your store page to check it. Use Sync now in the status menu of the page header, then come back. | Kiln braucht den veröffentlichten Text Ihres Eintrags, um ihn zu prüfen. Nutzen Sie Jetzt synchronisieren im Statusmenü der Seitenkopfzeile und kommen Sie dann zurück. |  | live = live |
| `checks.noListingTitle` | The store page has not been read yet | Der Store-Eintrag wurde noch nicht gelesen |  |  |
| `checks.openLocale` | Open {{locale}} | {{locale}} öffnen |  |  |
| `checks.pasteHint` | Nothing is sent to a store. Paste it in the field editor and stage it. | Es wird nichts an einen Store gesendet. Fügen Sie ihn im Feldeditor ein und legen Sie ihn als ausstehende Änderung ab. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `checks.score` | Score {{score}} | Punktzahl {{score}} |  |  |
| `checks.suggested` | Suggested text for {{field}} | Vorgeschlagener Text für {{field}} |  |  |
| `checks.summary` | Score {{score}} out of 100 | Punktzahl {{score}} von 100 |  |  |
| `checks.title` | Store page checks | Prüfungen des Store-Eintrags |  |  |
| `countries.addLanguage` | Add it in the store listing | Im Store-Eintrag hinzufügen |  | listing = Store-Eintrag |
| `countries.byLanguage` | Downloads by main language | Downloads nach Hauptsprache |  |  |
| `countries.colCountry` | Country or region | Land oder Region |  |  |
| `countries.colDownloads` | New downloads | Neue Downloads |  |  |
| `countries.colLanguage` | Main language | Hauptsprache |  |  |
| `countries.colPage` | Store page | Store-Eintrag |  |  |
| `countries.colShare` | Share | Anteil |  |  |
| `countries.hint` | New downloads of the last 28 days: {{total}}. The main language of a country is the one most people there speak; many speak others too. | Neue Downloads der letzten 28 Tage: {{total}}. Die Hauptsprache eines Landes ist die, die dort die meisten sprechen; viele sprechen auch andere. |  |  |
| `countries.languageUnknown` | Unknown | Unbekannt |  |  |
| `countries.leadCovered` | Your store page covers the main language of every country that downloads your app | Ihr Store-Eintrag deckt die Hauptsprache jedes Landes ab, aus dem Ihre App geladen wird |  |  |
| `countries.leadUncovered` | {{percent}} of new downloads come from countries whose language your store page lacks | {{percent}} der neuen Downloads kommen aus Ländern, deren Sprache Ihrem Store-Eintrag fehlt |  |  |
| `countries.loadError` | The countries could not be read. Try again. | Die Länder konnten nicht gelesen werden. Versuchen Sie es erneut. |  |  |
| `countries.loadErrorTitle` | Countries unavailable | Länder nicht verfügbar |  |  |
| `countries.moreLanguages_one` | {{count}} more language with fewer downloads is not shown. | {{count}} weitere Sprache mit weniger Downloads wird nicht angezeigt. |  |  |
| `countries.moreLanguages_other` | {{count}} more languages with fewer downloads are not shown. | {{count}} weitere Sprachen mit weniger Downloads werden nicht angezeigt. |  |  |
| `countries.notOnPage` | Not on your store page | Nicht in Ihrem Eintrag |  |  |
| `countries.onPage` | On your store page ({{locale}}) | In Ihrem Eintrag ({{locale}}) |  |  |
| `countries.table` | Countries | Länder |  |  |
| `countries.unavailable.noAccess` | Your role may not read the store page, so the languages on it cannot be compared. | Ihre Rolle darf den Store-Eintrag nicht lesen, daher lassen sich seine Sprachen nicht vergleichen. |  |  |
| `countries.unavailable.noCountries` | The store sends no downloads by country for this app (Google Play reports carry none), or none are stored yet. Sync the analytics to read them. | Der Store sendet für diese App keine Downloads nach Land (Berichte von Google Play enthalten keine), oder es sind noch keine gespeichert. Synchronisieren Sie Analytics, um sie zu lesen. |  |  |
| `countries.unavailable.noListing` | Kiln has not read your live store page yet, so it cannot tell which languages it covers. Use Sync now in the status menu of the page header. | Kiln hat Ihren veröffentlichten Store-Eintrag noch nicht gelesen und weiß daher nicht, welche Sprachen er abdeckt. Nutzen Sie Jetzt synchronisieren im Statusmenü der Seitenkopfzeile. |  | live = live |
| `countries.unavailableTitle` | No table of countries | Keine Tabelle der Länder |  |  |
| `countries.unknown_one` | {{count}} download came from a country whose main language is not known. | {{count}} Download stammt aus einem Land, dessen Hauptsprache nicht bekannt ist. |  |  |
| `countries.unknown_other` | {{count}} downloads came from countries whose main language is not known. | {{count}} Downloads stammen aus Ländern, deren Hauptsprache nicht bekannt ist. |  |  |
| `empty.hiddenTitle` | Every card is dismissed | Alle Karten sind ausgeblendet |  |  |
| `empty.hidden_one` | The {{count}} card Kiln found is hidden. Show it again below, or wait: a hidden card returns when its finding changes. | Kiln hat {{count}} Karte gefunden, und sie ist ausgeblendet. Blenden Sie sie unten wieder ein, oder warten Sie: Eine ausgeblendete Karte kehrt zurück, wenn sich ihr Befund ändert. |  |  |
| `empty.hidden_other` | The {{count}} cards Kiln found are hidden. Show them again below, or wait: a hidden card returns when its finding changes. | Die {{count}} Karten, die Kiln gefunden hat, sind ausgeblendet. Blenden Sie sie unten wieder ein, oder warten Sie: Eine ausgeblendete Karte kehrt zurück, wenn sich ihr Befund ändert. |  |  |
| `empty.nodata` | Some checks could not run, so there is nothing to show. The notes below say what each one is missing. | Einige Prüfungen konnten nicht laufen, daher gibt es nichts zu zeigen. Die Hinweise unten nennen, was jeder fehlt. |  |  |
| `empty.nodataTitle` | Not enough data yet | Noch nicht genug Daten |  |  |
| `empty.quiet` | Every check ran and found nothing worth your time. Kiln looks again after the next sync. | Alle Prüfungen sind gelaufen und haben nichts gefunden, das Ihre Zeit verdient. Kiln schaut nach der nächsten Synchronisierung wieder nach. |  |  |
| `empty.quietTitle` | Nothing stands out | Nichts fällt auf |  |  |
| `evidence.browseDay` | That day | An diesem Tag |  |  |
| `evidence.browseUsual` | Usual day | Üblicher Tag |  |  |
| `evidence.complaints` | All complaints | Alle Beschwerden |  |  |
| `evidence.current` | Last 14 days | Letzte 14 Tage |  |  |
| `evidence.day` | Day | Tag |  |  |
| `evidence.downloads` | New downloads | Neue Downloads |  |  |
| `evidence.issues` | Problems | Probleme |  |  |
| `evidence.mentions` | Mentions | Erwähnungen |  |  |
| `evidence.previous` | 14 days before | 14 Tage davor |  |  |
| `evidence.rateNow` | Rate now | Rate jetzt |  |  |
| `evidence.ratePrevious` | Rate before | Rate davor |  |  |
| `evidence.ratingNow` | Rating now | Bewertung jetzt |  | rating = Bewertung |
| `evidence.ratingPrevious` | Rating before | Bewertung davor |  | rating = Bewertung |
| `evidence.score` | Score | Punktzahl |  |  |
| `evidence.share` | Share of downloads | Anteil der Downloads |  |  |
| `evidence.unranked` | Not ranked | Nicht platziert |  |  |
| `evidence.warnings` | To review | Zu prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `field.description` | Description | Beschreibung |  |  |
| `field.fullDescription` | Full description | Vollständige Beschreibung |  |  |
| `field.keywords` | Keywords | Keywords |  |  |
| `field.name` | Name | Name |  |  |
| `field.promotionalText` | Promotional text | Werbetext |  |  |
| `field.shortDescription` | Short description | Kurzbeschreibung |  |  |
| `field.subtitle` | Subtitle | Untertitel |  |  |
| `field.title` | Title | Titel |  |  |
| `filter.all` | All | Alle |  |  |
| `filter.empty` | Nothing in this topic. | Nichts in diesem Thema. |  |  |
| `filter.label` | Filter by topic | Nach Thema filtern |  |  |
| `lead.headline_one` | {{count}} thing to look at | {{count}} Punkt zum Ansehen |  |  |
| `lead.headline_other` | {{count}} things to look at | {{count}} Punkte zum Ansehen |  |  |
| `lead.hint` | Worked out from what Kiln has already stored: analytics, reviews, keyword ranks and your live store page. Nothing is sent to a store. | Berechnet aus dem, was Kiln schon gespeichert hat: Analytics, Rezensionen, Keyword-Platzierungen und Ihr veröffentlichter Store-Eintrag. Es wird nichts an einen Store gesendet. |  | review: Rezension (user) vs Prüfung (App Review); live = live |
| `lead.none` | Nothing needs your attention | Nichts braucht Ihre Aufmerksamkeit |  |  |
| `notes.title` | Checks that did not run | Prüfungen, die nicht gelaufen sind |  |  |
| `reason.noAccess` | your role may not read the data it needs. | Ihre Rolle darf die nötigen Daten nicht lesen. |  |  |
| `reason.noCountries` | the store sends no downloads by country (Google Play does not), or none are stored yet. | der Store sendet keine Downloads nach Land (Google Play tut das nicht), oder es sind noch keine gespeichert. |  |  |
| `reason.noData` | no data is stored yet. Sync the app, or turn on analytics. | es sind noch keine Daten gespeichert. Synchronisieren Sie die App oder aktivieren Sie Analytics. |  |  |
| `reason.noKeywords` | no keywords are tracked yet. | es werden noch keine Keywords verfolgt. |  |  |
| `reason.noListing` | the live store page has not been read yet. Sync the app first. | der veröffentlichte Store-Eintrag wurde noch nicht gelesen. Synchronisieren Sie zuerst die App. |  | live = live |
| `reason.noReviews` | no reviews are stored. Read the reviews first. | es sind keine Rezensionen gespeichert. Lesen Sie zuerst die Rezensionen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `reason.notForStore` | it does not apply to this store. | sie gilt für diesen Store nicht. |  |  |
| `reason.other` | it could not run. | sie konnte nicht laufen. |  |  |
| `reason.tooLittleData` | there are not enough days of data to compare two weeks yet. | es gibt noch nicht genug Tage mit Daten, um zwei Wochen zu vergleichen. |  |  |
| `severity.good` | Good news | Gute Nachricht |  |  |
| `severity.info` | Information | Information |  |  |
| `severity.problem` | Problem | Problem |  |  |
| `severity.warning` | Warning | Warnung |  |  |
| `skip.complaints` | Review complaints | Beschwerden in Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `skip.conversion` | Conversion | Conversion |  |  |
| `skip.downloads` | Downloads | Downloads |  |  |
| `skip.featured` | Store featuring | Hervorhebung im Store |  |  |
| `skip.keywords` | Keyword ranks | Keyword-Platzierungen |  |  |
| `skip.line` | {{rule}}: {{reason}} | {{rule}}: {{reason}} |  |  |
| `skip.listing` | Store page checks | Prüfungen des Store-Eintrags |  |  |
| `skip.localize` | Languages of your countries | Sprachen Ihrer Länder |  |  |
| `skip.other` | Another check | Eine andere Prüfung |  |  |
| `skip.versionRating` | Rating of the latest version | Bewertung der neuesten Version |  | rating = Bewertung |
| `skip.visibility` | Visibility | Sichtbarkeit |  |  |
| `theme.ads` | ads | Werbung |  |  |
| `theme.bug` | bugs | Fehler |  |  |
| `theme.crash` | crashes | Abstürze |  |  |
| `theme.data` | lost or missing data | verlorene oder fehlende Daten |  |  |
| `theme.login` | signing in | Anmeldung |  |  |
| `theme.performance` | slow performance | Langsamkeit |  |  |
| `theme.price` | the price | Preis |  |  |
| `theme.update` | the latest update | neuestes Update |  |  |
| `unit.bytes` | bytes | Bytes |  |  |
| `unit.characters` | characters | Zeichen |  |  |

## web/listing (58)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `compare.discard` | Discard | Verwerfen |  |  |
| `compare.discardFor` | Discard the staged {{label}} ({{locale}}) | Vorgemerkte Änderung von {{label}} ({{locale}}) verwerfen |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.after` | After | Nachher |  |  |
| `fix.afterPending` | After pending changes: {{problems}} problems, {{warnings}} warnings, {{tips}} tips. Score {{score}}. | Nach den ausstehenden Änderungen: {{problems}} Probleme, {{warnings}} Warnungen, {{tips}} Tipps. Wert {{score}}. |  | cart = "Ausstehende Änderungen" |
| `fix.all_one` | Fix all that can be fixed ({{count}}) | Alles korrigieren, was möglich ist ({{count}}) |  |  |
| `fix.all_other` | Fix all that can be fixed ({{count}}) | Alles korrigieren, was möglich ist ({{count}}) |  |  |
| `fix.barTitle` | Fixes for this language | Korrekturen für diese Sprache |  |  |
| `fix.before` | Before | Vorher |  |  |
| `fix.button` | Fix | Korrigieren |  |  |
| `fix.bytes` | bytes | Bytes |  |  |
| `fix.cannot` | Cannot be fixed automatically. | Lässt sich nicht automatisch korrigieren. |  |  |
| `fix.characters` | characters | Zeichen |  |  |
| `fix.discard` | Discard | Verwerfen |  |  |
| `fix.drops_one` | Removes {{count}} whole term. No word is cut. | Entfernt {{count}} ganzen Begriff. Kein Wort wird abgeschnitten. |  |  |
| `fix.drops_other` | Removes {{count}} whole terms. No word is cut. | Entfernt {{count}} ganze Begriffe. Kein Wort wird abgeschnitten. |  |  |
| `fix.editField` | Edit | Bearbeiten |  |  |
| `fix.emptyHint` | A required field is empty. Nothing is invented: write it in the editor. | Ein Pflichtfeld ist leer. Es wird nichts erfunden: Schreiben Sie es im Editor. |  |  |
| `fix.failed` | The fix could not be staged. Reload and try again. | Die Korrektur konnte nicht vorgemerkt werden. Laden Sie neu und versuchen Sie es erneut. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.keywordsDropInTitle` | Remove terms already in the name or subtitle | Begriffe entfernen, die schon im Namen oder Untertitel stehen |  |  |
| `fix.keywordsFit` | Drop terms to fit the limit | Begriffe entfernen, bis das Limit passt |  |  |
| `fix.keywordsTidy` | Tidy the keyword field | Schlüsselwortfeld aufräumen |  |  |
| `fix.locked` | This version is live or in review, so its text is read-only here. | Diese Version ist live oder in der Prüfung, ihr Text ist hier daher schreibgeschützt. |  | review: Rezension (user) vs Prüfung (App Review); live = live |
| `fix.noMeaning` | Only spaces, empty terms and repeats change. Nothing a shopper reads. | Nur Leerzeichen, leere Begriffe und Wiederholungen ändern sich. Nichts, was Nutzer lesen. |  |  |
| `fix.noRight` | Your role cannot stage changes. | Ihre Rolle darf keine Änderungen vormerken. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.notPublished` | Nothing is sent to a store from here. | Von hier wird nichts an einen Store gesendet. |  |  |
| `fix.openEditor` | Open the {{field}} editor | Editor öffnen: {{field}} |  |  |
| `fix.partial` | {{done}} of {{total}} were staged. | {{done}} von {{total}} wurden vorgemerkt. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.removedList` | Removed: {{terms}} | Entfernt: {{terms}} |  |  |
| `fix.removedTerm` | removed:  | entfernt:  |  |  |
| `fix.reviewDescription` | Check the text before and after. Staging adds it to the pending changes; nothing is published until you review and send them. | Prüfen Sie den Text vorher und nachher. Vormerken fügt ihn den ausstehenden Änderungen hinzu; veröffentlicht wird erst, wenn Sie sie prüfen und senden. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `fix.reviewTitleOne` | Review the fix | Korrektur prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `fix.reviewTitle_one` | Review {{count}} fix | {{count}} Korrektur prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `fix.reviewTitle_other` | Review {{count}} fixes | {{count}} Korrekturen prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `fix.riskReview` | Read before staging | Vor dem Vormerken lesen |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.riskSafe` | Changes no wording | Ändert keinen Wortlaut |  |  |
| `fix.shortenAi` | Shorten with AI | Mit KI kürzen |  |  |
| `fix.shortenHint` | Shortening changes the wording, so it is never automatic. The editor shows the limit as you type. | Kürzen ändert den Wortlaut und ist daher nie automatisch. Der Editor zeigt das Limit beim Tippen. |  |  |
| `fix.stage` | Stage fix | Korrektur vormerken |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.stageMany_one` | Stage {{count}} fix | {{count}} Korrektur vormerken |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.stageMany_other` | Stage {{count}} fixes | {{count}} Korrekturen vormerken |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.staged` | Fix staged | Korrektur vorgemerkt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `fix.textTidy` | Collapse extra spaces | Überzählige Leerzeichen zusammenfassen |  |  |
| `fix.whiteSpace` | Only extra spaces and blank lines change. Every word stays. | Nur überzählige Leerzeichen und Leerzeilen ändern sich. Alle Wörter bleiben. |  |  |
| `matrix.cell.fine` | No problems | Keine Probleme |  |  |
| `matrix.cellShort.fine` | No problems | Keine Probleme |  |  |
| `matrix.status.noProblems` | No problems found | Keine Probleme gefunden |  |  |
| `matrixView.cellAriaStaged` | {{column}}, {{locale}}: {{summary}}. {{staged}}. Open the locale. | {{column}}, {{locale}}: {{summary}}. {{staged}}. Sprache öffnen. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.compareOff` | The repository is not compared with the store. Turn on “Compare repository and store” in the app settings to see differences. | Das Repository wird nicht mit dem Store verglichen. Aktiviere „Repository und Store vergleichen“ in den App-Einstellungen, um Unterschiede zu sehen. |  |  |
| `matrixView.discardFailed` | Could not discard the staged change. Try again. | Die vorgemerkte Änderung konnte nicht verworfen werden. Versuche es erneut. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.localeStagedAria_one` | {{count}} staged change in {{locale}}. Open it in the pending changes. | {{count}} vorgemerkte Änderung in {{locale}}. In den ausstehenden Änderungen öffnen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.localeStagedAria_other` | {{count}} staged changes in {{locale}}. Open them in the pending changes. | {{count}} vorgemerkte Änderungen in {{locale}}. In den ausstehenden Änderungen öffnen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.localeStaged_one` | {{count}} staged | {{count}} vorgemerkt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.localeStaged_other` | {{count}} staged | {{count}} vorgemerkt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.stagedChange` | Staged: {{before}} → {{after}} | Vorgemerkt: {{before}} → {{after}} |  | stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.stagedEdited` | Edited | Bearbeitet |  |  |
| `matrixView.stagedMark` | Edited: a staged value waits in the pending changes. Point at the marker to read the change. | Bearbeitet: Ein vorgemerkter Wert wartet in den ausstehenden Änderungen. Zeige auf die Markierung, um die Änderung zu lesen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `matrixView.stagedNothing` | (nothing) | (nichts) |  |  |
| `matrixView.unstagedAnnounce` | Discarded the staged {{label}} ({{locale}}). | Vorgemerkte Änderung verworfen: {{label}} ({{locale}}). |  | stage = vormerken / vorbereiten (nothing is sent) |

## web/portfolio (8)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `activity.feed.analytics` | analytics | Analysen |  |  |
| `activity.feed.other` | other data | weitere Daten |  |  |
| `activity.feed.releases` | release state | Release-Status |  | release = Release |
| `activity.feed.reviews` | reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `activity.queued_one` | {{count}} more waiting | {{count}} weitere wartet |  |  |
| `activity.queued_other` | {{count}} more waiting | {{count}} weitere warten |  |  |
| `activity.title` | Syncing now | Synchronisierung läuft |  |  |
| `activity.unknownApp` | Another app | Andere App |  |  |

## web/products (95)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `price.ack.existingSubscribers` | I know existing subscribers will be moved to the new price. | Ich weiß, dass bestehende Abonnenten auf den neuen Preis wechseln. |  |  |
| `price.ack.largeAbsolute` | I know a price changes by a large amount of money (limit: {{amount}} units of the currency, more for currencies with small units). | Ich weiß, dass sich ein Preis um einen hohen Geldbetrag ändert (Grenze: {{amount}} Einheiten der Währung, höher bei Währungen mit kleiner Einheit). |  |  |
| `price.ack.largeChange` | I know a price changes by more than {{percent}}%. | Ich weiß, dass sich ein Preis um mehr als {{percent}} % ändert. |  |  |
| `price.acks` | Confirm each of these | Bestätigen Sie jeden dieser Punkte |  |  |
| `price.alreadyStaged_one` | A price change for {{count}} territory is staged and waiting in the pending changes. | Eine Preisänderung für {{count}} Gebiet wartet in den ausstehenden Änderungen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `price.alreadyStaged_other` | A price change for {{count}} territories is staged and waiting in the pending changes. | Eine Preisänderung für {{count}} Gebiete wartet in den ausstehenden Änderungen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `price.blockRole` | Only an owner or admin can change prices. | Nur Inhaber oder Admins können Preise ändern. |  |  |
| `price.blockServer` | Price changes are switched off on this server. An operator can turn them on with {{env}}. | Preisänderungen sind auf diesem Server ausgeschaltet. Ein Betreiber kann sie mit {{env}} einschalten. |  |  |
| `price.blockWorkspace` | Price changes are switched off for this workspace. Turn on the setting {{setting}}. | Preisänderungen sind für diesen Arbeitsbereich ausgeschaltet. Schalten Sie die Einstellung {{setting}} ein. |  |  |
| `price.caption` | New prices of {{id}} by territory | Neue Preise von {{id}} nach Gebiet |  |  |
| `price.changedCount_one` | {{count}} territory changed (at most {{max}}). | {{count}} Gebiet geändert (höchstens {{max}}). |  |  |
| `price.changedCount_other` | {{count}} territories changed (at most {{max}}). | {{count}} Gebiete geändert (höchstens {{max}}). |  |  |
| `price.colChange` | Change | Änderung |  |  |
| `price.colCurrent` | Now | Aktuell |  |  |
| `price.colNew` | New price | Neuer Preis |  |  |
| `price.convert.amount` | Base price | Basispreis |  |  |
| `price.convert.base` | Base region | Basisregion |  |  |
| `price.convert.done_one` | Filled {{count}} region from Google Play. Check each price. | {{count}} Region von Google Play ausgefüllt. Prüfen Sie jeden Preis. |  |  |
| `price.convert.done_other` | Filled {{count}} regions from Google Play. Check each price. | {{count}} Regionen von Google Play ausgefüllt. Prüfen Sie jeden Preis. |  |  |
| `price.convert.go` | Convert | Umrechnen |  |  |
| `price.convert.help` | Google Play can work out the price of every region from one base price. The numbers are a start: check and edit each one. | Google Play kann den Preis jeder Region aus einem Basispreis berechnen. Die Zahlen sind ein Anfang: Prüfen und bearbeiten Sie jede. |  |  |
| `price.convert.needBase` | Type a different base price first. | Geben Sie zuerst einen anderen Basispreis ein. |  |  |
| `price.convert.title` | Convert from one base price | Aus einem Basispreis umrechnen |  |  |
| `price.date` | Effective date (optional) | Gültig ab (optional) |  |  |
| `price.dateHelp` | Leave empty for as soon as the store allows. Kiln never deletes a price that is already scheduled. | Leer lassen für so früh wie der Store es erlaubt. Kiln löscht nie einen bereits geplanten Preis. |  |  |
| `price.default` | Default | Standard |  |  |
| `price.delay` | Stores can take a while to show a new price everywhere. Nothing is sent from here: the change is staged, and you review and confirm it in the pending changes. | Stores brauchen oft eine Weile, bis ein neuer Preis überall erscheint. Von hier wird nichts gesendet: Die Änderung wird vorgemerkt, und Sie prüfen und bestätigen sie in den ausstehenden Änderungen. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `price.direction.decrease` | down | niedriger |  |  |
| `price.direction.increase` | up | höher |  |  |
| `price.direction.same` | no change | unverändert |  |  |
| `price.edit` | Edit price | Preis bearbeiten |  |  |
| `price.failure.network` | Could not reach the server. Nothing was changed. | Der Server ist nicht erreichbar. Es wurde nichts geändert. |  |  |
| `price.failure.stale` | The product was synced again since you opened it. Reload it and review the prices again. | Das Produkt wurde seit dem Öffnen neu synchronisiert. Laden Sie es neu und prüfen Sie die Preise. |  | review: Rezension (user) vs Prüfung (App Review) |
| `price.failure.withNothing` | {{message}} Nothing was sent to the store. | {{message}} Es wurde nichts an den Store gesendet. |  |  |
| `price.formAria` | Edit the price of {{id}} | Preis von {{id}} bearbeiten |  |  |
| `price.fromTo` | {{from}} to {{to}} | {{from}} auf {{to}} |  |  |
| `price.issue.ackRequired` | This change needs an explicit acknowledgement. | Diese Änderung braucht eine ausdrückliche Bestätigung. |  |  |
| `price.issue.ackUnknown` | Not a known acknowledgement. | Unbekannte Bestätigung. |  |  |
| `price.issue.amountNotPricePoint` | Apple only sells at its price points. This amount is not one. | Apple verkauft nur zu seinen Preisstufen. Dieser Betrag ist keine. |  |  |
| `price.issue.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Ein Betrag muss in ganzen kleinsten Einheiten stehen, etwa 499 für 4,99. |  |  |
| `price.issue.badProduct` | Not a valid product. | Kein gültiges Produkt. |  |  |
| `price.issue.badTerritory` | Not a territory of this store. | Kein Gebiet dieses Stores. |  |  |
| `price.issue.currencyMismatch` | The currency is not the currency of that territory. | Die Währung ist nicht die dieses Gebiets. |  |  |
| `price.issue.dateInvalid` | Not a date: use YYYY-MM-DD. | Kein Datum: verwenden Sie JJJJ-MM-TT. |  |  |
| `price.issue.datePast` | The date is in the past. | Das Datum liegt in der Vergangenheit. |  |  |
| `price.issue.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Dieser Store wendet einen Preis beim Senden an: er lässt sich nicht datieren. |  |  |
| `price.issue.duplicateTerritory` | A territory is named twice. | Ein Gebiet ist doppelt genannt. |  |  |
| `price.issue.noChange` | The new price is the price the store already shows. | Der neue Preis ist der, den der Store bereits zeigt. |  |  |
| `price.issue.noLines` | Name at least one territory. | Nennen Sie mindestens ein Gebiet. |  |  |
| `price.issue.notPositive` | A price must be greater than zero. | Ein Preis muss größer als null sein. |  |  |
| `price.issue.other` | This change has an error. | Diese Änderung enthält einen Fehler. |  |  |
| `price.issue.planMissing` | Name the base plan or purchase option. | Nennen Sie den Basisplan oder die Kaufoption. |  |  |
| `price.issue.planNotAllowed` | This product has no such plan. | Dieses Produkt hat keinen solchen Plan. |  |  |
| `price.issue.pricePointMismatch` | The amount is not the amount of that price point. | Der Betrag ist nicht der dieser Preisstufe. |  |  |
| `price.issue.pricePointMissing` | Apple prices are chosen from price points: pick one. | Apple-Preise werden aus Preisstufen gewählt: wählen Sie eine. |  |  |
| `price.issue.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Google-Play-Preise sind Beträge, keine Preisstufen. |  |  |
| `price.issue.pricePointTerritory` | That price point belongs to another territory. | Diese Preisstufe gehört zu einem anderen Gebiet. |  |  |
| `price.issue.pricePointUnknown` | That price point does not exist for this product. | Diese Preisstufe gibt es für dieses Produkt nicht. |  |  |
| `price.issue.stalePrice` | The price changed since you looked at it. Sync the app and review again. | Der Preis hat sich seit Ihrer Ansicht geändert. Synchronisieren Sie die App und prüfen Sie erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `price.issue.subscriberRule` | That choice for existing subscribers does not exist in this store. | Diese Wahl für bestehende Abonnenten gibt es in diesem Store nicht. |  |  |
| `price.issue.tooHigh` | That price is above the highest price Kiln allows. | Dieser Preis liegt über dem höchsten, den Kiln erlaubt. |  |  |
| `price.issue.tooManyTerritories` | Too many territories in one change. | Zu viele Gebiete in einer Änderung. |  |  |
| `price.issue.unknownTerritory` | The product has no price in that territory. | Das Produkt hat in diesem Gebiet keinen Preis. |  |  |
| `price.loadingPoints` | Reading Apple price points... | Apple-Preisstufen werden gelesen... |  |  |
| `price.nearest` | Nearest price points: {{list}}. | Nächste Preisstufen: {{list}}. |  |  |
| `price.newFor` | New price for {{territory}} in {{currency}} | Neuer Preis für {{territory}} in {{currency}} |  |  |
| `price.noDate` | Google Play applies a price as soon as it is sent. It cannot be dated. | Google Play wendet einen Preis beim Senden an. Er lässt sich nicht datieren. |  |  |
| `price.notPoint` | Not an Apple price point. | Keine Apple-Preisstufe. |  |  |
| `price.openCart` | Open pending changes | Ausstehende Änderungen öffnen |  | cart = "Ausstehende Änderungen" |
| `price.plan` | Plan | Plan |  |  |
| `price.problem.empty` | Type a price. | Geben Sie einen Preis ein. |  |  |
| `price.problem.format` | Not a price. Use digits, for example 4.99. | Kein Preis. Verwenden Sie Ziffern, zum Beispiel 4,99. |  |  |
| `price.problem.precision` | {{currency}} does not have that many decimals. Kiln does not round prices. | {{currency}} hat nicht so viele Dezimalstellen. Kiln rundet keine Preise. |  |  |
| `price.problem.zero` | A price must be greater than zero. | Ein Preis muss größer als null sein. |  |  |
| `price.reload` | Reload the product | Produkt neu laden |  |  |
| `price.replaces` | A price change for this product is already staged. Saving replaces it. | Für dieses Produkt ist schon eine Preisänderung vorgemerkt. Speichern ersetzt sie. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `price.revenueCatNote` | RevenueCat shows these prices read only. Prices are changed in the store, and RevenueCat picks them up from there. | RevenueCat zeigt diese Preise nur lesend. Preise werden im Store geändert, RevenueCat übernimmt sie von dort. |  |  |
| `price.rule.apply` | Move existing subscribers to the new price | Bestehende Abonnenten auf den neuen Preis umstellen |  |  |
| `price.rule.notApplicable` | Not a subscription | Kein Abonnement |  |  |
| `price.rule.optIn` | Ask existing subscribers to accept the new price | Bestehende Abonnenten um Zustimmung zum neuen Preis bitten |  |  |
| `price.rule.optOut` | Move existing subscribers unless they decline | Bestehende Abonnenten umstellen, außer sie lehnen ab |  |  |
| `price.rule.preserve` | Keep existing subscribers at their current price | Bestehende Abonnenten beim aktuellen Preis lassen |  |  |
| `price.ruleHelp.apply` | Existing subscribers move to the new price. The store may notify them or ask for their consent, and some may cancel. | Bestehende Abonnenten wechseln auf den neuen Preis. Der Store kann sie benachrichtigen oder um Zustimmung bitten, und manche kündigen. |  |  |
| `price.ruleHelp.optIn` | Existing subscribers keep their price until they accept the new one. Google Play sends the request. | Bestehende Abonnenten behalten ihren Preis, bis sie den neuen akzeptieren. Google Play sendet die Anfrage. |  |  |
| `price.ruleHelp.optOut` | Existing subscribers move to the new price after Google Play tells them, unless they decline or cancel. | Bestehende Abonnenten wechseln nach der Mitteilung von Google Play auf den neuen Preis, außer sie lehnen ab oder kündigen. |  |  |
| `price.ruleHelp.preserve` | Only new subscribers pay the new price. This is the safe choice. | Nur neue Abonnenten zahlen den neuen Preis. Das ist die sichere Wahl. |  |  |
| `price.stage` | Add to pending changes | Zu ausstehenden Änderungen hinzufügen |  | cart = "Ausstehende Änderungen" |
| `price.stageHelp` | Nothing is sent to the store yet. | Es wird noch nichts an den Store gesendet. |  |  |
| `price.staged` | Added to pending changes. Nothing is sent to the store until you confirm there. | Zu den ausstehenden Änderungen hinzugefügt. Bis Sie dort bestätigen, wird nichts an den Store gesendet. |  | cart = "Ausstehende Änderungen" |
| `price.subscribers` | Existing subscribers | Bestehende Abonnenten |  |  |
| `price.switchOff` | Turn off price changes for this workspace | Preisänderungen für diesen Arbeitsbereich ausschalten |  |  |
| `price.switchOn` | Turn on price changes for this workspace | Preisänderungen für diesen Arbeitsbereich einschalten |  |  |
| `price.tooMany` | More than {{max}} territories in one change. | Mehr als {{max}} Gebiete in einer Änderung. |  |  |
| `price.usePoint` | Use {{amount}} | {{amount}} verwenden |  |  |
| `tab.revenueInInsights` | Subscriptions, MRR and revenue are in Insights. | Abos, MRR und Umsatz finden Sie unter Auswertungen. |  |  |

## web/ratings (101)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `change.noData` | No ratings in this period | Keine Bewertungen in diesem Zeitraum |  | rating = Bewertung |
| `change.noPrevious` | Nothing recorded before this period to compare with | Vor diesem Zeitraum wurde nichts aufgezeichnet, das sich vergleichen ließe |  |  |
| `change.notEnough` | Not enough days with numbers to compare | Zu wenige Tage mit Zahlen für einen Vergleich |  |  |
| `change.oneReading` | Only one reading so far: no change to show yet | Bisher nur eine Messung: noch keine Veränderung zu zeigen |  |  |
| `change.points` | {{text}} points | {{text}} Punkte |  |  |
| `change.same_one` | About the same as the previous day | Ungefähr wie am Vortag |  |  |
| `change.same_other` | About the same as the previous {{count}} days | Ungefähr wie in den vorherigen {{count}} Tagen |  |  |
| `change.sinceDay` | {{text}} since {{date}} | {{text}} seit {{date}} |  |  |
| `change.vsPrevious_one` | {{text}} vs previous day | {{text}} gegenüber dem Vortag |  |  |
| `change.vsPrevious_other` | {{text}} vs previous {{count}} days | {{text}} gegenüber den vorherigen {{count}} Tagen |  |  |
| `chart.average` | Average rating | Durchschnittsbewertung |  | rating = Bewertung |
| `chart.lowReviews` | Low-star reviews per day | Rezensionen mit wenigen Sternen pro Tag |  | review: Rezension (user) vs Prüfung (App Review) |
| `compare.average` | Average rating | Durchschnittsbewertung |  | rating = Bewertung |
| `compare.caption_one` | Ratings and stability by platform, against the previous day | Bewertungen und Stabilität je Plattform, gegenüber dem Vortag |  | rating = Bewertung |
| `compare.caption_other` | Ratings and stability by platform, against the previous {{count}} days | Bewertungen und Stabilität je Plattform, gegenüber den vorherigen {{count}} Tagen |  | rating = Bewertung |
| `compare.change` | Change | Veränderung |  |  |
| `compare.count` | Ratings | Bewertungen |  | rating = Bewertung |
| `compare.crash` | Crash rate | Absturzrate |  |  |
| `compare.freeze` | ANR rate | ANR-Rate |  |  |
| `compare.lowReviews` | Low-star reviews | Rezensionen mit wenigen Sternen |  | review: Rezension (user) vs Prüfung (App Review) |
| `compare.measure` | Measure | Messwert |  |  |
| `count.lowSample` | Low sample: read this with care | Kleine Stichprobe: mit Vorsicht lesen |  |  |
| `count.notGiven` | This store does not give the number of ratings. | Dieser Store nennt keine Anzahl der Bewertungen. |  | rating = Bewertung |
| `count.ratings_one` | {{number}} rating | {{number}} Bewertung |  | rating = Bewertung |
| `count.ratings_other` | {{number}} ratings | {{number}} Bewertungen |  | rating = Bewertung |
| `count.unknown` | Count not provided | Anzahl nicht angegeben |  |  |
| `countries.caption` | Ratings by country for {{platform}} | Bewertungen nach Land für {{platform}} |  | rating = Bewertung |
| `countries.country` | Country | Land |  |  |
| `countries.note` | Kiln reads a few countries per sync, so this is not every country. An average over a small count can swing a lot. | Kiln liest pro Synchronisierung nur einige Länder, die Liste ist also nicht vollständig. Ein Durchschnitt über wenige Bewertungen kann stark schwanken. |  |  |
| `countries.read` | Last read | Zuletzt gelesen |  |  |
| `empty.android` | Google Play gives the average rating in its reports, but no count and no stars. Turn on the Google Play reports in Overview, Data sources, then Sync. | Google Play nennt die Durchschnittsbewertung in seinen Berichten, aber weder Anzahl noch Sterne. Aktivieren Sie die Google-Play-Berichte unter Übersicht, Datenquellen und synchronisieren Sie. |  | rating = Bewertung |
| `empty.error` | Could not read the {{platform}} ratings. Try Sync again. | Die Bewertungen für {{platform}} ließen sich nicht lesen. Synchronisieren Sie erneut. |  | rating = Bewertung |
| `empty.ios` | Apple does not provide rating history. Kiln records one point each time it syncs, so the trend starts with the first sync: run Sync (top right) to begin. | Apple liefert keinen Bewertungsverlauf. Kiln speichert bei jeder Synchronisierung einen Punkt, der Verlauf beginnt also mit der ersten: starten Sie die Synchronisierung (oben rechts). |  | rating = Bewertung |
| `empty.loading` | Reading the {{platform}} ratings… | Bewertungen für {{platform}} werden gelesen … |  | rating = Bewertung |
| `finding.better` | {{measure}} went down in version {{version}} | {{measure}} ist in Version {{version}} gesunken |  |  |
| `finding.detail` | Against version {{previous}}: {{before}}, then {{after}} (from {{from}}). | Gegenüber Version {{previous}}: {{before}}, dann {{after}} (seit {{from}}). |  |  |
| `finding.mentions_one` | {{count}} review since then mentions crashes. | {{count}} Rezension seitdem erwähnt Abstürze. |  | review: Rezension (user) vs Prüfung (App Review) |
| `finding.mentions_other` | {{count}} reviews since then mention crashes. | {{count}} Rezensionen seitdem erwähnen Abstürze. |  | review: Rezension (user) vs Prüfung (App Review) |
| `finding.worse` | {{measure}} went up in version {{version}} | {{measure}} ist in Version {{version}} gestiegen |  |  |
| `note.countDropped` | The number of ratings fell between two readings: stores can remove ratings. That is not counted as new ratings. | Die Anzahl der Bewertungen ist zwischen zwei Messungen gesunken: Stores können Bewertungen entfernen. Das zählt nicht als neue Bewertung. |  | rating = Bewertung |
| `note.gap` | Some days have no reading (no sync): a change between two readings is counted on the later day. | Für einige Tage gibt es keine Messung (keine Synchronisierung): eine Veränderung zwischen zwei Messungen wird dem späteren Tag zugerechnet. |  |  |
| `note.newUnknown` | New ratings need two readings: they appear after the next sync. | Neue Bewertungen brauchen zwei Messungen: sie erscheinen nach der nächsten Synchronisierung. |  | rating = Bewertung |
| `note.noCount` | This store gives neither the number of ratings nor their stars. | Dieser Store nennt weder die Anzahl der Bewertungen noch deren Sterne. |  | rating = Bewertung |
| `note.reset` | The store reset the summary rating in this period: the count starts again from that day. | Der Store hat die Gesamtbewertung in diesem Zeitraum zurückgesetzt: die Zählung beginnt an diesem Tag neu. |  | rating = Bewertung |
| `rail.countries` | Countries | Länder |  |  |
| `rail.group` | Ratings and health | Bewertungen und Stabilität |  | rating = Bewertung |
| `rail.label` | Sections of ratings and health | Abschnitte zu Bewertungen und Stabilität |  | rating = Bewertung |
| `rail.ratings` | Ratings | Bewertungen |  | rating = Bewertung |
| `rail.releases` | Release impact | Wirkung der Releases |  | release = Release |
| `rail.reviews` | Reviews signal | Rezensionssignal |  | review: Rezension (user) vs Prüfung (App Review) |
| `rail.stability` | Stability | Stabilität |  |  |
| `releases.better` | Lower | Niedriger |  |  |
| `releases.caption` | Releases of {{platform}} | Releases von {{platform}} |  | release = Release |
| `releases.crash` | Crash rate | Absturzrate |  |  |
| `releases.crashReviews_one` | {{count}} mentions a crash | {{count}} erwähnt einen Absturz |  |  |
| `releases.crashReviews_other` | {{count}} mention crashes | {{count}} erwähnen Abstürze |  |  |
| `releases.day` | First seen | Erstmals gesehen |  |  |
| `releases.lead` | How stability and the rating moved around each release. A before and after comparison, never proof of cause: other things change at the same time. | Wie sich Stabilität und Bewertung rund um jedes Release bewegt haben. Ein Vorher-nachher-Vergleich, nie ein Beleg für die Ursache: gleichzeitig ändert sich anderes. |  | release = Release; rating = Bewertung |
| `releases.legend` | Crash rate: the previous version, then this one. Rating: the 14 days before the release, then 7 to 14 days after it. | Absturzrate: vorherige Version, dann diese. Bewertung: die 14 Tage vor der Version, dann 7 bis 14 Tage danach. |  | release = Release; rating = Bewertung |
| `releases.noHistory` | No readings | Keine Messung |  |  |
| `releases.noHistoryTitle` | No readings around this day | Keine Messungen um diesen Tag |  |  |
| `releases.rating` | Rating | Bewertung |  | rating = Bewertung |
| `releases.reviews` | Reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `releases.tooEarly` | Too early | Zu früh |  |  |
| `releases.tooEarlyTitle` | Too early: the release is under 7 days old | Zu früh: die Version ist jünger als 7 Tage |  | release = Release |
| `releases.version` | Version | Version |  |  |
| `releases.worse` | Higher | Höher |  |  |
| `reviews.empty` | No written reviews in this period for {{platform}}. Sync reviews to read new ones. | Keine geschriebenen Rezensionen in diesem Zeitraum für {{platform}}. Synchronisieren Sie die Rezensionen, um neue zu lesen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `reviews.lead` | The written reviews Kiln stored in this period. Low means {{max}} stars or fewer. These are reviews with text, not every rating. | Die geschriebenen Rezensionen, die Kiln in diesem Zeitraum gespeichert hat. Wenige Sterne heißt höchstens {{max}}. Das sind Rezensionen mit Text, nicht alle Bewertungen. |  | review: Rezension (user) vs Prüfung (App Review); rating = Bewertung |
| `reviews.lowOf_one` | {{low}} of {{count}} review | {{low}} von {{count}} Rezension |  | review: Rezension (user) vs Prüfung (App Review) |
| `reviews.lowOf_other` | {{low}} of {{count}} reviews | {{low}} von {{count}} Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `reviews.open` | Open the low-star reviews | Rezensionen mit wenigen Sternen öffnen |  | review: Rezension (user) vs Prüfung (App Review) |
| `since.android` | Google Play gives no rating history through its API: this trend comes from its daily reports, as recorded since {{date}}. | Google Play liefert über seine API keinen Verlauf: dieser Verlauf stammt aus den Tagesberichten, aufgezeichnet seit {{date}}. |  | rating = Bewertung |
| `since.ios` | Apple gives no rating history: Kiln records one point per sync, from {{date}}. Earlier days are not available. | Apple liefert keinen Verlauf: Kiln speichert einen Punkt pro Synchronisierung, seit {{date}}. Frühere Tage sind nicht verfügbar. |  | rating = Bewertung |
| `since.oneReading` | Only one reading so far, so there is no trend yet. A point is added at each sync. | Bisher nur eine Messung, daher noch kein Verlauf. Bei jeder Synchronisierung kommt ein Punkt hinzu. |  |  |
| `stability.coverage_one` | Only {{days}} of the last day has numbers. | Nur {{days}} vom letzten Tag hat Zahlen. |  |  |
| `stability.coverage_other` | Only {{days}} of the last {{count}} days have numbers. | Nur {{days}} der letzten {{count}} Tage haben Zahlen. |  |  |
| `stability.error` | The last read of the {{platform}} crash numbers failed. Open data sources for the reason, then Sync. | Das letzte Lesen der Absturzzahlen für {{platform}} ist fehlgeschlagen. Den Grund finden Sie unter Datenquellen, dann synchronisieren. |  |  |
| `stability.noneAndroid` | No crash or ANR numbers for {{platform}} yet. They come from Android vitals (the Play Developer Reporting API): turn them on in data sources, then Sync. | Noch keine Absturz- oder ANR-Zahlen für {{platform}}. Sie stammen aus Android Vitals (Play Developer Reporting API): aktivieren Sie sie unter Datenquellen und synchronisieren Sie. |  |  |
| `stability.noneIos` | No crash numbers for {{platform}} yet. Apple sends them with App Analytics, for people who opted in, and only for days with at least five crashing users. Turn on analytics, then Sync. | Noch keine Absturzzahlen für {{platform}}. Apple sendet sie mit App Analytics, nur für Personen mit Einwilligung und nur für Tage mit mindestens fünf betroffenen Nutzern. Aktivieren Sie die Analysen und synchronisieren Sie. |  |  |
| `stability.noteAndroid` | Google Play reports the share of users with a crash or an ANR, for users who opted in. | Google Play nennt den Anteil der Nutzer mit Absturz oder ANR, unter denen mit Einwilligung. |  |  |
| `stability.noteIos` | Apple counts only people who shared analytics, and sends crash numbers only for days with at least five crashing users: a day without a number is not a day without crashes. | Apple zählt nur Personen, die Analysen teilen, und sendet Abstürze nur für Tage mit mindestens fünf betroffenen Nutzern: ein Tag ohne Zahl ist kein Tag ohne Abstürze. |  |  |
| `stability.openSources` | Open data sources | Datenquellen öffnen |  |  |
| `stability.setup` | Crash numbers for {{platform}} are not set up yet: the store source behind them is off or needs a permission. | Die Absturzzahlen für {{platform}} sind noch nicht eingerichtet: die Quelle im Store ist aus oder braucht eine Berechtigung. |  |  |
| `stars.label_one` | {{count}} star | {{count}} Stern |  |  |
| `stars.label_other` | {{count}} stars | {{count}} Sterne |  |  |
| `stars.title_one` | New ratings by stars ({{count}} rating) | Neue Bewertungen nach Sternen ({{count}} Bewertung) |  | rating = Bewertung |
| `stars.title_other` | New ratings by stars ({{count}} ratings) | Neue Bewertungen nach Sternen ({{count}} Bewertungen) |  | rating = Bewertung |
| `tile.average` | Average rating | Durchschnittsbewertung |  | rating = Bewertung |
| `tile.averageTitle` | The rating the store shows now, from the latest reading Kiln made | Die Bewertung, die der Store jetzt zeigt, laut der letzten Messung von Kiln |  | rating = Bewertung |
| `tile.count` | Ratings | Bewertungen |  | rating = Bewertung |
| `tile.countTitle` | How many people rated the app, from the latest reading | Wie viele Personen die App bewertet haben, laut der letzten Messung |  |  |
| `tile.crash` | Crash rate | Absturzrate |  |  |
| `tile.freeze` | ANR rate | ANR-Rate |  |  |
| `tile.lowReviews` | Low-star reviews | Rezensionen mit wenigen Sternen |  | review: Rezension (user) vs Prüfung (App Review) |
| `tile.lowTitle` | Written reviews with {{max}} stars or fewer | Geschriebene Rezensionen mit höchstens {{max}} Sternen |  | review: Rezension (user) vs Prüfung (App Review) |
| `tile.new` | New ratings | Neue Bewertungen |  | rating = Bewertung |
| `tile.newTitle` | Ratings added in this period: the difference between two readings of the store | In diesem Zeitraum hinzugekommene Bewertungen: der Unterschied zwischen zwei Messungen des Stores |  | rating = Bewertung |
| `tile.rateTitle` | Mean of the {{days}} days with numbers in this period | Mittelwert der {{days}} Tage mit Zahlen in diesem Zeitraum |  |  |
| `tile.reviews` | Written reviews | Geschriebene Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `tile.reviewsTitle` | Reviews with text that Kiln stored in this period (not the same as ratings) | Rezensionen mit Text, die Kiln in diesem Zeitraum gespeichert hat (nicht dasselbe wie Bewertungen) |  | review: Rezension (user) vs Prüfung (App Review); rating = Bewertung |

## web/release-stepper (57)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `ap.allStaged` | All the store asset changes of the repository are in your pending changes. | Alle Änderungen der Store-Inhalte aus dem Repository sind in Ihren ausstehenden Änderungen. |  | cart = "Ausstehende Änderungen" |
| `ap.checking` | Checking the repository for changed store assets | Das Repository wird auf geänderte Store-Inhalte geprüft |  |  |
| `ap.confirm.body_one` | {{count}} of the selected items has errors. A store may refuse it when the changes are published. Stage it anyway? | {{count}} der ausgewählten Einträge hat Fehler. Ein Store kann ihn beim Veröffentlichen der Änderungen ablehnen. Trotzdem bereitstellen? |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.confirm.body_other` | {{count}} of the selected items have errors. A store may refuse them when the changes are published. Stage them anyway? | {{count}} der ausgewählten Einträge haben Fehler. Ein Store kann sie beim Veröffentlichen der Änderungen ablehnen. Trotzdem bereitstellen? |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.confirm.title` | Stage items that have errors? | Einträge mit Fehlern bereitstellen? |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.confirm.yes` | Stage anyway | Trotzdem bereitstellen |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.doneFailed_one` | {{count}} item could not be staged. | {{count}} Eintrag konnte nicht bereitgestellt werden. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.doneFailed_other` | {{count}} items could not be staged. | {{count}} Einträge konnten nicht bereitgestellt werden. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.doneLeft_one` | {{count}} item was already staged and was left as it is. | {{count}} Eintrag war bereits bereitgestellt und blieb unverändert. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.doneLeft_other` | {{count}} items were already staged and were left as they are. | {{count}} Einträge waren bereits bereitgestellt und blieben unverändert. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.done_one` | {{count}} item staged. Nothing was sent to a store. | {{count}} Eintrag bereitgestellt. Es wurde nichts an einen Store gesendet. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.done_other` | {{count}} items staged. Nothing was sent to a store. | {{count}} Einträge bereitgestellt. Es wurde nichts an einen Store gesendet. |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.issues.errorWord` | Error | Fehler |  |  |
| `ap.issues.errors_one` | {{count}} error | {{count}} Fehler |  |  |
| `ap.issues.errors_other` | {{count}} errors | {{count}} Fehler |  |  |
| `ap.issues.none` | No problems found in these texts and graphics. | In diesen Texten und Grafiken wurden keine Probleme gefunden. |  |  |
| `ap.issues.tipWord` | Tip | Tipp |  |  |
| `ap.issues.tips_one` | {{count}} tip | {{count}} Tipp |  |  |
| `ap.issues.tips_other` | {{count}} tips | {{count}} Tipps |  |  |
| `ap.issues.title` | Checked before you stage | Vor dem Bereitstellen geprüft |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.issues.warningWord` | Warning | Warnung |  |  |
| `ap.issues.warnings_one` | {{count}} warning | {{count}} Warnung |  |  |
| `ap.issues.warnings_other` | {{count}} warnings | {{count}} Warnungen |  |  |
| `ap.item.empty` | nothing | nichts |  |  |
| `ap.item.hasIssues` | Has issues | Hat Probleme |  |  |
| `ap.item.repo` | Repository | Repository |  |  |
| `ap.item.selectAria` | Stage {{item}} ({{locale}}) | {{item}} ({{locale}}) bereitstellen |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.item.store` | Store | Store |  |  |
| `ap.items.title` | Changes to stage | Bereitzustellende Änderungen |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.later` | Remind me later | Später erinnern |  |  |
| `ap.laterLine_one` | {{count}} store asset change is waiting for your decision. | {{count}} Änderung der Store-Inhalte wartet auf Ihre Entscheidung. |  |  |
| `ap.laterLine_other` | {{count}} store asset changes are waiting for your decision. | {{count}} Änderungen der Store-Inhalte warten auf Ihre Entscheidung. |  |  |
| `ap.lead` | Texts and graphics that changed in the repository since the previous release and still differ from the store. Staging only adds them to your pending changes: nothing is sent to a store. | Texte und Grafiken, die sich seit der vorherigen Version im Repository geändert haben und sich noch vom Store unterscheiden. Beim Bereitstellen werden sie nur zu Ihren ausstehenden Änderungen hinzugefügt: Es wird nichts an einen Store gesendet. |  | cart = "Ausstehende Änderungen"; stage = vormerken / vorbereiten (nothing is sent) |
| `ap.loadFailed` | Could not check the repository for changed store assets | Das Repository konnte nicht auf geänderte Store-Inhalte geprüft werden |  |  |
| `ap.locked` | The listing is locked: a version is live or in App Review. Prepare a new version first, then these changes can be staged. | Der Eintrag ist gesperrt: Eine Version ist live oder in der App-Prüfung. Bereiten Sie zuerst eine neue Version vor, dann können diese Änderungen bereitgestellt werden. |  | stage = vormerken / vorbereiten (nothing is sent); listing = Store-Eintrag |
| `ap.notListed` | Not listed: {{unchanged}} unchanged since the last release, {{same}} identical to the store, {{other}} that cannot be staged (for example the App Store name and subtitle). | Nicht aufgelistet: {{unchanged}} seit der letzten Version unverändert, {{same}} identisch mit dem Store, {{other}} nicht bereitstellbar (zum Beispiel Name und Untertitel im App Store). |  | stage = vormerken / vorbereiten (nothing is sent); release = Release |
| `ap.openCart` | Open pending changes | Ausstehende Änderungen öffnen |  | cart = "Ausstehende Änderungen" |
| `ap.refs` | Compared: the previous release ({{base}}) with this release ({{target}}). | Verglichen: die vorherige Version ({{base}}) mit dieser Version ({{target}}). |  | release = Release |
| `ap.refsBranch` | Compared: the previous release ({{base}}) with the default branch ({{target}}), because no build is chosen for this release yet. | Verglichen: die vorherige Version ({{base}}) mit dem Standard-Branch ({{target}}), weil für diese Version noch kein Build gewählt ist. |  | release = Release |
| `ap.refsNoBase` | No previous release found: everything in the repository ({{target}}) that differs from the store is listed. | Keine vorherige Version gefunden: Alles im Repository ({{target}}), was sich vom Store unterscheidet, wird aufgelistet. |  | release = Release |
| `ap.review` | Review | Prüfen |  | review: Rezension (user) vs Prüfung (App Review) |
| `ap.show` | Show again | Wieder anzeigen |  |  |
| `ap.skip` | Skip for this release | Für diese Version überspringen |  | release = Release |
| `ap.skippedLine` | Store asset changes skipped for this release. | Änderungen der Store-Inhalte für diese Version übersprungen. |  | release = Release |
| `ap.stage` | Stage selected ({{count}}) | Auswahl bereitstellen ({{count}}) |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.staged.edited` | Already staged with your edit, kept as it is | Bereits mit Ihrer Änderung bereitgestellt, bleibt unverändert |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.staged.same` | Already staged | Bereits bereitgestellt |  | stage = vormerken / vorbereiten (nothing is sent) |
| `ap.staged.title` | Already in your pending changes | Bereits in Ihren ausstehenden Änderungen |  | cart = "Ausstehende Änderungen" |
| `ap.storeUnread` | The graphics in the store could not be read, so graphics are listed by what changed in the repository alone. | Die Grafiken im Store konnten nicht gelesen werden, daher werden Grafiken nur nach den Änderungen im Repository aufgelistet. |  |  |
| `ap.sum.graphics_one` | {{count}} graphics set | {{count}} Grafiksatz |  |  |
| `ap.sum.graphics_other` | {{count}} graphics sets | {{count}} Grafiksätze |  |  |
| `ap.sum.locales_one` | in {{count}} language | in {{count}} Sprache |  |  |
| `ap.sum.locales_other` | in {{count}} languages | in {{count}} Sprachen |  |  |
| `ap.sum.texts_one` | {{count}} text | {{count}} Text |  |  |
| `ap.sum.texts_other` | {{count}} texts | {{count}} Texte |  |  |
| `ap.title` | Store assets changed in the repository | Im Repository geänderte Store-Inhalte |  |  |
| `ap.truncated` | Only the first items are listed. | Nur die ersten Einträge werden aufgelistet. |  |  |

## web/reviews (24)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `ai.regenerate` | Summarise again | Erneut zusammenfassen |  |  |
| `ai.staleMany_one` | More than {{count}} review came in after this summary. Summarise again to include them. | Mehr als {{count}} Rezension kam nach dieser Zusammenfassung. Fassen Sie erneut zusammen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `ai.staleMany_other` | {{count}} or more reviews came in after this summary. Summarise again to include them. | {{count}} oder mehr Rezensionen kamen nach dieser Zusammenfassung. Fassen Sie erneut zusammen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `ai.stale_one` | {{count}} review came in after this summary. Summarise again to include it. | {{count}} Rezension kam nach dieser Zusammenfassung. Fassen Sie erneut zusammen, um sie einzubeziehen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `ai.stale_other` | {{count}} reviews came in after this summary. Summarise again to include them. | {{count}} Rezensionen kamen nach dieser Zusammenfassung. Fassen Sie erneut zusammen, um sie einzubeziehen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `ai.summaryNotice` | A summary reads at most {{reviews}} reviews of the period (the newest and some of the lowest-rated), {{chars}} characters each. Names, emails, links and phone numbers are removed; the reviewer, the device and the country are never sent. The same reviews reuse the stored summary. | Eine Zusammenfassung liest höchstens {{reviews}} Rezensionen des Zeitraums (die neuesten und einige der schlechtesten), je {{chars}} Zeichen. Namen, E-Mail-Adressen, Links und Telefonnummern werden entfernt; Autor, Gerät und Land werden nie gesendet. Dieselben Rezensionen verwenden die gespeicherte Zusammenfassung erneut. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.actions` | Actions | Aktionen |  |  |
| `competitors.app` | App | App |  |  |
| `competitors.average` | Average | Durchschnitt |  |  |
| `competitors.caption` | Reviews of this app and of the followed competitors | Rezensionen dieser App und der verfolgten Wettbewerber |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.count` | Reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.lead` | Public App Store reviews of the competitors you follow, read from Apple's customer reviews feed when you press Read and kept for {{days}} days. The reviewer is never stored. Nothing here is sent to an AI model. | Öffentliche App-Store-Rezensionen der Wettbewerber, denen Sie folgen, gelesen aus dem Kundenrezensions-Feed von Apple, wenn Sie auf Lesen drücken, und {{days}} Tage gespeichert. Der Verfasser wird nie gespeichert. Nichts davon wird an ein KI-Modell gesendet. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.noneFollowed` | No competitors followed yet. Follow an App Store app in the ASO competitors list, then read its reviews here. | Noch keine Wettbewerber verfolgt. Folgen Sie einer App-Store-App in der ASO-Wettbewerberliste und lesen Sie hier ihre Rezensionen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.periodLabel` | Period of the comparison | Zeitraum des Vergleichs |  |  |
| `competitors.playNote` | Google Play competitors are not available: Google offers no official way to read the reviews of an app you do not own, and Kiln does not scrape its pages. | Wettbewerber aus Google Play sind nicht verfügbar: Google bietet keinen offiziellen Weg, die Rezensionen einer fremden App zu lesen, und Kiln ruft ihre Seiten nicht ab. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.read` | Read | Lesen |  |  |
| `competitors.readAt` | read {{time}} | gelesen {{time}} |  |  |
| `competitors.readDone_one` | {{count}} review stored. | {{count}} Rezension gespeichert. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.readDone_other` | {{count}} reviews stored. | {{count}} Rezensionen gespeichert. |  | review: Rezension (user) vs Prüfung (App Review) |
| `competitors.recent` | Read a few minutes ago: nothing new was asked of the App Store. | Vor wenigen Minuten gelesen: beim App Store wurde nichts Neues angefragt. |  |  |
| `competitors.thisApp` | This app | Diese App |  |  |
| `competitors.title` | Competitors | Wettbewerber |  |  |
| `competitors.trend` | First half, second half | Erste Hälfte, zweite Hälfte |  |  |
| `competitors.unavailable` | Not available for Google Play. | Für Google Play nicht verfügbar. |  |  |

## web/settings (31)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `group.ai` | AI | KI |  |  |
| `group.integrations` | Integrations | Integrationen |  |  |
| `group.personal` | Just for you | Nur für Sie |  |  |
| `group.security` | Security | Sicherheit |  |  |
| `group.workspace` | Workspace | Arbeitsbereich |  |  |
| `keywords.ai` | assistant model key provider monthly limit openai anthropic | assistent modell schlüssel anbieter monatslimit openai anthropic |  |  |
| `keywords.analytics` | opt-in vendor number apple play bucket reports | opt-in anbieternummer apple play bucket berichte |  |  |
| `keywords.chat` | slack teams webhook channel notifications digest alerts routing | slack teams webhook kanal benachrichtigungen zusammenfassung warnungen weiterleitung |  |  |
| `keywords.confirm` | hard actions step-up password recovery codes confirm | kritische aktionen erneute bestätigung passwort wiederherstellungscodes bestätigen |  |  |
| `keywords.language` | locale french spanish german english display | sprache locale französisch spanisch deutsch englisch anzeige |  |  |
| `keywords.mail` | smtp email server host port sender | smtp e-mail server host port absender |  |  |
| `keywords.mcp` | mcp connect assistant claude tools token | mcp verbinden assistent claude werkzeuge token |  |  |
| `keywords.releases` | unfinished release days stuck reminder | unfertige version tage hängend erinnerung |  | release = Release |
| `keywords.reviews` | ratings low rating threshold reminder unanswered replies | bewertungen rezensionen schwelle niedrige bewertung erinnerung unbeantwortet antworten |  | rating = Bewertung |
| `keywords.secondFactor` | two-factor 2fa authenticator totp email code | zwei-faktor 2fa authenticator totp e-mail code |  |  |
| `keywords.storeRefresh` | sync interval schedule refresh stores alerts review state | synchronisierung intervall zeitplan aktualisierung stores warnungen prüfstatus |  | review: Rezension (user) vs Prüfung (App Review) |
| `keywords.translation` | translate provider deepl google target language budget | übersetzung anbieter deepl google zielsprache budget |  |  |
| `keywords.webhooks` | http callback events signing endpoint | http rückruf ereignisse signatur endpunkt |  |  |
| `nav.label` | Settings sections | Bereiche der Einstellungen |  |  |
| `nav.noMatch` | No section matches “{{query}}”. | Kein Bereich passt zu „{{query}}“. |  |  |
| `nav.search` | Search settings | Einstellungen suchen |  |  |
| `nav.searchLabel` | Search the settings sections | Bereiche der Einstellungen durchsuchen |  |  |
| `nav.unsaved` | Unsaved changes | Nicht gespeicherte Änderungen |  |  |
| `nav.unsavedWithLink` | You have unsaved workspace changes. They stay until you save or discard them there. <link>Go to the workspace settings</link>. | Sie haben nicht gespeicherte Änderungen am Arbeitsbereich. Sie bleiben erhalten, bis Sie sie dort speichern oder verwerfen. <link>Zu den Einstellungen des Arbeitsbereichs</link>. |  |  |
| `page.otherSectionAnalytics` | A value in Analytics is not valid. Fix it there, then save. | Ein Wert im Bereich Analytics ist ungültig. Korrigieren Sie ihn dort und speichern Sie dann. |  |  |
| `page.otherSectionWorkspace` | A value in another workspace section is not valid. Fix it there, then save. | Ein Wert in einem anderen Bereich des Arbeitsbereichs ist ungültig. Korrigieren Sie ihn dort und speichern Sie dann. |  |  |
| `section.ai` | AI assistant | KI-Assistent |  |  |
| `section.analytics` | Analytics | Analytics |  |  |
| `section.chat` | Slack and Teams | Slack und Teams |  |  |
| `section.language` | Language | Sprache |  |  |
| `section.mcp` | Connect an AI assistant | KI-Assistenten verbinden |  |  |

## web/shell (4)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `nav.chat` | Slack and Teams | Slack und Teams |  |  |
| `nav.collapse` | Collapse the navigation to icons | Navigation auf Symbole verkleinern |  |  |
| `nav.expand` | Expand the navigation | Navigation aufklappen |  |  |
| `shortcut.any.sidebar` | Fold or unfold the left panel | Linkes Panel ein- oder ausklappen |  |  |

## web/testflight (130)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `build.both` | {{version}} (build {{build}}) | {{version}} (Build {{build}}) |  |  |
| `build.number` | Build {{build}} | Build {{build}} |  |  |
| `build.unknown` | Unknown build | Unbekannter Build |  |  |
| `connection.mobileData` | Mobile data | Mobilfunk |  |  |
| `connection.none` | No connection | Keine Verbindung |  |  |
| `connection.unknown` | Unknown | Unbekannt |  |  |
| `connection.wifi` | Wi-Fi | WLAN |  |  |
| `connection.wire` | Wired | Kabelgebunden |  |  |
| `console.body` | Screenshots are not shown here (the page does not load images from other sites). Open them from the detail, or in App Store Connect, under TestFlight, Feedback. | Screenshots werden hier nicht angezeigt (die Seite lädt keine Bilder von anderen Seiten). Öffnen Sie sie in den Details oder in App Store Connect unter TestFlight, Feedback. |  |  |
| `console.title` | The full list is also in App Store Connect | Die vollständige Liste gibt es auch in App Store Connect |  |  |
| `crash.copy` | Copy the log | Protokoll kopieren |  |  |
| `crash.heading` | Crash log | Absturzprotokoll |  |  |
| `crash.hide` | Hide the log | Protokoll ausblenden |  |  |
| `crash.missing` | Apple has no crash log for this submission. | Apple hat kein Absturzprotokoll zu dieser Einsendung. |  | submit = einreichen / senden |
| `crash.noLog` | The crash log has not been read yet. It is read by the next sync. | Das Absturzprotokoll wurde noch nicht gelesen. Die nächste Synchronisierung liest es. |  |  |
| `crash.noteAddresses` | The first frame is an address, not a name: this log is probably not symbolicated. Symbolicate it with the dSYM of the build. | Der erste Frame ist eine Adresse, kein Name: Dieses Protokoll ist wahrscheinlich nicht symbolisiert. Symbolisieren Sie es mit der dSYM des Builds. |  |  |
| `crash.noteSymbols` | The first frame has a name. The rest of the log is shown as Apple gave it; Kiln does not check whether every frame is symbolicated. | Der erste Frame hat einen Namen. Der Rest des Protokolls wird so angezeigt, wie Apple ihn geliefert hat; Kiln prüft nicht, ob jeder Frame symbolisiert ist. |  |  |
| `crash.noteUnknown` | Kiln could not read the layout of this log. It is shown as Apple gave it, and may or may not be symbolicated. | Kiln konnte das Format dieses Protokolls nicht lesen. Es wird so angezeigt, wie Apple es geliefert hat, und ist möglicherweise symbolisiert oder nicht. |  |  |
| `crash.show` | Show the log | Protokoll anzeigen |  |  |
| `crash.signature` | Signature | Signatur |  |  |
| `crash.signatureHint` | Kiln groups crashes by the exception and the first frame of the crashed thread. | Kiln gruppiert Abstürze nach der Ausnahme und dem ersten Frame des abgestürzten Threads. |  |  |
| `crash.truncated` | The log was cut at 64 KB. | Das Protokoll wurde bei 64 KB abgeschnitten. |  |  |
| `detail.assignee` | Assignee | Zugewiesen an |  |  |
| `detail.changedBy` | Changed {{ago}} | Geändert {{ago}} |  |  |
| `detail.close` | Close | Schließen |  |  |
| `detail.comment` | Comment | Kommentar |  |  |
| `detail.deviceHeading` | Tester and device | Tester und Gerät |  |  |
| `detail.emailHidden` | The email address is shown to administrators only. | Die E-Mail-Adresse sehen nur Administratoren. |  |  |
| `detail.formerMember` | A former member | Ein ehemaliges Mitglied |  |  |
| `detail.loadError` | The details could not be read. | Die Details konnten nicht gelesen werden. |  |  |
| `detail.loading` | Reading the details | Details werden gelesen |  |  |
| `detail.nobody` | Nobody | Niemand |  |  |
| `detail.note` | Internal note | Interne Notiz |  |  |
| `detail.noteHint` | Only your team sees it. It is never sent to Apple. | Nur Ihr Team sieht sie. Sie wird nie an Apple gesendet. |  |  |
| `detail.save` | Save | Speichern |  |  |
| `detail.saveFailed` | The change could not be saved. | Die Änderung konnte nicht gespeichert werden. |  |  |
| `detail.saved` | Saved. | Gespeichert. |  |  |
| `detail.screenshotsCount_one` | {{count}} screenshot. Apple's links expire after a short time, so they are read when you ask. | {{count}} Screenshot. Die Links von Apple laufen nach kurzer Zeit ab, deshalb werden sie auf Anfrage gelesen. |  |  |
| `detail.screenshotsCount_other` | {{count}} screenshots. Apple's links expire after a short time, so they are read when you ask. | {{count}} Screenshots. Die Links von Apple laufen nach kurzer Zeit ab, deshalb werden sie auf Anfrage gelesen. |  |  |
| `detail.screenshotsExpire` | The links expire {{when}}. Ask again if they stopped working. | Die Links laufen {{when}} ab. Rufen Sie sie erneut ab, wenn sie nicht mehr funktionieren. |  |  |
| `detail.screenshotsFailed` | The screenshot links could not be read. | Die Screenshot-Links konnten nicht gelesen werden. |  |  |
| `detail.screenshotsHeading` | Screenshots | Screenshots |  |  |
| `detail.screenshotsLoad` | Get the screenshot links | Screenshot-Links abrufen |  |  |
| `detail.screenshotsNoLinks` | Apple gave no link for this feedback. It may have been deleted in App Store Connect. | Apple hat keinen Link für dieses Feedback geliefert. Es wurde möglicherweise in App Store Connect gelöscht. |  |  |
| `detail.screenshotsNone` | This feedback has no screenshot. | Dieses Feedback hat keinen Screenshot. |  |  |
| `detail.screenshotsOpen` | Open screenshot {{number}} | Screenshot {{number}} öffnen |  |  |
| `detail.status` | Status | Status |  |  |
| `detail.tester` | Tester | Tester |  |  |
| `detail.title` | Details | Details |  |  |
| `detail.triageHeading` | Triage | Sichtung |  |  |
| `empty.crashDescription` | No tester has sent a crash report yet, or none matches the filters. Good news, if you have testers. | Noch kein Tester hat einen Absturzbericht gesendet, oder keiner passt zu den Filtern. Gute Nachricht, wenn Sie Tester haben. |  |  |
| `empty.crashTitle` | No crashes | Keine Abstürze |  |  |
| `empty.feedbackDescription` | No tester has sent feedback with a screenshot yet, or none matches the filters. Testers send it from TestFlight: take a screenshot, then Share Beta Feedback. | Noch kein Tester hat Feedback mit Screenshot gesendet, oder keines passt zu den Filtern. Tester senden es aus TestFlight: Screenshot aufnehmen, dann Beta-Feedback teilen. |  |  |
| `empty.feedbackTitle` | No feedback | Kein Feedback |  |  |
| `empty.neverDescription` | Sync to read the feedback and crashes your testers sent from TestFlight. The app must have been distributed with TestFlight, and the App Store Connect key needs the Admin, App Manager or Developer role. | Synchronisieren Sie, um das Feedback und die Abstürze zu lesen, die Ihre Tester aus TestFlight gesendet haben. Die App muss über TestFlight verteilt worden sein, und der App-Store-Connect-Schlüssel braucht die Rolle Admin, App Manager oder Developer. |  |  |
| `empty.neverTitle` | Nothing read yet | Noch nichts gelesen |  |  |
| `fact.architecture` | Architecture | Architektur |  |  |
| `fact.battery` | Battery | Akku |  |  |
| `fact.bundle` | Bundle id | Bundle-ID |  |  |
| `fact.connection` | Connection | Verbindung |  |  |
| `fact.device` | Device | Gerät |  |  |
| `fact.disk` | Free disk space | Freier Speicher |  |  |
| `fact.diskValue` | {{free}} of {{total}} | {{free}} von {{total}} |  |  |
| `fact.family` | Device family | Gerätefamilie |  |  |
| `fact.locale` | Language | Sprache |  |  |
| `fact.screen` | Screen (points) | Bildschirm (Punkte) |  |  |
| `fact.sent` | Sent | Gesendet |  |  |
| `fact.timeZone` | Time zone | Zeitzone |  |  |
| `fact.uptime` | App uptime | Laufzeit der App |  |  |
| `fact.watch` | Paired watch | Gekoppelte Uhr |  |  |
| `filter.all` | All | Alle |  |  |
| `filter.build` | Build | Build |  |  |
| `filter.clear` | Clear filters | Filter zurücksetzen |  |  |
| `filter.label` | Filters | Filter |  |  |
| `filter.open` | Open | Offen |  |  |
| `filter.signature` | Showing one crash group | Eine einzelne Absturzgruppe wird angezeigt |  |  |
| `filter.status` | Status | Status |  |  |
| `filter.tester` | Tester | Tester |  |  |
| `filter.version` | Version | Version |  |  |
| `groups.builds` | Builds: {{builds}} | Builds: {{builds}} |  |  |
| `groups.byBuild` | By build | Nach Build |  |  |
| `groups.bySignature` | By signature | Nach Signatur |  |  |
| `groups.count_one` | {{count}} crash | {{count}} Absturz |  |  |
| `groups.count_other` | {{count}} crashes | {{count}} Abstürze |  |  |
| `groups.heading` | Crashes by build and by signature | Abstürze nach Build und Signatur |  |  |
| `groups.loadError` | The groups could not be read. | Die Gruppen konnten nicht gelesen werden. |  |  |
| `groups.open` | {{count}} open | {{count}} offen |  |  |
| `groups.show` | Show these crashes | Diese Abstürze anzeigen |  |  |
| `groups.unknown` | No signature (log not read, or an unknown layout) | Ohne Signatur (Protokoll nicht gelesen oder unbekanntes Format) |  |  |
| `kind.crash` | Crashes | Abstürze |  |  |
| `kind.feedback` | Feedback | Feedback |  |  |
| `list.colBuild` | Build | Build |  |  |
| `list.colComment` | Comment | Kommentar |  |  |
| `list.colSent` | Sent | Gesendet |  |  |
| `list.colStatus` | Status | Status |  |  |
| `list.colTester` | Tester | Tester |  |  |
| `list.more` | Load more | Mehr laden |  |  |
| `list.noComment` | No comment | Kein Kommentar |  |  |
| `list.screenshots_one` | {{count}} screenshot | {{count}} Screenshot |  |  |
| `list.screenshots_other` | {{count}} screenshots | {{count}} Screenshots |  |  |
| `status.ignored` | Ignored | Ignoriert |  |  |
| `status.inProgress` | In progress | In Bearbeitung |  |  |
| `status.new` | New | Neu |  |  |
| `status.resolved` | Resolved | Gelöst |  |  |
| `status.seen` | Seen | Gesehen |  |  |
| `sync.failedKept` | The last read failed ({{error}}). What is shown was read {{ago}}. | Das letzte Lesen ist fehlgeschlagen ({{error}}). Was angezeigt wird, wurde {{ago}} gelesen. |  |  |
| `sync.failedNothing` | The last read failed: {{error}} | Das letzte Lesen ist fehlgeschlagen: {{error}} |  |  |
| `sync.never` | Never read. Sync to read the TestFlight feedback. | Noch nie gelesen. Synchronisieren Sie, um das TestFlight-Feedback zu lesen. |  |  |
| `sync.partial` | Read {{ago}}, but only the newest submissions: Apple may have older ones. | Gelesen {{ago}}, aber nur die neuesten Einsendungen: Apple hat möglicherweise ältere. |  | submit = einreichen / senden |
| `sync.read` | Read {{ago}}. | Gelesen {{ago}}. |  |  |
| `tab.about` | About this view | Über diese Ansicht |  |  |
| `tab.aboutBody` | Kiln reads the feedback and crash reports your testers send from TestFlight, keeps a copy here, and lets your team triage them. It never deletes or changes anything in App Store Connect. | Kiln liest das Feedback und die Absturzberichte, die Ihre Tester aus TestFlight senden, speichert hier eine Kopie und lässt Ihr Team sie sichten. Es löscht oder ändert nie etwas in App Store Connect. |  |  |
| `tab.aboutRequirements` | Needed: the app has been distributed with TestFlight, and its App Store Connect key has the Admin, App Manager or Developer role. | Voraussetzung: Die App wurde über TestFlight verteilt, und der App-Store-Connect-Schlüssel hat die Rolle Admin, App Manager oder Developer. |  |  |
| `tab.aboutRetention` | Apple keeps feedback for about a year and crash logs for 120 days; Kiln keeps what it has read until the retention of the workspace. | Apple bewahrt Feedback etwa ein Jahr und Absturzprotokolle 120 Tage auf; Kiln behält, was es gelesen hat, bis zur Aufbewahrungsdauer des Arbeitsbereichs. |  |  |
| `tab.headlineCount` | {{feedback}} feedback and {{crashes}} crashes from your testers | {{feedback}} Feedbacks und {{crashes}} Abstürze Ihrer Tester |  |  |
| `tab.headlineDefault` | TestFlight feedback and crashes | TestFlight-Feedback und -Abstürze |  |  |
| `tab.headlineNone` | No TestFlight feedback yet | Noch kein TestFlight-Feedback |  |  |
| `tab.kinds` | Kind of submission | Art der Einsendung |  | submit = einreichen / senden |
| `tab.leadHint` | What your beta testers send from TestFlight, next to the customer reviews. | Was Ihre Beta-Tester aus TestFlight senden, neben den Kundenrezensionen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `tab.listLabel` | {{kind}} of {{app}} | {{kind}} von {{app}} |  |  |
| `tab.loadError` | The feedback could not be read. | Das Feedback konnte nicht gelesen werden. |  |  |
| `tab.loadErrorTitle` | The feedback could not be read | Das Feedback konnte nicht gelesen werden |  |  |
| `tab.openConsole` | Open in App Store Connect | In App Store Connect öffnen |  |  |
| `tab.partsTitle` | Some of it could not be read | Ein Teil konnte nicht gelesen werden |  |  |
| `tab.reading` | Reading the feedback | Feedback wird gelesen |  |  |
| `tab.syncFailedTitle` | The sync failed | Die Synchronisierung ist fehlgeschlagen |  |  |
| `tester.anonymous` | Anonymous tester | Anonymer Tester |  |  |
| `tester.code` | Tester {{code}} | Tester {{code}} |  |  |
| `unsupported.body` | Google Play has no TestFlight. Beta feedback of Android testers is read in the Play Console. | Google Play hat kein TestFlight. Das Beta-Feedback von Android-Testern lesen Sie in der Play Console. |  |  |
| `unsupported.title` | TestFlight is for App Store Connect apps | TestFlight gibt es nur für Apps aus App Store Connect |  |  |

## web/timeline (150)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `add.app` | Platform | Plattform |  |  |
| `add.day` | Day | Tag |  |  |
| `add.description` | A note marks a day: an ad campaign, a price change, press. It is only text for your team; nothing is sent to a store. | Eine Notiz markiert einen Tag: Werbekampagne, Preisänderung, Presse. Sie ist nur Text für Ihr Team; an einen Store wird nichts gesendet. |  |  |
| `add.failed` | The note could not be saved. | Die Notiz konnte nicht gespeichert werden. |  |  |
| `add.kind` | Type | Typ |  |  |
| `add.name` | Title | Titel |  |  |
| `add.nameHint` | Up to 120 characters. | Bis zu 120 Zeichen. |  |  |
| `add.note` | Details (optional) | Details (optional) |  |  |
| `add.noteHint` | Up to {{max}} characters. | Bis zu {{max}} Zeichen. |  |  |
| `add.open` | Add note | Notiz hinzufügen |  |  |
| `add.save` | Add note | Notiz hinzufügen |  |  |
| `add.saved` | Note added. | Notiz hinzugefügt. |  |  |
| `add.title` | Add a note to the timeline | Notiz zur Zeitleiste hinzufügen |  |  |
| `event.competitorChange` | {{name}} changed its App Store listing: {{what}} | {{name}} hat seinen App-Store-Eintrag geändert: {{what}} |  | listing = Store-Eintrag |
| `event.competitorKind.category` | category | Kategorie |  |  |
| `event.competitorKind.description` | description | Beschreibung |  |  |
| `event.competitorKind.icon` | icon | Icon |  |  |
| `event.competitorKind.name` | name | Name |  |  |
| `event.competitorKind.price` | price | Preis |  |  |
| `event.competitorKind.releaseNotes` | release notes | Versionshinweise |  | release = Release |
| `event.competitorKind.screenshots` | screenshots | Screenshots |  |  |
| `event.competitorKind.version` | version | Version |  |  |
| `event.experimentEnded` | Experiment ended: {{name}} | Experiment beendet: {{name}} |  |  |
| `event.experimentStarted` | Experiment started: {{name}} | Experiment gestartet: {{name}} |  |  |
| `event.graphics_one` | {{count}} graphics set pushed to the store draft | {{count}} Grafiksatz an den Store-Entwurf gesendet |  |  |
| `event.graphics_other` | {{count}} graphics sets pushed to the store draft | {{count}} Grafiksätze an den Store-Entwurf gesendet |  |  |
| `event.listingDrift_one` | {{count}} change to the live store listing that Kiln did not make | {{count}} Änderung am Live-Eintrag, die nicht von Kiln stammt |  | listing = Store-Eintrag; live = live |
| `event.listingDrift_other` | {{count}} changes to the live store listing that Kiln did not make | {{count}} Änderungen am Live-Eintrag, die nicht von Kiln stammen |  | listing = Store-Eintrag; live = live |
| `event.listingText_one` | {{count}} listing text change pushed to the store draft | {{count}} Listing-Text an den Store-Entwurf gesendet |  | listing = Store-Eintrag |
| `event.listingText_other` | {{count}} listing text changes pushed to the store draft | {{count}} Listing-Texte an den Store-Entwurf gesendet |  | listing = Store-Eintrag |
| `event.release` | Version {{version}} released | Version {{version}} veröffentlicht |  |  |
| `event.releaseRollingOut` | Version {{version}} started a staged rollout | Version {{version}} hat einen gestaffelten Rollout begonnen |  | stage = vormerken / vorbereiten (nothing is sent); rollout = Einführung |
| `event.releaseTrack` | Version {{version}} released on {{track}} | Version {{version}} auf {{track}} veröffentlicht |  | track = Track (Play) / verfolgen (keyword) |
| `event.rolloutStep` | Rollout of {{version}} reached {{percent}}% | Der Rollout von {{version}} hat {{percent}} % erreicht |  | rollout = Einführung |
| `filter.all` | All | Alle |  |  |
| `filter.clear` | Show all types | Alle Typen anzeigen |  |  |
| `filter.label` | Filter by type | Nach Typ filtern |  |  |
| `kind.adCampaign` | Ad campaign | Werbekampagne |  |  |
| `kind.competitorChange` | Competitor listing changed | Eintrag eines Wettbewerbers geändert |  | listing = Store-Eintrag |
| `kind.experimentEnded` | Experiment ended | Experiment beendet |  |  |
| `kind.experimentStarted` | Experiment started | Experiment gestartet |  |  |
| `kind.graphics` | Graphics | Grafiken |  |  |
| `kind.listingDrift` | Store listing changed | Store-Eintrag geändert |  | listing = Store-Eintrag |
| `kind.listingText` | Listing text | Listing-Text |  | listing = Store-Eintrag |
| `kind.other` | Note | Notiz |  |  |
| `kind.press` | Press | Presse |  |  |
| `kind.priceChange` | Price change | Preisänderung |  |  |
| `kind.release` | Release | Veröffentlichung |  | release = Release |
| `kind.rollout` | Rollout step | Rollout-Schritt |  | rollout = Einführung |
| `list.byKiln` | Recorded by Kiln | Von Kiln erfasst |  |  |
| `list.byPerson` | Note added by a person | Notiz von einer Person |  |  |
| `list.cut` | The range is longer than the timeline reads at once: it shows the days since {{date}}. | Der Zeitraum ist länger, als die Zeitleiste auf einmal liest: Sie zeigt die Tage seit dem {{date}}. |  |  |
| `list.empty` | No events in this range. Kiln records releases, rollout steps, pushes to the store draft, experiments and changes of the live listing; add a note for anything else, such as an ad campaign or a price change. | Keine Ereignisse in diesem Zeitraum. Kiln erfasst Veröffentlichungen, Rollout-Schritte, Übertragungen an den Store-Entwurf, Experimente und Änderungen am Live-Eintrag; für alles andere, etwa eine Werbekampagne oder eine Preisänderung, lässt sich eine Notiz hinzufügen. |  | release = Release; rollout = Einführung |
| `list.failed_one` | The timeline of {{count}} platform could not be read | Die Zeitleiste von {{count}} Plattform konnte nicht gelesen werden |  |  |
| `list.failed_other` | The timeline of {{count}} platforms could not be read | Die Zeitleiste von {{count}} Plattformen konnte nicht gelesen werden |  |  |
| `list.label` | Events by day, newest first | Ereignisse nach Tag, neueste zuerst |  |  |
| `list.liveOn` | live in the store on {{date}} | im Store live seit {{date}} |  | live = live |
| `list.loading` | Reading the timeline | Zeitleiste wird gelesen |  |  |
| `list.more_one` | Show {{count}} more | {{count}} weitere anzeigen |  |  |
| `list.more_other` | Show {{count}} more | {{count}} weitere anzeigen |  |  |
| `list.noMatch` | No events of the chosen types in this range. | Keine Ereignisse der gewählten Typen in diesem Zeitraum. |  |  |
| `list.remove` | Delete note: {{name}} | Notiz löschen: {{name}} |  |  |
| `list.removeFailed` | The note could not be deleted. | Die Notiz konnte nicht gelöscht werden. |  |  |
| `list.removed` | Note deleted. | Notiz gelöscht. |  |  |
| `list.result_one` | {{count}} event shown | {{count}} Ereignis angezeigt |  |  |
| `list.result_other` | {{count}} events shown | {{count}} Ereignisse angezeigt |  |  |
| `list.shown` | Showing {{shown}} of {{total}} | {{shown}} von {{total}} angezeigt |  |  |
| `list.waits` | goes live with the next release | geht mit der nächsten Version live |  | release = Release; live = live |
| `marker.caption` | Diamonds on the axis mark days with events; a number is how many that day had. Point at a day to read them. | Rauten auf der Achse markieren Tage mit Ereignissen; eine Zahl gibt an, wie viele es an dem Tag waren. Auf einen Tag zeigen, um sie zu lesen. |  |  |
| `marker.failed` | The events could not be read, so no markers are drawn. | Die Ereignisse konnten nicht gelesen werden, daher werden keine Markierungen gezeichnet. |  |  |
| `marker.hidden_one` | {{count}} more day with events is not marked. | {{count}} weiterer Tag mit Ereignissen ist nicht markiert. |  |  |
| `marker.hidden_other` | {{count}} more days with events are not marked. | {{count}} weitere Tage mit Ereignissen sind nicht markiert. |  |  |
| `marker.hide` | Hide events | Ereignisse ausblenden |  |  |
| `marker.label` | Events of this day | Ereignisse dieses Tages |  |  |
| `marker.more_one` | + {{count}} more | + {{count}} weiteres |  |  |
| `marker.more_other` | + {{count}} more | + {{count}} weitere |  |  |
| `marker.show` | Show events | Ereignisse anzeigen |  |  |
| `marker.spoken_one` | {{count}} event this day: {{events}} | {{count}} Ereignis an diesem Tag: {{events}} |  |  |
| `marker.spoken_other` | {{count}} events this day: {{events}} | {{count}} Ereignisse an diesem Tag: {{events}} |  |  |
| `metric.downloadRate` | Download rate (per impression) | Download-Rate (pro Impression) |  |  |
| `metric.downloadsFirstTime` | Downloads (first time) | Downloads (erstmalig) |  |  |
| `metric.downloadsRedownload` | Redownloads | Erneute Downloads |  |  |
| `metric.impressions` | Impressions | Impressionen |  |  |
| `metric.installsUser` | Installs (users) | Installationen (Nutzer) |  |  |
| `metric.productPageConversion` | Conversion rate (product page) | Conversionsrate (Produktseite) |  |  |
| `metric.productPageViews` | Product page views | Produktseitenaufrufe |  |  |
| `metric.salesGross` | Gross sales | Bruttoumsatz |  |  |
| `metric.salesProceeds` | Proceeds | Erlös |  |  |
| `metric.salesUnits` | Units sold | Verkaufte Einheiten |  |  |
| `metric.storeListingAcquisitions` | Store listing acquisitions | Neuinstallationen über den Store-Eintrag |  | listing = Store-Eintrag |
| `metric.storeListingVisitors` | Store listing visitors | Besucher des Store-Eintrags |  | listing = Store-Eintrag |
| `rail.events` | Timeline | Zeitleiste |  |  |
| `rail.group` | Timeline and reports | Zeitleiste und Berichte |  |  |
| `rail.label` | Timeline sections | Abschnitte der Zeitleiste |  |  |
| `rail.reports` | Reports | Berichte |  |  |
| `report.col.change` | Change | Veränderung |  |  |
| `report.col.figure` | Figure | Kennzahl |  |  |
| `report.col.previous` | Before | Davor |  |  |
| `report.col.value` | This period | Dieser Zeitraum |  |  |
| `report.compare` | {{current}}, compared with {{previous}}. | {{current}}, verglichen mit {{previous}}. |  |  |
| `report.copied` | Copied | Kopiert |  |  |
| `report.copyMarkdown` | Copy as Markdown | Als Markdown kopieren |  |  |
| `report.countries.title` | Countries (downloads) | Länder (Downloads) |  |  |
| `report.downloadCsv` | Download CSV | CSV herunterladen |  |  |
| `report.empty` | Nothing was recorded for this period: no figures, no written reviews and no events. | Für diesen Zeitraum wurde nichts erfasst: keine Zahlen, keine Rezensionen und keine Ereignisse. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.events.more_one` | {{count}} more event is not listed. | {{count}} weiteres Ereignis ist nicht aufgeführt. |  |  |
| `report.events.more_other` | {{count}} more events are not listed. | {{count}} weitere Ereignisse sind nicht aufgeführt. |  |  |
| `report.events.none` | No events in this period. | Keine Ereignisse in diesem Zeitraum. |  |  |
| `report.events.title` | Events of the period | Ereignisse des Zeitraums |  |  |
| `report.failed` | The report of {{platform}} could not be read. | Der Bericht für {{platform}} konnte nicht gelesen werden. |  |  |
| `report.figuresCaption` | Figures for {{period}} against the period before | Zahlen für {{period}} im Vergleich zum Vorzeitraum |  |  |
| `report.kind.month` | Month | Monat |  |  |
| `report.kind.week` | Week | Woche |  |  |
| `report.kind.year` | Year | Jahr |  |  |
| `report.kindLabel` | Report period | Berichtszeitraum |  |  |
| `report.loading` | Reading the report | Bericht wird gelesen |  |  |
| `report.localOnly` | Made in your browser from what Kiln stored; nothing is shared or sent. | In Ihrem Browser aus den von Kiln gespeicherten Daten erstellt; nichts wird geteilt oder gesendet. |  |  |
| `report.next` | Next period | Nächster Zeitraum |  |  |
| `report.noValue` | no data | keine Daten |  |  |
| `report.note.lengths` | The periods have different lengths ({{current}} days against {{previous}}), so totals are not like for like. | Die Zeiträume sind unterschiedlich lang ({{current}} gegenüber {{previous}} Tagen); die Summen sind daher nicht direkt vergleichbar. |  |  |
| `report.note.lowReviews_one` | Only {{count}} written review: the average is not reliable. | Nur {{count}} Rezension: Der Durchschnitt ist nicht aussagekräftig. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.note.lowReviews_other` | Only {{count}} written reviews: the average is not reliable. | Nur {{count}} Rezensionen: Der Durchschnitt ist nicht aussagekräftig. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.note.missingDays_one` | {{count}} day of this period has no numbers yet; the stores publish with a delay. | Für {{count}} Tag dieses Zeitraums gibt es noch keine Zahlen; die Stores veröffentlichen mit Verzögerung. |  |  |
| `report.note.missingDays_other` | {{count}} days of this period have no numbers yet; the stores publish with a delay. | Für {{count}} Tage dieses Zeitraums gibt es noch keine Zahlen; die Stores veröffentlichen mit Verzögerung. |  |  |
| `report.note.noCountries` | There is no split by country for this period. | Für diesen Zeitraum gibt es keine Aufteilung nach Land. |  |  |
| `report.note.noFiguresAndroid` | No analytics numbers are stored for this period. Connect the Play Console reports and sync, or the store has not published them yet. | Für diesen Zeitraum sind keine Analytics-Zahlen gespeichert. Play-Console-Berichte verbinden und synchronisieren, oder der Store hat sie noch nicht veröffentlicht. |  |  |
| `report.note.noFiguresIos` | No analytics numbers are stored for this period. Connect App Store analytics and sync, or the store has not published them yet. | Für diesen Zeitraum sind keine Analytics-Zahlen gespeichert. App-Store-Analytics verbinden und synchronisieren, oder der Store hat sie noch nicht veröffentlicht. |  |  |
| `report.note.noReviews` | No written reviews are stored for this period or the one before. Sync reviews to read them. | Für diesen und den vorherigen Zeitraum sind keine Rezensionen gespeichert. Rezensionen synchronisieren, um sie zu lesen. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.note.noSourcesAndroid` | Google Play does not give downloads by source, so there is no split. | Google Play liefert keine Downloads nach Quelle, daher gibt es keine Aufteilung. |  |  |
| `report.note.noSourcesIos` | There is no split by source for this period. | Für diesen Zeitraum gibt es keine Aufteilung nach Quelle. |  |  |
| `report.note.notStarted` | This period has not started: there are no numbers yet. | Dieser Zeitraum hat noch nicht begonnen: Es gibt noch keine Zahlen. |  |  |
| `report.note.partial_one` | This period is still running. The figures cover its first {{count}} day (until {{through}}) and are compared with the same number of days before it. | Dieser Zeitraum läuft noch. Die Zahlen decken {{count}} Tag ab (bis {{through}}) und werden mit der gleichen Anzahl Tage davor verglichen. |  |  |
| `report.note.partial_other` | This period is still running. The figures cover its first {{count}} days (until {{through}}) and are compared with the same number of days before it. | Dieser Zeitraum läuft noch. Die Zahlen decken seine ersten {{count}} Tage ab (bis {{through}}) und werden mit der gleichen Anzahl Tage davor verglichen. |  |  |
| `report.note.uncompared_one` | {{count}} figure has no comparison because too many days are missing in one of the two periods. | {{count}} Kennzahl wird nicht verglichen, weil in einem der beiden Zeiträume zu viele Tage fehlen. |  |  |
| `report.note.uncompared_other` | {{count}} figures have no comparison because too many days are missing in one of the two periods. | {{count}} Kennzahlen werden nicht verglichen, weil in einem der beiden Zeiträume zu viele Tage fehlen. |  |  |
| `report.notes.title` | About the data | Zu den Daten |  |  |
| `report.periodLabel` | Choose a period | Zeitraum wählen |  |  |
| `report.prev` | Previous period | Vorheriger Zeitraum |  |  |
| `report.print` | Print | Drucken |  |  |
| `report.range` | {{from}} to {{to}} | {{from}} bis {{to}} |  |  |
| `report.reason.currentIncomplete` | Not compared: this period has too many days without numbers | Nicht verglichen: In diesem Zeitraum fehlen zu viele Tage |  |  |
| `report.reason.noData` | No numbers this period | Keine Zahlen in diesem Zeitraum |  |  |
| `report.reason.previousIncomplete` | Not compared: the period before has too many days without numbers | Nicht verglichen: Im Vorzeitraum fehlen zu viele Tage |  |  |
| `report.reviews.line_one` | {{count}} written review, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} Rezension, Durchschnitt {{average}} (davor: {{previous}}). Das sind die von Kiln gespeicherten Rezensionen, nicht die Store-Bewertung. |  | review: Rezension (user) vs Prüfung (App Review); rating = Bewertung |
| `report.reviews.line_other` | {{count}} written reviews, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} Rezensionen, Durchschnitt {{average}} (davor: {{previous}}). Das sind die von Kiln gespeicherten Rezensionen, nicht die Store-Bewertung. |  | review: Rezension (user) vs Prüfung (App Review); rating = Bewertung |
| `report.reviews.title` | Written reviews | Rezensionen |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.reviews.unanswered_one` | {{count}} review of 1 or 2 stars has no reply. | {{count}} Rezension mit 1 oder 2 Sternen ohne Antwort. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.reviews.unanswered_other` | {{count}} reviews of 1 or 2 stars have no reply. | {{count}} Rezensionen mit 1 oder 2 Sternen ohne Antwort. |  | review: Rezension (user) vs Prüfung (App Review) |
| `report.sources.title` | How people found the app (downloads) | Wie Menschen die App gefunden haben (Downloads) |  |  |
| `report.title` | Report: {{period}} | Bericht: {{period}} |  |  |

## web/workspace (8)

| Key | English | German | OK/Fix | Notes |
|---|---|---|---|---|
| `token.action.monetizationPrice` | Change prices of in-app products | Preise von In-App-Produkten ändern |  |  |
| `webhook.event.asoCompetitorListingChanged` | A followed App Store competitor changed its screenshots, icon, name, description or release notes (ids and the kinds of change only) | Ein beobachteter App-Store-Wettbewerber hat Screenshots, Icon, Namen, Beschreibung oder Versionshinweise geändert (nur IDs und Art der Änderung) |  | release = Release |
| `webhook.event.easBuildFailed` | An EAS build was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Ein EAS-Build wurde als fehlgeschlagen gespeichert (nur IDs, Plattform, Version und ein kurzer Code; nie die Meldung von Expo) |  |  |
| `webhook.event.easSubmissionFailed` | An EAS store submission was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Eine EAS-Einreichung beim Store wurde als fehlgeschlagen gespeichert (nur IDs, Plattform, Version und ein kurzer Code; nie die Meldung von Expo) |  | submit = einreichen / senden |
| `webhook.event.easUpdateRolloutStuck` | An EAS Update rollout stayed at the same percentage below 100% for longer than the limit (ids, platform, channel and percentage only; never the update message) | Ein EAS-Update-Rollout blieb länger als das Limit auf demselben Prozentsatz unter 100 % (nur IDs, Plattform, Kanal und Prozentsatz; nie die Update-Nachricht) |  | rollout = Einführung |
| `webhook.event.healthCrashRegression` | A version crashes clearly more than the one before it (ids, version names and two rates only) | Eine Version stürzt deutlich häufiger ab als die vorherige (nur IDs, Versionsnamen und zwei Raten) |  |  |
| `webhook.event.testflightCrash` | A tester sent a TestFlight crash that was stored (ids, build and platform only; never the log) | Ein TestFlight-Absturz eines Testers wurde gespeichert (nur IDs, Build und Plattform; nie das Protokoll) |  |  |
| `webhook.event.testflightFeedback` | A tester sent TestFlight feedback that was stored (ids, build and platform only; never the comment) | Ein TestFlight-Feedback eines Testers wurde gespeichert (nur IDs, Build und Plattform; nie der Kommentar) |  |  |
