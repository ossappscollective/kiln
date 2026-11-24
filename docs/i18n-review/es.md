# Spanish (es) review sheet

Status: UNREVIEWED machine-quality translation. Every row below was added or changed after commit 550fb83. Mark each row OK or Fix (and write the correction in the notes). See [README](README.md).

Plural `_many` forms (French and Spanish only) are derived mechanically from `_other` ("de" or "d’" inserted after the number: "1 million de ...") and are not listed.
Keys identical in every language (brand names, units, numbers) are skipped. Placeholders such as `{{count}}` must stay exactly as they are.

## Glossary

| English term | Translation in the catalog | Flag |
|---|---|---|
| release | lanzamiento | consistent |
| build | compilación (build in 53 places) | mixed; "compilación" is established |
| rollout | despliegue | consistent |
| listing (store page) | ficha | consistent |
| cart / pending changes | Cambios pendientes | consistent |
| staged / stage | preparado / preparar | consistent |
| draft | borrador | consistent |
| track (Google Play) | canal | same word as EAS "channel" (canal): ambiguous |
| in review (App Review) | revisión | also used for "submit" ("enviar a revisión") |
| reviews | reseñas | "revisión" is App Review, "reseña" a user review |
| rating | valoración | consistent |
| submit | enviar (a revisión) | consistent |
| keyword | palabra clave | consistent |
| workflow | flujo de trabajo (workflow in 33 places) | mixed; "flujo de trabajo" is established |
| workspace | espacio de trabajo | consistent |
| tester | probador | consistent |
| screenshot | captura de pantalla | consistent |
| token | token | kept |
| territory / region | territorio / región | both used |
| app | app (aplicación 32) | "app" is established |
| store | tienda | "store" only in product names |
| live | vivo / publicada | two variants for "live"; check context |
| register | tú | a few formal "usted" imperatives were changed to tú |

## server/alerts (39)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `action.openHealth` | Open the ratings and app health | Abrir las valoraciones y la salud de la app |  | rating = valoración |
| `action.openTestflight` | Open the TestFlight feedback | Abrir los comentarios de TestFlight |  |  |
| `competitor.listingChanged.body` | A followed competitor changed: {{what}}. | Un competidor seguido cambió: {{what}}. |  |  |
| `competitor.listingChanged.body.noKinds` | A followed competitor changed its public App Store listing. | Un competidor seguido cambió su ficha pública de App Store. |  | listing = ficha |
| `competitor.listingChanged.kind.category` | category | categoría |  |  |
| `competitor.listingChanged.kind.description` | description | descripción |  |  |
| `competitor.listingChanged.kind.icon` | icon | icono |  |  |
| `competitor.listingChanged.kind.name` | name | nombre |  |  |
| `competitor.listingChanged.kind.price` | price | precio |  |  |
| `competitor.listingChanged.kind.releaseNotes` | release notes | notas de la versión |  | release = lanzamiento |
| `competitor.listingChanged.kind.screenshots` | screenshots | capturas |  |  |
| `competitor.listingChanged.kind.version` | version | versión |  |  |
| `competitor.listingChanged.title` | A competitor of {{app}} changed its App Store listing | Un competidor de {{app}} cambió su ficha de App Store |  | listing = ficha |
| `eas.buildFailed.body` | Build {{build}} ({{platform}}) of {{app}} failed at Expo. Open Builds to read Expo’s reason. | El build {{build}} ({{platform}}) de {{app}} falló en Expo. Abre Builds para leer el motivo de Expo. |  |  |
| `eas.buildFailed.body.noBuild` | A build of {{app}} failed at Expo. Open Builds to read Expo’s reason. | Un build de {{app}} falló en Expo. Abre Builds para leer el motivo de Expo. |  |  |
| `eas.buildFailed.title` | The EAS build of {{app}} failed | Falló el build de EAS de {{app}} |  |  |
| `eas.submissionFailed.body` | The submission of build {{build}} ({{platform}}) of {{app}} to the store failed. Open Builds to read Expo’s reason. | Falló el envío del build {{build}} ({{platform}}) de {{app}} a la tienda. Abre Builds para leer el motivo de Expo. |  | submit = enviar |
| `eas.submissionFailed.body.noBuild` | A store submission of {{app}} failed. Open Builds to read Expo’s reason. | Falló un envío de {{app}} a la tienda. Abre Builds para leer el motivo de Expo. |  | submit = enviar |
| `eas.submissionFailed.title` | The EAS submission of {{app}} failed | Falló el envío de EAS de {{app}} |  | submit = enviar |
| `eas.updateRolloutStuck.body` | An over-the-air update of {{app}} on the {{channel}} channel has been at {{percentage}}% for {{hours}} hours. Open Builds, EAS updates, to raise it or end it. | Una actualización remota de {{app}} en el canal {{channel}} lleva {{hours}} horas al {{percentage}} %. Abre Builds, Actualizaciones EAS, para subirla o terminarla. |  |  |
| `eas.updateRolloutStuck.body.short` | An over-the-air update rollout of {{app}} has been at the same percentage for a long time. Open Builds, EAS updates, to raise it or end it. | El despliegue de una actualización remota de {{app}} lleva mucho tiempo en el mismo porcentaje. Abre Builds, Actualizaciones EAS, para subirlo o terminarlo. |  | rollout = despliegue |
| `eas.updateRolloutStuck.title` | The EAS Update rollout of {{app}} is stuck | El despliegue de EAS Update de {{app}} está detenido |  | rollout = despliegue |
| `health.crashRegression.body.perSessions` | {{app}} {{version}} crashes {{after}} times for every 1,000 sessions, up from {{before}} in {{previous}}. Only people who share analytics with developers are counted. | {{app}} {{version}} falla {{after}} veces por cada 1000 sesiones, frente a {{before}} en {{previous}}. Solo se cuentan las personas que comparten datos de análisis con los desarrolladores. |  |  |
| `health.crashRegression.body.share` | {{after}}% of the people using {{app}} {{version}} had a crash, up from {{before}}% in {{previous}}. | El {{after}} % de las personas que usan {{app}} {{version}} sufrió un fallo, frente al {{before}} % en {{previous}}. |  |  |
| `health.crashRegression.title` | {{app}} {{version}} crashes more | {{app}} {{version}} falla más |  |  |
| `testflight.crash.body` | A tester sent a crash report for build {{build}} of {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Un probador envió un informe de cierre inesperado de la compilación {{build}} de {{app}}. Abre la vista TestFlight para leerlo con su registro; el registro no se envía aquí. |  |  |
| `testflight.crash.body.grouped_one` | {{count}} more crash report of {{app}} was stored. Open the TestFlight view to read it and its log; the log is not sent here. | Se guardó {{count}} informe de cierre inesperado más de {{app}}. Abre la vista TestFlight para leerlo con su registro; el registro no se envía aquí. |  |  |
| `testflight.crash.body.grouped_other` | {{count}} more crash reports of {{app}} were stored. Open the TestFlight view to read them and their logs; the logs are not sent here. | Se guardaron {{count}} informes de cierre inesperado más de {{app}}. Abre la vista TestFlight para leerlos con sus registros; los registros no se envían aquí. |  |  |
| `testflight.crash.body.noBuild` | A tester sent a crash report for {{app}}. Open the TestFlight view to read it and its log; the log is not sent here. | Un probador envió un informe de cierre inesperado de {{app}}. Abre la vista TestFlight para leerlo con su registro; el registro no se envía aquí. |  |  |
| `testflight.crash.title` | New TestFlight crash in {{app}} | Nuevo cierre inesperado de TestFlight en {{app}} |  |  |
| `testflight.crash.title.grouped_one` | {{count}} more TestFlight crash in {{app}} | {{count}} cierre inesperado más de TestFlight en {{app}} |  |  |
| `testflight.crash.title.grouped_other` | {{count}} more TestFlight crashes in {{app}} | {{count}} cierres inesperados más de TestFlight en {{app}} |  |  |
| `testflight.feedback.body` | A tester sent feedback on build {{build}} of {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Un probador envió un comentario sobre la compilación {{build}} de {{app}}. Abre la vista TestFlight para leerlo; el comentario no se envía aquí. |  |  |
| `testflight.feedback.body.grouped_one` | {{count}} more feedback of {{app}} was stored. Open the TestFlight view to read it; the comment is not sent here. | Se guardó {{count}} comentario más sobre {{app}}. Abre la vista TestFlight para leerlo; el comentario no se envía aquí. |  |  |
| `testflight.feedback.body.grouped_other` | {{count}} more feedback items of {{app}} were stored. Open the TestFlight view to read them; the comments are not sent here. | Se guardaron {{count}} comentarios más sobre {{app}}. Abre la vista TestFlight para leerlos; los comentarios no se envían aquí. |  |  |
| `testflight.feedback.body.noBuild` | A tester sent feedback on {{app}}. Open the TestFlight view to read it; the comment is not sent here. | Un probador envió un comentario sobre {{app}}. Abre la vista TestFlight para leerlo; el comentario no se envía aquí. |  |  |
| `testflight.feedback.title` | New TestFlight feedback for {{app}} | Nuevo comentario de TestFlight para {{app}} |  |  |
| `testflight.feedback.title.grouped_one` | {{count}} more TestFlight feedback for {{app}} | {{count}} comentario más de TestFlight para {{app}} |  |  |
| `testflight.feedback.title.grouped_other` | {{count}} more TestFlight feedback items for {{app}} | {{count}} comentarios más de TestFlight para {{app}} |  |  |

## server/chat (23)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `digest.heading_one` | {{count}} alert since the last summary | {{count}} alerta desde el último resumen |  |  |
| `digest.heading_other` | {{count}} alerts since the last summary | {{count}} alertas desde el último resumen |  |  |
| `digest.more_one` | and {{count}} more alert. Open Kiln to see all of them. | y {{count}} alerta más. Abre Kiln para verlas todas. |  |  |
| `digest.more_other` | and {{count}} more alerts. Open Kiln to see all of them. | y {{count}} alertas más. Abre Kiln para verlas todas. |  |  |
| `digest.title` | Alert summary | Resumen de alertas |  |  |
| `field.app` | App | App |  |  |
| `field.platform` | Platform | Plataforma |  |  |
| `field.version` | Version | Versión |  |  |
| `footer.digest` | Kiln · daily summary | Kiln · resumen diario |  |  |
| `footer.test` | Kiln · test message | Kiln · mensaje de prueba |  |  |
| `item.repeated_one` | {{title}} ({{count}} time) | {{title}} ({{count}} vez) |  |  |
| `item.repeated_other` | {{title}} ({{count}} times) | {{title}} ({{count}} veces) |  |  |
| `noLink` | Open Kiln: {{where}}. | Abre Kiln: {{where}}. |  |  |
| `openKiln` | Open Kiln | Abrir Kiln |  |  |
| `repeated_one` | Happened {{count}} time. | Ha ocurrido {{count}} vez. |  |  |
| `repeated_other` | Happened {{count}} times. | Ha ocurrido {{count}} veces. |  |  |
| `severity.critical` | Critical | Crítica |  |  |
| `severity.info` | For your information | Para tu información |  |  |
| `severity.warning` | Needs attention | Requiere atención |  |  |
| `test.body` | If you can read this, the destination “{{name}}” works. Alerts and summaries routed to it will appear here. | Si puedes leer esto, el destino «{{name}}» funciona. Las alertas y los resúmenes dirigidos a él aparecerán aquí. |  |  |
| `test.hint` | Nothing is wrong. This message was sent because someone pressed “Send test message” in Kiln. | No pasa nada. Este mensaje se envió porque alguien pulsó «Enviar mensaje de prueba» en Kiln. |  |  |
| `test.title` | Kiln test message | Mensaje de prueba de Kiln |  |  |
| `whatToDo` | What to do | Qué hacer |  |  |

## web/ads (100)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `account.neverSynced` | Nothing has been read from Apple Ads yet. Press Sync. | Todavía no se ha leído nada de Apple Ads. Pulsa Sincronizar. |  |  |
| `account.partial` | The last read was cut short, so some rows may be missing. | La última lectura se cortó antes de terminar, así que pueden faltar filas. |  |  |
| `account.synced` | The last read covered {{campaigns}} campaigns, from {{from}} to {{to}}. | La última lectura abarcó {{campaigns}} campañas, del {{from}} al {{to}}. |  |  |
| `campaigns.days_one` | {{count}} day with data | {{count}} día con datos |  |  |
| `campaigns.days_other` | {{count}} days with data | {{count}} días con datos |  |  |
| `campaigns.empty` | No campaign promoting this app has data in this range. | Ninguna campaña que promocione esta app tiene datos en este periodo. |  |  |
| `col.campaign` | Campaign | Campaña |  |  |
| `col.conversion` | Conversion rate | Tasa de conversión |  |  |
| `col.country` | Country | País |  |  |
| `col.cpi` | Cost per install | Coste por instalación |  |  |
| `col.cpt` | Cost per tap | Coste por toque |  |  |
| `col.day` | Day | Día |  |  |
| `col.impressions` | Impressions | Impresiones |  |  |
| `col.installs` | Installs | Instalaciones |  |  |
| `col.spend` | Spend | Gasto |  |  |
| `col.taps` | Taps | Toques |  |  |
| `col.ttr` | Tap-through rate | Tasa de toques |  |  |
| `err.credentialKind` | Choose an Apple Ads API user key credential. | Elige una credencial de tipo clave de usuario de la API de Apple Ads. |  |  |
| `err.credentialNotFound` | That credential does not exist in this workspace. | Esa credencial no existe en este espacio de trabajo. |  |  |
| `err.forbidden` | Your role cannot do this. | Tu rol no puede hacer esto. |  |  |
| `err.notFound` | This app was not found. | No se encontró esta app. |  |  |
| `err.notLinked` | This app is not linked to an Apple Ads account. Link it first. | Esta app no está vinculada a una cuenta de Apple Ads. Vincúlala primero. |  |  |
| `err.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads es para apps de la App Store. Esta app no lo es. |  |  |
| `err.rateLimited` | Too many requests. Try again in a minute. | Demasiadas solicitudes. Inténtalo de nuevo en un minuto. |  |  |
| `link.account` | Ad account | Cuenta publicitaria |  |  |
| `link.accountHint` | Only accounts the key can read are listed. Loading them asks Apple Ads once. | Solo se listan las cuentas que la clave puede leer. Cargarlas consulta Apple Ads una vez. |  |  |
| `link.adamHint` | The number after id in the App Store address of the app. Kiln uses the store id of the record when you leave it empty. | El número después de id en la dirección de la app en la App Store. Kiln usa el id de tienda del registro si lo dejas vacío. |  |  |
| `link.adamId` | Apple id of the app | Id de Apple de la app |  |  |
| `link.adamInvalid` | Use only digits: 5 to 15 of them. | Usa solo dígitos: de 5 a 15. |  |  |
| `link.adamPlaceholder` | For example 1234567890 | Por ejemplo 1234567890 |  |  |
| `link.askAdmin` | Ask an admin to link this app to an Apple Ads account. | Pide a un administrador que vincule esta app a una cuenta de Apple Ads. |  |  |
| `link.badgeLinked` | Linked | Vinculada |  |  |
| `link.badgeNeedsCredential` | Needs a credential | Necesita una credencial |  |  |
| `link.checked` | Checked {{when}}. | Comprobado {{when}}. |  |  |
| `link.chooseAccount` | Choose an ad account | Elige una cuenta publicitaria |  |  |
| `link.chooseCredential` | Choose a credential | Elige una credencial |  |  |
| `link.credential` | Apple Ads credential | Credencial de Apple Ads |  |  |
| `link.credentialDeleted` | The credential of this link was deleted. Choose another. | Se eliminó la credencial de este vínculo. Elige otra. |  |  |
| `link.credentialsHint` | Add an Apple Ads API user key under <link>Credentials</link> first. It only needs read access. | Primero añade una clave de usuario de la API de Apple Ads en <link>Credenciales</link>. Solo necesita acceso de lectura. |  |  |
| `link.currency` | Currency | Moneda |  |  |
| `link.linkAccount` | Link ad account | Vincular cuenta publicitaria |  |  |
| `link.linked` | Linked to {{account}}. | Vinculada a {{account}}. |  |  |
| `link.loadAccounts` | Load ad accounts | Cargar cuentas publicitarias |  |  |
| `link.loadFirst` | Load the ad accounts first | Carga primero las cuentas publicitarias |  |  |
| `link.noAccounts` | This key sees no ad account. Invite its API user to the account in Apple Ads. | Esta clave no ve ninguna cuenta publicitaria. Invita a su usuario de API a la cuenta en Apple Ads. |  |  |
| `link.notLinked` | This app is not linked to an Apple Ads account. | Esta app no está vinculada a una cuenta de Apple Ads. |  |  |
| `link.readOnly` | Read only: Kiln reads reports and never changes a campaign, a budget or a bid. | Solo lectura: Kiln lee informes y nunca cambia una campaña, un presupuesto ni una puja. |  |  |
| `link.remove` | Remove link | Quitar vínculo |  |  |
| `link.removed` | The link was removed. The stored reports of this app were kept until they age out. | Se quitó el vínculo. Los informes guardados de esta app se conservan hasta que caduquen. |  |  |
| `link.saveChanges` | Save changes | Guardar cambios |  |  |
| `noApple` | Apple Ads is for App Store apps. This app has no App Store record. | Apple Ads es para apps de la App Store. Esta app no tiene registro en la App Store. |  |  |
| `overview.compare` | Compared with {{from}} to {{to}}. | Comparado con el periodo del {{from}} al {{to}}. |  |  |
| `overview.coverage` | Days with data: {{days}}. Campaigns: {{campaigns}}. Amounts in {{currency}}. | Días con datos: {{days}}. Campañas: {{campaigns}}. Importes en {{currency}}. |  |  |
| `overview.daily` | Per day | Por día |  |  |
| `overview.dailyAria` | {{metric}} per day over {{days}} days | {{metric}} por día durante {{days}} días |  |  |
| `overview.dailyOf` | Show | Mostrar |  |  |
| `overview.deltaAria` | Before: {{previous}} | Antes: {{previous}} |  |  |
| `overview.empty` | No Apple Ads data from {{from}} to {{to}}. Press Sync to read it, or choose another range. | No hay datos de Apple Ads del {{from}} al {{to}}. Pulsa Sincronizar para leerlos, o elige otro periodo. |  |  |
| `overview.noCompare` | Nothing to compare with | Nada con qué comparar |  |  |
| `overview.table` | Show the days as a table | Mostrar los días como tabla |  |  |
| `overview.totals` | Totals of the range | Totales del periodo |  |  |
| `pick` | App Store record | Registro de la App Store |  |  |
| `rail.account` | Account | Cuenta |  |  |
| `rail.campaigns` | Campaigns | Campañas |  |  |
| `rail.keywords` | Keywords | Palabras clave |  |  |
| `rail.label` | Apple Ads sections | Secciones de Apple Ads |  |  |
| `rail.overview` | Overview | Resumen |  |  |
| `rail.terms` | Search terms | Términos de búsqueda |  |  |
| `rangeClamped` | Apple Ads is read one year at a time: the last year of this range is shown. | Apple Ads se lee de un año en un año: se muestra el último año de este periodo. |  |  |
| `settings.description` | Which Apple Ads ad account reports on this app. Read only: nothing is changed in Apple Ads. | Qué cuenta publicitaria de Apple Ads informa sobre esta app. Solo lectura: no se cambia nada en Apple Ads. |  |  |
| `settings.platformLabel` | Apple Ads of the {{platform}} record | Apple Ads del registro {{platform}} |  |  |
| `setup.lead` | Link an Apple Ads account to see what your campaigns spent and which search terms led to taps and installs. Kiln only reads reports. | Vincula una cuenta de Apple Ads para ver cuánto gastaron tus campañas y qué términos de búsqueda llevaron a toques e instalaciones. Kiln solo lee informes. |  |  |
| `setup.needsCredential` | No Apple Ads credential exists yet. Add one under Credentials: the guide there explains the key. | Todavía no existe ninguna credencial de Apple Ads. Añade una en Credenciales: la guía explica la clave. |  |  |
| `setup.step1` | In Apple Ads, create an API user with a read-only role and a key pair, and save the public key. | En Apple Ads, crea un usuario de API con un rol de solo lectura y un par de claves, y guarda la clave pública. |  |  |
| `setup.step2` | Add the private key and its ids under Credentials, as an Apple Ads API user key. | Añade la clave privada y sus ids en Credenciales, como clave de usuario de la API de Apple Ads. |  |  |
| `setup.step3` | Choose the credential and the ad account below, then press Link ad account. | Elige abajo la credencial y la cuenta publicitaria, y pulsa Vincular cuenta publicitaria. |  |  |
| `setup.title` | Link Apple Ads | Vincular Apple Ads |  |  |
| `terms.col.keyword` | Keyword | Palabra clave |  |  |
| `terms.col.term` | Search term | Término de búsqueda |  |  |
| `terms.count_one` | {{count}} row | {{count}} fila |  |  |
| `terms.count_other` | {{count}} rows | {{count}} filas |  |  |
| `terms.empty` | No search term in this range. Apple hides terms with very few impressions, so a small campaign may show none. | No hay términos de búsqueda en este periodo. Apple oculta los términos con muy pocas impresiones, así que una campaña pequeña puede no mostrar ninguno. |  |  |
| `terms.emptyKeywords` | No keyword has data in this range. | Ninguna palabra clave tiene datos en este periodo. |  |  |
| `terms.filter` | Filter the list | Filtrar la lista |  |  |
| `terms.hiddenNote` | Apple hides search terms with very few impressions, so this is not every search. | Apple oculta los términos de búsqueda con muy pocas impresiones, así que no es cada búsqueda. |  |  |
| `terms.isTracked` | Tracked | Seguida |  |  |
| `terms.matched` | Matched your keyword: {{keyword}} | Coincidió con tu palabra clave: {{keyword}} |  |  |
| `terms.next` | Next | Siguiente |  |  |
| `terms.noMatch` | Nothing matches that filter. | Nada coincide con ese filtro. |  |  |
| `terms.prev` | Previous | Anterior |  |  |
| `terms.range` | {{from}} to {{to}} of {{total}} | {{from}} a {{to}} de {{total}} |  |  |
| `terms.track` | Track keyword | Seguir palabra clave |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `terms.tracked` | {{term}} is now a tracked keyword. | {{term}} ya es una palabra clave seguida. |  |  |
| `warn.capCampaigns` | Only the campaigns with the most impressions were read. | Solo se leyeron las campañas con más impresiones. |  |  |
| `warn.currencyMismatch` | Some days were left out because they were not in the currency of the ad account. | Se dejaron fuera algunos días porque no estaban en la moneda de la cuenta publicitaria. |  |  |
| `warn.noCampaign` | No campaign promotes this app. Check the Apple id of the app. | Ninguna campaña promociona esta app. Comprueba el id de Apple de la app. |  |  |
| `warn.popularityFailed` | Apple’s own popularity could not be read this time. The rest was read. | Esta vez no se pudo leer la popularidad propia de Apple. Lo demás se leyó. |  |  |
| `warn.popularityPartial` | Apple’s own popularity was read for some of your keywords only. | La popularidad propia de Apple solo se leyó para algunas de tus palabras clave. |  |  |
| `warn.readCut` | A read was cut short to stay within limits. Press Sync again later. | Una lectura se cortó para respetar los límites. Vuelve a pulsar Sincronizar más tarde. |  |  |
| `warn.unknown` | The last read reported something this version does not know. | La última lectura informó de algo que esta versión no conoce. |  |  |

## web/ai (10)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `insight.changesSince` | Since the last summary: | Desde el último resumen: |  |  |
| `insight.generatedFrom_one` | Generated {{time}} from {{count}} review. | Generado {{time}} a partir de {{count}} reseña. |  | review: reseña (user) vs revisión (App Review) |
| `insight.generatedFrom_other` | Generated {{time}} from {{count}} reviews. | Generado {{time}} a partir de {{count}} reseñas. |  | review: reseña (user) vs revisión (App Review) |
| `insight.madeWith` | {{provider}}, {{model}}, {{tokens}} tokens | {{provider}}, {{model}}, {{tokens}} tokens |  |  |
| `insight.shareTitle` | Counted from the reviews that were read, which include some extra low-rated ones: an approximate share, not a share of all reviews. | Contado sobre las reseñas leídas, que incluyen algunas más de baja valoración: una proporción aproximada, no de todas las reseñas. |  | review: reseña (user) vs revisión (App Review) |
| `insight.themeShare` | about {{percent}} of the reviews read | aproximadamente {{percent}} de las reseñas leídas |  | review: reseña (user) vs revisión (App Review) |
| `insight.trend` | Average rating: {{earlier}} in the first half of the period, {{recent}} in the second half ({{direction}}). | Valoración media: {{earlier}} en la primera mitad del periodo, {{recent}} en la segunda ({{direction}}). |  | rating = valoración |
| `insight.trendDown` | falling | a la baja |  |  |
| `insight.trendFlat` | steady | estable |  |  |
| `insight.trendUp` | rising | al alza |  |  |

## web/analytics (78)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `bucketField.empty` | Enter the bucket of this app, or switch back to the workspace default. | Introduce el bucket de esta app o vuelve al bucket predeterminado del espacio de trabajo. |  |  |
| `bucketField.invalid` | That is not a Play reports bucket. Paste pubsite_prod_rev_ followed by digits, a gs:// address or a Cloud Storage link. | Eso no es un bucket de informes de Play. Pega pubsite_prod_rev_ seguido de dígitos, una dirección gs:// o un enlace de Cloud Storage. |  |  |
| `bucketField.normalized` | Will be saved as {{bucket}}. | Se guardará como {{bucket}}. |  |  |
| `error.bucketForbidden` | Google refused the service account the Cloud Storage bucket of the Play Console reports (403). Either the bucket belongs to another Play developer account than this app, or the service account was not invited in Play Console with "View app information and download bulk reports (read-only)". Check the bucket id, then the invitation. | Google ha denegado a la cuenta de servicio el bucket de Cloud Storage de los informes de Play Console (403). O el bucket pertenece a otra cuenta de desarrollador de Play distinta a la de esta app, o la cuenta de servicio no fue invitada en Play Console con «Ver información de la aplicación y descargar informes masivos (solo lectura)». Revisa el id del bucket y después la invitación. |  |  |
| `error.bucketNotFound` | Google Cloud Storage has no bucket with this id. Copy it again from Play Console, Download reports, Statistics, Copy Cloud Storage URI: it is pubsite_prod_rev_ followed by your developer account number. | Google Cloud Storage no tiene ningún bucket con este id. Cópialo de nuevo desde Play Console, Descargar informes, Estadísticas, Copiar URI de Cloud Storage: es pubsite_prod_rev_ seguido del número de tu cuenta de desarrollador. |  |  |
| `error.playSalesForbidden` | Google refused the service account the financial reports (sales, earnings, subscription statistics) while the statistics of the same bucket can be read. In Play Console, Users and permissions, the service account needs "View financial data, orders and cancellation survey responses" set to Global (all apps), not for one app only. A new permission can take 24 to 48 hours to apply. | Google ha denegado a la cuenta de servicio los informes financieros (ventas, ingresos, estadísticas de suscripciones) aunque las estadísticas del mismo bucket se pueden leer. En Play Console, Usuarios y permisos, la cuenta de servicio necesita «Ver datos financieros, pedidos y respuestas de encuestas de cancelación» en modo Global (todas las apps), no solo para una app. Un permiso nuevo puede tardar de 24 a 48 horas en aplicarse. |  |  |
| `error.salesForbidden` | Apple refused the API key the Sales and Trends reports (HTTP 403). The key needs the role Sales, Finance, Admin or Account Holder (roles without access to sales, such as Developer or Marketing, are refused), and the vendor number must belong to the same team as the key. Check both in App Store Connect, then test access again. | Apple ha denegado a la clave de API los informes de Ventas y tendencias (HTTP 403). La clave necesita el rol Ventas, Finanzas, Admin o Titular de la cuenta (los roles sin acceso a ventas, como Developer o Marketing, se rechazan), y el número de proveedor debe pertenecer al mismo equipo que la clave. Revisa ambos en App Store Connect y vuelve a probar el acceso. |  |  |
| `error.storeRejected` | The store refused the request (this is not an outage). Check the credential, the vendor number and the bucket id of the data sources, then test access. | La tienda rechazó la solicitud (no es una caída). Revisa la credencial, el número de proveedor y el id del bucket de las fuentes de datos y prueba el acceso. |  |  |
| `guide.account` | Invite this address | Invita esta dirección |  |  |
| `guide.accountUnknown` | The client_email in the JSON key of this service account | El client_email de la clave JSON de esta cuenta de servicio |  |  |
| `guide.bucket.cause` | Google refused the service account the bucket of the Play Console reports. Either this bucket belongs to another Play developer account than this app, or the service account was not invited in the Play Console of this account. | Google denegó a la cuenta de servicio el bucket de informes de Play Console. O este bucket pertenece a otra cuenta de desarrollador de Play distinta a la de esta app, o la cuenta de servicio no fue invitada en la Play Console de esta cuenta. |  |  |
| `guide.bucket.step1` | In Play Console, open Users and permissions of the Play account that owns this app and invite the address below. | En Play Console, abre Usuarios y permisos de la cuenta de Play propietaria de esta app e invita la dirección de abajo. |  |  |
| `guide.bucket.step2` | Give it the account permission “View app information and download bulk reports (read-only)”. | Dale el permiso de cuenta «Ver información de la aplicación y descargar informes masivos (solo lectura)». |  |  |
| `guide.bucket.step3` | Still refused? Open the bucket in Google Cloud. If you can see its permissions, the service account must be listed with Storage Object Viewer. Google manages this bucket for most accounts, so the invitation above is normally enough. | ¿Sigue denegado? Abre el bucket en Google Cloud. Si ves sus permisos, la cuenta de servicio debe aparecer con Storage Object Viewer. Google gestiona este bucket en la mayoría de las cuentas, así que la invitación de arriba suele bastar. |  |  |
| `guide.bucket.step4` | Wait: a new permission can take 24 to 48 hours to apply. Then press Test access. | Espera: un permiso nuevo puede tardar de 24 a 48 horas en aplicarse. Luego pulsa Probar el acceso. |  |  |
| `guide.bucketId.cause` | Copy the Cloud Storage URI from Play Console, Download reports, Statistics, and set it for the Play account that owns this app. | Copia el URI de Cloud Storage desde Play Console, Descargar informes, Estadísticas, e indícalo para la cuenta de Play propietaria de esta app. |  |  |
| `guide.finance.cause` | Google lets the service account read the statistics but refuses the financial reports (sales, earnings, subscriptions). The missing piece is a Play Console permission, not Cloud Storage. | Google deja que la cuenta de servicio lea las estadísticas pero deniega los informes financieros (ventas, ingresos, suscripciones). Lo que falta es un permiso de Play Console, no de Cloud Storage. |  |  |
| `guide.finance.step1` | In Play Console, open Users and permissions, then the service account with the address below. | En Play Console, abre Usuarios y permisos y luego la cuenta de servicio con la dirección de abajo. |  |  |
| `guide.finance.step2` | Under Account permissions, tick “View financial data, orders and cancellation survey responses”. It must apply to the whole account (Global, all apps), not to one app. | En Permisos de la cuenta, marca «Ver datos financieros, pedidos y respuestas de encuestas de cancelación». Debe aplicarse a toda la cuenta (Global, todas las apps), no a una sola app. |  |  |
| `guide.finance.step3` | Save, wait up to 24 to 48 hours, then press Test access. | Guarda, espera hasta 24 o 48 horas y pulsa Probar el acceso. |  |  |
| `guide.heading` | How to fix this | Cómo solucionarlo |  |  |
| `guide.link.bucket` | Open the bucket permissions | Abrir los permisos del bucket |  |  |
| `guide.link.playConsole` | Open Play Console | Abrir Play Console |  |  |
| `guide.link.usersAndAccess` | Open Users and Access | Abrir Usuarios y acceso |  |  |
| `guide.link.usersAndPermissions` | Open Users and permissions | Abrir Usuarios y permisos |  |  |
| `guide.link.vendor` | Open Payments and Financial Reports | Abrir Pagos e informes financieros |  |  |
| `guide.opensNew` | (opens in a new tab) | (se abre en una pestaña nueva) |  |  |
| `guide.otherAccount` | This app reads the bucket set for the whole workspace, and the workspace has several Play accounts. That bucket is probably the one of another account: set the bucket of this app’s own account below. | Esta app lee el bucket definido para todo el espacio de trabajo, que tiene varias cuentas de Play. Ese bucket probablemente es el de otra cuenta: indica abajo el bucket de la cuenta de esta app. |  |  |
| `guide.role.cause` | Apple refused the API key the Sales and Trends reports (403). Two things cause this: the role of the key, or a vendor number that belongs to another Apple team. | Apple denegó a la clave de API los informes de Ventas y tendencias (403). Hay dos causas posibles: el rol de la clave o un número de proveedor de otro equipo de Apple. |  |  |
| `guide.role.step1` | In App Store Connect, Users and Access, Integrations: the key needs the role Sales, Finance, Admin or Account Holder. Roles without access to sales, such as Developer or Marketing, are refused. Create a key with the right role and replace it under Credentials. | En App Store Connect, Usuarios y acceso, Integraciones: la clave necesita el rol Ventas, Finanzas, Admin o Titular de la cuenta. Los roles sin acceso a ventas, como Developer o Marketing, se rechazan. Crea una clave con el rol adecuado y reemplázala en Credenciales. |  |  |
| `guide.role.step2` | Check that the vendor number below is the one of the same team as the key. | Comprueba que el número de proveedor de abajo es el del mismo equipo que la clave. |  |  |
| `guide.testAccess` | Test access | Probar el acceso |  |  |
| `guide.testNoReport` | Access works. The store has no file for the period asked yet, which is normal for a new app or a new month. | El acceso funciona. La tienda aún no tiene archivo para el periodo pedido, lo normal en una app nueva o un mes nuevo. |  |  |
| `guide.testOk` | Access works. Nothing is missing for this source. | El acceso funciona. No falta nada para esta fuente. |  |  |
| `guide.testing` | Testing… | Probando… |  |  |
| `guide.vendor.causeInvalid` | Apple does not accept this vendor number. Check it against App Store Connect. | Apple no acepta este número de proveedor. Compáralo con App Store Connect. |  |  |
| `guide.vendor.causeMissing` | Sales and Trends and the subscription reports need the vendor number of your Apple team. | Ventas y tendencias y los informes de suscripciones necesitan el número de proveedor de tu equipo de Apple. |  |  |
| `guide.vendor.hint` | Digits only, 5 to 12. | Solo dígitos, de 5 a 12. |  |  |
| `guide.vendor.invalid` | Enter digits only, 5 to 12 of them. | Introduce solo dígitos, de 5 a 12. |  |  |
| `guide.vendor.label` | Vendor number | Número de proveedor |  |  |
| `guide.vendor.saved` | Vendor number saved. | Número de proveedor guardado. |  |  |
| `guide.vendor.step1` | Open Payments and Financial Reports in App Store Connect. The vendor number is shown at the top left, next to the team name (about 8 digits). | Abre Pagos e informes financieros en App Store Connect. El número de proveedor aparece arriba a la izquierda, junto al nombre del equipo (unos 8 dígitos). |  |  |
| `guide.vendor.step2` | Enter it here. It is kept for this Apple team, so apps of another team can have their own number. | Introdúcelo aquí. Se guarda para este equipo de Apple, así que las apps de otro equipo pueden tener su propio número. |  |  |
| `guide.vendor.usingWorkspace` | Now using the workspace default. Saving a number here keeps it for this Apple team only. | Se usa el valor predeterminado del espacio de trabajo. Al guardar un número aquí solo se aplica a este equipo de Apple. |  |  |
| `metric.anrRatePerceived` | User-perceived ANR rate | Tasa de ANR percibida por los usuarios |  |  |
| `metric.anrUsers` | Users behind the ANR rate | Usuarios detrás de la tasa de ANR |  |  |
| `metric.crashRatePerceived` | User-perceived crash rate | Tasa de fallos percibida por los usuarios |  |  |
| `metric.crashUsers` | Users behind the crash rate | Usuarios detrás de la tasa de fallos |  |  |
| `overview.empty.error` | No {{platform}} numbers: they could not be read. | Sin cifras de {{platform}}: no se pudieron leer. |  |  |
| `overview.empty.loading` | Reading {{platform}} data… | Leyendo los datos de {{platform}}… |  |  |
| `overview.empty.never` | No {{platform}} data yet. Nothing has been read: use Sync in the header, or check the data sources. | Aún no hay datos de {{platform}}. No se ha leído nada: usa Sincronizar en la cabecera o revisa las fuentes de datos. |  |  |
| `overview.empty.off` | No {{platform}} data yet. Analytics is off, so nothing is read. | Aún no hay datos de {{platform}}. Las analíticas están desactivadas, así que no se lee nada. |  |  |
| `overview.measure` | Measure | Medida |  |  |
| `overview.noValue` | No data | Sin datos |  |  |
| `overview.openSources` | Open Data sources | Abrir las fuentes de datos |  |  |
| `rail.acquisition` | Acquisition | Adquisición |  |  |
| `rail.groupMore` | More | Más |  |  |
| `rail.groupNumbers` | Numbers | Cifras |  |  |
| `rail.label` | Sections of Insights | Secciones de Insights |  |  |
| `rail.next` | Next steps | Próximos pasos |  |  |
| `rail.nothingStored` | Nothing stored for this yet. See Data sources. | Aún no hay nada guardado aquí. Consulta Fuentes de datos. |  |  |
| `rail.overview` | Overview | Resumen |  |  |
| `rail.quality` | Quality | Calidad |  |  |
| `rail.revenue` | Revenue | Ingresos |  |  |
| `rail.sources` | Data sources | Fuentes de datos |  |  |
| `rail.sourcesFailed_one` | {{count}} source could not be read | No se pudo leer {{count}} fuente |  |  |
| `rail.sourcesFailed_other` | {{count}} sources could not be read | No se pudieron leer {{count}} fuentes |  |  |
| `revenue.openProducts` | Products and sync | Productos y sincronización |  |  |
| `revenue.title` | Revenue | Ingresos |  |  |
| `revenue.waiting` | The RevenueCat figures are not read yet. Open Products and choose “Sync products” to read them. | Las cifras de RevenueCat aún no se han leído. Abre Productos y elige «Sincronizar productos» para leerlas. |  |  |
| `setup.bucketForbidden` | Google refuses the service account the Play Console reports bucket. See the steps below. | Google deniega a la cuenta de servicio el bucket de informes de Play Console. Mira los pasos de abajo. |  |  |
| `setup.bucketNotFound` | Google Cloud Storage has no bucket with this id. Set the bucket of this app’s Play account. | Google Cloud Storage no tiene ningún bucket con este id. Indica el bucket de la cuenta de Play de esta app. |  |  |
| `setup.packageNotInBucket` | This bucket can be read but holds no report of this app: it is probably the bucket of another Play account. Set the bucket of the account that owns this app. | Este bucket se puede leer pero no contiene ningún informe de esta app: probablemente es el bucket de otra cuenta de Play. Indica el bucket de la cuenta propietaria de esta app. |  |  |
| `setup.playSalesForbidden` | Google reads the statistics but refuses the financial reports (sales, earnings, subscriptions). One Play Console permission is missing. See the steps below. | Google lee las estadísticas pero deniega los informes financieros (ventas, ingresos, suscripciones). Falta un permiso de Play Console. Mira los pasos de abajo. |  |  |
| `setup.salesForbidden` | Apple refuses the key the Sales and Trends reports. Its role or the vendor number is wrong. See the steps below. | Apple deniega a la clave los informes de Ventas y tendencias. Su rol o el número de proveedor es incorrecto. Mira los pasos de abajo. |  |  |
| `setup.vendorNumberInvalid` | Apple does not accept this vendor number. It must be the one of the same Apple team as this app’s key. | Apple no acepta este número de proveedor. Debe ser el del mismo equipo de Apple que la clave de esta app. |  |  |
| `setup.vendorNumberMissing` | Optional: enter the Apple vendor number of this app’s team to read daily units and proceeds, also by product, and subscription counts. | Opcional: introduce el número de proveedor de Apple del equipo de esta app para leer unidades e ingresos diarios, también por producto, y el número de suscripciones. |  |  |
| `sources.retryStillFailed` | {{source}} could not be read again. The reason is in the list. | {{source}} no se pudo volver a leer. El motivo está en la lista. |  |  |

## web/app (211)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `builds.group.automation` | Automation | Automatización |  |  |
| `builds.navLabel` | Sections of Builds | Secciones de Builds |  |  |
| `builds.section.config` | EAS configuration | Configuración de EAS |  |  |
| `builds.section.submissions` | EAS submissions | Envíos de EAS |  | submit = enviar |
| `builds.section.tests` | Test builds | Builds de prueba |  |  |
| `builds.section.updates` | EAS updates | Actualizaciones de EAS |  |  |
| `builds.section.workflows` | Workflows | Flujos de trabajo |  |  |
| `cart.added` | Added to pending changes | Añadido a los cambios pendientes |  | cart = "Cambios pendientes" |
| `cart.bundleNote` | Staged changes are sent to the store together as one draft, so selecting one selects them all. | Los cambios preparados se envían juntos a la tienda como un solo borrador, así que elegir uno los elige todos. |  | stage = preparar (nothing is sent) |
| `cart.confirm.approval` | You will be asked to confirm again. | Se te pedirá confirmar de nuevo. |  |  |
| `cart.confirm.discardBody` | This removes the draft here only. The store is not touched and nothing is sent. | Esto elimina solo el borrador de aquí. La tienda no se toca y no se envía nada. |  |  |
| `cart.confirm.discardGo` | Discard | Descartar |  |  |
| `cart.confirm.discardTitle_one` | Discard {{count}} item? | ¿Descartar {{count}} elemento? |  |  |
| `cart.confirm.discardTitle_other` | Discard {{count}} items? | ¿Descartar {{count}} elementos? |  |  |
| `cart.confirm.drafts_one` | {{count}} staged change will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} cambio preparado se escribirá en {{stores}} como borrador. No se envía nada a revisión. |  | stage = preparar (nothing is sent); review: reseña (user) vs revisión (App Review) |
| `cart.confirm.drafts_other` | {{count}} staged changes will be written to {{stores}} as a draft. Nothing is submitted for review. | {{count}} cambios preparados se escribirán en {{stores}} como borrador. No se envía nada a revisión. |  | stage = preparar (nothing is sent); review: reseña (user) vs revisión (App Review) |
| `cart.confirm.go` | Publish | Publicar |  |  |
| `cart.confirm.pricesDelay` | Stores can take a while to show a new price everywhere. If an answer is lost, Kiln reads the store back instead of sending again. | Las tiendas pueden tardar en mostrar un precio nuevo en todas partes. Si se pierde una respuesta, Kiln vuelve a leer la tienda en lugar de enviar de nuevo. |  |  |
| `cart.confirm.prices_one` | {{count}} price change goes live in the store. It changes what customers pay. | {{count}} cambio de precio se aplicará en la tienda. Cambia lo que pagan los clientes. |  | live = vivo / publicada |
| `cart.confirm.prices_other` | {{count}} price changes go live in the store. They change what customers pay. | {{count}} cambios de precio se aplicarán en la tienda. Cambian lo que pagan los clientes. |  | live = vivo / publicada |
| `cart.confirm.publishTitle_one` | Publish {{count}} item? | ¿Publicar {{count}} elemento? |  |  |
| `cart.confirm.publishTitle_other` | Publish {{count}} items? | ¿Publicar {{count}} elementos? |  |  |
| `cart.confirm.replies_one` | {{count}} reply will be public on {{stores}} right away. | {{count}} respuesta será pública en {{stores}} de inmediato. |  |  |
| `cart.confirm.replies_other` | {{count}} replies will be public on {{stores}} right away. | {{count}} respuestas serán públicas en {{stores}} de inmediato. |  |  |
| `cart.confirm.type` | To confirm, type | Para confirmar, escriba |  |  |
| `cart.confirm.typeFor` | For {{platform}}, type | Para {{platform}}, escriba |  |  |
| `cart.countAnnounce_one` | {{count}} pending change | {{count}} cambio pendiente |  |  |
| `cart.countAnnounce_other` | {{count}} pending changes | {{count}} cambios pendientes |  | cart = "Cambios pendientes" |
| `cart.diffNew` | New: {{after}} | Nuevo: {{after}} |  |  |
| `cart.discard` | Discard selected | Descartar la selección |  |  |
| `cart.dryRun.button` | Check prices with the store (dry run) | Comprobar precios con la tienda (simulación) |  |  |
| `cart.dryRun.error` | Could not check | No se pudo comprobar |  |  |
| `cart.dryRun.noStoreCheck` | This store has no check of its own. These requests would be sent: | Esta tienda no tiene comprobación propia. Se enviarían estas solicitudes: |  |  |
| `cart.dryRun.note` | Kiln read the store and checked each change. Nothing was sent. | Kiln leyó la tienda y comprobó cada cambio. No se envió nada. |  |  |
| `cart.dryRun.refused` | Would be refused | Se rechazaría |  |  |
| `cart.dryRun.storeChecked` | The store's own check accepted it. | La comprobación de la tienda lo aceptó. |  |  |
| `cart.dryRun.switchOff` | Sending is switched off: this check works, but a send would be refused. | El envío está desactivado: esta comprobación funciona, pero un envío se rechazaría. |  |  |
| `cart.dryRun.title` | Dry run of the price changes | Simulación de los cambios de precio |  |  |
| `cart.dryRun.wouldSend` | Would be sent | Se enviaría |  |  |
| `cart.empty` | Nothing is waiting. Changes you stage and replies you draft appear here. | No hay nada pendiente. Los cambios que prepares y las respuestas que redactes aparecerán aquí. |  | stage = preparar (nothing is sent) |
| `cart.fabLabel` | Pending | Pendientes |  |  |
| `cart.files_one` | {{count}} file | {{count}} archivo |  |  |
| `cart.files_other` | {{count}} files | {{count}} archivos |  |  |
| `cart.fixFirst` | Fix this first: {{message}} | Corrígelo primero: {{message}} |  |  |
| `cart.graphicsDiff` | {{before}} → {{after}} images | {{before}} → {{after}} imágenes |  |  |
| `cart.group.graphics` | Graphics | Gráficos |  |  |
| `cart.group.listing` | Store listing | Ficha de la tienda |  | listing = ficha |
| `cart.group.price` | Price changes | Cambios de precio |  |  |
| `cart.group.release` | Release details | Detalles de la versión |  | release = lanzamiento |
| `cart.group.reviewReply` | Review replies | Respuestas a reseñas |  | review: reseña (user) vs revisión (App Review) |
| `cart.intro` | Nothing is published until you review it here and send it. | No se publica nada hasta que lo revises aquí y lo envíes. |  | review: reseña (user) vs revisión (App Review) |
| `cart.loadFailed` | Could not load the pending changes. | No se pudieron cargar los cambios pendientes. |  | cart = "Cambios pendientes" |
| `cart.open` | Open | Abrir |  |  |
| `cart.openAria_one` | Open pending changes: {{count}} item waiting | Abrir los cambios pendientes: {{count}} elemento |  | cart = "Cambios pendientes" |
| `cart.openAria_other` | Open pending changes: {{count}} items waiting | Abrir los cambios pendientes: {{count}} elementos |  | cart = "Cambios pendientes" |
| `cart.openRow` | Open {{title}} where it was made | Abrir {{title}} donde se creó |  |  |
| `cart.price.acks` | Confirmed: | Confirmado: |  |  |
| `cart.price.asap` | As soon as the store allows | En cuanto la tienda lo permita |  |  |
| `cart.price.caption` | Price changes of {{id}} | Cambios de precio de {{id}} |  |  |
| `cart.price.colChange` | Price | Precio |  |  |
| `cart.price.colPercent` | Change | Variación |  |  |
| `cart.price.confirmed` | Confirmed by the store | Confirmado por la tienda |  |  |
| `cart.price.from` | From {{date}} | Desde el {{date}} |  |  |
| `cart.price.lineFailed` | {{territory}}: {{amount}} {{outcome}} | {{territory}}: {{amount}} {{outcome}} |  |  |
| `cart.price.lineRefused` | was not changed | no se cambió |  |  |
| `cart.price.lineUnknown` | may not have reached the store | puede que no haya llegado a la tienda |  |  |
| `cart.price.noPrice` | no price | ningún precio |  |  |
| `cart.price.notSent` | Nothing was sent. | No se envió nada. |  |  |
| `cart.price.perCurrency` | {{currency}}: {{up}} up, {{down}} down | {{currency}}: {{up}} al alza, {{down}} a la baja |  |  |
| `cart.price.storeShows` | Store shows {{actual}} for {{territory}}, not {{expected}}. | La tienda muestra {{actual}} para {{territory}}, no {{expected}}. |  |  |
| `cart.price.storeShowsOther` | The store shows other prices than the ones asked. | La tienda muestra otros precios que los pedidos. |  |  |
| `cart.price.summary_one` | Price change in {{count}} territory. | Cambio de precio en {{count}} territorio. |  |  |
| `cart.price.summary_other` | Price change in {{count}} territories. | Cambio de precio en {{count}} territorios. |  |  |
| `cart.price.territories_one` | Show {{count}} territory | Mostrar {{count}} territorio |  |  |
| `cart.price.territories_other` | Show {{count}} territories | Mostrar {{count}} territorios |  |  |
| `cart.price.unverified` | Not verified: the store's prices could not be read back. | Sin verificar: no se pudieron volver a leer los precios de la tienda. |  |  |
| `cart.publishPage` | Open the full publish page | Abrir la página de publicación completa |  |  |
| `cart.publishPageHint` | Submitting, releasing and rollout steps are done there. | El envío a revisión, el lanzamiento y el despliegue gradual se hacen allí. |  | rollout = despliegue; submit = enviar |
| `cart.publish_one` | Publish {{count}} selected | Publicar {{count}} seleccionado |  |  |
| `cart.publish_other` | Publish {{count}} selected | Publicar {{count}} seleccionados |  |  |
| `cart.reason.bundleBlocked` | Another staged change has an error, and they are sent together. | Otro cambio preparado tiene un error, y se envían juntos. |  | stage = preparar (nothing is sent) |
| `cart.reason.inProgress` | A send is already running. | Ya hay un envío en curso. |  |  |
| `cart.reason.invalid` | This change has an error and cannot be sent yet. | Este cambio tiene un error y todavía no se puede enviar. |  |  |
| `cart.reason.metadataLocked` | This version is live or in review, so its listing is locked. Prepare a new version first. | Esta versión está publicada o en revisión, así que su ficha está bloqueada. Prepara primero una versión nueva. |  | listing = ficha; review: reseña (user) vs revisión (App Review) |
| `cart.reason.noRight` | You do not have the right to send this. | No tienes permiso para enviar esto. |  |  |
| `cart.reason.other` | It cannot be sent right now. | No se puede enviar ahora. |  |  |
| `cart.reason.outcomeUnknown` | The last send did not answer. Check the store first. | El último envío no respondió. Comprueba primero la tienda. |  |  |
| `cart.reason.switchOff` | Sending this to the store is switched off for this server. | El envío a la tienda está desactivado en este servidor. |  |  |
| `cart.reason.workspaceOff` | Price changes are switched off for this workspace. | Los cambios de precio están desactivados para este espacio de trabajo. |  |  |
| `cart.report.dismiss` | Dismiss | Cerrar |  |  |
| `cart.report.summary` | {{ok}} done, {{failed}} failed, {{skipped}} skipped | {{ok}} hechos, {{failed}} con error, {{skipped}} omitidos |  |  |
| `cart.result.blocked` | The store check blocks this change. | La comprobación de la tienda bloquea este cambio. |  |  |
| `cart.result.bundleIncomplete` | Staged changes are sent together. Select all of them. | Los cambios preparados se envían juntos. Selecciónalos todos. |  | stage = preparar (nothing is sent) |
| `cart.result.changedSinceReview` | It changed after you opened this list. Review it again. | Cambió después de abrir esta lista. Revísalo de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `cart.result.confirmationMismatch` | The typed phrase was not the right one. Nothing was sent. | La frase escrita no era la correcta. No se envió nada. |  |  |
| `cart.result.network` | Could not reach the server. | No se pudo conectar con el servidor. |  |  |
| `cart.result.notPending` | Already sent or removed. | Ya enviado o eliminado. |  |  |
| `cart.result.other` | It could not be sent. | No se pudo enviar. |  |  |
| `cart.result.priceAck` | An acknowledgement is missing. | Falta una confirmación. |  |  |
| `cart.result.priceCurrency` | The currency of a territory changed in the store. Nothing was changed. | La moneda de un territorio cambió en la tienda. No se cambió nada. |  |  |
| `cart.result.priceInvalid` | The change has an error and was not sent. | El cambio tiene un error y no se envió. |  |  |
| `cart.result.priceNotAllowed` | The store does not allow this price change now (for example, one is already scheduled). | La tienda no permite este cambio de precio ahora (por ejemplo, ya hay uno programado). |  |  |
| `cart.result.pricePartial` | Some territories were changed and some were not. See below. | Algunos territorios se cambiaron y otros no. Vea abajo. |  |  |
| `cart.result.pricePoint` | An amount is not an Apple price point. | Un importe no es un nivel de precio de Apple. |  |  |
| `cart.result.priceProduct` | The product no longer exists in the store. | El producto ya no existe en la tienda. |  |  |
| `cart.result.priceRejected` | The store rejected the price change. | La tienda rechazó el cambio de precio. |  |  |
| `cart.result.priceStale` | The price in the store changed since you reviewed it. Nothing was changed. Sync and review again. | El precio en la tienda cambió desde su revisión. No se cambió nada. Sincronice y revise de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `cart.result.priceSubscribers` | The store does not accept that choice for existing subscribers. | La tienda no acepta esa opción para los suscriptores actuales. |  |  |
| `cart.result.priceTerritory` | The store does not support a price in one of these territories. | La tienda no admite un precio en uno de estos territorios. |  |  |
| `cart.result.rateLimited` | The store asked for a pause. Nothing more was sent. Review again in a moment. | La tienda pidió una pausa. No se envió nada más. Revisa de nuevo en un momento. |  | review: reseña (user) vs revisión (App Review) |
| `cart.result.stagedInvalid` | A staged change has an error. | Un cambio preparado tiene un error. |  | stage = preparar (nothing is sent) |
| `cart.result.stateChanged` | The store changed since it was checked. Review again. | La tienda cambió desde la comprobación. Revisa de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `cart.result.stepUpRequired` | The confirmation was not completed. | La confirmación no se completó. |  |  |
| `cart.review` | Review | Revisar |  | review: reseña (user) vs revisión (App Review) |
| `cart.reviewLine` | Review, {{stars}}: {{excerpt}} | Reseña, {{stars}}: {{excerpt}} |  | review: reseña (user) vs revisión (App Review) |
| `cart.risk.financial` | Changes what customers pay | Cambia lo que pagan los clientes |  |  |
| `cart.risk.publicReply` | Public reply | Respuesta pública |  |  |
| `cart.risk.storeDraft` | Store draft | Borrador de la tienda |  |  |
| `cart.selectAll` | Select all | Seleccionar todo |  |  |
| `cart.selectedCount` | {{selected}} of {{total}} selected | {{selected}} de {{total}} seleccionados |  |  |
| `cart.stars_one` | {{count}} star | {{count}} estrella |  |  |
| `cart.stars_other` | {{count}} stars | {{count}} estrellas |  |  |
| `cart.status.failed` | Failed | Error |  |  |
| `cart.status.ok` | Done | Hecho |  |  |
| `cart.status.running` | Sending | Enviando |  |  |
| `cart.status.skipped` | Skipped | Omitido |  |  |
| `cart.title` | Pending changes | Cambios pendientes |  | cart = "Cambios pendientes" |
| `listingSettings.compareMedia` | Compare repository and store graphics | Comparar gráficos del repositorio y de la tienda |  |  |
| `listingSettings.compareMediaHint` | Compares the screenshots and icons in the repository with the store's; the store's own graphics are listed either way. | Compara las capturas e iconos del repositorio con los de la tienda; los gráficos de la tienda se listan en cualquier caso. |  |  |
| `listingSettings.compareRepo` | Compare repository and store | Comparar repositorio y tienda |  |  |
| `listingSettings.compareRepoHint` | Shows where the repository text and the store text differ and offers to stage the repository text; leave it off if this app keeps no fastlane files. | Muestra dónde difieren el texto del repositorio y el de la tienda y ofrece preparar el del repositorio; déjalo desactivado si esta app no tiene archivos fastlane. |  | stage = preparar (nothing is sent) |
| `listingSettings.description` | Choose whether Kiln compares your repository with the store; the store page is always checked on its own. | Elige si Kiln compara tu repositorio con la tienda; la ficha de la tienda siempre se comprueba por sí sola. |  |  |
| `listingSettings.forbidden` | Only an admin can change this setting. | Solo un admin puede cambiar este ajuste. |  |  |
| `listingSettings.notSaved` | Not saved | No guardado |  |  |
| `listingSettings.readOnly` | You can see these settings; an admin changes them. | Puedes ver estos ajustes; un admin los cambia. |  |  |
| `listingSettings.saveFailed` | The setting could not be saved. Try again. | No se pudo guardar el ajuste. Inténtalo de nuevo. |  |  |
| `listingSettings.saved` | Listing setting saved. | Ajuste de la ficha guardado. |  | listing = ficha |
| `nav.badgeInsights_one` | {{count}} insight to look at | {{count}} punto que revisar en los análisis |  |  |
| `nav.badgeInsights_other` | {{count}} insights to look at | {{count}} puntos que revisar en los análisis |  |  |
| `nav.expandToSwitch` | {{name}}: expand the navigation to switch apps | {{name}}: expandir la navegación para cambiar de app |  |  |
| `settings.group.connections` | Connections | Conexiones |  |  |
| `settings.group.danger` | Removal | Eliminación |  |  |
| `settings.group.data` | Data and alerts | Datos y alertas |  |  |
| `settings.group.releases` | Releases | Lanzamientos |  | release = lanzamiento |
| `settings.integrationsNone` | Nothing here applies to this app yet: no Expo project and no RevenueCat link are available for it. | Nada de esto se aplica aún a esta app: no hay proyecto de Expo ni vínculo con RevenueCat disponible. |  |  |
| `settings.navLabel` | Sections of the app settings | Secciones de los ajustes de la app |  |  |
| `settings.part.integrations` | Expo and RevenueCat | Expo y RevenueCat |  |  |
| `settings.part.listing` | Store listing | Ficha de la tienda |  | listing = ficha |
| `stores.effective.bucket` | Play reports bucket | Bucket de informes de Play |  |  |
| `stores.effective.fromAccount` | from this Play account | de esta cuenta de Play |  |  |
| `stores.effective.fromApp` | set on this app | definido en esta app |  |  |
| `stores.effective.fromCredential` | from this credential | de esta credencial |  |  |
| `stores.effective.fromWorkspace` | from the workspace default | valor predeterminado del espacio de trabajo |  |  |
| `stores.effective.vendorNumber` | Vendor number | Número de proveedor |  |  |
| `stores.identifiers` | Identifiers | Identificadores |  |  |
| `sync.couldNotRead` | Could not read: {{what}}. | No se pudo leer: {{what}}. |  |  |
| `sync.hint.ads` | Press Sync. If it keeps failing, check the Apple Ads key under Credentials. | Pulsa Sincronizar. Si sigue fallando, revisa la clave de Apple Ads en Credenciales. |  |  |
| `sync.hint.analytics` | Open Insights, Data sources, and follow the next step of that source. | Abre Insights, Fuentes de datos, y sigue el siguiente paso de esa fuente. |  |  |
| `sync.hint.app` | Check the store credential in the app settings, then press Sync. | Revisa la credencial de la tienda en los ajustes de la app y pulsa Sincronizar. |  |  |
| `sync.hint.eas` | Press Sync. If it keeps failing, check the Expo access token under Credentials. | Pulsa Sincronizar. Si sigue fallando, revisa el token de acceso de Expo en Credenciales. |  |  |
| `sync.hint.products` | Press Sync. Check that the store credential may read in-app products. | Pulsa Sincronizar. Comprueba que la credencial de la tienda puede leer los productos integrados. |  |  |
| `sync.hint.reviews` | Press Sync. If it keeps failing, check that the store credential may read reviews. | Pulsa Sincronizar. Si sigue fallando, comprueba que la credencial de la tienda puede leer reseñas. |  | review: reseña (user) vs revisión (App Review) |
| `sync.hint.testflight` | Press Sync. Check that the App Store Connect key may read beta feedback. | Pulsa Sincronizar. Comprueba que la clave de App Store Connect puede leer los comentarios beta. |  |  |
| `sync.kind.ads` | Apple Ads reports | Informes de Apple Ads |  |  |
| `sync.kind.analytics` | Analytics | Analíticas |  |  |
| `sync.kind.app` | Store listing and releases | Ficha de la tienda y versiones |  | release = lanzamiento; listing = ficha |
| `sync.kind.eas` | EAS builds and submissions | Builds y envíos de EAS |  | submit = enviar |
| `sync.kind.products` | In-app products and RevenueCat | Productos integrados y RevenueCat |  |  |
| `sync.kind.reviews` | Reviews | Reseñas |  | review: reseña (user) vs revisión (App Review) |
| `sync.kind.testflight` | TestFlight feedback | Comentarios de TestFlight |  |  |
| `sync.lastRead` | Read {{ago}} | Leído {{ago}} |  |  |
| `sync.neverRead` | Never read | Nunca leído |  |  |
| `sync.none` | Nothing to sync yet. Connect a store in the app settings. | Nada que sincronizar todavía. Conecta una tienda en los ajustes de la app. |  |  |
| `sync.notReadYet` | Not read yet. Use Sync at the top of the page. | Aún sin leer. Usa Sincronizar en la parte superior de la página. |  |  |
| `sync.problem` | Some sources could not be queued: {{message}} | Algunas fuentes no se pudieron poner en cola: {{message}} |  |  |
| `sync.running` | Syncing… | Sincronizando… |  |  |
| `sync.seeStatus` | See Status | Ver Estado |  |  |
| `sync.sourcesLabel` | What this app is synced from | De dónde se sincroniza esta app |  |  |
| `sync.sourcesTitle` | Sources | Fuentes |  |  |
| `sync.state.failed` | Could not read | No se pudo leer |  |  |
| `sync.state.never` | Not read yet | Aún sin leer |  |  |
| `sync.state.ok` | Up to date | Al día |  |  |
| `sync.state.running` | Syncing | Sincronizando |  |  |
| `sync.updated` | Updated {{ago}} | Actualizado {{ago}} |  |  |
| `syncButton.everything` | Sync everything | Sincronizar todo |  |  |
| `syncButton.label.ads` | Sync Apple Ads | Sincronizar Apple Ads |  |  |
| `syncButton.label.analytics` | Sync analytics | Sincronizar analíticas |  |  |
| `syncButton.label.builds` | Sync builds | Sincronizar compilaciones |  |  |
| `syncButton.label.health` | Sync ratings and health | Sincronizar valoraciones y salud |  | rating = valoración |
| `syncButton.label.listing` | Sync listing | Sincronizar la ficha |  | listing = ficha |
| `syncButton.label.products` | Sync products | Sincronizar productos |  |  |
| `syncButton.label.reviews` | Sync reviews | Sincronizar reseñas |  | review: reseña (user) vs revisión (App Review) |
| `syncButton.label.timeline` | Sync timeline data | Sincronizar datos de la cronología |  |  |
| `syncButton.menuTitle` | Sync | Sincronización |  |  |
| `syncButton.more` | More sync options | Más opciones de sincronización |  |  |
| `syncButton.noPage` | Nothing on this page needs a sync. Sync everything reads the rest. | Nada en esta página necesita sincronizarse. «Sincronizar todo» lee el resto. |  |  |
| `syncButton.none` | Nothing to sync yet. | Aún no hay nada que sincronizar. |  |  |
| `syncButton.onlyFailed` | Only failed ({{failed}}) | Solo los fallidos ({{failed}}) |  |  |
| `syncButton.progress` | Syncing {{done}} of {{total}} | Sincronizando {{done}} de {{total}} |  |  |
| `syncButton.retry` | Retry failed ({{failed}}) | Reintentar los fallidos ({{failed}}) |  |  |
| `syncButton.retrySource` | Retry | Reintentar |  |  |
| `syncButton.run` | Sync | Sincronizar |  |  |
| `syncButton.runKind` | Sync: {{kind}} | Sincronizar: {{kind}} |  |  |
| `syncButton.upToDate` | Everything on this page was read recently. This reads it again. | Todo lo de esta página se leyó hace poco. Esto lo vuelve a leer. |  |  |
| `view.ads` | Ads | Anuncios |  |  |
| `view.countries` | Countries | Países |  |  |
| `view.experiments` | Experiments | Experimentos |  |  |
| `view.highlights` | Highlights | Destacados |  |  |
| `view.ratings` | Ratings and health | Valoraciones y salud |  | rating = valoración |
| `view.reviews` | Reviews | Reseñas |  | review: reseña (user) vs revisión (App Review) |
| `view.timeline` | Timeline and reports | Cronología e informes |  |  |

## web/aso (161)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `changes.category` | Category: {{from}} to {{to}} | Categoría: de {{from}} a {{to}} |  |  |
| `changes.checkFailed` | The check failed. | La comprobación falló. |  |  |
| `changes.checkNow` | Check now | Comprobar ahora |  |  |
| `changes.checkedAgo` | Last checked {{ago}}. | Última comprobación: {{ago}}. |  |  |
| `changes.checkedNone` | Checked: no new changes. | Comprobado: sin cambios nuevos. |  |  |
| `changes.checkedNotFound` | The store no longer lists this app in that country. | La tienda ya no muestra esta app en ese país. |  |  |
| `changes.checkedRecent` | Checked a moment ago. Kiln does not read the store again within 5 minutes. | Comprobado hace un momento. Kiln no vuelve a leer la tienda antes de 5 minutos. |  |  |
| `changes.checked_one` | Checked: {{count}} new change found. | Comprobado: {{count}} cambio nuevo. |  |  |
| `changes.checked_other` | Checked: {{count}} new changes found. | Comprobado: {{count}} cambios nuevos. |  |  |
| `changes.description` | Description changed | Descripción modificada |  |  |
| `changes.firstOnly` | Kiln saved the first look on {{date}}. Changes show from the next check on. | Kiln guardó la primera lectura el {{date}}. Los cambios se muestran a partir de la próxima comprobación. |  |  |
| `changes.icon` | Icon changed | Icono modificado |  |  |
| `changes.iconAlt` | Icon, {{side}} | Icono, {{side}} |  |  |
| `changes.listLabel` | Listing changes of {{name}} | Cambios de la ficha de {{name}} |  | listing = ficha |
| `changes.loadFailed` | The changes could not be loaded. | No se pudieron cargar los cambios. |  |  |
| `changes.name` | Name changed | Nombre modificado |  |  |
| `changes.noneSince` | Checked {{ago}}, no changes since we started watching on {{date}}. | Comprobado {{ago}}, sin cambios desde que empezamos a vigilar el {{date}}. |  |  |
| `changes.notChecked` | Not checked yet. Changes show from the first check on. | Aún sin comprobar. Los cambios se muestran desde la primera comprobación. |  |  |
| `changes.notWatched` | Not watched: Kiln does not read Google Play pages, so changes to this listing are not tracked. | Sin vigilar: Kiln no lee las páginas de Google Play, así que los cambios de esta ficha no se siguen. |  | listing = ficha |
| `changes.older` | Show older changes | Mostrar cambios anteriores |  |  |
| `changes.part.added_one` | {{count}} added | {{count}} añadida |  |  |
| `changes.part.added_other` | {{count}} added | {{count}} añadidas |  |  |
| `changes.part.removed_one` | {{count}} removed | {{count}} eliminada |  |  |
| `changes.part.removed_other` | {{count}} removed | {{count}} eliminadas |  |  |
| `changes.part.reordered` | reordered | reordenadas |  |  |
| `changes.part.replaced_one` | {{count}} replaced | {{count}} sustituida |  |  |
| `changes.part.replaced_other` | {{count}} replaced | {{count}} sustituidas |  |  |
| `changes.price` | Price: {{from}} to {{to}} | Precio: de {{from}} a {{to}} |  |  |
| `changes.rating` | Average rating: {{from}} to {{to}} stars | Valoración media: de {{from}} a {{to}} estrellas |  | rating = valoración |
| `changes.ratingCount` | Number of ratings: {{from}} to {{to}} | Número de valoraciones: de {{from}} a {{to}} |  | rating = valoración |
| `changes.releaseNotes` | Release notes changed | Notas de la versión modificadas |  | release = lanzamiento |
| `changes.retention` | Kept for {{days}} days, at most 200 changes per competitor. | Se guardan {{days}} días, como máximo 200 cambios por competidor. |  |  |
| `changes.screenshots` | {{device}} screenshots: {{parts}} | Capturas de {{device}}: {{parts}} |  |  |
| `changes.shotAlt` | Screenshot {{n}} of {{total}}, {{side}} ({{device}}) | Captura {{n}} de {{total}}, {{side}} ({{device}}) |  |  |
| `changes.showDiff` | Show the difference | Mostrar la diferencia |  |  |
| `changes.side.after` | after | después |  |  |
| `changes.side.before` | before | antes |  |  |
| `changes.sr.added` | Added: | Añadido: |  |  |
| `changes.sr.removed` | Removed: | Eliminado: |  |  |
| `changes.status.new` | new | nueva |  |  |
| `changes.status.removed` | removed | eliminada |  |  |
| `changes.stripLabel` | {{device}} screenshots, {{side}} | Capturas de {{device}}, {{side}} |  |  |
| `changes.summaryNone` | Listing changes: none seen yet | Cambios de la ficha: ninguno por ahora |  | listing = ficha |
| `changes.summaryNotWatched` | Listing changes: not watched | Cambios de la ficha: sin vigilar |  | listing = ficha |
| `changes.summary_one` | Listing changes ({{count}}{{more}}) | Cambios de la ficha ({{count}}{{more}}) |  | listing = ficha |
| `changes.summary_other` | Listing changes ({{count}}{{more}}) | Cambios de la ficha ({{count}}{{more}}) |  | listing = ficha |
| `changes.version` | Version: {{from}} to {{to}} | Versión: de {{from}} a {{to}} |  |  |
| `changes.watchingSince` | Watching since {{date}}: Kiln only sees changes from then on. | Vigilado desde el {{date}}: Kiln solo ve los cambios a partir de entonces. |  |  |
| `est.col.details` | Details | Detalles |  |  |
| `est.col.difficulty` | Difficulty (est.) | Dificultad (est.) |  |  |
| `est.col.keyword` | Keyword | Palabra clave |  |  |
| `est.col.opportunity` | Opportunity (est.) | Oportunidad (est.) |  |  |
| `est.col.popularity` | Popularity (est.) | Popularidad (est.) |  |  |
| `est.col.rank` | Rank | Posición |  |  |
| `est.confidence.high` | High confidence | Confianza alta |  |  |
| `est.confidence.low` | Low confidence | Confianza baja |  |  |
| `est.confidence.medium` | Medium confidence | Confianza media |  |  |
| `est.detail.appleAdsCampaigns` | Your campaigns: {{impressions}} impressions, {{taps}} taps, {{installs}} installs in {{days}} days. | Tus campañas: {{impressions}} impresiones, {{taps}} toques, {{installs}} instalaciones en {{days}} días. |  |  |
| `est.detail.appleAdsIntro` | Apple’s own numbers, shown beside the estimate and never mixed into it. | Las cifras propias de Apple, junto a la estimación y sin mezclarse nunca con ella. |  |  |
| `est.detail.appleAdsNoScore` | {{genre}}: Apple gave no popularity | {{genre}}: Apple no dio popularidad |  |  |
| `est.detail.appleAdsRank` | rank {{rank}} in the genre | puesto {{rank}} en el género |  |  |
| `est.detail.appleAdsScore` | {{genre}}: Apple popularity {{score}} of 100 | {{genre}}: popularidad de Apple {{score}} de 100 |  |  |
| `est.detail.close` | Close | Cerrar |  |  |
| `est.detail.col.ratings` | Ratings | Valoraciones |  | rating = valoración |
| `est.detail.competing` | Apps in the first results | Apps de los primeros resultados |  |  |
| `est.detail.competingNone` | No search results have been read yet. | Todavía no se han leído resultados de búsqueda. |  |  |
| `est.detail.difficulty` | Difficulty inputs | Entradas de la dificultad |  |  |
| `est.detail.hints` | Search hints | Sugerencias de búsqueda |  |  |
| `est.detail.hintsIntro` | What the App Store suggests while this term is typed, in its order. | Lo que sugiere la App Store mientras se escribe este término, en su orden. |  |  |
| `est.detail.hintsNone` | No hints have been read yet. | Todavía no se ha leído ninguna sugerencia. |  |  |
| `est.detail.line` | {{points}} of 100, share {{share}}% | {{points}} de 100, peso {{share}} % |  |  |
| `est.detail.noRead` | No public signal has been read yet. Model {{model}}. | Todavía no se ha leído ninguna señal pública. Modelo {{model}}. |  |  |
| `est.detail.opportunity` | Opportunity: your current rank leaves {{percent}}% of the room. | Oportunidad: tu posición actual deja un {{percent}} % de margen. |  |  |
| `est.detail.popularity` | Popularity inputs | Entradas de la popularidad |  |  |
| `est.detail.read` | Public signals read {{when}}. Model {{model}}. | Señales públicas leídas {{when}}. Modelo {{model}}. |  |  |
| `est.detail.title` | Why this estimate: {{term}} | Por qué esta estimación: {{term}} |  |  |
| `est.detail.trend` | Trend of the estimate | Evolución de la estimación |  |  |
| `est.detail.trendDifficulty` | Difficulty estimate over {{count}} days, latest {{latest}} | Estimación de dificultad en {{count}} días, última {{latest}} |  |  |
| `est.detail.trendLabel` | Popularity estimate over {{count}} days, latest {{latest}} | Estimación de popularidad en {{count}} días, última {{latest}} |  |  |
| `est.detail.trendNone` | The trend needs readings from at least two days. | La evolución necesita lecturas de al menos dos días. |  |  |
| `est.empty` | Estimates appear after the keywords have been checked. | Las estimaciones aparecen después de comprobar las palabras clave. |  |  |
| `est.filter.all` | All keywords | Todas las palabras clave |  |  |
| `est.filter.estimated` | With an estimate | Con estimación |  |  |
| `est.filter.label` | Show | Mostrar |  |  |
| `est.filter.none` | No estimate | Sin estimación |  |  |
| `est.filter.own` | From your data | De tus datos |  |  |
| `est.how.confidence` | Confidence says how much evidence is behind a number: one dot is low, two medium, three high. Public signals alone never reach high, and difficulty never does. | La confianza indica cuántas pruebas hay detrás de una cifra: un punto es baja, dos media, tres alta. Las señales públicas por sí solas nunca llegan a alta, ni tampoco la dificultad. |  |  |
| `est.how.demand` | Popularity: how many ratings the first results have, a weak sign of how big the niche is. | Popularidad: cuántas valoraciones tienen los primeros resultados, un indicio débil del tamaño del nicho. |  | rating = valoración |
| `est.how.difficulty` | Difficulty: how strong the first results are (their ratings), how many have every word of the term in their name, how crowded the results are, and how much your own rank moves between checks. | Dificultad: la fuerza de los primeros resultados (sus valoraciones), cuántos tienen todas las palabras del término en su nombre, lo saturados que están los resultados y cuánto se mueve tu posición entre comprobaciones. |  | rating = valoración |
| `est.how.hints` | Popularity: where the App Store suggests the term while someone types it (its search hints). | Popularidad: en qué posición sugiere la App Store el término mientras se escribe (sus sugerencias de búsqueda). |  |  |
| `est.how.intro` | Apple and Google publish no search volume for a term. Kiln combines what it can see: | Apple y Google no publican el volumen de búsqueda de un término. Kiln combina lo que puede ver: |  |  |
| `est.how.label` | How this is estimated | Cómo se estima |  |  |
| `est.how.limits` | Limits: the hints and the results are what Apple’s public services show and may differ from the App Store app. Each term is read once a day, at most {{count}} terms per check, only for keywords you track. Nothing is sent to an AI. | Límites: las sugerencias y los resultados son los de los servicios públicos de Apple y pueden diferir de la app de la App Store. Cada término se lee una vez al día, como máximo {{count}} términos por comprobación y solo de las palabras clave que sigues. No se envía nada a una IA. |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `est.how.none` | With no signal there is “No estimate”, never 0. Google Play keywords get an estimate only from your own search terms file. | Sin señal aparece «Sin estimación», nunca 0. Las palabras clave de Google Play solo tienen estimación con tu propio archivo de términos de búsqueda. |  |  |
| `est.how.own` | Popularity: your own visitors for the term (the Google Play search terms file). This is the strongest input and it is marked “from your data”. It is a lower bound: only people who reached your listing. | Popularidad: tus propios visitantes para el término (el archivo de términos de búsqueda de Google Play). Es la entrada más fuerte y se marca «de tus datos». Es un mínimo: solo cuenta a quienes llegaron a tu ficha. |  | listing = ficha |
| `est.lead` | Popularity and difficulty are estimates that Kiln works out from public signals and from your own data. They are not Apple’s popularity score and not a Google Play number. | La popularidad y la dificultad son estimaciones que Kiln calcula a partir de señales públicas y de tus propios datos. No son la puntuación de popularidad de Apple ni una cifra de Google Play. |  |  |
| `est.loadFailed` | The estimates could not be loaded. | No se pudieron cargar las estimaciones. |  |  |
| `est.noMatch` | No keyword matches this filter. | Ninguna palabra clave coincide con este filtro. |  |  |
| `est.none` | No estimate | Sin estimación |  |  |
| `est.noneWhy` | Why there is no estimate | Por qué no hay estimación |  |  |
| `est.opportunity.tip` | Opportunity is an estimate too: popularity, times how easy the term looks, times how much room your current rank leaves. It is a place to look, not a promise. | La oportunidad también es una estimación: la popularidad, por lo fácil que parece el término, por el margen que deja tu posición actual. Es un sitio donde mirar, no una promesa. |  |  |
| `est.origin.adsData` | from your data (Apple Ads) | de tus datos (Apple Ads) |  |  |
| `est.origin.ownData` | from your data | de tus datos |  |  |
| `est.origin.publicSignals` | from public signals | de señales públicas |  |  |
| `est.reason.adsImpressions` | Your Apple Ads campaigns showed this search term {{impressions}} times, with {{taps}} taps and {{installs}} installs, in {{days}} days. Only searches that reached one of your ads are counted. | Tus campañas de Apple Ads mostraron este término de búsqueda {{impressions}} veces, con {{taps}} toques y {{installs}} instalaciones, en {{days}} días. Solo se cuentan las búsquedas que llegaron a uno de tus anuncios. |  |  |
| `est.reason.hintsAbsent` | The App Store suggests {{size}} other terms but not this one. | La App Store sugiere otros {{size}} términos, pero no este. |  |  |
| `est.reason.hintsEmpty` | The App Store suggests nothing for this term. | La App Store no sugiere nada para este término. |  |  |
| `est.reason.hintsPosition` | The App Store suggests this term in place {{position}} of {{size}} while it is typed. | La App Store sugiere este término en el puesto {{position}} de {{size}} mientras se escribe. |  |  |
| `est.reason.noSignal` | No signal has been read yet. Check the keywords to read the App Store. | Todavía no se ha leído ninguna señal. Comprueba las palabras clave para leer la App Store. |  |  |
| `est.reason.ownVisitors` | {{visitors}} visitors and {{installs}} installs in {{days}} days, from your search terms file. Only people who reached your listing are counted. | {{visitors}} visitantes y {{installs}} instalaciones en {{days}} días, según tu archivo de términos de búsqueda. Solo se cuenta a quienes llegaron a tu ficha. |  | listing = ficha |
| `est.reason.playNeedsOwnData` | Google Play has no public signal. Import your Play Console search terms file to get an estimate. | Google Play no tiene ninguna señal pública. Importa tu archivo de términos de búsqueda de Play Console para obtener una estimación. |  |  |
| `est.reason.playNoCompetitionData` | Kiln does not read Google Play, so there is no difficulty estimate. | Kiln no lee Google Play, así que no hay estimación de dificultad. |  |  |
| `est.reason.rankVolatility` | Your rank moved {{meanMove}} places per check on average over {{checks}} checks. | Tu posición se movió {{meanMove}} puestos por comprobación de media en {{checks}} comprobaciones. |  |  |
| `est.reason.resultsCrowding` | The search returned {{total}} apps out of up to {{limit}}. | La búsqueda devolvió {{total}} apps de un máximo de {{limit}}. |  |  |
| `est.reason.resultsDemand` | The first {{apps}} results have {{ratings}} ratings together. | Los primeros {{apps}} resultados suman {{ratings}} valoraciones. |  | rating = valoración |
| `est.reason.resultsEmpty` | The search returned no apps. | La búsqueda no devolvió ninguna app. |  |  |
| `est.reason.resultsStrength` | The first {{apps}} results have a median of {{medianRatings}} ratings. | Los primeros {{apps}} resultados tienen una mediana de {{medianRatings}} valoraciones. |  | rating = valoración |
| `est.reason.resultsTitleMatch` | {{matching}} of the first {{apps}} results have every word of the term in their name. | {{matching}} de los primeros {{apps}} resultados tienen todas las palabras del término en su nombre. |  |  |
| `est.reason.tooFewResults` | Only {{apps}} results show a rating count, too few to estimate. | Solo {{apps}} resultados muestran un número de valoraciones, muy pocos para estimar. |  | rating = valoración |
| `est.reason.unknown` | Another input of the estimate. | Otra entrada de la estimación. |  |  |
| `est.showDetails` | Why this estimate for {{term}} | Por qué esta estimación para {{term}} |  |  |
| `est.sort.difficulty` | Easiest first | Más fáciles primero |  |  |
| `est.sort.label` | Sort the estimates | Ordenar las estimaciones |  |  |
| `est.sort.opportunity` | Opportunity first | Mayor oportunidad primero |  |  |
| `est.sort.popularity` | Most popular first | Más populares primero |  |  |
| `est.sort.term` | Keyword A to Z | Palabra clave de A a Z |  |  |
| `est.suggest.failed` | The keyword could not be tracked. | No se pudo seguir la palabra clave. |  |  |
| `est.suggest.from` | from {{terms}} | de {{terms}} |  |  |
| `est.suggest.lead` | Terms the App Store suggests for the keywords you track. Weigh them yourself: a suggestion does not promise traffic. | Términos que la App Store sugiere para las palabras clave que sigues. Valóralos tú: una sugerencia no promete tráfico. |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `est.suggest.none` | No related terms yet. Check the keywords to read the App Store’s hints. | Aún no hay términos relacionados. Comprueba las palabras clave para leer las sugerencias de la App Store. |  |  |
| `est.suggest.title` | Related terms | Términos relacionados |  |  |
| `est.suggest.track` | Track | Seguir |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `est.suggest.trackFor` | Track {{term}} | Seguir {{term}} |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `est.suggest.tracked` | Now tracking {{term}}. Check the keywords to read its estimate. | Ahora se sigue {{term}}. Comprueba las palabras clave para leer su estimación. |  |  |
| `est.title` | Keyword estimates | Estimaciones de palabras clave |  |  |
| `est.value` | {{score}} of 100, estimate | {{score}} de 100, estimación |  |  |
| `follow.adding` | Following… | Siguiendo… |  |  |
| `follow.badPackage` | That is not a package name. It looks like com.example.app, with at least two parts. | Eso no es un nombre de paquete. Tiene la forma com.example.app, con al menos dos partes. |  |  |
| `follow.count_one` | {{count}} app found | {{count}} app encontrada |  |  |
| `follow.count_other` | {{count}} apps found | {{count}} apps encontradas |  |  |
| `follow.empty` | No apps found for “{{term}}” in {{country}}. Try another spelling or storefront, or paste the link or id. | No se encontraron apps para «{{term}}» en {{country}}. Prueba otra ortografía u otra tienda, o pega el enlace o el id. |  |  |
| `follow.emptyShort` | No apps found | No se encontraron apps |  |  |
| `follow.free` | Free | Gratis |  |  |
| `follow.hintAppStore` | Type at least 2 letters to search the App Store, or paste an apps.apple.com link or an id. | Escribe al menos 2 letras para buscar en la App Store, o pega un enlace de apps.apple.com o un id. |  |  |
| `follow.hintPackage` | Google Play cannot be searched by name. Paste the package name (such as com.example.app) or the play.google.com address: the package is the text after id= in the address. | Google Play no se puede buscar por nombre. Pega el nombre del paquete (como com.example.app) o la dirección de play.google.com: el paquete es el texto que sigue a id= en la dirección. |  |  |
| `follow.keys` | Use the arrow keys to move through the results, Enter to follow, Escape to close. | Usa las flechas para recorrer los resultados, Intro para seguir y Esc para cerrar. |  |  |
| `follow.noRating` | No ratings | Sin valoraciones |  | rating = valoración |
| `follow.offline` | The server cannot be reached. Check your connection and try again. | No se puede contactar con el servidor. Revisa tu conexión e inténtalo de nuevo. |  |  |
| `follow.packageLabel` | Package name or Play Store link | Nombre del paquete o enlace de Play Store |  |  |
| `follow.ratings_one` | {{count}} rating | {{count}} valoración |  | rating = valoración |
| `follow.ratings_other` | {{count}} ratings | {{count}} valoraciones |  | rating = valoración |
| `follow.resolvedId` | App Store id {{id}} ({{country}}) recognised. Following reads it once. | Id de la App Store {{id}} ({{country}}) reconocido. Seguirlo lo lee una vez. |  |  |
| `follow.resolvedPackage` | Package {{id}} recognised. Following reads it once. | Paquete {{id}} reconocido. Seguirlo lo lee una vez. |  |  |
| `follow.results` | Search results | Resultados de la búsqueda |  |  |
| `follow.searchFailed` | The search did not work. Try again. | La búsqueda no funcionó. Inténtalo de nuevo. |  |  |
| `follow.searchLabel` | Search by name, or paste a store link or id | Busca por nombre, o pega un enlace o id de la tienda |  |  |
| `follow.searching` | Searching the App Store… | Buscando en la App Store… |  |  |
| `follow.stateFollowed` | Already followed | Ya la sigues |  |  |
| `follow.stateOwn` | This is your app | Es tu app |  |  |
| `follow.wrongStoreApple` | That is an App Store link or id, but this app is on Google Play. Choose the matching store. | Es un enlace o id de la App Store, pero esta app está en Google Play. Elige la tienda correspondiente. |  |  |
| `follow.wrongStorePlay` | That is a Google Play link or package, but this app is on the App Store. Choose the matching store. | Es un enlace o paquete de Google Play, pero esta app está en la App Store. Elige la tienda correspondiente. |  |  |

## web/assets (80)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `device.unrecognised` | Device not recognised | Dispositivo no reconocido |  |  |
| `filter.noDevice` | No device | Sin dispositivo |  |  |
| `lightbox.altNoDevice` | {{kind}} {{order}}, {{locale}}: {{name}} | {{kind}} {{order}}, {{locale}}: {{name}} |  |  |
| `store.add` | Add images | Añadir imágenes |  |  |
| `store.addTitle` | Add images | Añadir imágenes |  |  |
| `store.announceMoved` | Moved image {{from}} of {{set}} to place {{to}} (staged). | Imagen {{from}} de {{set}} movida a la posición {{to}} (preparado). |  | stage = preparar (nothing is sent) |
| `store.announceRemoved` | Removed image {{position}} of {{set}} (staged). | Imagen {{position}} de {{set}} quitada (preparado). |  | stage = preparar (nothing is sent) |
| `store.announceStaged` | Staged {{set}}. | {{set}} preparado. |  | stage = preparar (nothing is sent) |
| `store.dragHint` | Drag to reorder | Arrastre para reordenar |  |  |
| `store.editFailed` | The change could not be staged | No se pudo preparar el cambio |  | stage = preparar (nothing is sent) |
| `store.emptyText` | Nothing is uploaded to the store page of this app, in any language. | No hay nada subido a la ficha de esta app, en ningún idioma. |  |  |
| `store.emptyTitle` | The store has no graphics yet | La tienda aún no tiene gráficos |  |  |
| `store.fullReason` | This set holds at most {{max}} images. | Este conjunto admite como máximo {{max}} imágenes. |  |  |
| `store.groupCount_one` | {{count}} image | {{count}} imagen |  |  |
| `store.groupCount_other` | {{count}} images | {{count}} imágenes |  |  |
| `store.imageAlt` | {{set}}, image {{position}} | {{set}}, imagen {{position}} |  |  |
| `store.images_one` | {{count}} image | {{count}} imagen |  |  |
| `store.images_other` | {{count}} images | {{count}} imágenes |  |  |
| `store.lockedReason` | The version in the store is live or in review, so its listing and graphics are locked. Create a new version to change them. | La versión de la tienda está publicada o en revisión, así que su ficha y sus gráficos están bloqueados. Crea una versión nueva para cambiarlos. |  | listing = ficha; review: reseña (user) vs revisión (App Review) |
| `store.moveEarlier` | Move image {{position}} earlier | Mover la imagen {{position}} antes |  |  |
| `store.moveLater` | Move image {{position}} later | Mover la imagen {{position}} después |  |  |
| `store.noPreview` | No preview | Sin vista previa |  |  |
| `store.notesImages` | Images | Imágenes |  |  |
| `store.notesLabel` | Notes | Notas |  |  |
| `store.notesLine_one` | {{count}} note about the store graphics | {{count}} nota sobre los gráficos de la tienda |  |  |
| `store.notesLine_other` | {{count}} notes about the store graphics | {{count}} notas sobre los gráficos de la tienda |  |  |
| `store.open` | Open {{set}}, image {{position}} | Abrir {{set}}, imagen {{position}} |  |  |
| `store.problems_one` | {{count}} problem in the store graphics | {{count}} problema en los gráficos de la tienda |  |  |
| `store.problems_other` | {{count}} problems in the store graphics | {{count}} problemas en los gráficos de la tienda |  |  |
| `store.readFailed` | The store graphics could not be read | No se pudieron leer los gráficos de la tienda |  |  |
| `store.readFailedText` | The store did not answer. Check the store connection of this app and try again. | La tienda no respondió. Revisa la conexión con la tienda de esta app e inténtalo de nuevo. |  |  |
| `store.reading` | Reading the store graphics… | Leyendo los gráficos de la tienda… |  |  |
| `store.refreshing` | Refreshing… | Actualizando… |  |  |
| `store.removeImage` | Remove image {{position}} | Quitar la imagen {{position}} |  |  |
| `store.replace` | Replace image {{position}} | Sustituir la imagen {{position}} |  |  |
| `store.replaceTitle` | Replace image {{position}} | Sustituir la imagen {{position}} |  |  |
| `store.repoHidden_one` | The repository holds {{count}} graphic. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see it next to the store’s. | El repositorio contiene {{count}} gráfico. Activa «Comparar gráficos del repositorio y de la tienda» en los ajustes de la app (Ficha de la tienda) para verlo junto al de la tienda. |  | listing = ficha |
| `store.repoHidden_other` | The repository holds {{count}} graphics. Turn on “Compare repository and store graphics” in the app settings (Store listing) to see them next to the store’s. | El repositorio contiene {{count}} gráficos. Activa «Comparar gráficos del repositorio y de la tienda» en los ajustes de la app (Ficha de la tienda) para verlos junto a los de la tienda. |  | listing = ficha |
| `store.reread` | Read again | Leer de nuevo |  |  |
| `store.rereadFailed` | The store graphics could not be read again. What is shown is from the last read. | No se pudieron volver a leer los gráficos de la tienda. Lo que se muestra es de la última lectura. |  |  |
| `store.ruleSourceShort` | Source of the rule | Fuente de la regla |  |  |
| `store.staged` | Staged | Preparado |  | stage = preparar (nothing is sent) |
| `store.storeHolds_one` | The store holds {{count}} image now | La tienda tiene ahora {{count}} imagen |  |  |
| `store.storeHolds_other` | The store holds {{count}} images now | La tienda tiene ahora {{count}} imágenes |  |  |
| `store.title` | Store graphics | Gráficos de la tienda |  |  |
| `store.tools` | Actions for image {{position}} | Acciones de la imagen {{position}} |  |  |
| `store.unplaced_one` | {{count}} image has a size Kiln does not know and is not shown. | {{count}} imagen tiene un tamaño que Kiln no conoce y no se muestra. |  |  |
| `store.unplaced_other` | {{count}} images have a size Kiln does not know and are not shown. | {{count}} imágenes tienen un tamaño que Kiln no conoce y no se muestran. |  |  |
| `store.unreadCause` | The store gives no size for these images and Kiln could not read the first bytes of the files (the image host did not answer, or the address is not one Kiln may fetch), so their size and format were not checked. Nothing is known to be wrong with them. | La tienda no da el tamaño de estas imágenes y Kiln no pudo leer los primeros bytes de los archivos (el servidor de imágenes no respondió, o la dirección no es una que Kiln pueda consultar), así que no se comprobaron su tamaño ni su formato. No se sabe que tengan ningún problema. |  |  |
| `store.unreadLabel` | Not checked | Sin comprobar |  |  |
| `store.unreadLine_one` | {{count}} image could not be checked | {{count}} imagen no se pudo comprobar |  |  |
| `store.unreadLine_other` | {{count}} images could not be checked | {{count}} imágenes no se pudieron comprobar |  |  |
| `store.updatedAt` | Updated {{when}} | Actualizado {{when}} |  |  |
| `store.uploadHint` | Files are checked against the store’s rules (pixel size, format, file size, count) before they are staged. Nothing is sent to the store until you publish from the pending cart. | Los archivos se comprueban con las reglas de la tienda (tamaño en píxeles, formato, peso, cantidad) antes de prepararse. No se envía nada a la tienda hasta que publique desde el carrito. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `tab.noMedia` | No graphics in the repository | No hay gráficos en el repositorio |  |  |
| `viewer.actions` | Image actions | Acciones de la imagen |  |  |
| `viewer.alt` | {{set}} ({{locale}}), image {{position}} of {{total}} | {{set}} ({{locale}}), imagen {{position}} de {{total}} |  |  |
| `viewer.bytes` | File size | Tamaño del archivo |  |  |
| `viewer.copied` | Image copied. | Imagen copiada. |  |  |
| `viewer.copy` | Copy image | Copiar imagen |  |  |
| `viewer.copyFallback` | This browser could not copy the image, so it was saved as a file instead. | Este navegador no pudo copiar la imagen, así que se guardó como archivo. |  |  |
| `viewer.device` | Screen size | Tamaño de pantalla |  |  |
| `viewer.editOff` | Editing is off: {{reason}} | La edición está desactivada: {{reason}} |  |  |
| `viewer.fetchFailed` | The original image could not be fetched. Try again. | No se pudo obtener la imagen original. Inténtalo de nuevo. |  |  |
| `viewer.file` | File name | Nombre del archivo |  |  |
| `viewer.index` | Place | Posición |  |  |
| `viewer.indexValue` | {{position}} of {{total}} | {{position}} de {{total}} |  |  |
| `viewer.keys` | The left and right arrow keys step through the images | Las flechas izquierda y derecha recorren las imágenes |  |  |
| `viewer.loadFailed` | The picture could not be loaded. | No se pudo cargar la imagen. |  |  |
| `viewer.locale` | Language | Idioma |  |  |
| `viewer.next` | Next | Siguiente |  |  |
| `viewer.pixels` | Pixel size | Tamaño en píxeles |  |  |
| `viewer.previous` | Previous | Anterior |  |  |
| `viewer.remove` | Remove | Quitar |  |  |
| `viewer.replace` | Replace | Sustituir |  |  |
| `viewer.save` | Save | Guardar |  |  |
| `viewer.saved` | Saved {{name}}. | {{name}} guardado. |  |  |
| `viewer.staged` | Staged | Preparado |  | stage = preparar (nothing is sent) |
| `viewer.title` | Image | Imagen |  |  |
| `viewer.unknown` | Unknown | Desconocido |  |  |

## web/auth (1)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `stepUp.action.price` | Send price changes to a store | Enviar cambios de precio a una tienda |  |  |

## web/builds (31)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `install.androidNew` | Android 8.0 and newer: when the phone asks, allow the app that opened the link (your browser) to install unknown apps. The switch is in Settings, Apps, Special app access, Install unknown apps, under that browser. | Android 8.0 y posterior: cuando el teléfono lo pida, permite que la app que abrió el enlace (tu navegador) instale apps desconocidas. El ajuste está en Ajustes, Apps, Acceso especial, Instalar apps desconocidas, bajo ese navegador. |  |  |
| `install.androidOld` | Android 7.1.1 and older: turn on Unknown sources in Settings, Security, then open the link again. | Android 7.1.1 y anterior: activa Orígenes desconocidos en Ajustes, Seguridad y abre el enlace de nuevo. |  |  |
| `install.blocked.expired` | Expo has deleted the file of this build. | Expo ha borrado el archivo de esta compilación. |  |  |
| `install.blocked.failed` | This build did not finish, so there is nothing to install. | Esta compilación no terminó, así que no hay nada que instalar. |  |  |
| `install.blocked.noLink` | Expo gave no address for this build. | Expo no dio ninguna dirección para esta compilación. |  |  |
| `install.blocked.running` | This build has not finished yet. | Esta compilación aún no ha terminado. |  |  |
| `install.blocked.store` | A store build is sent to the store, not installed from a link. | Una compilación para la tienda se envía a la tienda, no se instala desde un enlace. |  |  |
| `install.download` | Download build | Descargar compilación |  |  |
| `install.downloadKind` | Download build ({{kind}}) | Descargar compilación ({{kind}}) |  |  |
| `install.downloadNote` | A direct link to the file at Expo. It does not pass through Kiln. | Un enlace directo al archivo en Expo. No pasa por Kiln. |  |  |
| `install.expires` | Expo keeps the build file until {{date}}. | Expo conserva el archivo de la compilación hasta el {{date}}. |  |  |
| `install.helpAndroid` | How to install on Android | Cómo instalar en Android |  |  |
| `install.helpIos` | How to install on iPhone and iPad | Cómo instalar en iPhone y iPad |  |  |
| `install.iosAdHoc` | An internal build only runs on devices registered for it: an ad hoc profile lists them by UDID, an enterprise profile needs no list. A new device needs a new build. | Una compilación interna solo funciona en los dispositivos registrados para ella: un perfil ad hoc los lista por UDID; uno de empresa no necesita lista. Un dispositivo nuevo requiere una compilación nueva. |  |  |
| `install.iosDocs` | Expo: internal distribution | Expo: distribución interna |  |  |
| `install.iosTrust` | If the phone says the developer is not trusted, trust the profile in Settings, General, VPN and Device Management. | Si el teléfono dice que el desarrollador no es de confianza, confía en el perfil en Ajustes, General, VPN y gestión de dispositivos. |  |  |
| `install.leadAndroid` | Open the camera on the Android phone and point it at this code, then tap the link that appears. | Abre la cámara del teléfono Android y apunta a este código; luego toca el enlace que aparece. |  |  |
| `install.leadIos` | Open the Camera app on the iPhone and point it at this code, then tap the notification that appears. | Abre la app Cámara del iPhone y apunta a este código; luego toca la notificación que aparece. |  |  |
| `install.leadNoCode` | The page of this build on Expo has the install link. Open it on the device. | La página de esta compilación en Expo tiene el enlace de instalación. Ábrela en el dispositivo. |  |  |
| `install.leadSimulator` | This is an iOS Simulator build. It does not install from a QR code: open it with Orbit, or download it and drop it on a running simulator. | Es una compilación para el simulador de iOS. No se instala con un código QR: ábrela con Orbit, o descárgala y suéltala en un simulador abierto. |  |  |
| `install.linkHint` | The same address as the code: open it on the device to install. | La misma dirección que el código: ábrela en el dispositivo para instalar. |  |  |
| `install.linkLabel` | Send a link to a device | Enviar un enlace a un dispositivo |  |  |
| `install.openExpo` | Open on Expo | Abrir en Expo |  |  |
| `install.orbit` | Open with Orbit | Abrir con Orbit |  |  |
| `install.orbitGet` | Get Expo Orbit | Obtener Expo Orbit |  |  |
| `install.orbitHint` | Nothing happened? Expo Orbit may not be installed. | ¿No pasó nada? Puede que Expo Orbit no esté instalado. |  |  |
| `install.orbitTip` | Needs Expo Orbit installed | Requiere Expo Orbit instalado |  |  |
| `install.qrLabel` | QR code for the install link | Código QR del enlace de instalación |  |  |
| `install.qrTooLong` | The link is too long for a QR code. Copy it below instead. | El enlace es demasiado largo para un código QR. Cópialo abajo. |  |  |
| `install.title` | Install on a test device | Instalar en un dispositivo de prueba |  |  |
| `install.whyBlocked` | Why this cannot be installed | Por qué no se puede instalar |  |  |

## web/chat (162)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `action.delete` | Delete | Eliminar |  |  |
| `action.deleteLabel` | Delete {{name}} | Eliminar {{name}} |  |  |
| `action.edit` | Edit | Editar |  |  |
| `action.editLabel` | Edit {{name}} | Editar {{name}} |  |  |
| `action.log` | Deliveries | Envíos |  |  |
| `action.logLabel` | Deliveries to {{name}} | Envíos a {{name}} |  |  |
| `action.routing` | Routing | Enrutamiento |  |  |
| `action.routingLabel` | Routing rules of {{name}} | Reglas de enrutamiento de {{name}} |  |  |
| `action.test` | Send test message | Enviar mensaje de prueba |  |  |
| `action.testLabel` | Send a test message to {{name}} | Enviar un mensaje de prueba a {{name}} |  |  |
| `action.testing` | Sending… | Enviando… |  |  |
| `card.anyHost` | Any host allowed | Cualquier host permitido |  |  |
| `card.digestDaily` | Daily summary at {{hour}} ({{zone}}) | Resumen diario a las {{hour}} ({{zone}}) |  |  |
| `card.digestOff` | Every alert is sent at once | Cada alerta se envía de inmediato |  |  |
| `card.endsIn` | Address ends in {{hint}} | La dirección termina en {{hint}} |  |  |
| `card.language` | Messages in {{language}} | Mensajes en {{language}} |  |  |
| `card.lastDelivery` | Last message: {{status}}, {{when}} | Último mensaje: {{status}}, {{when}} |  |  |
| `card.noDelivery` | Nothing sent yet | Aún no se ha enviado nada |  |  |
| `card.off` | Off | Desactivado |  |  |
| `card.on` | On | Activo |  |  |
| `card.rulesOff` | off | desactivada |  |  |
| `card.rules_one` | {{count}} rule | {{count}} regla |  |  |
| `card.rules_other` | {{count}} rules | {{count}} reglas |  |  |
| `delete.body` | Messages to {{name}} stop, and its routing and delivery log are removed. The channel itself is not touched. | Los mensajes a {{name}} se detienen y se eliminan su enrutamiento y su registro de envíos. El canal en sí no se toca. |  |  |
| `delete.title` | Delete this destination? | ¿Eliminar este destino? |  |  |
| `form.anyHost` | Allow a host other than Slack or Microsoft | Permitir un host distinto de Slack o Microsoft |  |  |
| `form.anyHostHint` | Only for your own gateway that forwards to Slack or Teams. Addresses inside your network are always refused. | Solo para tu propia pasarela que reenvía a Slack o Teams. Las direcciones dentro de tu red siempre se rechazan. |  |  |
| `form.create` | Add destination | Añadir destino |  |  |
| `form.creating` | Adding… | Añadiendo… |  |  |
| `form.defaultsNote` | A new destination starts with every critical alert and every release event. Change that under Routing. | Un destino nuevo empieza con todas las alertas críticas y todos los eventos de lanzamiento. Cámbialo en Enrutamiento. |  | release = lanzamiento |
| `form.description` | One Slack or Microsoft Teams channel that receives Kiln messages. | Un canal de Slack o Microsoft Teams que recibe los mensajes de Kiln. |  |  |
| `form.digest` | Daily summary | Resumen diario |  |  |
| `form.digestDaily` | Daily: alerts below critical wait for the summary, critical ones are sent at once | Diario: las alertas no críticas esperan al resumen y las críticas se envían de inmediato |  |  |
| `form.digestHour` | Send the summary at | Enviar el resumen a las |  |  |
| `form.digestOff` | Off: every alert is sent at once | Desactivado: cada alerta se envía de inmediato |  |  |
| `form.enabled` | Send messages to this destination | Enviar mensajes a este destino |  |  |
| `form.errors.name` | Give the destination a name. | Pon un nombre al destino. |  |  |
| `form.errors.nameLong` | Use at most 80 characters. | Usa 80 caracteres como máximo. |  |  |
| `form.errors.timezone` | Enter a time zone for the summary. | Indica una zona horaria para el resumen. |  |  |
| `form.errors.url` | Paste the https webhook address from Slack or Teams. | Pega la dirección de webhook https de Slack o Teams. |  |  |
| `form.language` | Language of the messages | Idioma de los mensajes |  |  |
| `form.languageHint` | Messages are written in this language, whatever language people use in Kiln. | Los mensajes se escriben en este idioma, sea cual sea el idioma que se use en Kiln. |  |  |
| `form.name` | Name | Nombre |  |  |
| `form.nameHint` | Only shown here, for example “#releases”. | Solo se muestra aquí, por ejemplo «#releases». |  | release = lanzamiento |
| `form.provider` | Service | Servicio |  |  |
| `form.save` | Save changes | Guardar cambios |  |  |
| `form.saving` | Saving… | Guardando… |  |  |
| `form.timezone` | Time zone | Zona horaria |  |  |
| `form.timezoneHint` | A time zone name such as Europe/Paris. | Un nombre de zona horaria, por ejemplo Europe/Paris. |  |  |
| `form.titleEdit` | Edit the destination | Editar el destino |  |  |
| `form.titleNew` | New chat destination | Nuevo destino de chat |  |  |
| `form.url` | Webhook address | Dirección del webhook |  |  |
| `form.urlHint` | Secret. Paste it once: it is stored encrypted and never shown again. | Secreta. Pégala una sola vez: se guarda cifrada y no se vuelve a mostrar. |  |  |
| `form.urlSaved` | The saved address ends in {{hint}}. Leave this empty to keep it, or paste a new one to replace it. | La dirección guardada termina en {{hint}}. Deja este campo vacío para conservarla o pega una nueva para reemplazarla. |  |  |
| `help.slack.step1` | Create a Slack app for your workspace at api.slack.com/apps (from scratch). | Crea una app de Slack para tu espacio de trabajo en api.slack.com/apps (desde cero). |  |  |
| `help.slack.step2` | In the app’s settings, turn on Incoming Webhooks. | En los ajustes de la app, activa Incoming Webhooks. |  |  |
| `help.slack.step3` | Choose Add New Webhook to Workspace and pick the channel. | Elige Add New Webhook to Workspace y selecciona el canal. |  |  |
| `help.slack.step4` | Copy the webhook URL, which starts with https://hooks.slack.com/services/, and paste it here. | Copia la URL del webhook, que empieza por https://hooks.slack.com/services/, y pégala aquí. |  |  |
| `help.teams.note` | Microsoft retired the old Office 365 connector webhooks, so a Teams destination needs a workflow. | Microsoft retiró los antiguos webhooks de conector de Office 365, así que un destino de Teams necesita un flujo. |  |  |
| `help.teams.step1` | In Teams, open the Workflows app and create a workflow from the template that posts to a channel when a webhook request is received (it may be named “Send webhook alerts to a channel”). | En Teams, abre la app Workflows y crea un flujo con la plantilla que publica en un canal cuando se recibe una solicitud de webhook (puede llamarse «Send webhook alerts to a channel»). |  |  |
| `help.teams.step2` | Pick the team and channel where the messages should appear, and finish the setup. | Elige el equipo y el canal donde deben aparecer los mensajes y termina la configuración. |  |  |
| `help.teams.step3` | Copy the HTTP URL that the workflow shows for its webhook trigger. | Copia la URL HTTP que el flujo muestra para su desencadenador de webhook. |  |  |
| `help.teams.step4` | Paste it here. It comes from powerplatform.com or logic.azure.com. | Pégala aquí. Procede de powerplatform.com o de logic.azure.com. |  |  |
| `help.title` | Where do I get the address? | ¿Dónde consigo la dirección? |  |  |
| `kind.alert` | Alert | Alerta |  |  |
| `kind.digest` | Daily summary | Resumen diario |  |  |
| `kind.test` | Test | Prueba |  |  |
| `log.answer` | Answer {{code}} | Respuesta {{code}} |  |  |
| `log.attempts_one` | {{count}} attempt | {{count}} intento |  |  |
| `log.attempts_other` | {{count}} attempts | {{count}} intentos |  |  |
| `log.caption` | Messages sent to this destination, newest first | Mensajes enviados a este destino, los más recientes primero |  |  |
| `log.close` | Close | Cerrar |  |  |
| `log.colKind` | Kind | Tipo |  |  |
| `log.colResult` | Result | Resultado |  |  |
| `log.colStatus` | Status | Estado |  |  |
| `log.colWhat` | About | Asunto |  |  |
| `log.colWhen` | When | Cuándo |  |  |
| `log.empty` | Nothing was sent to this destination yet. | Aún no se ha enviado nada a este destino. |  |  |
| `log.loadFailed` | Could not load the deliveries. | No se pudieron cargar los envíos. |  |  |
| `log.loading` | Loading… | Cargando… |  |  |
| `log.refresh` | Refresh | Actualizar |  |  |
| `log.region` | Deliveries to {{name}} | Envíos a {{name}} |  |  |
| `log.title` | Deliveries | Envíos |  |  |
| `outcome.blockedAddress` | The address points inside a network or to an address that is never allowed, so nothing was sent. | La dirección apunta al interior de una red o a una dirección que nunca se permite, así que no se envió nada. |  |  |
| `outcome.digestSent` | Sent in the daily summary. | Enviada en el resumen diario. |  |  |
| `outcome.disabled` | The destination is switched off, so nothing was sent. | El destino está desactivado, así que no se envió nada. |  |  |
| `outcome.dnsFailed` | The address could not be looked up. It will be tried again. | No se pudo resolver la dirección. Se reintentará. |  |  |
| `outcome.hostNotAllowed` | The address is not from Slack or Microsoft and the destination does not allow other hosts, so nothing was sent. | La dirección no es de Slack ni de Microsoft y el destino no permite otros hosts, así que no se envió nada. |  |  |
| `outcome.inDigest` | Held for the daily summary. | Retenida para el resumen diario. |  |  |
| `outcome.networkError` | The connection failed. It will be tried again. | Falló la conexión. Se reintentará. |  |  |
| `outcome.ok` | Delivered. | Entregado. |  |  |
| `outcome.payloadRejected` | The service did not accept the message. Please report this. | El servicio no aceptó el mensaje. Infórmanos, por favor. |  |  |
| `outcome.queued` | Waiting to be sent. | Esperando a ser enviado. |  |  |
| `outcome.rateLimited` | The service asked Kiln to slow down. It will be tried again after the wait it named. | El servicio pidió a Kiln que fuera más despacio. Se reintentará tras la espera que indicó. |  |  |
| `outcome.redirected` | The address redirects elsewhere, which Kiln does not follow. Paste the final address. | La dirección redirige a otro sitio, algo que Kiln no sigue. Pega la dirección final. |  |  |
| `outcome.rejected` | The service refused the message. | El servicio rechazó el mensaje. |  |  |
| `outcome.secretUnreadable` | The saved address could not be read. Paste it again. | No se pudo leer la dirección guardada. Pégala de nuevo. |  |  |
| `outcome.serverError` | The service had a problem. It will be tried again. | El servicio tuvo un problema. Se reintentará. |  |  |
| `outcome.timeout` | The service did not answer in time. It will be tried again. | El servicio no respondió a tiempo. Se reintentará. |  |  |
| `outcome.unknown` | Unknown result. | Resultado desconocido. |  |  |
| `outcome.webhookGone` | The webhook no longer exists. Create a new one and paste its address here. | El webhook ya no existe. Crea uno nuevo y pega aquí su dirección. |  |  |
| `outcome.webhookRejected` | The service refused the webhook. It may have been disabled or restricted; check it in Slack or Teams. | El servicio rechazó el webhook. Puede que se haya desactivado o restringido; revísalo en Slack o Teams. |  |  |
| `page.deleteFailed` | Could not delete the destination. | No se pudo eliminar el destino. |  |  |
| `page.deleted` | Deleted {{name}}. | Se eliminó {{name}}. |  |  |
| `page.description` | Send alerts, release events and a daily summary to a Slack or Microsoft Teams channel. | Envía alertas, eventos de lanzamiento y un resumen diario a un canal de Slack o Microsoft Teams. |  | release = lanzamiento |
| `page.emptyText` | Add a Slack or Teams channel to hear about rejections, releases and credential problems where your team already talks. | Añade un canal de Slack o Teams para enterarte de rechazos, lanzamientos y problemas con credenciales donde tu equipo ya conversa. |  | release = lanzamiento |
| `page.emptyTitle` | No chat destination yet | Aún no hay destinos de chat |  |  |
| `page.footer` | A message is retried a few times, then marked failed. The webhook address is secret: it is stored encrypted and never shown again. | Un mensaje se reintenta varias veces y después se marca como fallido. La dirección del webhook es secreta: se guarda cifrada y no se vuelve a mostrar. |  |  |
| `page.loadFailed` | Could not load the chat destinations. | No se pudieron cargar los destinos de chat. |  |  |
| `page.loading` | Loading… | Cargando… |  |  |
| `page.new` | New destination | Nuevo destino |  |  |
| `page.noRead` | Your role does not include chat integrations. Owners and admins manage them. | Tu rol no incluye las integraciones de chat. Las gestionan los propietarios y administradores. |  |  |
| `page.routesSaved` | Saved the routing of {{name}}. | Se guardó el enrutamiento de {{name}}. |  |  |
| `page.saved` | Saved {{name}}. | Se guardó {{name}}. |  |  |
| `page.testFailed` | Could not send the test message. | No se pudo enviar el mensaje de prueba. |  |  |
| `page.title` | Chat | Chat |  |  |
| `routes.add` | Add a rule | Añadir una regla |  |  |
| `routes.allApps` | All apps | Todas las apps |  |  |
| `routes.allAppsLabel` | All apps | Todas las apps |  |  |
| `routes.allPlatforms` | All platforms | Todas las plataformas |  |  |
| `routes.allPlatformsLabel` | All platforms | Todas las plataformas |  |  |
| `routes.allTypes` | All alert types | Todos los tipos de alerta |  |  |
| `routes.allTypesLabel` | All alert types | Todos los tipos de alerta |  |  |
| `routes.apps` | Apps | Apps |  |  |
| `routes.caption` | Routing rules | Reglas de enrutamiento |  |  |
| `routes.col.apps` | Apps | Apps |  |  |
| `routes.col.platforms` | Platforms | Plataformas |  |  |
| `routes.col.severity` | From | Desde |  |  |
| `routes.col.types` | Alerts | Alertas |  |  |
| `routes.defaults` | Use the defaults | Usar los valores predeterminados |  |  |
| `routes.description` | Which alerts go to {{name}}. An alert is sent when any rule takes it. | Qué alertas van a {{name}}. Una alerta se envía cuando cualquier regla la acepta. |  |  |
| `routes.enabled` | This rule is on | Esta regla está activa |  |  |
| `routes.errors.noTypes` | Choose at least one alert type, or choose all of them. | Elige al menos un tipo de alerta o elígelos todos. |  |  |
| `routes.errors.saveFailed` | Could not save the routing. | No se pudo guardar el enrutamiento. |  |  |
| `routes.from.critical` | Critical only | Solo críticas |  |  |
| `routes.from.info` | Everything (info and above) | Todo (información y superior) |  |  |
| `routes.from.warning` | Needs attention and critical | Requiere atención y críticas |  |  |
| `routes.minSeverity` | From severity | Desde la gravedad |  |  |
| `routes.noRules` | With no rule, nothing is sent to this destination. | Sin reglas, no se envía nada a este destino. |  |  |
| `routes.platforms` | Platforms | Plataformas |  |  |
| `routes.remove` | Remove rule | Quitar regla |  |  |
| `routes.removeLabel` | Remove rule {{n}} | Quitar la regla {{n}} |  |  |
| `routes.rule` | Rule {{n}} | Regla {{n}} |  |  |
| `routes.save` | Save routing | Guardar enrutamiento |  |  |
| `routes.saving` | Saving… | Guardando… |  |  |
| `routes.someTypes_one` | {{count}} alert type | {{count}} tipo de alerta |  |  |
| `routes.someTypes_other` | {{count}} alert types | {{count}} tipos de alerta |  |  |
| `routes.title` | Routing | Enrutamiento |  |  |
| `routes.types` | Alert types | Tipos de alerta |  |  |
| `severity.critical` | Critical | Crítica |  |  |
| `severity.info` | Info | Información |  |  |
| `severity.warning` | Needs attention | Requiere atención |  |  |
| `status.deferred` | Waiting for the summary | Esperando al resumen |  |  |
| `status.failed` | Failed | Fallido |  |  |
| `status.queued` | Queued | En cola |  |  |
| `status.retrying` | Retrying | Reintentando |  |  |
| `status.sent` | Sent | Enviado |  |  |
| `status.skipped` | Skipped | Omitido |  |  |
| `test.failed` | The test message did not arrive: {{reason}} | El mensaje de prueba no llegó: {{reason}} |  |  |
| `test.noResult` | No result yet. Open the deliveries to follow it. | Aún no hay resultado. Abre los envíos para seguirlo. |  |  |
| `test.sent` | The test message was delivered. Look in the channel. | El mensaje de prueba se entregó. Mira en el canal. |  |  |
| `test.waiting` | Sending the test message… | Enviando el mensaje de prueba… |  |  |

## web/connect (71)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `banner.button` | Connect your apps | Conectar tus apps |  |  |
| `banner.expo.next_one` | Your Expo token “{{label}}” is saved. {{count}} app is not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the project from app.json where it can; nothing is saved until you confirm. | Tu token de Expo «{{label}}» está guardado. {{count}} app aún no está vinculada a un proyecto de Expo, así que Compilaciones no muestra ninguna compilación de EAS. Kiln lee el proyecto de app.json cuando puede; no se guarda nada hasta que confirmes. |  |  |
| `banner.expo.next_other` | Your Expo token “{{label}}” is saved. {{count}} apps are not linked to an Expo project yet, so Builds shows no EAS builds. Kiln reads the projects from app.json where it can; nothing is saved until you confirm. | Tu token de Expo «{{label}}» está guardado. {{count}} apps aún no están vinculadas a un proyecto de Expo, así que Compilaciones no muestra ninguna compilación de EAS. Kiln lee los proyectos de app.json cuando puede; no se guarda nada hasta que confirmes. |  |  |
| `banner.expo.text_one` | You have an Expo token (“{{label}}”), but {{count}} app is not linked to an Expo project yet. Link it to see its EAS builds, submissions and workflows. | Tienes un token de Expo («{{label}}»), pero {{count}} app aún no está vinculada a un proyecto de Expo. Vincúlala para ver sus compilaciones de EAS, envíos y flujos de trabajo. |  | submit = enviar |
| `banner.expo.text_other` | You have an Expo token (“{{label}}”), but {{count}} apps are not linked to an Expo project yet. Link them to see their EAS builds, submissions and workflows. | Tienes un token de Expo («{{label}}»), pero {{count}} apps aún no están vinculadas a un proyecto de Expo. Vincúlalas para ver sus compilaciones de EAS, envíos y flujos de trabajo. |  | submit = enviar |
| `banner.expo.title` | Connect your apps to Expo | Conecta tus apps a Expo |  |  |
| `banner.rc.next_one` | Your RevenueCat key “{{label}}” is saved. {{count}} app is not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Tu clave de RevenueCat «{{label}}» está guardada. {{count}} app aún no está vinculada a un proyecto de RevenueCat, así que Productos no muestra nada de RevenueCat. Kiln propone las coincidencias; no se guarda nada hasta que confirmes. |  |  |
| `banner.rc.next_other` | Your RevenueCat key “{{label}}” is saved. {{count}} apps are not linked to a RevenueCat project yet, so Products shows nothing from RevenueCat. Kiln proposes the matches; nothing is saved until you confirm. | Tu clave de RevenueCat «{{label}}» está guardada. {{count}} apps aún no están vinculadas a un proyecto de RevenueCat, así que Productos no muestra nada de RevenueCat. Kiln propone las coincidencias; no se guarda nada hasta que confirmes. |  |  |
| `banner.rc.text_one` | You have a RevenueCat key (“{{label}}”), but {{count}} app is not linked to RevenueCat yet. Link it to see which products RevenueCat sells, with their entitlements and offerings. | Tienes una clave de RevenueCat («{{label}}»), pero {{count}} app aún no está vinculada a RevenueCat. Vincúlala para ver qué productos vende RevenueCat, con sus entitlements y ofertas. |  |  |
| `banner.rc.text_other` | You have a RevenueCat key (“{{label}}”), but {{count}} apps are not linked to RevenueCat yet. Link them to see which products RevenueCat sells, with their entitlements and offerings. | Tienes una clave de RevenueCat («{{label}}»), pero {{count}} apps aún no están vinculadas a RevenueCat. Vincúlalas para ver qué productos vende RevenueCat, con sus entitlements y ofertas. |  |  |
| `banner.rc.title` | Connect your apps to RevenueCat | Conecta tus apps a RevenueCat |  |  |
| `callout.addKey` | Add a key in Credentials | Añadir una clave en Credenciales |  |  |
| `callout.expo.button` | Connect to Expo | Conectar a Expo |  |  |
| `callout.expo.title` | This app is not connected to Expo | Esta app no está conectada a Expo |  |  |
| `callout.rc.button` | Connect to RevenueCat | Conectar a RevenueCat |  |  |
| `callout.rc.title` | This app is not connected to RevenueCat | Esta app no está conectada a RevenueCat |  |  |
| `dialog.addKey` | Open Credentials | Abrir Credenciales |  |  |
| `dialog.askAdmin` | Only an owner or an admin can link apps. Ask one of them to connect them. | Solo un propietario o un administrador puede vincular apps. Pídele a uno de ellos que las conecte. |  |  |
| `dialog.confirm_one` | Link {{count}} app | Vincular {{count}} app |  |  |
| `dialog.confirm_other` | Link {{count}} apps | Vincular {{count}} apps |  |  |
| `dialog.description` | Review the matches Kiln found. Nothing is saved until you confirm. | Revisa las coincidencias que ha encontrado Kiln. No se guarda nada hasta que confirmes. |  | review: reseña (user) vs revisión (App Review) |
| `dialog.expoHelp` | The project id is in app.json under extra.eas.projectId (running “eas init” adds it); you can also enter @account/slug. Kiln cannot list the projects your token sees. | El id del proyecto está en app.json, en extra.eas.projectId (al ejecutar «eas init» se añade); también puedes escribir @cuenta/slug. Kiln no puede listar los proyectos que ve tu token. |  |  |
| `dialog.keyHint` | The key is only used to read. Nothing is changed. | La clave solo se usa para leer. No se cambia nada. |  |  |
| `dialog.keyLabel.expo` | Expo token | Token de Expo |  |  |
| `dialog.keyLabel.rc` | RevenueCat key | Clave de RevenueCat |  |  |
| `dialog.lookUp` | Look up | Buscar |  |  |
| `dialog.noKey.expo` | No Expo token is saved yet. Add an Expo access token first. | Aún no hay ningún token de Expo guardado. Añade primero un token de acceso de Expo. |  |  |
| `dialog.noKey.rc` | No RevenueCat key is saved yet. Add a RevenueCat secret key first. | Aún no hay ninguna clave de RevenueCat guardada. Añade primero una clave secreta de RevenueCat. |  |  |
| `dialog.nothingToDo` | Every app that {{name}} can serve is already linked. | Todas las apps que {{name}} puede atender ya están vinculadas. |  |  |
| `dialog.readingExpo` | Reading app.json of the linked repositories… | Leyendo app.json de los repositorios vinculados… |  |  |
| `dialog.readingRc` | Reading your RevenueCat projects and apps… | Leyendo tus proyectos y apps de RevenueCat… |  |  |
| `dialog.reviewExpo` | Kiln read the Expo project id from app.json of each linked repository. Tick the apps to link, or type the project of an app yourself. | Kiln ha leído el id del proyecto de Expo en app.json de cada repositorio vinculado. Marca las apps que quieras vincular, o escribe tú el proyecto de una app. |  |  |
| `dialog.reviewRc` | Kiln matched each app to a RevenueCat app by its bundle id or package name and its store. Tick the apps to link. Where several RevenueCat apps fit, choose one: Kiln never guesses. | Kiln ha asociado cada app con una app de RevenueCat por su id de paquete (bundle id o nombre de paquete) y su tienda. Marca las apps que quieras vincular. Si encajan varias apps de RevenueCat, elige una: Kiln nunca adivina. |  |  |
| `dialog.safeExpo` | Confirming only saves the link in Kiln. Expo is never changed. | Al confirmar solo se guarda el vínculo en Kiln. Expo nunca se modifica. |  |  |
| `dialog.safeRc` | Confirming only saves the link in Kiln. RevenueCat is never changed. | Al confirmar solo se guarda el vínculo en Kiln. RevenueCat nunca se modifica. |  |  |
| `dialog.saving` | Saving the links… | Guardando los vínculos… |  |  |
| `dialog.title` | Connect your apps to {{name}} | Conectar tus apps a {{name}} |  |  |
| `done.expo.appears` | Builds of each linked app now shows its EAS builds and submissions, and Settings offers EAS Workflows. | Compilaciones de cada app vinculada ya muestra sus compilaciones y envíos de EAS, y Ajustes ofrece EAS Workflows. |  | submit = enviar |
| `done.expo.empty` | The lists stay empty until Expo has been read for the first time (“Read Expo now”, or Read again on Builds), and for as long as the project has no build. | Las listas siguen vacías hasta que se lea Expo por primera vez («Leer Expo ahora», o Leer de nuevo en Compilaciones) y mientras el proyecto no tenga ninguna compilación. |  |  |
| `done.failedRow` | Not linked: {{problem}} | No vinculada: {{problem}} |  |  |
| `done.linkedRow` | Linked. | Vinculada. |  |  |
| `done.openBuilds` | Open Builds | Abrir Compilaciones |  |  |
| `done.openProducts` | Open Products | Abrir Productos |  |  |
| `done.rc.appears` | Products of each linked app now has a RevenueCat column, with the entitlements and offerings that use each product, and the figures strip. | Productos de cada app vinculada ya tiene una columna de RevenueCat, con los entitlements y ofertas que usan cada producto, y la tira de cifras. |  |  |
| `done.rc.empty` | They stay empty until the first sync: it is pending. Kiln has only saved the link; RevenueCat is read by “Sync products”. | Siguen vacíos hasta la primera sincronización: está pendiente. Kiln solo ha guardado el vínculo; RevenueCat se lee con «Sincronizar productos». |  |  |
| `done.read.ok` | Read. | Leído. |  |  |
| `done.readExpo` | Read Expo now | Leer Expo ahora |  |  |
| `done.syncProducts` | Sync products | Sincronizar productos |  |  |
| `done.title_one` | {{count}} app linked to {{name}} | {{count}} app vinculada a {{name}} |  |  |
| `done.title_other` | {{count}} apps linked to {{name}} | {{count}} apps vinculadas a {{name}} |  |  |
| `missing.expo.keyFound` | Kiln has your Expo token “{{label}}”, but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Link it in one step; nothing is changed in Expo. | Kiln tiene tu token de Expo «{{label}}», pero esta app no está vinculada a un proyecto de Expo, así que Compilaciones no muestra compilaciones ni envíos de EAS. Vincúlala en un paso; no se cambia nada en Expo. |  | submit = enviar |
| `missing.expo.keyFoundAsk` | Kiln has an Expo token (“{{label}}”), but this app is not linked to an Expo project, so Builds shows no EAS builds or submissions. Ask an owner or an admin to link it. | Kiln tiene un token de Expo («{{label}}»), pero esta app no está vinculada a un proyecto de Expo, así que Compilaciones no muestra compilaciones ni envíos de EAS. Pídele a un propietario o a un administrador que la vincule. |  | submit = enviar |
| `missing.expo.noKey` | No Expo token is saved yet, and this app is not linked to an Expo project. Add an Expo access token in Credentials first, then link the app. | Aún no hay ningún token de Expo guardado, y esta app no está vinculada a un proyecto de Expo. Añade primero un token de acceso de Expo en Credenciales y luego vincula la app. |  |  |
| `missing.expo.unknown` | This app is not linked to an Expo project, so Builds shows no EAS builds. An Expo token and the link are needed; an owner or an admin can set them up. | Esta app no está vinculada a un proyecto de Expo, así que Compilaciones no muestra compilaciones de EAS. Hacen falta un token de Expo y el vínculo; un propietario o un administrador puede configurarlos. |  |  |
| `missing.rc.keyFound` | Kiln has your RevenueCat key “{{label}}”, but this app is not linked to a RevenueCat project, so the RevenueCat column, entitlements and offerings stay empty. Link it in one step; nothing is changed in RevenueCat. | Kiln tiene tu clave de RevenueCat «{{label}}», pero esta app no está vinculada a un proyecto de RevenueCat, así que la columna de RevenueCat, los entitlements y las ofertas siguen vacíos. Vincúlala en un paso; no se cambia nada en RevenueCat. |  |  |
| `missing.rc.keyFoundAsk` | Kiln has a RevenueCat key (“{{label}}”), but this app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. Ask an owner or an admin to link it. | Kiln tiene una clave de RevenueCat («{{label}}»), pero esta app no está vinculada a un proyecto de RevenueCat, así que no se muestra nada de RevenueCat. Pídele a un propietario o a un administrador que la vincule. |  |  |
| `missing.rc.noKey` | No RevenueCat key is saved yet, and this app is not linked to a RevenueCat project. Add a RevenueCat secret key in Credentials first, then link the app. | Aún no hay ninguna clave de RevenueCat guardada, y esta app no está vinculada a un proyecto de RevenueCat. Añade primero una clave secreta de RevenueCat en Credenciales y luego vincula la app. |  |  |
| `missing.rc.unknown` | This app is not linked to a RevenueCat project, so nothing from RevenueCat is shown. A RevenueCat key and the link are needed; an owner or an admin can set them up. | Esta app no está vinculada a un proyecto de RevenueCat, así que no se muestra nada de RevenueCat. Hacen falta una clave de RevenueCat y el vínculo; un propietario o un administrador puede configurarlos. |  |  |
| `rc.choiceInProject` | {{project}}: {{choice}} | {{project}}: {{choice}} |  |  |
| `row.checkAria` | Link {{name}} | Vincular {{name}} |  |  |
| `row.expo.inputAria` | Expo project of {{name}} | Proyecto de Expo de {{name}} |  |  |
| `row.expo.none` | No project found. Type its id or @account/slug. | No se ha encontrado ningún proyecto. Escribe su id o @cuenta/slug. |  |  |
| `row.expo.placeholder` | Project id or @account/slug | Id del proyecto o @cuenta/slug |  |  |
| `row.expo.proposed` | Project read from app.json. | Proyecto leído de app.json. |  |  |
| `row.linked` | Already linked | Ya vinculada |  |  |
| `row.rc.ambiguous` | Several RevenueCat apps fit. Choose one. | Encajan varias apps de RevenueCat. Elige una. |  |  |
| `row.rc.choose` | Choose a RevenueCat app | Elegir una app de RevenueCat |  |  |
| `row.rc.none` | No match by identifier. Choose a RevenueCat app, or leave the app unlinked. | Ninguna coincidencia por identificador. Elige una app de RevenueCat o deja la app sin vincular. |  |  |
| `row.rc.nothing` | No RevenueCat app of this store was found with this key. | No se ha encontrado con esta clave ninguna app de RevenueCat de esta tienda. |  |  |
| `row.rc.proposed` | Match found: the bundle id or package name and the store agree. | Coincidencia encontrada: el id de paquete o nombre de paquete y la tienda coinciden. |  |  |
| `row.rc.selectAria` | RevenueCat app for {{name}} | App de RevenueCat para {{name}} |  |  |

## web/credentials (21)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `identifier.appId` | App ID | ID de la app |  |  |
| `identifier.clientEmail` | Service account | Cuenta de servicio |  |  |
| `identifier.clientId` | Client ID | ID de cliente |  |  |
| `identifier.copy` | Copy {{label}} | Copiar {{label}} |  |  |
| `identifier.hide` | Hide identifiers | Ocultar identificadores |  |  |
| `identifier.hideAria` | Hide the identifiers of {{label}} | Ocultar los identificadores de {{label}} |  |  |
| `identifier.installationId` | Installation ID | ID de instalación |  |  |
| `identifier.none` | No identifiers to show for this type of credential. | No hay identificadores que mostrar para este tipo de credencial. |  |  |
| `identifier.projectId` | Project ID | ID del proyecto |  |  |
| `identifier.region` | Region | Región |  |  |
| `identifier.serviceKeyId` | Private key ID | ID de la clave privada |  |  |
| `identifier.show` | Show identifiers | Mostrar identificadores |  |  |
| `identifier.showAria` | Show the identifiers of {{label}} | Mostrar los identificadores de {{label}} |  |  |
| `identifier.title` | Identifiers (not secret) | Identificadores (no secretos) |  |  |
| `identifier.tokenKind.classic` | Personal access token (classic) | Token de acceso personal (clásico) |  |  |
| `identifier.tokenKind.fineGrained` | Fine-grained personal access token | Token de acceso personal de granularidad fina |  |  |
| `identifier.tokenKind.installation` | GitHub App installation token | Token de instalación de una GitHub App |  |  |
| `identifier.tokenKind.oauth` | OAuth token | Token OAuth |  |  |
| `identifier.tokenKind.userToServer` | GitHub App user token | Token de usuario de una GitHub App |  |  |
| `identifier.tokenType` | Token type | Tipo de token |  |  |
| `table.rotatedAgo` | Secret replaced {{when}} | Secreto reemplazado {{when}} |  |  |

## web/eas (40)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `overview.aria` | Expo builds and submissions | Builds y envíos de Expo |  | submit = enviar |
| `overview.latestBuild` | Latest build | Último build |  |  |
| `overview.latestSubmission` | Latest submission | Último envío |  | submit = enviar |
| `overview.link` | Link it to Expo | Vincular con Expo |  |  |
| `overview.loading` | Reading the stored builds… | Leyendo los builds guardados… |  |  |
| `overview.noBuild` | No build yet | Aún no hay builds |  |  |
| `overview.noBuilds` | No EAS build or submission is stored yet. They appear after the first build or the next refresh. | Todavía no hay ningún build ni envío de EAS guardado. Aparecerán tras el primer build o la próxima actualización. |  | submit = enviar |
| `overview.noSubmission` | No submission yet | Aún no hay envíos |  | submit = enviar |
| `overview.notLinked` | Not linked to an Expo project yet, so no builds or submissions show here. | Aún no está vinculado a un proyecto de Expo, así que aquí no se muestran builds ni envíos. |  | submit = enviar |
| `overview.openBuilds` | Open Builds | Abrir Builds |  |  |
| `overview.ota.branch` | Branch {{branch}} | Rama {{branch}} |  |  |
| `overview.ota.empty` | No update is stored for this platform. | No hay ninguna actualización guardada para esta plataforma. |  |  |
| `overview.ota.failedNever` | The updates could not be read. | No se pudieron leer las actualizaciones. |  |  |
| `overview.ota.never` | The updates have not been read yet. Read again from Builds. | Las actualizaciones aún no se han leído. Vuelve a leerlas desde Builds. |  |  |
| `overview.ota.openBuilds` | EAS updates in Builds | Actualizaciones EAS en Builds |  |  |
| `overview.ota.openExpo` | Open at Expo | Abrir en Expo |  |  |
| `overview.ota.rollout` | {{percentage}}% rollout | Despliegue al {{percentage}} % |  | rollout = despliegue |
| `overview.ota.title` | Current update per channel | Actualización actual por canal |  |  |
| `overview.ota.updated` | Updated {{when}}. | Actualizado {{when}}. |  |  |
| `overview.ota.updatedFailed` | The last read failed. Showing what was stored {{when}}. | La última lectura falló. Datos guardados {{when}}. |  |  |
| `overview.unavailable` | The stored {{platform}} builds could not be read. | No se pudieron leer los builds de {{platform}} guardados. |  |  |
| `releaseSteps.built.current` | Build running | Build en curso |  |  |
| `releaseSteps.built.done` | Build finished | Build terminado |  |  |
| `releaseSteps.built.failed` | Build failed or cancelled | Build fallido o cancelado |  |  |
| `releaseSteps.ota.channel` | channel {{channel}} | canal {{channel}} |  |  |
| `releaseSteps.ota.open` | Open at Expo | Abrir en Expo |  |  |
| `releaseSteps.ota.published` | OTA update published | Actualización OTA publicada |  |  |
| `releaseSteps.review.current` | In store review | En revisión de la tienda |  | review: reseña (user) vs revisión (App Review) |
| `releaseSteps.review.done` | Store review passed | Revisión de la tienda superada |  | review: reseña (user) vs revisión (App Review) |
| `releaseSteps.review.failed` | Rejected in store review | Rechazado en la revisión de la tienda |  | review: reseña (user) vs revisión (App Review) |
| `releaseSteps.review.todo` | Store review not started | Revisión de la tienda sin empezar |  | review: reseña (user) vs revisión (App Review) |
| `releaseSteps.submitted.current` | Submitting to the store | Enviando a la tienda |  | submit = enviar |
| `releaseSteps.submitted.done` | Submitted to the store | Enviado a la tienda |  | submit = enviar |
| `releaseSteps.submitted.failed` | Submission failed or cancelled | Envío fallido o cancelado |  | submit = enviar |
| `releaseSteps.submitted.todo` | Not submitted through EAS | No enviado a través de EAS |  | submit = enviar |
| `releaseSteps.title` | Build and submission (Expo EAS) | Build y envío (Expo EAS) |  | submit = enviar |
| `submissions.none` | EAS has not sent a build of this app to a store yet. | EAS todavía no ha enviado ningún build de esta app a una tienda. |  |  |
| `submissions.noneTitle` | No submissions yet | Aún no hay envíos |  | submit = enviar |
| `submissions.notLinked` | Link this app to an Expo project to see the builds it sent to the stores. | Vincula esta app a un proyecto de Expo para ver los builds que envió a las tiendas. |  |  |
| `submissions.notLinkedTitle` | Not linked to Expo | No vinculada a Expo |  |  |

## web/errors (79)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `ads.accountMissing` | That ad account is not one the key can read. Choose one from the list. | Esa cuenta publicitaria no es una que la clave pueda leer. Elige una de la lista. |  |  |
| `ads.adamRequired` | Enter the Apple id of the app (the number in its App Store address, after id). It is the app's store id, which this record does not have yet. | Introduce el id de Apple de la app (el número de su dirección en la App Store, después de id). Es el id de la app en la tienda, que este registro aún no tiene. |  |  |
| `ads.auth` | Apple did not accept the key. Check that the public key of this private key is saved in Apple Ads (Account Settings, API) and that the client ID, team ID and key ID are the ones Apple Ads showed after saving it. | Apple no aceptó la clave. Comprueba que la clave pública de esta clave privada está guardada en Apple Ads (Ajustes de la cuenta, API) y que el ID de cliente, el ID de equipo y el ID de clave son los que Apple Ads mostró al guardarla. |  |  |
| `ads.forbidden` | Apple Ads accepted the key, but this user may not read the ad account. Give the API user a role with read access, such as API Account Read Only, in Apple Ads. | Apple Ads aceptó la clave, pero este usuario no puede leer la cuenta publicitaria. Da al usuario de la API un rol con acceso de lectura, como API Account Read Only, en Apple Ads. |  |  |
| `ads.invalidInput` | That is not a valid Apple Ads request. | Esa no es una solicitud válida de Apple Ads. |  |  |
| `ads.invalidKey` | The private key could not be read. Paste the whole private-key.pem file, from -----BEGIN EC PRIVATE KEY----- to -----END EC PRIVATE KEY-----. It must be a P-256 key. | No se pudo leer la clave privada. Pega el archivo private-key.pem completo, desde -----BEGIN EC PRIVATE KEY----- hasta -----END EC PRIVATE KEY-----. Debe ser una clave P-256. |  |  |
| `ads.network` | Could not reach Apple Ads. Check that this server has internet access (and a proxy, if it needs one) to appleid.apple.com and api.ads.apple.com, then try again. | No se pudo conectar con Apple Ads. Comprueba que este servidor tiene acceso a internet (y a un proxy, si lo necesita) hacia appleid.apple.com y api.ads.apple.com, y vuelve a intentarlo. |  |  |
| `ads.noAccount` | Apple Ads accepted the key, but it sees no ad account. Invite the API user to the account in Apple Ads (Account Settings, User Management). | Apple Ads aceptó la clave, pero no ve ninguna cuenta publicitaria. Invita al usuario de la API a la cuenta en Apple Ads (Ajustes de la cuenta, Gestión de usuarios). |  |  |
| `ads.notFound` | Apple Ads has no such ad account or campaign, or the key cannot see it. | Apple Ads no tiene esa cuenta publicitaria ni esa campaña, o la clave no puede verlas. |  |  |
| `ads.notLinked` | This app is not linked to an Apple Ads account. Link it in the app settings first. | Esta app no está vinculada a una cuenta de Apple Ads. Vincúlala primero en los ajustes de la app. |  |  |
| `ads.notSupported` | Apple Ads is for App Store apps. This app is not one. | Apple Ads es para apps de la App Store. Esta app no lo es. |  |  |
| `ads.rateLimited` | Apple Ads asked to slow down. Try again in a minute. | Apple Ads pidió ir más despacio. Inténtalo de nuevo en un minuto. |  |  |
| `ads.requestFailed` | The Apple Ads request could not be completed. Try again in a moment. | No se pudo completar la solicitud a Apple Ads. Inténtalo de nuevo en un momento. |  |  |
| `ads.server` | Apple Ads had a problem. Try again in a few minutes. | Apple Ads tuvo un problema. Inténtalo de nuevo en unos minutos. |  |  |
| `ads.timeout` | Apple Ads did not answer in time. Try again in a minute. | Apple Ads no respondió a tiempo. Inténtalo de nuevo en un minuto. |  |  |
| `ads.unexpected` | Apple Ads answered with something this server could not read. | Apple Ads respondió algo que este servidor no pudo leer. |  |  |
| `app.listingSettingInvalid` | A listing setting is not valid. | Un ajuste de la ficha no es válido. |  | listing = ficha |
| `aso.playListingNotWatched` | Kiln does not read Google Play pages, so the listing of a Google Play competitor is not watched. | Kiln no lee las páginas de Google Play, así que la ficha de un competidor de Google Play no se vigila. |  | listing = ficha |
| `aso.searchAppStoreOnly` | Search by name is for App Store apps. For Google Play, paste the package name or the play.google.com address. | La búsqueda por nombre es solo para apps de la App Store. En Google Play, pega el nombre del paquete o la dirección de play.google.com. |  |  |
| `assetProposal.hasIssues` | Some of the selected items have errors. Confirm them to stage them anyway. | Algunos de los elementos seleccionados tienen errores. Confírmalos para prepararlos de todos modos. |  | stage = preparar (nothing is sent) |
| `assetProposal.unavailable` | There is nothing to stage for this release: the app has no repository, or the repository holds no store listing for it. | No hay nada que preparar para esta versión: la app no tiene repositorio, o el repositorio no contiene una ficha para ella. |  | stage = preparar (nothing is sent); release = lanzamiento |
| `chat.hostNotAllowed` | A {{provider}} webhook address comes from {{hosts}}. Allow other hosts on the destination to use another address. | Una dirección de webhook de {{provider}} procede de {{hosts}}. Permite otros hosts en el destino para usar otra dirección. |  |  |
| `chat.tooManyDestinations_one` | A workspace can have at most {{count}} chat destination. | Un espacio de trabajo puede tener como máximo {{count}} destino de chat. |  |  |
| `chat.tooManyDestinations_other` | A workspace can have at most {{count}} chat destinations. | Un espacio de trabajo puede tener como máximo {{count}} destinos de chat. |  |  |
| `chat.urlInvalid` | That address cannot be used. Use the https webhook address from Slack or Teams. | No se puede usar esa dirección. Usa la dirección de webhook https que da Slack o Teams. |  |  |
| `credential.notAppleAdsKind` | Apple Ads needs a credential of the Apple Ads API user key kind. | Apple Ads necesita una credencial del tipo clave de usuario de la API de Apple Ads. |  |  |
| `experiments.datesOrder` | The end date is before the start date. | La fecha de fin es anterior a la fecha de inicio. |  |  |
| `experiments.noteNotFound` | No such note. | Esa nota no existe. |  |  |
| `experiments.tooManyNotes` | An app can have {{limit}} notes. Delete one first. | Una app puede tener {{limit}} notas. Elimina una primero. |  |  |
| `experiments.unsupported` | The store of this app has no API for experiments or custom pages. Use the manual tracker and the links to its console. | La tienda de esta app no tiene API para experimentos ni páginas personalizadas. Usa el seguimiento manual y los enlaces a su consola. |  |  |
| `listing.fixNotAvailable` | This fix no longer applies: the text changed or it is already fixed. Reload and look again. | Esta corrección ya no se aplica: el texto cambió o ya está corregido. Recarga y vuelve a mirar. |  |  |
| `listing.staleFix` | The text changed since you looked at this fix. Reload and review it again. | El texto cambió desde que viste esta corrección. Recarga y revísala de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `prices.ackRequired` | This change needs an explicit acknowledgement before it can be staged or sent. | Este cambio necesita una confirmación explícita antes de prepararse o enviarse. |  | stage = preparar (nothing is sent) |
| `prices.ackUnknown` | Not a known acknowledgement. | Confirmación desconocida. |  |  |
| `prices.amountNotPricePoint` | Apple only sells at its price points. This amount is not one: pick the nearest. | Apple solo vende en sus niveles de precio. Este importe no es uno: elige el más cercano. |  |  |
| `prices.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Un importe debe estar en unidades menores enteras, por ejemplo 499 para 4,99. |  |  |
| `prices.badChoice` | Not a known choice for existing subscribers or acknowledgement. | Opción desconocida para los suscriptores actuales o confirmación desconocida. |  |  |
| `prices.badProduct` | Not a valid product. | Producto no válido. |  |  |
| `prices.badTerritory` | Not a territory of this store. | No es un país o región de esta tienda. |  |  |
| `prices.busy` | A price change for this app is in progress. Wait for it to finish. | Hay un cambio de precio de esta app en curso. Espera a que termine. |  |  |
| `prices.confirmationMismatch` | The confirmation phrase is not the one for these price changes. Nothing was sent. | La frase de confirmación no es la de estos cambios de precio. No se envió nada. |  |  |
| `prices.convertBase` | Name a base territory the plan has a price in, and an amount in minor units. | Indica un país o región base en el que el plan tenga precio y un importe en unidades menores. |  |  |
| `prices.convertNotApplicable` | Only Google Play converts one price to other regions. | Solo Google Play convierte un precio a otras regiones. |  |  |
| `prices.currencyMismatch` | The currency is not the currency of that territory. | Esa moneda no es la de ese país o región. |  |  |
| `prices.dateInvalid` | Not a date: use YYYY-MM-DD. | Fecha no válida: usa AAAA-MM-DD. |  |  |
| `prices.datePast` | The date is in the past. | La fecha ya pasó. |  |  |
| `prices.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Esta tienda aplica el precio al enviarlo: no se puede fechar. |  |  |
| `prices.disabledServer` | Price changes are switched off on this server. Set KILN_PRICE_WRITES_ENABLED=true to turn it on (see docs/deployment.md). | Los cambios de precio están desactivados en este servidor. Define KILN_PRICE_WRITES_ENABLED=true para activarlos (consulta docs/deployment.md). |  |  |
| `prices.disabledWorkspace` | Price changes are switched off for this workspace. An owner or admin can turn on the setting prices.writeEnabled. | Los cambios de precio están desactivados en este espacio de trabajo. Un propietario o administrador puede activar el ajuste prices.writeEnabled. |  |  |
| `prices.duplicateTerritory` | A territory is named twice. | Un país o región aparece dos veces. |  |  |
| `prices.noChange` | The new price is the price the store already shows. | El nuevo precio es el que la tienda ya muestra. |  |  |
| `prices.noLines` | Name at least one territory. | Indica al menos un país o región. |  |  |
| `prices.notPositive` | A price must be greater than zero. | Un precio debe ser mayor que cero. |  |  |
| `prices.planMissing` | Name the base plan or purchase option. | Indica el plan base o la opción de compra. |  |  |
| `prices.planNotAllowed` | This product has no such plan. | Este producto no tiene ese plan. |  |  |
| `prices.pricePointMismatch` | The amount is not the amount of that price point. | El importe no es el de ese nivel de precio. |  |  |
| `prices.pricePointMissing` | Apple prices are chosen from price points: pick one. | Los precios de Apple se eligen entre niveles de precio: elige uno. |  |  |
| `prices.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Los precios de Google Play son importes, no niveles de precio. |  |  |
| `prices.pricePointTerritory` | That price point belongs to another territory. | Ese nivel de precio pertenece a otro país o región. |  |  |
| `prices.pricePointUnknown` | That price point does not exist for this product. | Ese nivel de precio no existe para este producto. |  |  |
| `prices.stale` | The price changed since you looked at it. Sync the app and review again. | El precio cambió desde que lo viste. Sincroniza la app y revisa de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `prices.staleSnapshot` | The product was synced again since you opened it. Reload it and review the prices again. | El producto se sincronizó de nuevo desde que lo abriste. Recárgalo y revisa los precios otra vez. |  | review: reseña (user) vs revisión (App Review) |
| `prices.subscriberRule` | That choice for existing subscribers does not exist in this store. | Esa opción para los suscriptores actuales no existe en esta tienda. |  |  |
| `prices.tooHigh` | That price is above the highest price Kiln allows. | Ese precio supera el máximo que permite Kiln. |  |  |
| `prices.tooManyTerritories` | Too many territories in one change. | Demasiados países o regiones en un solo cambio. |  |  |
| `prices.unknownState` | It is not known whether the last price change of this app reached the store. Run a dry run: it reads the store and shows where it stands. Nothing was sent. | No se sabe si el último cambio de precio de esta app llegó a la tienda. Haz una simulación: lee la tienda y muestra cómo están los precios. No se envió nada. |  |  |
| `prices.unknownTerritory` | The product has no price in that territory. | El producto no tiene precio en ese país o región. |  |  |
| `rate.ads_one` | Too many Apple Ads checks. Try again in {{count}} second. | Demasiadas comprobaciones de Apple Ads. Inténtalo de nuevo en {{count}} segundo. |  |  |
| `rate.ads_other` | Too many Apple Ads checks. Try again in {{count}} seconds. | Demasiadas comprobaciones de Apple Ads. Inténtalo de nuevo en {{count}} segundos. |  |  |
| `staged.metadataLocked` | Version {{version}} is live or in App Review, so its listing can no longer be changed. Prepare a new version first, then stage the change. | La versión {{version}} está publicada o en revisión, así que su ficha ya no se puede cambiar. Prepara primero una versión nueva y luego prepara el cambio. |  | stage = preparar (nothing is sent); listing = ficha |
| `staged.storeImageFormat` | Image {{position}} of this set is stored as a format that cannot be pushed (only PNG and JPEG can), so the set cannot be edited here. | La imagen {{position}} de este conjunto está en un formato que no se puede enviar (solo PNG y JPEG), así que el conjunto no se puede editar aquí. |  |  |
| `staged.storeImageMismatch` | Image {{position}} of this set does not match the checksum the store gave, so it was not taken. Read the store again. | La imagen {{position}} de este conjunto no coincide con la suma de comprobación que dio la tienda, así que no se tomó. Vuelve a leer la tienda. |  |  |
| `testflight.assigneeNotMember` | The assignee is not a member of this workspace. | La persona asignada no es miembro de este espacio de trabajo. |  |  |
| `testflight.notFound` | No such feedback. | No existe ese comentario. |  |  |
| `testflight.unsupported` | The store of this app has no TestFlight feedback. Only App Store Connect apps (iOS and macOS) have it. | La tienda de esta aplicación no tiene comentarios de TestFlight. Solo las aplicaciones de App Store Connect (iOS y macOS) los tienen. |  |  |
| `timeline.eventNotFound` | That event no longer exists. | Ese evento ya no existe. |  |  |
| `timeline.invalidRange` | That date range is not valid. Pick days that exist and keep the range short enough. | Ese intervalo de fechas no es válido. Elige días que existan y un intervalo más corto. |  |  |
| `timeline.tooManyEvents_one` | An app can have at most {{limit}} event of its own. Delete one first. | Una app puede tener como máximo {{limit}} evento propio. Elimina uno primero. |  |  |
| `timeline.tooManyEvents_other` | An app can have at most {{limit}} events of its own. Delete one first. | Una app puede tener como máximo {{limit}} eventos propios. Elimina uno primero. |  |  |

## web/experiments (133)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `assets.none` | No media read | Sin contenido multimedia leído |  |  |
| `assets.other_one` | {{count}} other asset | {{count}} otro recurso |  |  |
| `assets.other_other` | {{count}} other assets | {{count}} otros recursos |  |  |
| `assets.previews_one` | {{count}} preview | {{count}} vista previa |  |  |
| `assets.previews_other` | {{count}} previews | {{count}} vistas previas |  |  |
| `assets.screenshots_one` | {{count}} screenshot | {{count}} captura de pantalla |  |  |
| `assets.screenshots_other` | {{count}} screenshots | {{count}} capturas de pantalla |  |  |
| `assets.sets_one` | {{count}} screenshot set | {{count}} conjunto de capturas |  |  |
| `assets.sets_other` | {{count}} screenshot sets | {{count}} conjuntos de capturas |  |  |
| `dates.notStarted` | Not started | Sin empezar |  |  |
| `dates.range` | {{from}} to {{to}} | Del {{from}} al {{to}} |  |  |
| `dates.since` | Since {{date}} | Desde el {{date}} |  |  |
| `dates.until` | Until {{date}} | Hasta el {{date}} |  |  |
| `experiments.aria` | Product Page Optimization experiments of {{app}} | Experimentos de optimización de la página de producto de {{app}} |  |  |
| `experiments.colDates` | Dates | Fechas |  |  |
| `experiments.colName` | Experiment | Experimento |  |  |
| `experiments.colState` | Status | Estado |  |  |
| `experiments.colTraffic` | Traffic | Tráfico |  |  |
| `experiments.colTreatments` | Treatments | Variantes |  |  |
| `experiments.emptyDescription` | This app has no Product Page Optimization experiment. Apple needs the app to be live on the App Store, and a test takes up to three treatments. Create one in App Store Connect, then sync again. | Esta app no tiene ningún experimento de optimización de la página de producto. Apple exige que la app esté publicada en la App Store, y un experimento admite hasta tres variantes. Crea uno en App Store Connect y vuelve a sincronizar. |  | live = vivo / publicada |
| `experiments.emptyTitle` | No experiments | Sin experimentos |  |  |
| `experiments.heading` | Product Page Optimization experiments | Experimentos de optimización de la página de producto |  |  |
| `experiments.neverDescription` | Sync to read the experiments of this app from App Store Connect. Nothing is changed in the store. | Sincroniza para leer los experimentos de esta app desde App Store Connect. No se cambia nada en la tienda. |  |  |
| `experiments.neverTitle` | Experiments not read yet | Experimentos aún sin leer |  |  |
| `experiments.noTreatments` | No treatments read | Sin variantes leídas |  |  |
| `experiments.reviewRequired` | Needs App Review | Requiere revisión de App Review |  | review: reseña (user) vs revisión (App Review) |
| `experiments.runningByDates` | Inside its run dates | Dentro de sus fechas de ejecución |  |  |
| `google.body` | The Google Play developer API has no store listing experiments and no custom store listings, so Kiln cannot read or change them. Manage them in the Play Console and keep your own record below. | La API de desarrollador de Google Play no tiene experimentos de ficha ni fichas personalizadas, así que Kiln no puede leerlos ni cambiarlos. Gestiónalos en la Google Play Console y lleva tu propio registro más abajo. |  | listing = ficha |
| `google.limitExperiments` | One default graphics experiment, or up to five localized experiments, can run at the same time. An experiment stops by itself after 6 months. | Puede ejecutarse un experimento de gráficos predeterminados, o hasta cinco experimentos localizados, al mismo tiempo. Un experimento se detiene solo a los 6 meses. |  |  |
| `google.limitListings` | An app can have up to 50 custom store listings, each reached by its own address. | Una app puede tener hasta 50 fichas personalizadas, cada una con su propia dirección. |  | listing = ficha |
| `google.title` | Experiments and custom listings live in the Play Console | Los experimentos y las fichas personalizadas se gestionan en la Google Play Console |  | listing = ficha; live = vivo / publicada |
| `noteDialog.addTitle` | Add a note | Añadir una nota |  |  |
| `noteDialog.description` | Kiln keeps this note for you. Nothing is sent to a store. | Kiln guarda esta nota por ti. No se envía nada a ninguna tienda. |  |  |
| `noteDialog.editTitle` | Change the note | Cambiar la nota |  |  |
| `noteDialog.endedOn` | Ended on | Terminó el |  |  |
| `noteDialog.kind` | About | Sobre |  |  |
| `noteDialog.listing` | Listing parameter | Parámetro de la ficha |  | listing = ficha |
| `noteDialog.listingHint` | The value after listing= in the address of the custom store listing. Lowercase letters, digits and . - _ ~ | El valor después de listing= en la dirección de la ficha personalizada. Minúsculas, dígitos y . - _ ~ |  | listing = ficha |
| `noteDialog.name` | Name | Nombre |  |  |
| `noteDialog.namePlaceholder` | For example: Icon test, spring campaign | Por ejemplo: prueba del icono, campaña de primavera |  |  |
| `noteDialog.note` | Notes | Notas |  |  |
| `noteDialog.noteHint` | What you tested and what you learned. Up to 2,000 characters. | Qué probaste y qué aprendiste. Hasta 2000 caracteres. |  |  |
| `noteDialog.saveFailed` | The note could not be saved. Try again. | No se pudo guardar la nota. Inténtalo de nuevo. |  |  |
| `noteDialog.saveFailedTitle` | Could not save the note | No se pudo guardar la nota |  |  |
| `noteDialog.startedOn` | Started on | Empezó el |  |  |
| `noteDialog.status` | Status | Estado |  |  |
| `noteDialog.url` | Link | Enlace |  |  |
| `noteDialog.urlHint` | Optional: the address of the page or the console view. | Opcional: la dirección de la página o de la vista de la consola. |  |  |
| `noteKind.customPage` | Custom page | Página personalizada |  |  |
| `noteKind.experiment` | Experiment | Experimento |  |  |
| `noteStatus.finished` | Finished | Terminado |  |  |
| `noteStatus.planned` | Planned | Planificado |  |  |
| `noteStatus.running` | Running | En curso |  |  |
| `noteStatus.stopped` | Stopped | Detenido |  |  |
| `notes.add` | Add a note | Añadir una nota |  |  |
| `notes.delete` | Delete | Eliminar |  |  |
| `notes.deleteFailed` | The note could not be deleted. Try again. | No se pudo eliminar la nota. Inténtalo de nuevo. |  |  |
| `notes.deleteFailedTitle` | Could not delete the note | No se pudo eliminar la nota |  |  |
| `notes.deleted` | Note deleted. | Nota eliminada. |  |  |
| `notes.edit` | Edit | Editar |  |  |
| `notes.emptyDescriptionApple` | Write down what you plan to test or what you learned. Kiln does not read this from the App Store. | Anota lo que piensas probar o lo que aprendiste. Kiln no lee esto desde la App Store. |  |  |
| `notes.emptyDescriptionGoogle` | Google Play has no API for experiments or custom listings, so this list is the record Kiln can keep: what you test, when, and what you learned. | Google Play no tiene API para experimentos ni fichas personalizadas, así que esta lista es el registro que Kiln puede llevar: qué pruebas, cuándo y qué aprendiste. |  | listing = ficha |
| `notes.emptyTitle` | No notes yet | Aún no hay notas |  |  |
| `notes.heading` | Manual tracker | Seguimiento manual |  |  |
| `notes.leadApple` | Your own notes about tests and pages, kept in Kiln. They are not read from or sent to the store. | Tus propias notas sobre pruebas y páginas, guardadas en Kiln. No se leen de la tienda ni se envían a ella. |  |  |
| `notes.leadGoogle` | Kiln cannot read Google Play experiments or custom listings. Keep your own record here and open the Play Console to run them. | Kiln no puede leer los experimentos ni las fichas personalizadas de Google Play. Lleva tu registro aquí y abre la Google Play Console para ejecutarlos. |  | listing = ficha |
| `notes.openLink` | Open the link | Abrir el enlace |  |  |
| `notes.openListing` | Open the listing on Google Play | Abrir la ficha en Google Play |  | listing = ficha |
| `pages.aria` | Custom product pages of {{app}} | Páginas de producto personalizadas de {{app}} |  |  |
| `pages.colActions` | Actions | Acciones |  |  |
| `pages.colDeepLink` | Deep link | Enlace profundo |  |  |
| `pages.colLanguages` | Languages | Idiomas |  |  |
| `pages.colName` | Page | Página |  |  |
| `pages.colState` | Status | Estado |  |  |
| `pages.copyLink` | Copy the address | Copiar la dirección |  |  |
| `pages.emptyDescription` | This app has no custom product page. An app can have up to 70, each with its own screenshots, previews and promotional text. Create them in App Store Connect, then sync again. | Esta app no tiene ninguna página de producto personalizada. Una app puede tener hasta 70, cada una con sus capturas, vistas previas y texto promocional. Créalas en App Store Connect y vuelve a sincronizar. |  |  |
| `pages.emptyTitle` | No custom product pages | Sin páginas de producto personalizadas |  |  |
| `pages.heading` | Custom product pages | Páginas de producto personalizadas |  |  |
| `pages.hidden` | Not visible | No visible |  |  |
| `pages.iosOnly` | Custom product pages are for iPhone and iPad apps: read them on the iOS record of this app. | Las páginas de producto personalizadas son para apps de iPhone y iPad: léelas en el registro iOS de esta app. |  |  |
| `pages.neverDescription` | Sync to read the custom product pages of this app from App Store Connect. | Sincroniza para leer las páginas de producto personalizadas de esta app desde App Store Connect. |  |  |
| `pages.neverTitle` | Custom product pages not read yet | Páginas de producto personalizadas aún sin leer |  |  |
| `pages.noDeepLink` | None | Ninguno |  |  |
| `pages.open` | Open | Abrir |  |  |
| `results.body` | Apple's API does not give the results of a test (impressions, conversion, confidence) or the numbers of a custom product page. They are in App Store Connect, under App Analytics. | La API de Apple no da los resultados de un experimento (impresiones, conversión, confianza) ni las cifras de una página de producto personalizada. Están en App Store Connect, en App Analytics. |  |  |
| `results.link` | Open {{console}} | Abrir {{console}} |  |  |
| `results.title` | Results are in App Store Connect | Los resultados están en App Store Connect |  |  |
| `state.approved` | Approved | Aprobado |  |  |
| `state.completed` | Completed | Completado |  |  |
| `state.draft` | Draft | Borrador |  |  |
| `state.inReview` | In review | En revisión |  | review: reseña (user) vs revisión (App Review) |
| `state.rejected` | Rejected | Rechazado |  |  |
| `state.replaced` | Replaced | Reemplazado |  |  |
| `state.stopped` | Stopped | Detenido |  |  |
| `state.unknown` | Unknown | Desconocido |  |  |
| `sync.failedKept` | The last sync failed. Showing what was read {{ago}}. {{error}} | La última sincronización falló. Se muestra lo leído {{ago}}. {{error}} |  |  |
| `sync.failedNothing` | The last sync failed. {{error}} | La última sincronización falló. {{error}} |  |  |
| `sync.never` | Not read yet. Sync to read the experiments and custom product pages. | Aún sin leer. Sincroniza para leer los experimentos y las páginas de producto personalizadas. |  |  |
| `sync.partial` | Read {{ago}}. The lists were cut at their limit: the store may have more. | Leído {{ago}}. Las listas se cortaron en su límite: la tienda puede tener más. |  |  |
| `sync.read` | Read {{ago}}. | Leído {{ago}}. |  |  |
| `tab.about` | About experiments | Acerca de los experimentos |  |  |
| `tab.aboutApple` | Apple's Product Page Optimization tests up to three treatments of your product page against the original, and custom product pages give a campaign its own page. Kiln reads them from App Store Connect. | La optimización de la página de producto de Apple prueba hasta tres variantes de tu página de producto frente a la original, y las páginas de producto personalizadas dan a una campaña su propia página. Kiln las lee desde App Store Connect. |  |  |
| `tab.aboutGoogle` | Google Play calls them store listing experiments and custom store listings. They are managed in the Play Console only. | Google Play los llama experimentos de ficha y fichas personalizadas. Solo se gestionan en la Google Play Console. |  | listing = ficha |
| `tab.aboutReadOnly` | Kiln reads and shows them. It cannot create, start, stop or change an experiment or a page: do that in the store's console. | Kiln los lee y los muestra. No puede crear, iniciar, detener ni cambiar un experimento o una página: hazlo en la consola de la tienda. |  |  |
| `tab.headlineCount` | Experiments and custom product pages, as of the last sync | Experimentos y páginas de producto personalizadas, a la última sincronización |  |  |
| `tab.headlineDefault` | Experiments and custom pages | Experimentos y páginas personalizadas |  |  |
| `tab.headlineGoogle` | Experiments on Google Play are managed in the Play Console | Los experimentos de Google Play se gestionan en la Google Play Console |  |  |
| `tab.headlineNone` | No experiments or custom product pages read | Sin experimentos ni páginas de producto personalizadas leídos |  |  |
| `tab.leadHintApple` | As of the last sync. Read only. | A la última sincronización. Solo lectura. |  |  |
| `tab.leadHintGoogle` | Google Play has no API for these: use the Play Console and the tracker below. | Google Play no tiene API para esto: usa la Google Play Console y el seguimiento de abajo. |  |  |
| `tab.loadError` | Could not load the experiments. | No se pudieron cargar los experimentos. |  |  |
| `tab.loadErrorTitle` | Could not load the experiments | No se pudieron cargar los experimentos |  |  |
| `tab.openConsole` | Open {{console}} | Abrir {{console}} |  |  |
| `tab.partsTitle` | Some parts could not be read | Algunas partes no se pudieron leer |  |  |
| `tab.rawState` | The store's own word | El término de la tienda |  |  |
| `tab.reading` | Reading the experiments | Leyendo los experimentos |  |  |
| `tab.sync` | Sync experiments | Sincronizar experimentos |  |  |
| `tab.syncDone` | Sync done. Experiments: {{experiments}}. Custom product pages: {{pages}}. | Sincronización terminada. Experimentos: {{experiments}}. Páginas de producto personalizadas: {{pages}}. |  |  |
| `tab.syncFailedNetwork` | The sync could not be completed. Try again. | No se pudo completar la sincronización. Inténtalo de nuevo. |  |  |
| `tab.syncFailedTitle` | The sync failed | La sincronización falló |  |  |
| `table.localesMore` | {{list}} and {{count}} more | {{list}} y {{count}} más |  |  |
| `table.none` | None | Ninguno |  |  |
| `traffic.percent` | {{percent}}% | {{percent}} % |  |  |
| `traffic.unknown` | Unknown | Desconocido |  |  |
| `treatment.icon` | icon {{name}} | icono {{name}} |  |  |
| `treatment.languages_one` | {{count}} language | {{count}} idioma |  |  |
| `treatment.languages_other` | {{count}} languages | {{count}} idiomas |  |  |
| `validation.datesOrder` | The end date is before the start date. | La fecha de fin es anterior a la fecha de inicio. |  |  |
| `validation.listing` | Lowercase letters, digits and . - _ ~ only. | Solo minúsculas, dígitos y . - _ ~. |  |  |
| `validation.nameLong` | At most 120 characters. | Como máximo 120 caracteres. |  |  |
| `validation.nameRequired` | Enter a name. | Escribe un nombre. |  |  |
| `validation.noteLong` | At most 2,000 characters. | Como máximo 2000 caracteres. |  |  |
| `validation.url` | Enter an address that starts with https:// or http://. | Escribe una dirección que empiece por https:// o http://. |  |  |

## web/insights (208)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `action.addLocale` | Add a language | Añadir un idioma |  |  |
| `action.open` | Open | Abrir |  |  |
| `action.openChecks` | See the checks | Ver las comprobaciones |  |  |
| `action.openCountries` | See the countries | Ver los países |  |  |
| `action.openGraphics` | Review the graphics | Revisar los gráficos |  | review: reseña (user) vs revisión (App Review) |
| `action.openKeywords` | Look at keywords | Ver las palabras clave |  |  |
| `action.openOverview` | Open the overview | Abrir el resumen |  |  |
| `action.openRank` | See the ranks | Ver las posiciones |  |  |
| `action.openReviews` | Read the reviews | Leer las reseñas |  | review: reseña (user) vs revisión (App Review) |
| `action.openText` | Review the text | Revisar el texto |  | review: reseña (user) vs revisión (App Review) |
| `card.complaints.explain` | {{count}} of the {{total}} complaints in the last {{days}} days are about this. Read those reviews to see what is going on. | {{count}} de las {{total}} quejas de los últimos {{days}} días tratan de esto. Lee esas reseñas para ver qué ocurre. |  | review: reseña (user) vs revisión (App Review) |
| `card.complaints.headline` | Complaints in reviews: {{theme}} | Quejas en las reseñas: {{theme}} |  | review: reseña (user) vs revisión (App Review) |
| `card.conversionDown.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, down from {{before}} in the 14 days before. The change is too large to be chance. Check what changed on the page: icon, screenshots, text. | En los últimos 14 días, el {{now}} de las personas que vieron tu ficha obtuvo la app, frente al {{before}} en los 14 días anteriores. El cambio es demasiado grande para deberse al azar. Comprueba qué cambió en la ficha: icono, capturas de pantalla, texto. |  |  |
| `card.conversionDown.headline` | Fewer people who see the page get the app | Menos personas que ven la ficha obtienen la app |  |  |
| `card.conversionUp.explain` | In the last 14 days {{now}} of the people who saw your store page got the app, up from {{before}} in the 14 days before. The change is too large to be chance. | En los últimos 14 días, el {{now}} de las personas que vieron tu ficha obtuvo la app, frente al {{before}} en los 14 días anteriores. El cambio es demasiado grande para deberse al azar. |  |  |
| `card.conversionUp.headline` | More people who see the page get the app | Más personas que ven la ficha obtienen la app |  |  |
| `card.downloadsDown.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} descargas nuevas en los últimos 14 días, frente a {{previous}} en los 14 días anteriores. |  |  |
| `card.downloadsDown.headline` | New downloads are down {{percent}} | Las descargas nuevas bajan un {{percent}} |  |  |
| `card.downloadsUp.explain` | {{current}} new downloads in the last 14 days, against {{previous}} in the 14 days before. | {{current}} descargas nuevas en los últimos 14 días, frente a {{previous}} en los 14 días anteriores. |  |  |
| `card.downloadsUp.headline` | New downloads are up {{percent}} | Las descargas nuevas suben un {{percent}} |  |  |
| `card.featuredSpike.explain` | On {{day}} the app was shown {{count}} times while browsing, about {{times}} times a usual day. This looks like a feature in the store. It rarely lasts, so make sure the page is ready. | El {{day}} la app se mostró {{count}} veces en la exploración, unas {{times}} veces un día habitual. Parece que la tienda te ha destacado. Rara vez dura, así que asegúrate de que la ficha esté lista. |  |  |
| `card.featuredSpike.headline` | A one-day jump in browse impressions | Un pico de impresiones en la exploración durante un día |  |  |
| `card.keywordsDown.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved down: {{count}}. | «{{term}}» en {{country}} pasó del puesto {{from}} al {{to}}. Palabras clave seguidas que bajan: {{count}}. |  |  |
| `card.keywordsDown.headline` | Keyword ranks dropped | Bajan las posiciones de palabras clave |  |  |
| `card.keywordsUp.explain` | “{{term}}” in {{country}} moved from #{{from}} to #{{to}}. Tracked keywords that moved up: {{count}}. | «{{term}}» en {{country}} pasó del puesto {{from}} al {{to}}. Palabras clave seguidas que suben: {{count}}. |  |  |
| `card.keywordsUp.headline` | Keyword ranks improved | Mejoran las posiciones de palabras clave |  |  |
| `card.listingIssues.explain_one` | {{count}} problem to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} problema por corregir y {{warnings}} por revisar. El idioma más débil es {{locale}}; la ficha obtiene {{score}} de 100. |  | review: reseña (user) vs revisión (App Review) |
| `card.listingIssues.explain_other` | {{count}} problems to fix and {{warnings}} to review. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} problemas por corregir y {{warnings}} por revisar. El idioma más débil es {{locale}}; la ficha obtiene {{score}} de 100. |  | review: reseña (user) vs revisión (App Review) |
| `card.listingIssues.headline` | The store page has problems to fix | La ficha de la tienda tiene problemas que corregir |  |  |
| `card.listingReview.explain_one` | {{count}} point to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} punto por revisar, nada que bloquee un envío. El idioma más débil es {{locale}}; la ficha obtiene {{score}} de 100. |  | review: reseña (user) vs revisión (App Review) |
| `card.listingReview.explain_other` | {{count}} points to review, nothing that blocks a push. The weakest language is {{locale}}; the page scores {{score}} out of 100. | {{count}} puntos por revisar, nada que bloquee un envío. El idioma más débil es {{locale}}; la ficha obtiene {{score}} de 100. |  | review: reseña (user) vs revisión (App Review) |
| `card.listingReview.headline` | The store page has points to review | La ficha de la tienda tiene puntos por revisar |  | review: reseña (user) vs revisión (App Review) |
| `card.localize.explain` | In countries such as {{countries}} people mainly speak {{language}}. There they see the page in another language. Text in their language usually helps them decide. | En países como {{countries}} se habla sobre todo {{language}}. Allí la gente ve la ficha en otro idioma. Un texto en su idioma suele ayudarles a decidirse. |  |  |
| `card.localize.headline` | {{percent}} of downloads come from countries that mainly speak {{language}}, but the store page has no {{language}} text | El {{percent}} de las descargas viene de países donde se habla sobre todo {{language}}, pero la ficha no tiene texto en ese idioma |  |  |
| `card.unknown.explain` | This card comes from a newer version of Kiln. Update Kiln to read it. | Esta tarjeta viene de una versión más reciente de Kiln. Actualiza Kiln para leerla. |  |  |
| `card.unknown.headline` | Something changed | Algo ha cambiado |  |  |
| `card.versionRatingDrop.explain` | Reviews of {{version}} average {{now}} stars, against {{before}} for {{previous}}. Look at what changed in that version. | Las reseñas de la {{version}} promedian {{now}} estrellas, frente a {{before}} de la {{previous}}. Mira qué cambió en esa versión. |  | review: reseña (user) vs revisión (App Review) |
| `card.versionRatingDrop.headline` | Version {{version}} is rated lower than {{previous}} | La versión {{version}} tiene peor valoración que la {{previous}} |  |  |
| `card.visibilityDownSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. Look at your keyword ranks first. | En los últimos 14 días la app se mostró {{current}} veces en la tienda, frente a {{previous}} en los 14 días anteriores. Mira primero las posiciones de tus palabras clave. |  |  |
| `card.visibilityDownSeen.headline` | The app is shown {{percent}} less often | Las impresiones de la app bajan un {{percent}} |  |  |
| `card.visibilityDownVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. Look at your keyword ranks first. | En los últimos 14 días la ficha de la tienda tuvo {{current}} visitantes, frente a {{previous}} en los 14 días anteriores. Mira primero las posiciones de tus palabras clave. |  |  |
| `card.visibilityDownVisits.headline` | Store page visits are down {{percent}} | Las visitas a la ficha bajan un {{percent}} |  |  |
| `card.visibilityUpSeen.explain` | In the last 14 days the app was shown {{current}} times in the store, against {{previous}} in the 14 days before. | En los últimos 14 días la app se mostró {{current}} veces en la tienda, frente a {{previous}} en los 14 días anteriores. |  |  |
| `card.visibilityUpSeen.headline` | The app is shown {{percent}} more often | Las impresiones de la app suben un {{percent}} |  |  |
| `card.visibilityUpVisits.explain` | In the last 14 days the store page had {{current}} visitors, against {{previous}} in the 14 days before. | En los últimos 14 días la ficha de la tienda tuvo {{current}} visitantes, frente a {{previous}} en los 14 días anteriores. |  |  |
| `card.visibilityUpVisits.headline` | Store page visits are up {{percent}} | Las visitas a la ficha suben un {{percent}} |  |  |
| `cards.dismiss` | Dismiss | Descartar |  |  |
| `cards.dismissFailed` | The card could not be hidden. Try again. | No se pudo ocultar la tarjeta. Inténtalo de nuevo. |  |  |
| `cards.dismissed` | Card hidden until its finding changes. | Tarjeta oculta hasta que cambie el hallazgo. |  |  |
| `cards.hiddenLine_one` | {{count}} card is hidden. | {{count}} tarjeta está oculta. |  |  |
| `cards.hiddenLine_other` | {{count}} cards are hidden. | {{count}} tarjetas están ocultas. |  |  |
| `cards.loadError` | The insights could not be read. Try again. | No se pudieron leer los análisis. Inténtalo de nuevo. |  |  |
| `cards.loadErrorTitle` | Insights unavailable | Análisis no disponibles |  |  |
| `cards.showHidden` | Show hidden cards | Mostrar las tarjetas ocultas |  |  |
| `cards.undo` | Undo | Deshacer |  |  |
| `cards.undoFailed` | The card could not be brought back. Try again. | No se pudo recuperar la tarjeta. Inténtalo de nuevo. |  |  |
| `category.conversion` | Conversion | Conversión |  |  |
| `category.downloads` | Downloads | Descargas |  |  |
| `category.keywords` | Keywords | Palabras clave |  |  |
| `category.listing` | Store page | Ficha de la tienda |  |  |
| `category.markets` | Markets | Mercados |  |  |
| `category.reviews` | Reviews | Reseñas |  | review: reseña (user) vs revisión (App Review) |
| `category.visibility` | Visibility | Visibilidad |  |  |
| `check.empty.explain` | This field has no text. Shoppers and store search get nothing from it. | Este campo no tiene texto. Ni los visitantes ni la búsqueda de la tienda sacan nada de él. |  |  |
| `check.empty.title` | {{field}} is empty | {{field}}: vacío |  |  |
| `check.keywordsDuplicate.explain` | The same word appears more than once ({{words}}). Each repeat wastes room. | La misma palabra aparece más de una vez ({{words}}). Cada repetición desperdicia espacio. |  |  |
| `check.keywordsDuplicate.title` | Repeated keywords | Palabras clave repetidas |  |  |
| `check.keywordsInTitle.explain` | These words are already searchable from the name or subtitle: {{words}}. Repeating them in the keyword field wastes room. | Estas palabras ya se encuentran por el nombre o el subtítulo: {{words}}. Repetirlas en el campo de palabras clave desperdicia espacio. |  |  |
| `check.keywordsInTitle.title` | Keywords already in the name or subtitle | Palabras clave que ya están en el nombre o el subtítulo |  |  |
| `check.keywordsSpaces.explain` | Spaces around the commas use up {{saved}} bytes of the keyword field. Without them there is room for more keywords. A rewritten field is suggested below. | Los espacios junto a las comas ocupan {{saved}} bytes del campo de palabras clave. Sin ellos cabrían más palabras clave. Abajo se propone un campo reescrito. |  |  |
| `check.keywordsSpaces.title` | The keywords waste space | Las palabras clave desperdician espacio |  |  |
| `check.keywordsUnderused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More keywords can bring more searches. | Solo se usan {{used}} de {{limit}} {{unit}}. Más palabras clave pueden traer más búsquedas. |  |  |
| `check.keywordsUnderused.title` | Room left in the keyword field | Espacio libre en el campo de palabras clave |  |  |
| `check.noScreenshots.explain` | Other languages have their own screenshots and this one has none. | Los demás idiomas tienen sus propias capturas de pantalla y este no tiene ninguna. |  |  |
| `check.noScreenshots.title` | No screenshots of its own | Sin capturas de pantalla propias |  |  |
| `check.promoMissing.explain` | Promotional text can change without a new version and shows above the description. Add some. | El texto promocional puede cambiar sin una versión nueva y aparece sobre la descripción. Añade uno. |  |  |
| `check.promoMissing.title` | No promotional text | Sin texto promocional |  |  |
| `check.severity.problem` | Problem | Problema |  |  |
| `check.severity.tip` | Tip | Consejo |  |  |
| `check.severity.warning` | Warning | Advertencia |  |  |
| `check.subtitleMissing.explain` | The subtitle is searchable text that shows under the name in search results. Add one. | El subtítulo es texto indexado que aparece bajo el nombre en los resultados de búsqueda. Añade uno. |  |  |
| `check.subtitleMissing.title` | No subtitle | Sin subtítulo |  |  |
| `check.subtitleRepeatsName.explain` | Every word of the subtitle is already in the name, so it adds nothing to search. Say something new about the app. | Todas las palabras del subtítulo ya están en el nombre, así que no aportan nada a la búsqueda. Di algo nuevo sobre la app. |  |  |
| `check.subtitleRepeatsName.title` | The subtitle repeats the name | El subtítulo repite el nombre |  |  |
| `check.tooLong.explain` | The text uses {{used}} of {{limit}} allowed {{unit}}. The store rejects text over the limit, so shorten it before you publish. | El texto usa {{used}} de {{limit}} {{unit}} permitidos. La tienda rechaza el texto que pasa del límite: acórtalo antes de publicar. |  |  |
| `check.tooLong.title` | {{field}} is {{over}} {{unit}} too long | {{field}}: sobran {{over}} {{unit}} |  |  |
| `check.underused.explain` | Only {{used}} of {{limit}} {{unit}} are used. More room means more words people can find the app by. | Solo se usan {{used}} de {{limit}} {{unit}}. Más espacio significa más palabras por las que encontrar la app. |  |  |
| `check.underused.title` | {{field}} uses little of its room | {{field}}: aprovecha poco el espacio |  |  |
| `check.unknown.explain` | This finding comes from a newer version of Kiln. Update Kiln to read it. | Este hallazgo viene de una versión más reciente de Kiln. Actualiza Kiln para leerlo. |  |  |
| `check.unknown.title` | A check found something | Una comprobación encontró algo |  |  |
| `check.untranslated.explain` | {{fields}} matches {{base}} word for word. Translate it, or people in this language read foreign text. | {{fields}}: igual que en {{base}}, palabra por palabra. Tradúcelo, o quienes hablan este idioma leerán un texto extranjero. |  |  |
| `check.untranslated.title` | Text is the same as in {{base}} | El texto es igual que el de {{base}} |  |  |
| `checks.allGood` | No findings. The text passes every check. | Sin hallazgos. El texto pasa todas las comprobaciones. |  |  |
| `checks.clean_one` | {{count}} language has no findings: {{locales}}. | {{count}} idioma sin hallazgos: {{locales}}. |  |  |
| `checks.clean_other` | {{count}} languages have no findings: {{locales}}. | {{count}} idiomas sin hallazgos: {{locales}}. |  |  |
| `checks.copied` | Copied | Copiado |  |  |
| `checks.copy` | Copy | Copiar |  |  |
| `checks.counts` | Problems {{problems}} · warnings {{warnings}} · tips {{tips}} | Problemas: {{problems}} · advertencias: {{warnings}} · consejos: {{tips}} |  |  |
| `checks.findings_one` | {{count}} finding | {{count}} hallazgo |  |  |
| `checks.findings_other` | {{count}} findings | {{count}} hallazgos |  |  |
| `checks.loadError` | The checks could not be read. Try again. | No se pudieron leer las comprobaciones. Inténtalo de nuevo. |  |  |
| `checks.loadErrorTitle` | Checks unavailable | Comprobaciones no disponibles |  |  |
| `checks.noListing` | Kiln needs the live text of your store page to check it. Use Sync now in the status menu of the page header, then come back. | Kiln necesita el texto publicado de tu ficha para comprobarla. Usa Sincronizar ahora en el menú de estado del encabezado de la página y vuelve. |  | live = vivo / publicada |
| `checks.noListingTitle` | The store page has not been read yet | Aún no se ha leído la ficha de la tienda |  |  |
| `checks.openLocale` | Open {{locale}} | Abrir {{locale}} |  |  |
| `checks.pasteHint` | Nothing is sent to a store. Paste it in the field editor and stage it. | No se envía nada a ninguna tienda. Pégalo en el editor del campo y déjalo en cambios pendientes. |  | stage = preparar (nothing is sent) |
| `checks.score` | Score {{score}} | Puntuación {{score}} |  |  |
| `checks.suggested` | Suggested text for {{field}} | Texto propuesto para {{field}} |  |  |
| `checks.summary` | Score {{score}} out of 100 | Puntuación de {{score}} sobre 100 |  |  |
| `checks.title` | Store page checks | Comprobaciones de la ficha de la tienda |  |  |
| `countries.addLanguage` | Add it in the store listing | Añadirlo en la ficha de la tienda |  | listing = ficha |
| `countries.byLanguage` | Downloads by main language | Descargas por idioma principal |  |  |
| `countries.colCountry` | Country or region | País o región |  |  |
| `countries.colDownloads` | New downloads | Descargas nuevas |  |  |
| `countries.colLanguage` | Main language | Idioma principal |  |  |
| `countries.colPage` | Store page | Ficha de la tienda |  |  |
| `countries.colShare` | Share | Parte |  |  |
| `countries.hint` | New downloads of the last 28 days: {{total}}. The main language of a country is the one most people there speak; many speak others too. | Descargas nuevas de los últimos 28 días: {{total}}. El idioma principal de un país es el que habla la mayoría de la gente; muchos hablan también otros. |  |  |
| `countries.languageUnknown` | Unknown | Desconocido |  |  |
| `countries.leadCovered` | Your store page covers the main language of every country that downloads your app | Tu ficha de la tienda cubre el idioma principal de cada país que descarga tu app |  |  |
| `countries.leadUncovered` | {{percent}} of new downloads come from countries whose language your store page lacks | El {{percent}} de las descargas nuevas viene de países cuyo idioma falta en tu ficha de la tienda |  |  |
| `countries.loadError` | The countries could not be read. Try again. | No se pudieron leer los países. Inténtalo de nuevo. |  |  |
| `countries.loadErrorTitle` | Countries unavailable | Países no disponibles |  |  |
| `countries.moreLanguages_one` | {{count}} more language with fewer downloads is not shown. | No se muestra {{count}} idioma más, con menos descargas. |  |  |
| `countries.moreLanguages_other` | {{count}} more languages with fewer downloads are not shown. | No se muestran {{count}} idiomas más, con menos descargas. |  |  |
| `countries.notOnPage` | Not on your store page | No está en tu ficha |  |  |
| `countries.onPage` | On your store page ({{locale}}) | En tu ficha ({{locale}}) |  |  |
| `countries.table` | Countries | Países |  |  |
| `countries.unavailable.noAccess` | Your role may not read the store page, so the languages on it cannot be compared. | Tu rol no puede leer la ficha de la tienda, así que no se pueden comparar los idiomas que contiene. |  |  |
| `countries.unavailable.noCountries` | The store sends no downloads by country for this app (Google Play reports carry none), or none are stored yet. Sync the analytics to read them. | La tienda no envía descargas por país para esta app (los informes de Google Play no las incluyen) o aún no hay ninguna guardada. Sincroniza la analítica para leerlas. |  |  |
| `countries.unavailable.noListing` | Kiln has not read your live store page yet, so it cannot tell which languages it covers. Use Sync now in the status menu of the page header. | Kiln aún no ha leído tu ficha publicada en la tienda, así que no sabe qué idiomas cubre. Usa Sincronizar ahora en el menú de estado del encabezado de la página. |  | live = vivo / publicada |
| `countries.unavailableTitle` | No table of countries | No hay tabla de países |  |  |
| `countries.unknown_one` | {{count}} download came from a country whose main language is not known. | {{count}} descarga viene de un país cuyo idioma principal no se conoce. |  |  |
| `countries.unknown_other` | {{count}} downloads came from countries whose main language is not known. | {{count}} descargas vienen de países cuyo idioma principal no se conoce. |  |  |
| `empty.hiddenTitle` | Every card is dismissed | Todas las tarjetas están descartadas |  |  |
| `empty.hidden_one` | The {{count}} card Kiln found is hidden. Show it again below, or wait: a hidden card returns when its finding changes. | Kiln encontró {{count}} tarjeta y está oculta. Vuelve a mostrarla abajo o espera: una tarjeta oculta reaparece cuando cambia su hallazgo. |  |  |
| `empty.hidden_other` | The {{count}} cards Kiln found are hidden. Show them again below, or wait: a hidden card returns when its finding changes. | Las {{count}} tarjetas que encontró Kiln están ocultas. Vuelve a mostrarlas abajo o espera: una tarjeta oculta reaparece cuando cambia su hallazgo. |  |  |
| `empty.nodata` | Some checks could not run, so there is nothing to show. The notes below say what each one is missing. | Algunas comprobaciones no pudieron ejecutarse, así que no hay nada que mostrar. Las notas de abajo dicen qué le falta a cada una. |  |  |
| `empty.nodataTitle` | Not enough data yet | Aún no hay datos suficientes |  |  |
| `empty.quiet` | Every check ran and found nothing worth your time. Kiln looks again after the next sync. | Se hicieron todas las comprobaciones y no se encontró nada que merezca tu tiempo. Kiln vuelve a mirar tras la próxima sincronización. |  |  |
| `empty.quietTitle` | Nothing stands out | Nada destaca |  |  |
| `evidence.browseDay` | That day | Ese día |  |  |
| `evidence.browseUsual` | Usual day | Día habitual |  |  |
| `evidence.complaints` | All complaints | Todas las quejas |  |  |
| `evidence.current` | Last 14 days | Últimos 14 días |  |  |
| `evidence.day` | Day | Día |  |  |
| `evidence.downloads` | New downloads | Descargas nuevas |  |  |
| `evidence.issues` | Problems | Problemas |  |  |
| `evidence.mentions` | Mentions | Menciones |  |  |
| `evidence.previous` | 14 days before | 14 días anteriores |  |  |
| `evidence.rateNow` | Rate now | Tasa actual |  |  |
| `evidence.ratePrevious` | Rate before | Tasa anterior |  |  |
| `evidence.ratingNow` | Rating now | Valoración actual |  | rating = valoración |
| `evidence.ratingPrevious` | Rating before | Valoración anterior |  | rating = valoración |
| `evidence.score` | Score | Puntuación |  |  |
| `evidence.share` | Share of downloads | Parte de las descargas |  |  |
| `evidence.unranked` | Not ranked | Sin posición |  |  |
| `evidence.warnings` | To review | Por revisar |  | review: reseña (user) vs revisión (App Review) |
| `field.description` | Description | Descripción |  |  |
| `field.fullDescription` | Full description | Descripción completa |  |  |
| `field.keywords` | Keywords | Palabras clave |  |  |
| `field.name` | Name | Nombre |  |  |
| `field.promotionalText` | Promotional text | Texto promocional |  |  |
| `field.shortDescription` | Short description | Descripción corta |  |  |
| `field.subtitle` | Subtitle | Subtítulo |  |  |
| `field.title` | Title | Título |  |  |
| `filter.all` | All | Todo |  |  |
| `filter.empty` | Nothing in this topic. | No hay nada en este tema. |  |  |
| `filter.label` | Filter by topic | Filtrar por tema |  |  |
| `lead.headline_one` | {{count}} thing to look at | {{count}} punto que revisar |  |  |
| `lead.headline_other` | {{count}} things to look at | {{count}} puntos que revisar |  |  |
| `lead.hint` | Worked out from what Kiln has already stored: analytics, reviews, keyword ranks and your live store page. Nothing is sent to a store. | Calculado a partir de lo que Kiln ya ha guardado: analítica, reseñas, posiciones de palabras clave y la ficha publicada en la tienda. No se envía nada a ninguna tienda. |  | review: reseña (user) vs revisión (App Review); live = vivo / publicada |
| `lead.none` | Nothing needs your attention | Nada requiere tu atención |  |  |
| `notes.title` | Checks that did not run | Comprobaciones que no se ejecutaron |  |  |
| `reason.noAccess` | your role may not read the data it needs. | tu rol no puede leer los datos que necesita. |  |  |
| `reason.noCountries` | the store sends no downloads by country (Google Play does not), or none are stored yet. | la tienda no envía descargas por país (Google Play no las envía) o aún no hay ninguna guardada. |  |  |
| `reason.noData` | no data is stored yet. Sync the app, or turn on analytics. | aún no hay datos guardados. Sincroniza la app o activa la analítica. |  |  |
| `reason.noKeywords` | no keywords are tracked yet. | aún no se sigue ninguna palabra clave. |  |  |
| `reason.noListing` | the live store page has not been read yet. Sync the app first. | aún no se ha leído la ficha publicada en la tienda. Sincroniza primero la app. |  | live = vivo / publicada |
| `reason.noReviews` | no reviews are stored. Read the reviews first. | no hay reseñas guardadas. Lee primero las reseñas. |  | review: reseña (user) vs revisión (App Review) |
| `reason.notForStore` | it does not apply to this store. | no se aplica a esta tienda. |  |  |
| `reason.other` | it could not run. | no se pudo ejecutar. |  |  |
| `reason.tooLittleData` | there are not enough days of data to compare two weeks yet. | aún no hay suficientes días de datos para comparar dos semanas. |  |  |
| `severity.good` | Good news | Buena noticia |  |  |
| `severity.info` | Information | Información |  |  |
| `severity.problem` | Problem | Problema |  |  |
| `severity.warning` | Warning | Advertencia |  |  |
| `skip.complaints` | Review complaints | Quejas en las reseñas |  | review: reseña (user) vs revisión (App Review) |
| `skip.conversion` | Conversion | Conversión |  |  |
| `skip.downloads` | Downloads | Descargas |  |  |
| `skip.featured` | Store featuring | Destacados en la tienda |  |  |
| `skip.keywords` | Keyword ranks | Posiciones de palabras clave |  |  |
| `skip.line` | {{rule}}: {{reason}} | {{rule}}: {{reason}} |  |  |
| `skip.listing` | Store page checks | Comprobaciones de la ficha de la tienda |  |  |
| `skip.localize` | Languages of your countries | Idiomas de tus países |  |  |
| `skip.other` | Another check | Otra comprobación |  |  |
| `skip.versionRating` | Rating of the latest version | Valoración de la última versión |  | rating = valoración |
| `skip.visibility` | Visibility | Visibilidad |  |  |
| `theme.ads` | ads | anuncios |  |  |
| `theme.bug` | bugs | errores |  |  |
| `theme.crash` | crashes | cierres inesperados |  |  |
| `theme.data` | lost or missing data | datos perdidos o ausentes |  |  |
| `theme.login` | signing in | inicio de sesión |  |  |
| `theme.performance` | slow performance | lentitud |  |  |
| `theme.price` | the price | precio |  |  |
| `theme.update` | the latest update | última actualización |  |  |
| `unit.bytes` | bytes | bytes |  |  |
| `unit.characters` | characters | caracteres |  |  |

## web/listing (58)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `compare.discard` | Discard | Descartar |  |  |
| `compare.discardFor` | Discard the staged {{label}} ({{locale}}) | Descartar el cambio preparado de {{label}} ({{locale}}) |  | stage = preparar (nothing is sent) |
| `fix.after` | After | Después |  |  |
| `fix.afterPending` | After pending changes: {{problems}} problems, {{warnings}} warnings, {{tips}} tips. Score {{score}}. | Tras los cambios pendientes: {{problems}} problemas, {{warnings}} avisos, {{tips}} consejos. Puntuación {{score}}. |  | cart = "Cambios pendientes" |
| `fix.all_one` | Fix all that can be fixed ({{count}}) | Corregir todo lo que se pueda ({{count}}) |  |  |
| `fix.all_other` | Fix all that can be fixed ({{count}}) | Corregir todo lo que se pueda ({{count}}) |  |  |
| `fix.barTitle` | Fixes for this language | Correcciones para este idioma |  |  |
| `fix.before` | Before | Antes |  |  |
| `fix.button` | Fix | Corregir |  |  |
| `fix.bytes` | bytes | bytes |  |  |
| `fix.cannot` | Cannot be fixed automatically. | No se puede corregir automáticamente. |  |  |
| `fix.characters` | characters | caracteres |  |  |
| `fix.discard` | Discard | Descartar |  |  |
| `fix.drops_one` | Removes {{count}} whole term. No word is cut. | Quita {{count}} término completo. No se corta ninguna palabra. |  |  |
| `fix.drops_other` | Removes {{count}} whole terms. No word is cut. | Quita {{count}} términos completos. No se corta ninguna palabra. |  |  |
| `fix.editField` | Edit | Editar |  |  |
| `fix.emptyHint` | A required field is empty. Nothing is invented: write it in the editor. | Un campo obligatorio está vacío. No se inventa nada: escríbelo en el editor. |  |  |
| `fix.failed` | The fix could not be staged. Reload and try again. | No se pudo preparar la corrección. Recarga e inténtalo de nuevo. |  | stage = preparar (nothing is sent) |
| `fix.keywordsDropInTitle` | Remove terms already in the name or subtitle | Quitar los términos que ya están en el nombre o el subtítulo |  |  |
| `fix.keywordsFit` | Drop terms to fit the limit | Quitar términos para cumplir el límite |  |  |
| `fix.keywordsTidy` | Tidy the keyword field | Ordenar el campo de palabras clave |  |  |
| `fix.locked` | This version is live or in review, so its text is read-only here. | Esta versión está publicada o en revisión, así que su texto es de solo lectura aquí. |  | review: reseña (user) vs revisión (App Review); live = vivo / publicada |
| `fix.noMeaning` | Only spaces, empty terms and repeats change. Nothing a shopper reads. | Solo cambian los espacios, los términos vacíos y los repetidos. Nada que lea el usuario. |  |  |
| `fix.noRight` | Your role cannot stage changes. | Tu rol no puede preparar cambios. |  | stage = preparar (nothing is sent) |
| `fix.notPublished` | Nothing is sent to a store from here. | Desde aquí no se envía nada a una tienda. |  |  |
| `fix.openEditor` | Open the {{field}} editor | Abrir el editor: {{field}} |  |  |
| `fix.partial` | {{done}} of {{total}} were staged. | Se prepararon {{done}} de {{total}}. |  | stage = preparar (nothing is sent) |
| `fix.removedList` | Removed: {{terms}} | Quitado: {{terms}} |  |  |
| `fix.removedTerm` | removed:  | quitado:  |  |  |
| `fix.reviewDescription` | Check the text before and after. Staging adds it to the pending changes; nothing is published until you review and send them. | Comprueba el texto antes y después. Prepararla la añade a los cambios pendientes; nada se publica hasta que los revises y los envíes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `fix.reviewTitleOne` | Review the fix | Revisar la corrección |  | review: reseña (user) vs revisión (App Review) |
| `fix.reviewTitle_one` | Review {{count}} fix | Revisar {{count}} corrección |  | review: reseña (user) vs revisión (App Review) |
| `fix.reviewTitle_other` | Review {{count}} fixes | Revisar {{count}} correcciones |  | review: reseña (user) vs revisión (App Review) |
| `fix.riskReview` | Read before staging | Léela antes de preparar |  | stage = preparar (nothing is sent) |
| `fix.riskSafe` | Changes no wording | No cambia ningún texto |  |  |
| `fix.shortenAi` | Shorten with AI | Acortar con IA |  |  |
| `fix.shortenHint` | Shortening changes the wording, so it is never automatic. The editor shows the limit as you type. | Acortar cambia la redacción, así que nunca es automático. El editor muestra el límite mientras escribes. |  |  |
| `fix.stage` | Stage fix | Preparar corrección |  | stage = preparar (nothing is sent) |
| `fix.stageMany_one` | Stage {{count}} fix | Preparar {{count}} corrección |  | stage = preparar (nothing is sent) |
| `fix.stageMany_other` | Stage {{count}} fixes | Preparar {{count}} correcciones |  | stage = preparar (nothing is sent) |
| `fix.staged` | Fix staged | Corrección preparada |  | stage = preparar (nothing is sent) |
| `fix.textTidy` | Collapse extra spaces | Reducir los espacios sobrantes |  |  |
| `fix.whiteSpace` | Only extra spaces and blank lines change. Every word stays. | Solo cambian los espacios sobrantes y las líneas en blanco. Todas las palabras se quedan. |  |  |
| `matrix.cell.fine` | No problems | Sin problemas |  |  |
| `matrix.cellShort.fine` | No problems | Sin problemas |  |  |
| `matrix.status.noProblems` | No problems found | No se encontraron problemas |  |  |
| `matrixView.cellAriaStaged` | {{column}}, {{locale}}: {{summary}}. {{staged}}. Open the locale. | {{column}}, {{locale}}: {{summary}}. {{staged}}. Abrir el idioma. |  | stage = preparar (nothing is sent) |
| `matrixView.compareOff` | The repository is not compared with the store. Turn on “Compare repository and store” in the app settings to see differences. | El repositorio no se compara con la tienda. Activa «Comparar repositorio y tienda» en los ajustes de la app para ver las diferencias. |  |  |
| `matrixView.discardFailed` | Could not discard the staged change. Try again. | No se pudo descartar el cambio preparado. Inténtalo de nuevo. |  | stage = preparar (nothing is sent) |
| `matrixView.localeStagedAria_one` | {{count}} staged change in {{locale}}. Open it in the pending changes. | {{count}} cambio preparado en {{locale}}. Abrirlo en los cambios pendientes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `matrixView.localeStagedAria_other` | {{count}} staged changes in {{locale}}. Open them in the pending changes. | {{count}} cambios preparados en {{locale}}. Abrirlos en los cambios pendientes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `matrixView.localeStaged_one` | {{count}} staged | {{count}} preparado |  | stage = preparar (nothing is sent) |
| `matrixView.localeStaged_other` | {{count}} staged | {{count}} preparados |  | stage = preparar (nothing is sent) |
| `matrixView.stagedChange` | Staged: {{before}} → {{after}} | Preparado: {{before}} → {{after}} |  | stage = preparar (nothing is sent) |
| `matrixView.stagedEdited` | Edited | Editado |  |  |
| `matrixView.stagedMark` | Edited: a staged value waits in the pending changes. Point at the marker to read the change. | Editado: hay un valor preparado en los cambios pendientes. Señala el marcador para leer el cambio. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `matrixView.stagedNothing` | (nothing) | (nada) |  |  |
| `matrixView.unstagedAnnounce` | Discarded the staged {{label}} ({{locale}}). | Se descartó el cambio preparado de {{label}} ({{locale}}). |  | stage = preparar (nothing is sent) |

## web/portfolio (8)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `activity.feed.analytics` | analytics | analíticas |  |  |
| `activity.feed.other` | other data | otros datos |  |  |
| `activity.feed.releases` | release state | estado de las versiones |  | release = lanzamiento |
| `activity.feed.reviews` | reviews | reseñas |  | review: reseña (user) vs revisión (App Review) |
| `activity.queued_one` | {{count}} more waiting | {{count}} más en espera |  |  |
| `activity.queued_other` | {{count}} more waiting | {{count}} más en espera |  |  |
| `activity.title` | Syncing now | Sincronizando ahora |  |  |
| `activity.unknownApp` | Another app | Otra app |  |  |

## web/products (95)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `price.ack.existingSubscribers` | I know existing subscribers will be moved to the new price. | Sé que los suscriptores actuales pasarán al nuevo precio. |  |  |
| `price.ack.largeAbsolute` | I know a price changes by a large amount of money (limit: {{amount}} units of the currency, more for currencies with small units). | Sé que un precio cambia en una cantidad grande de dinero (límite: {{amount}} unidades de la moneda, más para monedas de unidad pequeña). |  |  |
| `price.ack.largeChange` | I know a price changes by more than {{percent}}%. | Sé que un precio cambia más de un {{percent}} %. |  |  |
| `price.acks` | Confirm each of these | Confirma cada uno de estos puntos |  |  |
| `price.alreadyStaged_one` | A price change for {{count}} territory is staged and waiting in the pending changes. | Un cambio de precio para {{count}} territorio espera en los cambios pendientes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `price.alreadyStaged_other` | A price change for {{count}} territories is staged and waiting in the pending changes. | Un cambio de precio para {{count}} territorios espera en los cambios pendientes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `price.blockRole` | Only an owner or admin can change prices. | Solo un propietario o administrador puede cambiar los precios. |  |  |
| `price.blockServer` | Price changes are switched off on this server. An operator can turn them on with {{env}}. | Los cambios de precio están desactivados en este servidor. Un operador puede activarlos con {{env}}. |  |  |
| `price.blockWorkspace` | Price changes are switched off for this workspace. Turn on the setting {{setting}}. | Los cambios de precio están desactivados para este espacio de trabajo. Activa el ajuste {{setting}}. |  |  |
| `price.caption` | New prices of {{id}} by territory | Nuevos precios de {{id}} por territorio |  |  |
| `price.changedCount_one` | {{count}} territory changed (at most {{max}}). | {{count}} territorio modificado (como máximo {{max}}). |  |  |
| `price.changedCount_other` | {{count}} territories changed (at most {{max}}). | {{count}} territorios modificados (como máximo {{max}}). |  |  |
| `price.colChange` | Change | Variación |  |  |
| `price.colCurrent` | Now | Actual |  |  |
| `price.colNew` | New price | Nuevo precio |  |  |
| `price.convert.amount` | Base price | Precio base |  |  |
| `price.convert.base` | Base region | Región base |  |  |
| `price.convert.done_one` | Filled {{count}} region from Google Play. Check each price. | Se rellenó {{count}} región desde Google Play. Revisa cada precio. |  |  |
| `price.convert.done_other` | Filled {{count}} regions from Google Play. Check each price. | Se rellenaron {{count}} regiones desde Google Play. Revisa cada precio. |  |  |
| `price.convert.go` | Convert | Convertir |  |  |
| `price.convert.help` | Google Play can work out the price of every region from one base price. The numbers are a start: check and edit each one. | Google Play puede calcular el precio de cada región desde un precio base. Los números son un punto de partida: revise y edite cada uno. |  |  |
| `price.convert.needBase` | Type a different base price first. | Escribe primero un precio base distinto. |  |  |
| `price.convert.title` | Convert from one base price | Convertir desde un precio base |  |  |
| `price.date` | Effective date (optional) | Fecha de efecto (opcional) |  |  |
| `price.dateHelp` | Leave empty for as soon as the store allows. Kiln never deletes a price that is already scheduled. | Deja vacío para lo antes que permita la tienda. Kiln nunca borra un precio ya programado. |  |  |
| `price.default` | Default | Predeterminado |  |  |
| `price.delay` | Stores can take a while to show a new price everywhere. Nothing is sent from here: the change is staged, and you review and confirm it in the pending changes. | Las tiendas pueden tardar en mostrar un precio nuevo en todas partes. Desde aquí no se envía nada: el cambio queda pendiente y lo revisa y confirma en los cambios pendientes. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `price.direction.decrease` | down | bajada |  |  |
| `price.direction.increase` | up | subida |  |  |
| `price.direction.same` | no change | sin cambio |  |  |
| `price.edit` | Edit price | Editar precio |  |  |
| `price.failure.network` | Could not reach the server. Nothing was changed. | No se pudo contactar con el servidor. No se cambió nada. |  |  |
| `price.failure.stale` | The product was synced again since you opened it. Reload it and review the prices again. | El producto se sincronizó de nuevo desde que lo abrió. Recárguelo y revise los precios. |  | review: reseña (user) vs revisión (App Review) |
| `price.failure.withNothing` | {{message}} Nothing was sent to the store. | {{message}} No se envió nada a la tienda. |  |  |
| `price.formAria` | Edit the price of {{id}} | Editar el precio de {{id}} |  |  |
| `price.fromTo` | {{from}} to {{to}} | {{from}} a {{to}} |  |  |
| `price.issue.ackRequired` | This change needs an explicit acknowledgement. | Este cambio necesita una confirmación explícita. |  |  |
| `price.issue.ackUnknown` | Not a known acknowledgement. | Confirmación desconocida. |  |  |
| `price.issue.amountNotPricePoint` | Apple only sells at its price points. This amount is not one. | Apple solo vende en sus niveles de precio. Este importe no es uno. |  |  |
| `price.issue.badAmount` | An amount must be whole minor units, such as 499 for 4.99. | Un importe debe ser en unidades menores enteras, por ejemplo 499 para 4,99. |  |  |
| `price.issue.badProduct` | Not a valid product. | Producto no válido. |  |  |
| `price.issue.badTerritory` | Not a territory of this store. | No es un territorio de esta tienda. |  |  |
| `price.issue.currencyMismatch` | The currency is not the currency of that territory. | La moneda no es la de ese territorio. |  |  |
| `price.issue.dateInvalid` | Not a date: use YYYY-MM-DD. | No es una fecha: use AAAA-MM-DD. |  |  |
| `price.issue.datePast` | The date is in the past. | La fecha ya pasó. |  |  |
| `price.issue.dateUnsupported` | This store applies a price when it is sent: it cannot be dated. | Esta tienda aplica el precio al enviarlo: no se puede fechar. |  |  |
| `price.issue.duplicateTerritory` | A territory is named twice. | Un territorio aparece dos veces. |  |  |
| `price.issue.noChange` | The new price is the price the store already shows. | El nuevo precio es el que la tienda ya muestra. |  |  |
| `price.issue.noLines` | Name at least one territory. | Indica al menos un territorio. |  |  |
| `price.issue.notPositive` | A price must be greater than zero. | Un precio debe ser mayor que cero. |  |  |
| `price.issue.other` | This change has an error. | Este cambio tiene un error. |  |  |
| `price.issue.planMissing` | Name the base plan or purchase option. | Indica el plan base o la opción de compra. |  |  |
| `price.issue.planNotAllowed` | This product has no such plan. | Este producto no tiene ese plan. |  |  |
| `price.issue.pricePointMismatch` | The amount is not the amount of that price point. | El importe no es el de ese nivel de precio. |  |  |
| `price.issue.pricePointMissing` | Apple prices are chosen from price points: pick one. | Los precios de Apple se eligen entre niveles de precio: elija uno. |  |  |
| `price.issue.pricePointNotAllowed` | Google Play prices are amounts, not price points. | Los precios de Google Play son importes, no niveles. |  |  |
| `price.issue.pricePointTerritory` | That price point belongs to another territory. | Ese nivel de precio pertenece a otro territorio. |  |  |
| `price.issue.pricePointUnknown` | That price point does not exist for this product. | Ese nivel de precio no existe para este producto. |  |  |
| `price.issue.stalePrice` | The price changed since you looked at it. Sync the app and review again. | El precio cambió desde que lo vio. Sincronice la app y revise de nuevo. |  | review: reseña (user) vs revisión (App Review) |
| `price.issue.subscriberRule` | That choice for existing subscribers does not exist in this store. | Esa opción para los suscriptores actuales no existe en esta tienda. |  |  |
| `price.issue.tooHigh` | That price is above the highest price Kiln allows. | Ese precio supera el máximo que permite Kiln. |  |  |
| `price.issue.tooManyTerritories` | Too many territories in one change. | Demasiados territorios en un solo cambio. |  |  |
| `price.issue.unknownTerritory` | The product has no price in that territory. | El producto no tiene precio en ese territorio. |  |  |
| `price.loadingPoints` | Reading Apple price points... | Leyendo los niveles de precio de Apple... |  |  |
| `price.nearest` | Nearest price points: {{list}}. | Niveles más cercanos: {{list}}. |  |  |
| `price.newFor` | New price for {{territory}} in {{currency}} | Nuevo precio para {{territory}} en {{currency}} |  |  |
| `price.noDate` | Google Play applies a price as soon as it is sent. It cannot be dated. | Google Play aplica el precio al enviarlo. No se puede fechar. |  |  |
| `price.notPoint` | Not an Apple price point. | No es un nivel de precio de Apple. |  |  |
| `price.openCart` | Open pending changes | Abrir los cambios pendientes |  | cart = "Cambios pendientes" |
| `price.plan` | Plan | Plan |  |  |
| `price.problem.empty` | Type a price. | Escribe un precio. |  |  |
| `price.problem.format` | Not a price. Use digits, for example 4.99. | No es un precio. Usa cifras, por ejemplo 4,99. |  |  |
| `price.problem.precision` | {{currency}} does not have that many decimals. Kiln does not round prices. | {{currency}} no tiene tantos decimales. Kiln nunca redondea un precio. |  |  |
| `price.problem.zero` | A price must be greater than zero. | Un precio debe ser mayor que cero. |  |  |
| `price.reload` | Reload the product | Recargar el producto |  |  |
| `price.replaces` | A price change for this product is already staged. Saving replaces it. | Ya hay un cambio de precio pendiente para este producto. Guardar lo reemplaza. |  | stage = preparar (nothing is sent) |
| `price.revenueCatNote` | RevenueCat shows these prices read only. Prices are changed in the store, and RevenueCat picks them up from there. | RevenueCat muestra estos precios solo de lectura. Los precios se cambian en la tienda y RevenueCat los toma de allí. |  |  |
| `price.rule.apply` | Move existing subscribers to the new price | Pasar a los suscriptores actuales al nuevo precio |  |  |
| `price.rule.notApplicable` | Not a subscription | No es una suscripción |  |  |
| `price.rule.optIn` | Ask existing subscribers to accept the new price | Pedir a los suscriptores actuales que acepten el nuevo precio |  |  |
| `price.rule.optOut` | Move existing subscribers unless they decline | Pasar a los suscriptores actuales salvo que lo rechacen |  |  |
| `price.rule.preserve` | Keep existing subscribers at their current price | Mantener a los suscriptores actuales en su precio |  |  |
| `price.ruleHelp.apply` | Existing subscribers move to the new price. The store may notify them or ask for their consent, and some may cancel. | Los suscriptores actuales pasan al nuevo precio. La tienda puede avisarles o pedir su consentimiento, y algunos pueden cancelar. |  |  |
| `price.ruleHelp.optIn` | Existing subscribers keep their price until they accept the new one. Google Play sends the request. | Los suscriptores actuales mantienen su precio hasta que acepten el nuevo. Google Play envía la solicitud. |  |  |
| `price.ruleHelp.optOut` | Existing subscribers move to the new price after Google Play tells them, unless they decline or cancel. | Los suscriptores actuales pasan al nuevo precio tras el aviso de Google Play, salvo que lo rechacen o cancelen. |  |  |
| `price.ruleHelp.preserve` | Only new subscribers pay the new price. This is the safe choice. | Solo los nuevos suscriptores pagan el nuevo precio. Es la opción más segura. |  |  |
| `price.stage` | Add to pending changes | Añadir a los cambios pendientes |  | cart = "Cambios pendientes" |
| `price.stageHelp` | Nothing is sent to the store yet. | Todavía no se envía nada a la tienda. |  |  |
| `price.staged` | Added to pending changes. Nothing is sent to the store until you confirm there. | Añadido a los cambios pendientes. No se envía nada a la tienda hasta que lo confirme allí. |  | cart = "Cambios pendientes" |
| `price.subscribers` | Existing subscribers | Suscriptores actuales |  |  |
| `price.switchOff` | Turn off price changes for this workspace | Desactivar los cambios de precio para este espacio de trabajo |  |  |
| `price.switchOn` | Turn on price changes for this workspace | Activar los cambios de precio para este espacio de trabajo |  |  |
| `price.tooMany` | More than {{max}} territories in one change. | Más de {{max}} territorios en un solo cambio. |  |  |
| `price.usePoint` | Use {{amount}} | Usar {{amount}} |  |  |
| `tab.revenueInInsights` | Subscriptions, MRR and revenue are in Insights. | Suscripciones, MRR e ingresos están en Análisis. |  |  |

## web/ratings (101)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `change.noData` | No ratings in this period | Sin valoraciones en este periodo |  | rating = valoración |
| `change.noPrevious` | Nothing recorded before this period to compare with | No hay registros anteriores a este periodo para comparar |  |  |
| `change.notEnough` | Not enough days with numbers to compare | No hay suficientes días con datos para comparar |  |  |
| `change.oneReading` | Only one reading so far: no change to show yet | Solo hay una lectura por ahora: aún no hay cambio que mostrar |  |  |
| `change.points` | {{text}} points | {{text}} puntos |  |  |
| `change.same_one` | About the same as the previous day | Casi igual que el día anterior |  |  |
| `change.same_other` | About the same as the previous {{count}} days | Casi igual que los {{count}} días anteriores |  |  |
| `change.sinceDay` | {{text}} since {{date}} | {{text}} desde el {{date}} |  |  |
| `change.vsPrevious_one` | {{text}} vs previous day | {{text}} respecto al día anterior |  |  |
| `change.vsPrevious_other` | {{text}} vs previous {{count}} days | {{text}} respecto a los {{count}} días anteriores |  |  |
| `chart.average` | Average rating | Valoración media |  | rating = valoración |
| `chart.lowReviews` | Low-star reviews per day | Reseñas de pocas estrellas por día |  | review: reseña (user) vs revisión (App Review) |
| `compare.average` | Average rating | Valoración media |  | rating = valoración |
| `compare.caption_one` | Ratings and stability by platform, against the previous day | Valoraciones y estabilidad por plataforma, respecto al día anterior |  | rating = valoración |
| `compare.caption_other` | Ratings and stability by platform, against the previous {{count}} days | Valoraciones y estabilidad por plataforma, respecto a los {{count}} días anteriores |  | rating = valoración |
| `compare.change` | Change | Cambio |  |  |
| `compare.count` | Ratings | Valoraciones |  | rating = valoración |
| `compare.crash` | Crash rate | Tasa de fallos |  |  |
| `compare.freeze` | ANR rate | Tasa de ANR |  |  |
| `compare.lowReviews` | Low-star reviews | Reseñas de pocas estrellas |  | review: reseña (user) vs revisión (App Review) |
| `compare.measure` | Measure | Medida |  |  |
| `count.lowSample` | Low sample: read this with care | Muestra pequeña: léelo con cuidado |  |  |
| `count.notGiven` | This store does not give the number of ratings. | Esta tienda no facilita el número de valoraciones. |  | rating = valoración |
| `count.ratings_one` | {{number}} rating | {{number}} valoración |  | rating = valoración |
| `count.ratings_other` | {{number}} ratings | {{number}} valoraciones |  | rating = valoración |
| `count.unknown` | Count not provided | Número no facilitado |  |  |
| `countries.caption` | Ratings by country for {{platform}} | Valoraciones por país de {{platform}} |  | rating = valoración |
| `countries.country` | Country | País |  |  |
| `countries.note` | Kiln reads a few countries per sync, so this is not every country. An average over a small count can swing a lot. | Kiln lee unos pocos países en cada sincronización, así que no son todos. Una media sobre pocas valoraciones puede variar mucho. |  |  |
| `countries.read` | Last read | Última lectura |  |  |
| `empty.android` | Google Play gives the average rating in its reports, but no count and no stars. Turn on the Google Play reports in Overview, Data sources, then Sync. | Google Play da la valoración media en sus informes, pero no el número ni las estrellas. Activa los informes de Google Play en Resumen, Fuentes de datos, y sincroniza. |  | rating = valoración |
| `empty.error` | Could not read the {{platform}} ratings. Try Sync again. | No se pudieron leer las valoraciones de {{platform}}. Vuelve a sincronizar. |  | rating = valoración |
| `empty.ios` | Apple does not provide rating history. Kiln records one point each time it syncs, so the trend starts with the first sync: run Sync (top right) to begin. | Apple no ofrece historial de valoraciones. Kiln guarda un punto en cada sincronización, así que la tendencia empieza con la primera: ejecuta Sincronizar (arriba a la derecha). |  | rating = valoración |
| `empty.loading` | Reading the {{platform}} ratings… | Leyendo las valoraciones de {{platform}}… |  | rating = valoración |
| `finding.better` | {{measure}} went down in version {{version}} | {{measure}} bajó en la versión {{version}} |  |  |
| `finding.detail` | Against version {{previous}}: {{before}}, then {{after}} (from {{from}}). | Frente a la versión {{previous}}: {{before}}, luego {{after}} (desde el {{from}}). |  |  |
| `finding.mentions_one` | {{count}} review since then mentions crashes. | {{count}} reseña desde entonces menciona fallos. |  | review: reseña (user) vs revisión (App Review) |
| `finding.mentions_other` | {{count}} reviews since then mention crashes. | {{count}} reseñas desde entonces mencionan fallos. |  | review: reseña (user) vs revisión (App Review) |
| `finding.worse` | {{measure}} went up in version {{version}} | {{measure}} subió en la versión {{version}} |  |  |
| `note.countDropped` | The number of ratings fell between two readings: stores can remove ratings. That is not counted as new ratings. | El número de valoraciones bajó entre dos lecturas: las tiendas pueden retirar valoraciones. No se cuenta como valoraciones nuevas. |  | rating = valoración |
| `note.gap` | Some days have no reading (no sync): a change between two readings is counted on the later day. | Algunos días no tienen lectura (sin sincronizar): un cambio entre dos lecturas se cuenta en el día posterior. |  |  |
| `note.newUnknown` | New ratings need two readings: they appear after the next sync. | Las valoraciones nuevas necesitan dos lecturas: aparecerán tras la próxima sincronización. |  | rating = valoración |
| `note.noCount` | This store gives neither the number of ratings nor their stars. | Esta tienda no facilita ni el número de valoraciones ni sus estrellas. |  | rating = valoración |
| `note.reset` | The store reset the summary rating in this period: the count starts again from that day. | La tienda reinició la valoración global en este periodo: el recuento empieza de nuevo ese día. |  | rating = valoración |
| `rail.countries` | Countries | Países |  |  |
| `rail.group` | Ratings and health | Valoraciones y salud |  | rating = valoración |
| `rail.label` | Sections of ratings and health | Secciones de valoraciones y salud |  | rating = valoración |
| `rail.ratings` | Ratings | Valoraciones |  | rating = valoración |
| `rail.releases` | Release impact | Efecto de las versiones |  | release = lanzamiento |
| `rail.reviews` | Reviews signal | Señal de las reseñas |  | review: reseña (user) vs revisión (App Review) |
| `rail.stability` | Stability | Estabilidad |  |  |
| `releases.better` | Lower | Más baja |  |  |
| `releases.caption` | Releases of {{platform}} | Versiones de {{platform}} |  | release = lanzamiento |
| `releases.crash` | Crash rate | Tasa de fallos |  |  |
| `releases.crashReviews_one` | {{count}} mentions a crash | {{count}} menciona un fallo |  |  |
| `releases.crashReviews_other` | {{count}} mention crashes | {{count}} mencionan fallos |  |  |
| `releases.day` | First seen | Vista el |  |  |
| `releases.lead` | How stability and the rating moved around each release. A before and after comparison, never proof of cause: other things change at the same time. | Cómo se movieron la estabilidad y la valoración en torno a cada versión. Una comparación de antes y después, nunca prueba de causa: otras cosas cambian a la vez. |  | release = lanzamiento; rating = valoración |
| `releases.legend` | Crash rate: the previous version, then this one. Rating: the 14 days before the release, then 7 to 14 days after it. | Tasa de fallos: la versión anterior y esta. Valoración: los 14 días antes de la versión y de 7 a 14 días después. |  | release = lanzamiento; rating = valoración |
| `releases.noHistory` | No readings | Sin lecturas |  |  |
| `releases.noHistoryTitle` | No readings around this day | Sin lecturas en torno a este día |  |  |
| `releases.rating` | Rating | Valoración |  | rating = valoración |
| `releases.reviews` | Reviews | Reseñas |  | review: reseña (user) vs revisión (App Review) |
| `releases.tooEarly` | Too early | Demasiado pronto |  |  |
| `releases.tooEarlyTitle` | Too early: the release is under 7 days old | Demasiado pronto: la versión tiene menos de 7 días |  | release = lanzamiento |
| `releases.version` | Version | Versión |  |  |
| `releases.worse` | Higher | Más alta |  |  |
| `reviews.empty` | No written reviews in this period for {{platform}}. Sync reviews to read new ones. | No hay reseñas escritas en este periodo para {{platform}}. Sincroniza las reseñas para leer las nuevas. |  | review: reseña (user) vs revisión (App Review) |
| `reviews.lead` | The written reviews Kiln stored in this period. Low means {{max}} stars or fewer. These are reviews with text, not every rating. | Las reseñas escritas que Kiln guardó en este periodo. Pocas estrellas significa {{max}} o menos. Son reseñas con texto, no todas las valoraciones. |  | review: reseña (user) vs revisión (App Review); rating = valoración |
| `reviews.lowOf_one` | {{low}} of {{count}} review | {{low}} de {{count}} reseña |  | review: reseña (user) vs revisión (App Review) |
| `reviews.lowOf_other` | {{low}} of {{count}} reviews | {{low}} de {{count}} reseñas |  | review: reseña (user) vs revisión (App Review) |
| `reviews.open` | Open the low-star reviews | Abrir las reseñas de pocas estrellas |  | review: reseña (user) vs revisión (App Review) |
| `since.android` | Google Play gives no rating history through its API: this trend comes from its daily reports, as recorded since {{date}}. | Google Play no da historial por su API: esta tendencia sale de sus informes diarios, guardados desde el {{date}}. |  | rating = valoración |
| `since.ios` | Apple gives no rating history: Kiln records one point per sync, from {{date}}. Earlier days are not available. | Apple no da historial: Kiln guarda un punto por sincronización, desde el {{date}}. Los días anteriores no están disponibles. |  | rating = valoración |
| `since.oneReading` | Only one reading so far, so there is no trend yet. A point is added at each sync. | Solo hay una lectura por ahora, así que aún no hay tendencia. Se añade un punto en cada sincronización. |  |  |
| `stability.coverage_one` | Only {{days}} of the last day has numbers. | Solo {{days}} del último día tiene datos. |  |  |
| `stability.coverage_other` | Only {{days}} of the last {{count}} days have numbers. | Solo {{days}} de los últimos {{count}} días tienen datos. |  |  |
| `stability.error` | The last read of the {{platform}} crash numbers failed. Open data sources for the reason, then Sync. | Falló la última lectura de los datos de fallos de {{platform}}. Abre las fuentes de datos para ver el motivo y sincroniza. |  |  |
| `stability.noneAndroid` | No crash or ANR numbers for {{platform}} yet. They come from Android vitals (the Play Developer Reporting API): turn them on in data sources, then Sync. | Aún no hay datos de fallos ni de ANR de {{platform}}. Vienen de Android vitals (API Play Developer Reporting): actívalos en las fuentes de datos y sincroniza. |  |  |
| `stability.noneIos` | No crash numbers for {{platform}} yet. Apple sends them with App Analytics, for people who opted in, and only for days with at least five crashing users. Turn on analytics, then Sync. | Aún no hay datos de fallos de {{platform}}. Apple los envía con App Analytics, solo de quien lo aceptó y solo los días con al menos cinco usuarios afectados. Activa los análisis y sincroniza. |  |  |
| `stability.noteAndroid` | Google Play reports the share of users with a crash or an ANR, for users who opted in. | Google Play indica la proporción de usuarios con un fallo o un ANR, entre quienes lo aceptaron. |  |  |
| `stability.noteIos` | Apple counts only people who shared analytics, and sends crash numbers only for days with at least five crashing users: a day without a number is not a day without crashes. | Apple solo cuenta a quien comparte análisis y solo envía fallos de los días con al menos cinco usuarios afectados: un día sin dato no es un día sin fallos. |  |  |
| `stability.openSources` | Open data sources | Abrir las fuentes de datos |  |  |
| `stability.setup` | Crash numbers for {{platform}} are not set up yet: the store source behind them is off or needs a permission. | Los datos de fallos de {{platform}} aún no están configurados: la fuente de la tienda está desactivada o necesita un permiso. |  |  |
| `stars.label_one` | {{count}} star | {{count}} estrella |  |  |
| `stars.label_other` | {{count}} stars | {{count}} estrellas |  |  |
| `stars.title_one` | New ratings by stars ({{count}} rating) | Valoraciones nuevas por estrellas ({{count}} valoración) |  | rating = valoración |
| `stars.title_other` | New ratings by stars ({{count}} ratings) | Valoraciones nuevas por estrellas ({{count}} valoraciones) |  | rating = valoración |
| `tile.average` | Average rating | Valoración media |  | rating = valoración |
| `tile.averageTitle` | The rating the store shows now, from the latest reading Kiln made | La valoración que muestra la tienda ahora, según la última lectura de Kiln |  | rating = valoración |
| `tile.count` | Ratings | Valoraciones |  | rating = valoración |
| `tile.countTitle` | How many people rated the app, from the latest reading | Cuántas personas han valorado la app, según la última lectura |  |  |
| `tile.crash` | Crash rate | Tasa de fallos |  |  |
| `tile.freeze` | ANR rate | Tasa de ANR |  |  |
| `tile.lowReviews` | Low-star reviews | Reseñas de pocas estrellas |  | review: reseña (user) vs revisión (App Review) |
| `tile.lowTitle` | Written reviews with {{max}} stars or fewer | Reseñas escritas con {{max}} estrellas o menos |  | review: reseña (user) vs revisión (App Review) |
| `tile.new` | New ratings | Valoraciones nuevas |  | rating = valoración |
| `tile.newTitle` | Ratings added in this period: the difference between two readings of the store | Valoraciones añadidas en este periodo: la diferencia entre dos lecturas de la tienda |  | rating = valoración |
| `tile.rateTitle` | Mean of the {{days}} days with numbers in this period | Media de los {{days}} días con datos en este periodo |  |  |
| `tile.reviews` | Written reviews | Reseñas escritas |  | review: reseña (user) vs revisión (App Review) |
| `tile.reviewsTitle` | Reviews with text that Kiln stored in this period (not the same as ratings) | Reseñas con texto que Kiln guardó en este periodo (no es lo mismo que las valoraciones) |  | review: reseña (user) vs revisión (App Review); rating = valoración |

## web/release-stepper (57)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `ap.allStaged` | All the store asset changes of the repository are in your pending changes. | Todos los cambios de la ficha del repositorio están en tus cambios pendientes. |  | cart = "Cambios pendientes" |
| `ap.checking` | Checking the repository for changed store assets | Buscando en el repositorio los elementos de la ficha modificados |  |  |
| `ap.confirm.body_one` | {{count}} of the selected items has errors. A store may refuse it when the changes are published. Stage it anyway? | {{count}} de los elementos seleccionados tiene errores. Una tienda puede rechazarlo cuando se publiquen los cambios. ¿Prepararlo de todos modos? |  | stage = preparar (nothing is sent) |
| `ap.confirm.body_other` | {{count}} of the selected items have errors. A store may refuse them when the changes are published. Stage them anyway? | {{count}} de los elementos seleccionados tienen errores. Una tienda puede rechazarlos cuando se publiquen los cambios. ¿Prepararlos de todos modos? |  | stage = preparar (nothing is sent) |
| `ap.confirm.title` | Stage items that have errors? | ¿Preparar elementos que tienen errores? |  | stage = preparar (nothing is sent) |
| `ap.confirm.yes` | Stage anyway | Preparar de todos modos |  | stage = preparar (nothing is sent) |
| `ap.doneFailed_one` | {{count}} item could not be staged. | No se pudo preparar {{count}} elemento. |  | stage = preparar (nothing is sent) |
| `ap.doneFailed_other` | {{count}} items could not be staged. | No se pudieron preparar {{count}} elementos. |  | stage = preparar (nothing is sent) |
| `ap.doneLeft_one` | {{count}} item was already staged and was left as it is. | {{count}} elemento ya estaba preparado y se dejó tal cual. |  | stage = preparar (nothing is sent) |
| `ap.doneLeft_other` | {{count}} items were already staged and were left as they are. | {{count}} elementos ya estaban preparados y se dejaron tal cual. |  | stage = preparar (nothing is sent) |
| `ap.done_one` | {{count}} item staged. Nothing was sent to a store. | {{count}} elemento preparado. No se envió nada a una tienda. |  | stage = preparar (nothing is sent) |
| `ap.done_other` | {{count}} items staged. Nothing was sent to a store. | {{count}} elementos preparados. No se envió nada a una tienda. |  | stage = preparar (nothing is sent) |
| `ap.issues.errorWord` | Error | Error |  |  |
| `ap.issues.errors_one` | {{count}} error | {{count}} error |  |  |
| `ap.issues.errors_other` | {{count}} errors | {{count}} errores |  |  |
| `ap.issues.none` | No problems found in these texts and graphics. | No se encontraron problemas en estos textos y gráficos. |  |  |
| `ap.issues.tipWord` | Tip | Consejo |  |  |
| `ap.issues.tips_one` | {{count}} tip | {{count}} consejo |  |  |
| `ap.issues.tips_other` | {{count}} tips | {{count}} consejos |  |  |
| `ap.issues.title` | Checked before you stage | Comprobado antes de preparar |  | stage = preparar (nothing is sent) |
| `ap.issues.warningWord` | Warning | Advertencia |  |  |
| `ap.issues.warnings_one` | {{count}} warning | {{count}} advertencia |  |  |
| `ap.issues.warnings_other` | {{count}} warnings | {{count}} advertencias |  |  |
| `ap.item.empty` | nothing | nada |  |  |
| `ap.item.hasIssues` | Has issues | Tiene problemas |  |  |
| `ap.item.repo` | Repository | Repositorio |  |  |
| `ap.item.selectAria` | Stage {{item}} ({{locale}}) | Preparar {{item}} ({{locale}}) |  | stage = preparar (nothing is sent) |
| `ap.item.store` | Store | Tienda |  |  |
| `ap.items.title` | Changes to stage | Cambios para preparar |  | stage = preparar (nothing is sent) |
| `ap.later` | Remind me later | Recuérdamelo más tarde |  |  |
| `ap.laterLine_one` | {{count}} store asset change is waiting for your decision. | {{count}} cambio de la ficha espera tu decisión. |  |  |
| `ap.laterLine_other` | {{count}} store asset changes are waiting for your decision. | {{count}} cambios de la ficha esperan tu decisión. |  |  |
| `ap.lead` | Texts and graphics that changed in the repository since the previous release and still differ from the store. Staging only adds them to your pending changes: nothing is sent to a store. | Textos y gráficos que cambiaron en el repositorio desde la versión anterior y aún difieren de la tienda. Prepararlos solo los añade a tus cambios pendientes: no se envía nada a una tienda. |  | cart = "Cambios pendientes"; stage = preparar (nothing is sent) |
| `ap.loadFailed` | Could not check the repository for changed store assets | No se pudo buscar en el repositorio los elementos de la ficha modificados |  |  |
| `ap.locked` | The listing is locked: a version is live or in App Review. Prepare a new version first, then these changes can be staged. | La ficha está bloqueada: hay una versión publicada o en revisión. Prepara primero una versión nueva y después se podrán preparar estos cambios. |  | stage = preparar (nothing is sent); listing = ficha |
| `ap.notListed` | Not listed: {{unchanged}} unchanged since the last release, {{same}} identical to the store, {{other}} that cannot be staged (for example the App Store name and subtitle). | No listados: {{unchanged}} sin cambios desde la última versión, {{same}} idénticos a la tienda, {{other}} que no se pueden preparar (por ejemplo el nombre y el subtítulo de App Store). |  | stage = preparar (nothing is sent); release = lanzamiento |
| `ap.openCart` | Open pending changes | Abrir los cambios pendientes |  | cart = "Cambios pendientes" |
| `ap.refs` | Compared: the previous release ({{base}}) with this release ({{target}}). | Comparado: la versión anterior ({{base}}) con esta versión ({{target}}). |  | release = lanzamiento |
| `ap.refsBranch` | Compared: the previous release ({{base}}) with the default branch ({{target}}), because no build is chosen for this release yet. | Comparado: la versión anterior ({{base}}) con la rama por defecto ({{target}}), porque aún no hay un build elegido para esta versión. |  | release = lanzamiento |
| `ap.refsNoBase` | No previous release found: everything in the repository ({{target}}) that differs from the store is listed. | No se encontró una versión anterior: se lista todo lo del repositorio ({{target}}) que difiere de la tienda. |  | release = lanzamiento |
| `ap.review` | Review | Revisar |  | review: reseña (user) vs revisión (App Review) |
| `ap.show` | Show again | Mostrar de nuevo |  |  |
| `ap.skip` | Skip for this release | Omitir para esta versión |  | release = lanzamiento |
| `ap.skippedLine` | Store asset changes skipped for this release. | Cambios de la ficha omitidos para esta versión. |  | release = lanzamiento |
| `ap.stage` | Stage selected ({{count}}) | Preparar la selección ({{count}}) |  | stage = preparar (nothing is sent) |
| `ap.staged.edited` | Already staged with your edit, kept as it is | Ya preparado con tu edición, se conserva tal cual |  | stage = preparar (nothing is sent) |
| `ap.staged.same` | Already staged | Ya preparado |  | stage = preparar (nothing is sent) |
| `ap.staged.title` | Already in your pending changes | Ya están en tus cambios pendientes |  | cart = "Cambios pendientes" |
| `ap.storeUnread` | The graphics in the store could not be read, so graphics are listed by what changed in the repository alone. | No se pudieron leer los gráficos de la tienda, así que los gráficos se listan solo por lo que cambió en el repositorio. |  |  |
| `ap.sum.graphics_one` | {{count}} graphics set | {{count}} conjunto de gráficos |  |  |
| `ap.sum.graphics_other` | {{count}} graphics sets | {{count}} conjuntos de gráficos |  |  |
| `ap.sum.locales_one` | in {{count}} language | en {{count}} idioma |  |  |
| `ap.sum.locales_other` | in {{count}} languages | en {{count}} idiomas |  |  |
| `ap.sum.texts_one` | {{count}} text | {{count}} texto |  |  |
| `ap.sum.texts_other` | {{count}} texts | {{count}} textos |  |  |
| `ap.title` | Store assets changed in the repository | Elementos de la ficha modificados en el repositorio |  |  |
| `ap.truncated` | Only the first items are listed. | Solo se listan los primeros elementos. |  |  |

## web/reviews (24)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `ai.regenerate` | Summarise again | Resumir de nuevo |  |  |
| `ai.staleMany_one` | More than {{count}} review came in after this summary. Summarise again to include them. | Han llegado más de {{count}} reseñas después de este resumen. Resume de nuevo para incluirlas. |  | review: reseña (user) vs revisión (App Review) |
| `ai.staleMany_other` | {{count}} or more reviews came in after this summary. Summarise again to include them. | Han llegado {{count}} o más reseñas después de este resumen. Resume de nuevo para incluirlas. |  | review: reseña (user) vs revisión (App Review) |
| `ai.stale_one` | {{count}} review came in after this summary. Summarise again to include it. | Ha llegado {{count}} reseña después de este resumen. Resume de nuevo para incluirla. |  | review: reseña (user) vs revisión (App Review) |
| `ai.stale_other` | {{count}} reviews came in after this summary. Summarise again to include them. | Han llegado {{count}} reseñas después de este resumen. Resume de nuevo para incluirlas. |  | review: reseña (user) vs revisión (App Review) |
| `ai.summaryNotice` | A summary reads at most {{reviews}} reviews of the period (the newest and some of the lowest-rated), {{chars}} characters each. Names, emails, links and phone numbers are removed; the reviewer, the device and the country are never sent. The same reviews reuse the stored summary. | Un resumen lee como máximo {{reviews}} reseñas del periodo (las más recientes y algunas de las peor valoradas), de {{chars}} caracteres cada una. Se quitan nombres, correos, enlaces y teléfonos; nunca se envía el autor, el dispositivo ni el país. Las mismas reseñas reutilizan el resumen guardado. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.actions` | Actions | Acciones |  |  |
| `competitors.app` | App | App |  |  |
| `competitors.average` | Average | Media |  |  |
| `competitors.caption` | Reviews of this app and of the followed competitors | Reseñas de esta app y de los competidores seguidos |  | review: reseña (user) vs revisión (App Review) |
| `competitors.count` | Reviews | Reseñas |  | review: reseña (user) vs revisión (App Review) |
| `competitors.lead` | Public App Store reviews of the competitors you follow, read from Apple's customer reviews feed when you press Read and kept for {{days}} days. The reviewer is never stored. Nothing here is sent to an AI model. | Reseñas públicas de la App Store de los competidores que sigues, leídas del feed de reseñas de clientes de Apple al pulsar Leer y guardadas {{days}} días. El autor nunca se guarda. Nada de esto se envía a un modelo de IA. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.noneFollowed` | No competitors followed yet. Follow an App Store app in the ASO competitors list, then read its reviews here. | Aún no sigues a ningún competidor. Sigue una app de la App Store en la lista de competidores ASO y lee aquí sus reseñas. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.periodLabel` | Period of the comparison | Periodo de la comparación |  |  |
| `competitors.playNote` | Google Play competitors are not available: Google offers no official way to read the reviews of an app you do not own, and Kiln does not scrape its pages. | Los competidores de Google Play no están disponibles: Google no ofrece una forma oficial de leer las reseñas de una app que no es tuya, y Kiln no extrae sus páginas. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.read` | Read | Leer |  |  |
| `competitors.readAt` | read {{time}} | leído {{time}} |  |  |
| `competitors.readDone_one` | {{count}} review stored. | {{count}} reseña guardada. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.readDone_other` | {{count}} reviews stored. | {{count}} reseñas guardadas. |  | review: reseña (user) vs revisión (App Review) |
| `competitors.recent` | Read a few minutes ago: nothing new was asked of the App Store. | Leído hace unos minutos: no se ha pedido nada nuevo a la App Store. |  |  |
| `competitors.thisApp` | This app | Esta app |  |  |
| `competitors.title` | Competitors | Competidores |  |  |
| `competitors.trend` | First half, second half | Primera mitad, segunda mitad |  |  |
| `competitors.unavailable` | Not available for Google Play. | No disponible para Google Play. |  |  |

## web/settings (31)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `group.ai` | AI | IA |  |  |
| `group.integrations` | Integrations | Integraciones |  |  |
| `group.personal` | Just for you | Solo para ti |  |  |
| `group.security` | Security | Seguridad |  |  |
| `group.workspace` | Workspace | Espacio de trabajo |  |  |
| `keywords.ai` | assistant model key provider monthly limit openai anthropic | asistente modelo clave proveedor límite mensual openai anthropic |  |  |
| `keywords.analytics` | opt-in vendor number apple play bucket reports | opt-in número de proveedor apple play bucket informes |  |  |
| `keywords.chat` | slack teams webhook channel notifications digest alerts routing | slack teams webhook canal notificaciones resumen alertas enrutamiento |  |  |
| `keywords.confirm` | hard actions step-up password recovery codes confirm | acciones críticas reautenticación contraseña códigos de recuperación confirmar |  |  |
| `keywords.language` | locale french spanish german english display | idioma configuración regional francés español alemán inglés pantalla |  |  |
| `keywords.mail` | smtp email server host port sender | smtp correo servidor host puerto remitente |  |  |
| `keywords.mcp` | mcp connect assistant claude tools token | mcp conectar asistente claude herramientas token |  |  |
| `keywords.releases` | unfinished release days stuck reminder | versión sin terminar días bloqueada recordatorio |  | release = lanzamiento |
| `keywords.reviews` | ratings low rating threshold reminder unanswered replies | valoraciones reseñas umbral valoración baja recordatorio sin responder respuestas |  | rating = valoración |
| `keywords.secondFactor` | two-factor 2fa authenticator totp email code | doble factor 2fa autenticador totp correo código |  |  |
| `keywords.storeRefresh` | sync interval schedule refresh stores alerts review state | sincronización intervalo programación actualización tiendas alertas estado de revisión |  | review: reseña (user) vs revisión (App Review) |
| `keywords.translation` | translate provider deepl google target language budget | traducción proveedor deepl google idioma de destino presupuesto |  |  |
| `keywords.webhooks` | http callback events signing endpoint | http devolución de llamada eventos firma punto final |  |  |
| `nav.label` | Settings sections | Secciones de los ajustes |  |  |
| `nav.noMatch` | No section matches “{{query}}”. | Ninguna sección coincide con «{{query}}». |  |  |
| `nav.search` | Search settings | Buscar ajustes |  |  |
| `nav.searchLabel` | Search the settings sections | Buscar en las secciones de los ajustes |  |  |
| `nav.unsaved` | Unsaved changes | Cambios sin guardar |  |  |
| `nav.unsavedWithLink` | You have unsaved workspace changes. They stay until you save or discard them there. <link>Go to the workspace settings</link>. | Tienes cambios sin guardar en el espacio de trabajo. Se conservan hasta que los guardes o los descartes allí. <link>Ir a los ajustes del espacio de trabajo</link>. |  |  |
| `page.otherSectionAnalytics` | A value in Analytics is not valid. Fix it there, then save. | Un valor de la sección Analíticas no es válido. Corrígelo allí y guarda. |  |  |
| `page.otherSectionWorkspace` | A value in another workspace section is not valid. Fix it there, then save. | Un valor de otra sección del espacio de trabajo no es válido. Corrígelo allí y guarda. |  |  |
| `section.ai` | AI assistant | Asistente de IA |  |  |
| `section.analytics` | Analytics | Analíticas |  |  |
| `section.chat` | Slack and Teams | Slack y Teams |  |  |
| `section.language` | Language | Idioma |  |  |
| `section.mcp` | Connect an AI assistant | Conectar un asistente de IA |  |  |

## web/shell (4)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `nav.chat` | Slack and Teams | Slack y Teams |  |  |
| `nav.collapse` | Collapse the navigation to icons | Reducir la navegación a iconos |  |  |
| `nav.expand` | Expand the navigation | Expandir la navegación |  |  |
| `shortcut.any.sidebar` | Fold or unfold the left panel | Plegar o desplegar el panel izquierdo |  |  |

## web/testflight (130)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `build.both` | {{version}} (build {{build}}) | {{version}} (compilación {{build}}) |  |  |
| `build.number` | Build {{build}} | Compilación {{build}} |  |  |
| `build.unknown` | Unknown build | Compilación desconocida |  |  |
| `connection.mobileData` | Mobile data | Datos móviles |  |  |
| `connection.none` | No connection | Sin conexión |  |  |
| `connection.unknown` | Unknown | Desconocida |  |  |
| `connection.wifi` | Wi-Fi | Wi-Fi |  |  |
| `connection.wire` | Wired | Por cable |  |  |
| `console.body` | Screenshots are not shown here (the page does not load images from other sites). Open them from the detail, or in App Store Connect, under TestFlight, Feedback. | Las capturas de pantalla no se muestran aquí (la página no carga imágenes de otros sitios). Ábrelas desde el detalle, o en App Store Connect, en TestFlight, Feedback. |  |  |
| `console.title` | The full list is also in App Store Connect | La lista completa también está en App Store Connect |  |  |
| `crash.copy` | Copy the log | Copiar el registro |  |  |
| `crash.heading` | Crash log | Registro del cierre inesperado |  |  |
| `crash.hide` | Hide the log | Ocultar el registro |  |  |
| `crash.missing` | Apple has no crash log for this submission. | Apple no tiene registro para este envío. |  | submit = enviar |
| `crash.noLog` | The crash log has not been read yet. It is read by the next sync. | El registro todavía no se ha leído. La próxima sincronización lo leerá. |  |  |
| `crash.noteAddresses` | The first frame is an address, not a name: this log is probably not symbolicated. Symbolicate it with the dSYM of the build. | El primer marco es una dirección, no un nombre: este registro probablemente no está simbolizado. Simbolízalo con el dSYM de la compilación. |  |  |
| `crash.noteSymbols` | The first frame has a name. The rest of the log is shown as Apple gave it; Kiln does not check whether every frame is symbolicated. | El primer marco tiene nombre. El resto del registro se muestra tal como lo dio Apple; Kiln no comprueba si cada marco está simbolizado. |  |  |
| `crash.noteUnknown` | Kiln could not read the layout of this log. It is shown as Apple gave it, and may or may not be symbolicated. | Kiln no pudo leer el formato de este registro. Se muestra tal como lo dio Apple y puede estar simbolizado o no. |  |  |
| `crash.show` | Show the log | Mostrar el registro |  |  |
| `crash.signature` | Signature | Firma |  |  |
| `crash.signatureHint` | Kiln groups crashes by the exception and the first frame of the crashed thread. | Kiln agrupa los cierres por la excepción y el primer marco del hilo que falló. |  |  |
| `crash.truncated` | The log was cut at 64 KB. | El registro se cortó a 64 KB. |  |  |
| `detail.assignee` | Assignee | Asignado a |  |  |
| `detail.changedBy` | Changed {{ago}} | Cambiado {{ago}} |  |  |
| `detail.close` | Close | Cerrar |  |  |
| `detail.comment` | Comment | Comentario |  |  |
| `detail.deviceHeading` | Tester and device | Probador y dispositivo |  |  |
| `detail.emailHidden` | The email address is shown to administrators only. | El correo electrónico solo lo ven los administradores. |  |  |
| `detail.formerMember` | A former member | Un antiguo miembro |  |  |
| `detail.loadError` | The details could not be read. | No se pudieron leer los detalles. |  |  |
| `detail.loading` | Reading the details | Leyendo los detalles |  |  |
| `detail.nobody` | Nobody | Nadie |  |  |
| `detail.note` | Internal note | Nota interna |  |  |
| `detail.noteHint` | Only your team sees it. It is never sent to Apple. | Solo la ve tu equipo. Nunca se envía a Apple. |  |  |
| `detail.save` | Save | Guardar |  |  |
| `detail.saveFailed` | The change could not be saved. | No se pudo guardar el cambio. |  |  |
| `detail.saved` | Saved. | Guardado. |  |  |
| `detail.screenshotsCount_one` | {{count}} screenshot. Apple's links expire after a short time, so they are read when you ask. | {{count}} captura de pantalla. Los enlaces de Apple caducan pronto, así que se leen cuando los pides. |  |  |
| `detail.screenshotsCount_other` | {{count}} screenshots. Apple's links expire after a short time, so they are read when you ask. | {{count}} capturas de pantalla. Los enlaces de Apple caducan pronto, así que se leen cuando los pides. |  |  |
| `detail.screenshotsExpire` | The links expire {{when}}. Ask again if they stopped working. | Los enlaces caducan {{when}}. Pídelos de nuevo si dejan de funcionar. |  |  |
| `detail.screenshotsFailed` | The screenshot links could not be read. | No se pudieron leer los enlaces de las capturas. |  |  |
| `detail.screenshotsHeading` | Screenshots | Capturas de pantalla |  |  |
| `detail.screenshotsLoad` | Get the screenshot links | Obtener los enlaces de las capturas |  |  |
| `detail.screenshotsNoLinks` | Apple gave no link for this feedback. It may have been deleted in App Store Connect. | Apple no dio ningún enlace para este comentario. Puede que se haya borrado en App Store Connect. |  |  |
| `detail.screenshotsNone` | This feedback has no screenshot. | Este comentario no tiene captura de pantalla. |  |  |
| `detail.screenshotsOpen` | Open screenshot {{number}} | Abrir la captura {{number}} |  |  |
| `detail.status` | Status | Estado |  |  |
| `detail.tester` | Tester | Probador |  |  |
| `detail.title` | Details | Detalles |  |  |
| `detail.triageHeading` | Triage | Clasificación |  |  |
| `empty.crashDescription` | No tester has sent a crash report yet, or none matches the filters. Good news, if you have testers. | Ningún probador ha enviado un informe de cierre inesperado, o ninguno coincide con los filtros. Buena noticia, si tienes probadores. |  |  |
| `empty.crashTitle` | No crashes | Sin cierres inesperados |  |  |
| `empty.feedbackDescription` | No tester has sent feedback with a screenshot yet, or none matches the filters. Testers send it from TestFlight: take a screenshot, then Share Beta Feedback. | Ningún probador ha enviado comentarios con captura de pantalla, o ninguno coincide con los filtros. Los probadores los envían desde TestFlight: captura de pantalla y luego Compartir comentarios beta. |  |  |
| `empty.feedbackTitle` | No feedback | Sin comentarios |  |  |
| `empty.neverDescription` | Sync to read the feedback and crashes your testers sent from TestFlight. The app must have been distributed with TestFlight, and the App Store Connect key needs the Admin, App Manager or Developer role. | Sincroniza para leer los comentarios y los cierres inesperados que tus probadores enviaron desde TestFlight. La app debe haberse distribuido con TestFlight y la clave de App Store Connect necesita el rol Admin, App Manager o Developer. |  |  |
| `empty.neverTitle` | Nothing read yet | Aún no se ha leído nada |  |  |
| `fact.architecture` | Architecture | Arquitectura |  |  |
| `fact.battery` | Battery | Batería |  |  |
| `fact.bundle` | Bundle id | ID de bundle |  |  |
| `fact.connection` | Connection | Conexión |  |  |
| `fact.device` | Device | Dispositivo |  |  |
| `fact.disk` | Free disk space | Espacio libre en disco |  |  |
| `fact.diskValue` | {{free}} of {{total}} | {{free}} de {{total}} |  |  |
| `fact.family` | Device family | Familia de dispositivos |  |  |
| `fact.locale` | Language | Idioma |  |  |
| `fact.screen` | Screen (points) | Pantalla (puntos) |  |  |
| `fact.sent` | Sent | Enviado |  |  |
| `fact.timeZone` | Time zone | Zona horaria |  |  |
| `fact.uptime` | App uptime | Tiempo de ejecución de la app |  |  |
| `fact.watch` | Paired watch | Reloj emparejado |  |  |
| `filter.all` | All | Todos |  |  |
| `filter.build` | Build | Compilación |  |  |
| `filter.clear` | Clear filters | Quitar los filtros |  |  |
| `filter.label` | Filters | Filtros |  |  |
| `filter.open` | Open | Abiertos |  |  |
| `filter.signature` | Showing one crash group | Se muestra un solo grupo de cierres |  |  |
| `filter.status` | Status | Estado |  |  |
| `filter.tester` | Tester | Probador |  |  |
| `filter.version` | Version | Versión |  |  |
| `groups.builds` | Builds: {{builds}} | Compilaciones: {{builds}} |  |  |
| `groups.byBuild` | By build | Por compilación |  |  |
| `groups.bySignature` | By signature | Por firma |  |  |
| `groups.count_one` | {{count}} crash | {{count}} cierre |  |  |
| `groups.count_other` | {{count}} crashes | {{count}} cierres |  |  |
| `groups.heading` | Crashes by build and by signature | Cierres por compilación y por firma |  |  |
| `groups.loadError` | The groups could not be read. | No se pudieron leer los grupos. |  |  |
| `groups.open` | {{count}} open | {{count}} abiertos |  |  |
| `groups.show` | Show these crashes | Mostrar estos cierres |  |  |
| `groups.unknown` | No signature (log not read, or an unknown layout) | Sin firma (registro no leído o formato desconocido) |  |  |
| `kind.crash` | Crashes | Cierres inesperados |  |  |
| `kind.feedback` | Feedback | Comentarios |  |  |
| `list.colBuild` | Build | Compilación |  |  |
| `list.colComment` | Comment | Comentario |  |  |
| `list.colSent` | Sent | Enviado |  |  |
| `list.colStatus` | Status | Estado |  |  |
| `list.colTester` | Tester | Probador |  |  |
| `list.more` | Load more | Cargar más |  |  |
| `list.noComment` | No comment | Sin comentario |  |  |
| `list.screenshots_one` | {{count}} screenshot | {{count}} captura de pantalla |  |  |
| `list.screenshots_other` | {{count}} screenshots | {{count}} capturas de pantalla |  |  |
| `status.ignored` | Ignored | Ignorado |  |  |
| `status.inProgress` | In progress | En curso |  |  |
| `status.new` | New | Nuevo |  |  |
| `status.resolved` | Resolved | Resuelto |  |  |
| `status.seen` | Seen | Visto |  |  |
| `sync.failedKept` | The last read failed ({{error}}). What is shown was read {{ago}}. | La última lectura falló ({{error}}). Lo que se muestra se leyó {{ago}}. |  |  |
| `sync.failedNothing` | The last read failed: {{error}} | La última lectura falló: {{error}} |  |  |
| `sync.never` | Never read. Sync to read the TestFlight feedback. | Nunca leído. Sincroniza para leer los comentarios de TestFlight. |  |  |
| `sync.partial` | Read {{ago}}, but only the newest submissions: Apple may have older ones. | Leído {{ago}}, pero solo los envíos más recientes: Apple puede tener más antiguos. |  | submit = enviar |
| `sync.read` | Read {{ago}}. | Leído {{ago}}. |  |  |
| `tab.about` | About this view | Acerca de esta vista |  |  |
| `tab.aboutBody` | Kiln reads the feedback and crash reports your testers send from TestFlight, keeps a copy here, and lets your team triage them. It never deletes or changes anything in App Store Connect. | Kiln lee los comentarios y los informes de cierre inesperado que tus probadores envían desde TestFlight, guarda una copia aquí y permite a tu equipo clasificarlos. Nunca borra ni cambia nada en App Store Connect. |  |  |
| `tab.aboutRequirements` | Needed: the app has been distributed with TestFlight, and its App Store Connect key has the Admin, App Manager or Developer role. | Requisitos: la app se ha distribuido con TestFlight y la clave de App Store Connect tiene el rol Admin, App Manager o Developer. |  |  |
| `tab.aboutRetention` | Apple keeps feedback for about a year and crash logs for 120 days; Kiln keeps what it has read until the retention of the workspace. | Apple conserva los comentarios cerca de un año y los registros de cierre 120 días; Kiln conserva lo que ha leído hasta el límite de conservación del espacio de trabajo. |  |  |
| `tab.headlineCount` | {{feedback}} feedback and {{crashes}} crashes from your testers | {{feedback}} comentarios y {{crashes}} cierres inesperados de tus probadores |  |  |
| `tab.headlineDefault` | TestFlight feedback and crashes | Comentarios y cierres inesperados de TestFlight |  |  |
| `tab.headlineNone` | No TestFlight feedback yet | Aún no hay comentarios de TestFlight |  |  |
| `tab.kinds` | Kind of submission | Tipo de envío |  | submit = enviar |
| `tab.leadHint` | What your beta testers send from TestFlight, next to the customer reviews. | Lo que tus probadores envían desde TestFlight, junto a las reseñas de clientes. |  | review: reseña (user) vs revisión (App Review) |
| `tab.listLabel` | {{kind}} of {{app}} | {{kind}} de {{app}} |  |  |
| `tab.loadError` | The feedback could not be read. | No se pudieron leer los comentarios. |  |  |
| `tab.loadErrorTitle` | The feedback could not be read | No se pudieron leer los comentarios |  |  |
| `tab.openConsole` | Open in App Store Connect | Abrir en App Store Connect |  |  |
| `tab.partsTitle` | Some of it could not be read | No se pudo leer una parte |  |  |
| `tab.reading` | Reading the feedback | Leyendo los comentarios |  |  |
| `tab.syncFailedTitle` | The sync failed | La sincronización falló |  |  |
| `tester.anonymous` | Anonymous tester | Probador anónimo |  |  |
| `tester.code` | Tester {{code}} | Probador {{code}} |  |  |
| `unsupported.body` | Google Play has no TestFlight. Beta feedback of Android testers is read in the Play Console. | Google Play no tiene TestFlight. Los comentarios de los probadores de Android se leen en la Play Console. |  |  |
| `unsupported.title` | TestFlight is for App Store Connect apps | TestFlight es para apps de App Store Connect |  |  |

## web/timeline (150)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `add.app` | Platform | Plataforma |  |  |
| `add.day` | Day | Día |  |  |
| `add.description` | A note marks a day: an ad campaign, a price change, press. It is only text for your team; nothing is sent to a store. | Una nota marca un día: una campaña publicitaria, un cambio de precio, prensa. Es solo texto para tu equipo; no se envía nada a una tienda. |  |  |
| `add.failed` | The note could not be saved. | No se pudo guardar la nota. |  |  |
| `add.kind` | Type | Tipo |  |  |
| `add.name` | Title | Título |  |  |
| `add.nameHint` | Up to 120 characters. | Hasta 120 caracteres. |  |  |
| `add.note` | Details (optional) | Detalles (opcional) |  |  |
| `add.noteHint` | Up to {{max}} characters. | Hasta {{max}} caracteres. |  |  |
| `add.open` | Add note | Añadir nota |  |  |
| `add.save` | Add note | Añadir nota |  |  |
| `add.saved` | Note added. | Nota añadida. |  |  |
| `add.title` | Add a note to the timeline | Añadir una nota a la cronología |  |  |
| `event.competitorChange` | {{name}} changed its App Store listing: {{what}} | {{name}} cambió su ficha de App Store: {{what}} |  | listing = ficha |
| `event.competitorKind.category` | category | categoría |  |  |
| `event.competitorKind.description` | description | descripción |  |  |
| `event.competitorKind.icon` | icon | icono |  |  |
| `event.competitorKind.name` | name | nombre |  |  |
| `event.competitorKind.price` | price | precio |  |  |
| `event.competitorKind.releaseNotes` | release notes | notas de la versión |  | release = lanzamiento |
| `event.competitorKind.screenshots` | screenshots | capturas |  |  |
| `event.competitorKind.version` | version | versión |  |  |
| `event.experimentEnded` | Experiment ended: {{name}} | Experimento finalizado: {{name}} |  |  |
| `event.experimentStarted` | Experiment started: {{name}} | Experimento iniciado: {{name}} |  |  |
| `event.graphics_one` | {{count}} graphics set pushed to the store draft | {{count}} conjunto de gráficos enviado al borrador de la tienda |  |  |
| `event.graphics_other` | {{count}} graphics sets pushed to the store draft | {{count}} conjuntos de gráficos enviados al borrador de la tienda |  |  |
| `event.listingDrift_one` | {{count}} change to the live store listing that Kiln did not make | {{count}} cambio en la ficha publicada que no hizo Kiln |  | listing = ficha; live = vivo / publicada |
| `event.listingDrift_other` | {{count}} changes to the live store listing that Kiln did not make | {{count}} cambios en la ficha publicada que no hizo Kiln |  | listing = ficha; live = vivo / publicada |
| `event.listingText_one` | {{count}} listing text change pushed to the store draft | {{count}} texto de ficha enviado al borrador de la tienda |  | listing = ficha |
| `event.listingText_other` | {{count}} listing text changes pushed to the store draft | {{count}} textos de ficha enviados al borrador de la tienda |  | listing = ficha |
| `event.release` | Version {{version}} released | Versión {{version}} publicada |  |  |
| `event.releaseRollingOut` | Version {{version}} started a staged rollout | La versión {{version}} inició un despliegue gradual |  | stage = preparar (nothing is sent); rollout = despliegue |
| `event.releaseTrack` | Version {{version}} released on {{track}} | Versión {{version}} publicada en {{track}} |  | track = canal (Play) / seguir (keyword); canal also = EAS channel |
| `event.rolloutStep` | Rollout of {{version}} reached {{percent}}% | El despliegue de {{version}} llegó al {{percent}} % |  | rollout = despliegue |
| `filter.all` | All | Todos |  |  |
| `filter.clear` | Show all types | Mostrar todos los tipos |  |  |
| `filter.label` | Filter by type | Filtrar por tipo |  |  |
| `kind.adCampaign` | Ad campaign | Campaña publicitaria |  |  |
| `kind.competitorChange` | Competitor listing changed | Ficha de un competidor modificada |  | listing = ficha |
| `kind.experimentEnded` | Experiment ended | Experimento finalizado |  |  |
| `kind.experimentStarted` | Experiment started | Experimento iniciado |  |  |
| `kind.graphics` | Graphics | Gráficos |  |  |
| `kind.listingDrift` | Store listing changed | Ficha cambiada en la tienda |  | listing = ficha |
| `kind.listingText` | Listing text | Texto de la ficha |  | listing = ficha |
| `kind.other` | Note | Nota |  |  |
| `kind.press` | Press | Prensa |  |  |
| `kind.priceChange` | Price change | Cambio de precio |  |  |
| `kind.release` | Release | Lanzamiento |  | release = lanzamiento |
| `kind.rollout` | Rollout step | Paso del despliegue |  | rollout = despliegue |
| `list.byKiln` | Recorded by Kiln | Registrado por Kiln |  |  |
| `list.byPerson` | Note added by a person | Nota añadida por una persona |  |  |
| `list.cut` | The range is longer than the timeline reads at once: it shows the days since {{date}}. | El rango es más largo de lo que la cronología lee de una vez: muestra los días desde el {{date}}. |  |  |
| `list.empty` | No events in this range. Kiln records releases, rollout steps, pushes to the store draft, experiments and changes of the live listing; add a note for anything else, such as an ad campaign or a price change. | No hay eventos en este rango. Kiln registra lanzamientos, pasos de despliegue, envíos al borrador de la tienda, experimentos y cambios de la ficha publicada; añade una nota para cualquier otra cosa, como una campaña publicitaria o un cambio de precio. |  | release = lanzamiento; rollout = despliegue |
| `list.failed_one` | The timeline of {{count}} platform could not be read | No se pudo leer la cronología de {{count}} plataforma |  |  |
| `list.failed_other` | The timeline of {{count}} platforms could not be read | No se pudo leer la cronología de {{count}} plataformas |  |  |
| `list.label` | Events by day, newest first | Eventos por día, del más reciente al más antiguo |  |  |
| `list.liveOn` | live in the store on {{date}} | publicado en la tienda el {{date}} |  | live = vivo / publicada |
| `list.loading` | Reading the timeline | Leyendo la cronología |  |  |
| `list.more_one` | Show {{count}} more | Mostrar {{count}} más |  |  |
| `list.more_other` | Show {{count}} more | Mostrar {{count}} más |  |  |
| `list.noMatch` | No events of the chosen types in this range. | No hay eventos de los tipos elegidos en este rango. |  |  |
| `list.remove` | Delete note: {{name}} | Eliminar la nota: {{name}} |  |  |
| `list.removeFailed` | The note could not be deleted. | No se pudo eliminar la nota. |  |  |
| `list.removed` | Note deleted. | Nota eliminada. |  |  |
| `list.result_one` | {{count}} event shown | {{count}} evento mostrado |  |  |
| `list.result_other` | {{count}} events shown | {{count}} eventos mostrados |  |  |
| `list.shown` | Showing {{shown}} of {{total}} | Mostrando {{shown}} de {{total}} |  |  |
| `list.waits` | goes live with the next release | se publicará con el próximo lanzamiento |  | release = lanzamiento; live = vivo / publicada |
| `marker.caption` | Diamonds on the axis mark days with events; a number is how many that day had. Point at a day to read them. | Los rombos del eje marcan los días con eventos; un número indica cuántos hubo ese día. Señala un día para leerlos. |  |  |
| `marker.failed` | The events could not be read, so no markers are drawn. | No se pudieron leer los eventos, así que no se dibujan marcas. |  |  |
| `marker.hidden_one` | {{count}} more day with events is not marked. | {{count}} día más con eventos no está marcado. |  |  |
| `marker.hidden_other` | {{count}} more days with events are not marked. | {{count}} días más con eventos no están marcados. |  |  |
| `marker.hide` | Hide events | Ocultar eventos |  |  |
| `marker.label` | Events of this day | Eventos de este día |  |  |
| `marker.more_one` | + {{count}} more | + {{count}} más |  |  |
| `marker.more_other` | + {{count}} more | + {{count}} más |  |  |
| `marker.show` | Show events | Mostrar eventos |  |  |
| `marker.spoken_one` | {{count}} event this day: {{events}} | {{count}} evento este día: {{events}} |  |  |
| `marker.spoken_other` | {{count}} events this day: {{events}} | {{count}} eventos este día: {{events}} |  |  |
| `metric.downloadRate` | Download rate (per impression) | Tasa de descarga (por impresión) |  |  |
| `metric.downloadsFirstTime` | Downloads (first time) | Descargas (primera vez) |  |  |
| `metric.downloadsRedownload` | Redownloads | Redescargas |  |  |
| `metric.impressions` | Impressions | Impresiones |  |  |
| `metric.installsUser` | Installs (users) | Instalaciones (usuarios) |  |  |
| `metric.productPageConversion` | Conversion rate (product page) | Tasa de conversión (página de producto) |  |  |
| `metric.productPageViews` | Product page views | Vistas de la página de producto |  |  |
| `metric.salesGross` | Gross sales | Ventas brutas |  |  |
| `metric.salesProceeds` | Proceeds | Ingresos netos |  |  |
| `metric.salesUnits` | Units sold | Unidades vendidas |  |  |
| `metric.storeListingAcquisitions` | Store listing acquisitions | Adquisiciones de la ficha |  | listing = ficha |
| `metric.storeListingVisitors` | Store listing visitors | Visitantes de la ficha |  | listing = ficha |
| `rail.events` | Timeline | Cronología |  |  |
| `rail.group` | Timeline and reports | Cronología e informes |  |  |
| `rail.label` | Timeline sections | Secciones de la cronología |  |  |
| `rail.reports` | Reports | Informes |  |  |
| `report.col.change` | Change | Cambio |  |  |
| `report.col.figure` | Figure | Indicador |  |  |
| `report.col.previous` | Before | Antes |  |  |
| `report.col.value` | This period | Este período |  |  |
| `report.compare` | {{current}}, compared with {{previous}}. | {{current}}, comparado con {{previous}}. |  |  |
| `report.copied` | Copied | Copiado |  |  |
| `report.copyMarkdown` | Copy as Markdown | Copiar como Markdown |  |  |
| `report.countries.title` | Countries (downloads) | Países (descargas) |  |  |
| `report.downloadCsv` | Download CSV | Descargar CSV |  |  |
| `report.empty` | Nothing was recorded for this period: no figures, no written reviews and no events. | No se registró nada en este período: ni cifras, ni reseñas escritas ni eventos. |  | review: reseña (user) vs revisión (App Review) |
| `report.events.more_one` | {{count}} more event is not listed. | {{count}} evento más no aparece en la lista. |  |  |
| `report.events.more_other` | {{count}} more events are not listed. | {{count}} eventos más no aparecen en la lista. |  |  |
| `report.events.none` | No events in this period. | No hay eventos en este período. |  |  |
| `report.events.title` | Events of the period | Eventos del período |  |  |
| `report.failed` | The report of {{platform}} could not be read. | No se pudo leer el informe de {{platform}}. |  |  |
| `report.figuresCaption` | Figures for {{period}} against the period before | Cifras de {{period}} frente al período anterior |  |  |
| `report.kind.month` | Month | Mes |  |  |
| `report.kind.week` | Week | Semana |  |  |
| `report.kind.year` | Year | Año |  |  |
| `report.kindLabel` | Report period | Período del informe |  |  |
| `report.loading` | Reading the report | Leyendo el informe |  |  |
| `report.localOnly` | Made in your browser from what Kiln stored; nothing is shared or sent. | Creado en tu navegador a partir de lo que Kiln guardó; no se comparte ni se envía nada. |  |  |
| `report.next` | Next period | Período siguiente |  |  |
| `report.noValue` | no data | sin datos |  |  |
| `report.note.lengths` | The periods have different lengths ({{current}} days against {{previous}}), so totals are not like for like. | Los períodos tienen distinta duración ({{current}} días frente a {{previous}}), por lo que los totales no son comparables. |  |  |
| `report.note.lowReviews_one` | Only {{count}} written review: the average is not reliable. | Solo {{count}} reseña escrita: la media no es fiable. |  | review: reseña (user) vs revisión (App Review) |
| `report.note.lowReviews_other` | Only {{count}} written reviews: the average is not reliable. | Solo {{count}} reseñas escritas: la media no es fiable. |  | review: reseña (user) vs revisión (App Review) |
| `report.note.missingDays_one` | {{count}} day of this period has no numbers yet; the stores publish with a delay. | {{count}} día de este período aún no tiene cifras; las tiendas publican con retraso. |  |  |
| `report.note.missingDays_other` | {{count}} days of this period have no numbers yet; the stores publish with a delay. | {{count}} días de este período aún no tienen cifras; las tiendas publican con retraso. |  |  |
| `report.note.noCountries` | There is no split by country for this period. | No hay desglose por país en este período. |  |  |
| `report.note.noFiguresAndroid` | No analytics numbers are stored for this period. Connect the Play Console reports and sync, or the store has not published them yet. | No hay cifras de analíticas guardadas para este período. Conecta los informes de Play Console y sincroniza, o la tienda aún no las ha publicado. |  |  |
| `report.note.noFiguresIos` | No analytics numbers are stored for this period. Connect App Store analytics and sync, or the store has not published them yet. | No hay cifras de analíticas guardadas para este período. Conecta las analíticas de App Store y sincroniza, o la tienda aún no las ha publicado. |  |  |
| `report.note.noReviews` | No written reviews are stored for this period or the one before. Sync reviews to read them. | No hay reseñas escritas guardadas para este período ni el anterior. Sincroniza las reseñas para leerlas. |  | review: reseña (user) vs revisión (App Review) |
| `report.note.noSourcesAndroid` | Google Play does not give downloads by source, so there is no split. | Google Play no da las descargas por fuente, así que no hay desglose. |  |  |
| `report.note.noSourcesIos` | There is no split by source for this period. | No hay desglose por fuente en este período. |  |  |
| `report.note.notStarted` | This period has not started: there are no numbers yet. | Este período no ha comenzado: aún no hay cifras. |  |  |
| `report.note.partial_one` | This period is still running. The figures cover its first {{count}} day (until {{through}}) and are compared with the same number of days before it. | Este período sigue en curso. Las cifras cubren {{count}} día (hasta el {{through}}) y se comparan con el mismo número de días anteriores. |  |  |
| `report.note.partial_other` | This period is still running. The figures cover its first {{count}} days (until {{through}}) and are compared with the same number of days before it. | Este período sigue en curso. Las cifras cubren sus primeros {{count}} días (hasta el {{through}}) y se comparan con el mismo número de días anteriores. |  |  |
| `report.note.uncompared_one` | {{count}} figure has no comparison because too many days are missing in one of the two periods. | {{count}} cifra no se compara porque faltan demasiados días en uno de los dos períodos. |  |  |
| `report.note.uncompared_other` | {{count}} figures have no comparison because too many days are missing in one of the two periods. | {{count}} cifras no se comparan porque faltan demasiados días en uno de los dos períodos. |  |  |
| `report.notes.title` | About the data | Sobre los datos |  |  |
| `report.periodLabel` | Choose a period | Elegir un período |  |  |
| `report.prev` | Previous period | Período anterior |  |  |
| `report.print` | Print | Imprimir |  |  |
| `report.range` | {{from}} to {{to}} | {{from}} al {{to}} |  |  |
| `report.reason.currentIncomplete` | Not compared: this period has too many days without numbers | Sin comparar: este período tiene demasiados días sin cifras |  |  |
| `report.reason.noData` | No numbers this period | Sin cifras en este período |  |  |
| `report.reason.previousIncomplete` | Not compared: the period before has too many days without numbers | Sin comparar: el período anterior tiene demasiados días sin cifras |  |  |
| `report.reviews.line_one` | {{count}} written review, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} reseña escrita, media {{average}} (antes: {{previous}}). Son las reseñas que Kiln guardó, no la valoración de la tienda. |  | review: reseña (user) vs revisión (App Review); rating = valoración |
| `report.reviews.line_other` | {{count}} written reviews, average {{average}} (before: {{previous}}). These are the reviews Kiln stored, not the store rating. | {{count}} reseñas escritas, media {{average}} (antes: {{previous}}). Son las reseñas que Kiln guardó, no la valoración de la tienda. |  | review: reseña (user) vs revisión (App Review); rating = valoración |
| `report.reviews.title` | Written reviews | Reseñas escritas |  | review: reseña (user) vs revisión (App Review) |
| `report.reviews.unanswered_one` | {{count}} review of 1 or 2 stars has no reply. | {{count}} reseña de 1 o 2 estrellas sin respuesta. |  | review: reseña (user) vs revisión (App Review) |
| `report.reviews.unanswered_other` | {{count}} reviews of 1 or 2 stars have no reply. | {{count}} reseñas de 1 o 2 estrellas sin respuesta. |  | review: reseña (user) vs revisión (App Review) |
| `report.sources.title` | How people found the app (downloads) | Cómo encontró la gente la app (descargas) |  |  |
| `report.title` | Report: {{period}} | Informe: {{period}} |  |  |

## web/workspace (8)

| Key | English | Spanish | OK/Fix | Notes |
|---|---|---|---|---|
| `token.action.monetizationPrice` | Change prices of in-app products | Cambiar los precios de los productos integrados |  |  |
| `webhook.event.asoCompetitorListingChanged` | A followed App Store competitor changed its screenshots, icon, name, description or release notes (ids and the kinds of change only) | Un competidor de App Store seguido cambió sus capturas, su icono, su nombre, su descripción o sus notas de la versión (solo ID y tipos de cambio) |  | release = lanzamiento |
| `webhook.event.easBuildFailed` | An EAS build was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Se guardó un build de EAS como fallido (solo identificadores, plataforma, versión y un código corto; nunca el mensaje de Expo) |  |  |
| `webhook.event.easSubmissionFailed` | An EAS store submission was stored as failed (ids, platform, version and a short code only; never Expo’s message) | Se guardó un envío de EAS a la tienda como fallido (solo identificadores, plataforma, versión y un código corto; nunca el mensaje de Expo) |  | submit = enviar |
| `webhook.event.easUpdateRolloutStuck` | An EAS Update rollout stayed at the same percentage below 100% for longer than the limit (ids, platform, channel and percentage only; never the update message) | Un despliegue de EAS Update se quedó en el mismo porcentaje, por debajo del 100 %, más tiempo que el límite (solo ids, plataforma, canal y porcentaje; nunca el mensaje de la actualización) |  | rollout = despliegue |
| `webhook.event.healthCrashRegression` | A version crashes clearly more than the one before it (ids, version names and two rates only) | Una versión falla claramente más que la anterior (solo identificadores, nombres de versión y dos tasas) |  |  |
| `webhook.event.testflightCrash` | A tester sent a TestFlight crash that was stored (ids, build and platform only; never the log) | Se guardó un cierre inesperado de TestFlight de un probador (solo identificadores, compilación y plataforma; nunca el registro) |  |  |
| `webhook.event.testflightFeedback` | A tester sent TestFlight feedback that was stored (ids, build and platform only; never the comment) | Se guardó un comentario de TestFlight de un probador (solo identificadores, compilación y plataforma; nunca el comentario) |  |  |
