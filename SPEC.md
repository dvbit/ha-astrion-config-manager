# Requisito — Astrion Config Manager (add-on HA) v1.14

Stato: approvato dal richiedente. v1.3: aggiunto RF6.12 (modalità solo navigazione). v1.4: aggiunto RF7 (icone e catalogo entità). v1.5: aggiunto RF8 (più hub Harmony e destinazioni IR). v1.6: aggiunto RF3.5 (menu e tavolozze). v1.7: aggiunti RF3.6 (liste strutturate) e RF9 (allineamento a upstream 1.2.0, Apple TV diretto). v1.8: RF9.6–RF9.7 (upstream 1.2.1-beta e ricontrollo 1.2.0). v1.9: RF10 (upstream 1.2.2–1.2.7-beta). v1.10: RF11 (upstream 1.2.8–1.2.9-beta, push/pull nella schermata principale). v1.11: RF12 (upstream 1.3.0, integrazione con la cronologia versioni del telecomando). v1.12: RF13 (mappa di navigazione) e RF14 (libreria temi). v1.13: RF15 (mappa di navigazione modificabile). v1.14: RF16 (upstream 1.3.1–1.3.2-beta, disposizione e interruttori della mappa, builder del telecomando). Sostituisce la v1.0: Harmony e IR rientrano nell'ambito; aggiunte le versioni con nome (RF2.11–RF2.13). Lingua del documento: italiano. Traduzione inglese: [SPEC.en.md](SPEC.en.md).

## 1. Scopo

Add-on di Home Assistant con pannello Ingress che gestisce le configurazioni (`dashboard.json`) di uno o più telecomandi Sanytron Astrion HA100 con app *Astrion Custom Dashboard* (repo `dckiller51/astrion-custom-dashboard`). Fornisce: editor a form, storico versioni a delta con undo/redo, sincronizzazione con i telecomandi, simulatore che riproduce il comportamento del telecomando ed esegue le azioni reali (Home Assistant, Hub Harmony, emettitore IR).

## 2. Ambito

**Incluso:** gestione telecomandi, editor (inclusi Harmony e IR), versioni, validazione, pull/push, rilevamento modifiche esterne, simulatore. **Escluso:** impostazioni di connessione del telecomando verso HA e Hub (restano sul dispositivo); aggiornamento dell'app del telecomando; scoperta automatica dei telecomandi; eliminazione definitiva di dati.

## 3. Riferimenti

- Schema di riferimento: `dashboard.json` secondo la release più recente del repo al momento dello sviluppo (ultima osservata: 1.3.0 stabile, 1.3.2-beta). Comportamento di card e azioni: sorgenti Kotlin (`cards/impl/`, `config/DashboardLoader.kt`) e editor web (`docs/index.html`, `cards.js`).
- Telecomando: il dispositivo non espone un'API. L'add-on esegue le stesse richieste HTTP del browser sulla pagina di configurazione `http://<host>:<porta>` (download e upload di `dashboard.json`), ricavate dai sorgenti `web/` del repo. L'editing avviene solo nell'interfaccia web dell'add-on.
- Home Assistant: API WebSocket tramite token Supervisor dell'add-on; nessun token inserito dall'utente.
- Hub Harmony: protocollo locale dell'Hub usato dal client Harmony dell'app (sorgenti Kotlin del repo).
- IR: entità HA `remote.*` con servizio `send_command`.

## 4. Glossario

- **Telecomando**: istanza registrata nell'app, con una storia propria.
- **Versione**: stato completo di un `dashboard.json`, memorizzato come delta dalla precedente.
- **Testa**: ultima versione di un telecomando.
- **Baseline**: hash del contenuto dell'ultimo pull o push riuscito.
- **Deriva**: contenuto sul dispositivo con hash diverso dalla baseline.

## 5. Requisiti funzionali

### RF1 — Telecomandi

- RF1.1 Registrazione solo manuale. Campi obbligatori: nome (univoco tra i non archiviati), host/IP, porta (default 8080), larghezza e altezza schermo in pixel, orientamento (verticale/orizzontale); nessun default per dimensioni e orientamento. Campi opzionali: indirizzo IP dell'Hub Harmony, entità HA `remote.*` emettitore IR.
- RF1.2 La registrazione esegue un pull iniziale: se riuscito crea la versione 1 (tipo `import`); se fallisce (dispositivo non raggiungibile o file assente) mostra l'errore e non registra.
- RF1.3 Tutti i campi sono modificabili dopo la registrazione.
- RF1.4 La rimozione archivia il telecomando: sparisce dall'elenco principale, storia e dati restano integri, è ripristinabile da una vista «Archiviati». Non esiste eliminazione definitiva.
- RF1.5 Più telecomandi con storie indipendenti.

### RF2 — Versioni

- RF2.1 Ogni versione ha: id intero progressivo per telecomando, id padre, timestamp, utente HA, tipo (`import`, `edit`, `undo`, `redo`, `restore`, `sync-import`), delta.
- RF2.2 Storico lineare append-only: nessuna versione viene mai modificata o cancellata; nessuna ramificazione.
- RF2.3 Si crea una versione a ogni commit di un campo (perdita di focus o invio) che produce un delta non vuoto. Un commit senza variazioni non crea versioni. Ogni operazione strutturale (aggiunta, rimozione, riordino, copia di pagina/card/hotkey) e ogni applicazione dell'editor JSON grezzo è una sola versione.
- RF2.4 **Undo**: crea una versione di tipo `undo` il cui stato è quello precedente all'ultima versione annullabile non ancora annullata. Sono annullabili le versioni di tipo `edit`, `restore`, `import`, `sync-import`. Undo ripetuto risale a ritroso (ordine LIFO).
- RF2.5 **Redo**: crea una versione di tipo `redo` che ripristina l'ultima versione annullata. Disponibile solo se dopo l'ultimo undo non è stata creata alcuna versione diversa da `undo`/`redo`; qualunque nuova modifica, ripristino o import azzera il redo.
- RF2.6 **Ripristino**: l'utente sceglie una versione qualsiasi dello storico e ne ripristina lo stato in un solo passo, creando una versione `restore`.
- RF2.7 Lo storico è consultabile: elenco versioni con tipo, data, utente e riepilogo delle modifiche (delta leggibile).
- RF2.8 Memorizzazione: solo delta in formato JSON Patch (RFC 6902) rispetto alla versione precedente. Eccezione per limitare il costo di ricostruzione: snapshot compresso completo alla versione 1 e ogni 50 versioni.
- RF2.9 Conservazione illimitata, nessuna compattazione.
- RF2.10 Concorrenza: ogni commit riporta l'id della testa vista dal client; se la testa è cambiata il commit è rifiutato, la UI si riallinea e informa l'utente.
- RF2.11 **Versioni con nome**: l'utente può assegnare un nome a qualsiasi versione, anche non la testa. Il nome non è vuoto, è unico per telecomando (senza distinzione tra maiuscole e minuscole) e ogni versione ne ha al massimo uno.
- RF2.12 Il nome è un'etichetta separata dalla versione: assegnarlo, rinominarlo o rimuoverlo non crea versioni e non altera lo storico; rimuovere il nome non cancella la versione. I nomi sono conservati anche quando il telecomando è archiviato.
- RF2.13 Dall'elenco dei nomi si ripristina la versione etichettata con le regole di RF2.6 (crea una versione `restore`). L'elenco dello storico mostra i nomi e consente di filtrare le sole versioni con nome.
- RF2.14 La cronologia propria del telecomando (app 1.3.0) affianca questa senza sostituirla: vedi RF12.

### RF3 — Editor

- RF3.1 Editor a form per pagine, card e hotkey, per tutti i tipi di card, campi e azioni presenti nello schema di riferimento (§3), comprese card e azioni Harmony e IR (inclusi i dispositivi IR e i relativi codici).
- RF3.2 Round-trip senza perdite: card, campi e azioni sconosciuti restano intatti nel file salvato e sono modificabili come JSON grezzo. L'ordine delle chiavi non è garantito; il contenuto è semanticamente identico.
- RF3.3 Copia di pagine e card da un telecomando a un altro: crea una sola versione nel telecomando di destinazione. Le collisioni di chiavi/id nella destinazione si risolvono con suffisso numerico, aggiornando i riferimenti interni agli elementi copiati.
- RF3.5 I campi a valori fissi (es. `alignment`) sono menu a tendina con i valori documentati dall'implementazione di riferimento e un'opzione «predefinito» che rimuove la chiave. I campi colore (card e tema) hanno una tavolozza più il valore esadecimale (#RRGGBB o #AARRGGBB, alfa preservato). Gli editor JSON permettono di inserire un colore. Valori fuori elenco o colori malformati sono avvisi, non errori.
- RF3.6 Le opzioni a lista hanno form per elemento con aggiunta, riordino, duplicazione e rimozione: `button_grid.buttons`, `scene_grid.scenes`, `tv_remote.apps`, `monitor.entities`, `speaker_group.speakers`, `picture_elements.elements`. `row.cards` contiene card annidate con il loro form completo. Copre le card senza form nel builder nativo (`monitor`, `picture_elements`, `row`, `source_select`, `speaker_group`).
- RF3.4 Token e segreti presenti nel JSON sono salvati in chiaro nello storico e mostrati senza mascheratura (rischio accettato dal richiedente).

### RF4 — Validazione

- RF4.1 Errori strutturali: JSON non valido, campi obbligatori mancanti o di tipo errato nelle parti note dello schema, comprese le parti Harmony e IR.
- RF4.2 Entità HA: ogni `entity_id` referenziato nei campi noti deve esistere in HA.
- RF4.3 Per Harmony e IR solo controllo strutturale: nessun controllo di esistenza di attività, dispositivi o comandi sull'Hub né dell'emettitore IR.
- RF4.4 La validazione è eseguita a ogni modifica e mostra gli errori in linea; non impedisce di creare versioni.
- RF4.5 Il push è bloccato se la testa contiene qualsiasi errore o entità HA inesistente.

### RF5 — Sincronizzazione

- RF5.1 **Pull**: scarica il `dashboard.json` dal dispositivo; se diverso dalla testa crea una versione `sync-import` e aggiorna la baseline.
- RF5.2 **Controllo deriva**: eseguito all'apertura del pannello (per ogni telecomando non archiviato) e immediatamente prima di ogni push. Confronta l'hash SHA-256 del JSON canonico (chiavi ordinate, spazi normalizzati) del dispositivo con la baseline. Dispositivo non raggiungibile: stato «non raggiungibile», push impossibile.
- RF5.3 La deriva è solo segnalata, il push non è bloccato. L'utente sceglie: *importa come versione* (`sync-import`, aggiorna la baseline), *sovrascrivi con la testa* (push), *ignora* (la segnalazione ricompare al controllo successivo).
- RF5.4 **Push**, nell'ordine: validazione (RF4.5), controllo deriva (RF5.2), upload della testa, rilettura e verifica dell'hash. Se coincide, aggiorna baseline e registra versione e data dell'ultimo push; altrimenti segnala errore e non aggiorna la baseline.
- RF5.5 Per ogni telecomando l'elenco mostra: stato deriva, versione testa, ultima versione inviata.

### RF6 — Simulatore

- RF6.1 Simula la testa del telecomando selezionato (non versioni storiche) e si aggiorna a ogni nuova versione.
- RF6.2 Schermo con larghezza, altezza e orientamento del telecomando (RF1.1), scalato per stare nel pannello, con pagine navigabili a scorrimento.
- RF6.3 Ogni tipo di card noto, comprese quelle Harmony e IR, è reso in modo visivamente fedele all'app del telecomando. Card sconosciute: segnaposto con tipo e indicazione «non simulabile».
- RF6.4 Stato live: le card mostrano lo stato corrente delle entità HA referenziate (accese/spente, valori), aggiornato in tempo reale. Le condizioni di visibilità e apertura delle pagine (`openWhenEntity`, `hiddenUnlessActivity`) sono valutate sullo stato live.
- RF6.5 Azione che si risolve in una chiamata a servizio HA: **sempre eseguita realmente** su HA con gli stessi servizi e dati che esegue l'app del telecomando. L'esito di errore è mostrato.
- RF6.6 Azioni di navigazione (cambio pagina, pagine collegate, overlay) sono simulate nel simulatore.
- RF6.7 Azione Harmony: eseguita realmente, direttamente verso l'Hub all'IP del telecomando (RF1.1), con lo stesso protocollo dell'app. Senza IP Hub configurato l'azione è disabilitata con indicazione del motivo; gli errori di invio sono mostrati.
- RF6.8 Azione IR: eseguita realmente tramite l'entità `remote.*` del telecomando (RF1.1) con `send_command`; l'add-on converte i codici IR della configurazione nel formato accettato dall'entità. Senza entità configurata l'azione è disabilitata con indicazione del motivo; gli errori sono mostrati.
- RF6.9 Pannello con i tasti fisici dell'HA100, cliccabili: eseguono l'hotkey configurato con le stesse regole di RF6.5–RF6.8.
- RF6.10 Il simulatore espone un indicatore permanente «Esecuzione reale: Home Assistant, Hub Harmony, IR».
- RF6.12 Interruttore «Solo navigazione»: se attivo, le azioni (HA, Harmony, IR) non vengono eseguite ma solo elencate; navigazione, pagine collegate, popup e Attività composte (aggiornate localmente) restano simulate. L'indicatore di RF6.10 segnala la modalità. Predefinito: disattivato.
- RF6.11 Il simulatore riproduce il comportamento che l'app ha sul telecomando (visibilità condizionale di pagine e card, pagine collegate, overlay, popup, risposta ai tasti fisici), non soltanto l'invio dei comandi. L'editor serve a progettare la configurazione; la prova avviene solo nel simulatore.

### RF7 — Icone e catalogo entità

- RF7.1 Libreria icone condivisa nell'add-on (PNG, JPEG, WebP, max 2 MB), inclusa nei backup HA. Nomi file normalizzati con la stessa regola del telecomando.
- RF7.2 Eliminare un'icona la toglie dalla libreria; dall'app 1.2.7 si può eliminare anche sui telecomandi (RF10.11).
- RF7.3 Al push, le icone usate dalla testa e assenti sul telecomando vengono caricate dalla libreria prima del file. Le icone presenti su un telecomando possono essere importate nella libreria.
- RF7.4 Ogni campo icona dell'editor ha anteprima e selettore (libreria + icone del telecomando); gli editor JSON permettono di inserire un percorso icona. Il simulatore mostra le icone reali. Un'icona assente sia in libreria sia sul telecomando è un errore che blocca il push.
- RF7.5 Form per il catalogo `haDevices` (nome, tipo, entità HA filtrata per tipo). Le voci del catalogo sono proposte nei campi entità dell'editor. Un'entità del catalogo inesistente in HA blocca il push.
- RF7.6 La copia di pagine/card tra telecomandi copia anche le voci del catalogo delle entità usate.

### RF8 — Più hub Harmony e destinazioni IR

- RF8.1 Hub Harmony ed extender IR vengono letti dal telecomando (`GET /devices-config`) alla registrazione, a ogni pull e con il pulsante Aggiorna. Sono in sola lettura. Il token HA contenuto nella risposta viene scartato e mai salvato.
- RF8.2 Il campo `hub` di un'azione seleziona l'hub per `localId`; se assente o sconosciuto si usa il primo hub, come nell'implementazione di riferimento.
- RF8.3 L'IP Hub Harmony del telecomando resta come riserva quando il telecomando non ha hub; l'entità emettitore IR è la destinazione `local`, perché l'emettitore integrato non è pilotabile da remoto.
- RF8.4 Un dispositivo IR con `target: {"extender": id}` viene inviato direttamente a quell'extender (`POST http://<host>/pronto`, corpo Pronto in text/plain).
- RF8.5 Verso un extender, i codici ir-database sono inviati così come sono; i codici inline sono convertiti in Pronto.
- RF8.6 Nell'editor `hub` e destinazione IR sono menu a tendina. Un extender sconosciuto è un errore che blocca il push; un hub sconosciuto è solo un avviso.
- RF8.7 Il simulatore indica nei messaggi d'errore e in «Solo navigazione» l'hub o l'extender usato.

### RF9 — Allineamento a upstream 1.2.0 (Apple TV diretto)

- RF9.1 Le Apple TV abbinate sono lette da `/devices-config` (solo localId, nome, entità); le credenziali di abbinamento non vengono mai salvate.
- RF9.2 Le entità `media_player.appletv_*` delle Apple TV abbinate sono valide anche se non esistono in HA.
- RF9.3 `apple_tv_remote` supporta entrambi i modi: diretto (`appleTv`) e Harmony (`deviceId`/`hub`); l'editor offre «Controllo tramite». Se sono impostati entrambi vale `appleTv` (avviso).
- RF9.4 Prima del push le voci `appletv_<localId>` vengono aggiunte al catalogo `haDevices` come versione `sync-import`, con la stessa logica del telecomando, così la verifica del push resta coerente.
- RF9.5 Il controllo diretto Apple TV non è eseguibile dall'add-on: nel simulatore è disabilitato con il motivo. Vale per `astrion_appletv.*` e per qualsiasi servizio sull'entità di una Apple TV abbinata, che il telecomando gestisce localmente.
- RF9.6 (1.2.1-beta) Ogni pulsante di `button_grid` e riquadro di `scene_grid` può avere un blocco `long_press` con gli stessi campi azione; editor con form dedicato, validazione delle entità interne, copia con riscrittura dei riferimenti, simulatore con pressione lunga (hub di riserva = quello del riquadro).
- RF9.7 `media_player.media_controls`/`volume_controls` sono liste separate da virgola (stringa vuota = nessun controllo, chiave assente = predefinito): editor a caselle, simulatore fedele. `openWhenState` vale `"on"` se assente.

### RF10 — Allineamento a upstream 1.2.2–1.2.7-beta

Riferimento: astrion-custom-dashboard ramo `dev`, 1.2.7-beta (ultima stabile 1.2.0). Ogni chiave è facoltativa; un'app più vecchia la ignora.

- RF10.1 Blocco `dock` (mode charging/clock/dashboard, idle_seconds, brightness, night_brightness, time_format 12/24, weather_entity, media_entities, show_battery) e blocco `power` (motion_wake_minutes, screen_off_filter_seconds, screen_off_entities, dock_debounce_seconds, screen_timeout_seconds): sezioni "Schermo dock" e "Standby e batteria" in Globale. Errori di tipo, intervallo e valore sono avvisi (il telecomando ignora il valore); le entità contenute sono verificate come le altre.
- RF10.2 `hideMode` della pagina (`dots` predefinito, `full`): menu. Con `full` e Activity spenta il simulatore salta la pagina negli swipe e la lascia (verso il genitore, altrimenti la pagina visibile più vicina) quando l'Activity si ferma. Con `dots` la pagina resta raggiungibile con lo swipe e si nasconde solo il pallino. `hideMode` senza `hiddenUnlessActivity` è un avviso.
- RF10.3 `stopActivity` (una stanza, o `*` per tutte) su tile, pulsanti, `long_press` e hotkey: menu delle stanze (stanze delle Activity e delle tile `track`). Stanza sconosciuta = avviso. Hotkey `event`, `openOverlay`, `openCurrentActivityRoom`, `track`/`room`/`devices`. I tasti fisici sono mostrati come "Menu (MAIN)".
- RF10.4 `apple_tv_remote`: `layout` classic/compact/full, `entity`, `showArtwork`/`showProgress`/`showSkip`, lista `apps` (source, label, icon, color), 14 pulsanti del catalogo upstream (predefiniti compact: Menu, −10 s, +10 s, Home). Il simulatore rende i tre layout; le app si avviano con `media_player.select_source` su `entity` (altrimenti l'Apple TV diretto).
- RF10.5 Le Activity composte seguono l'ActivityPlanner upstream: con `profile` nell'ir-database (alimentazione discrete/toggle/none, tempi, ripetizioni, ingressi con nome come sequenze di tasti) avvio stile Harmony (spegne i dispositivi della stanza non usati, accensioni scaglionate, ingressi quando pronti e solo se cambiano); altrimenti l'ordine originale per dispositivo. Il simulatore tiene una memoria degli stati per telecomando (acceso/spento, ingresso, Activity attive, stanze tracciate) nei dati dell'add-on; è la convinzione dell'add-on, non del telecomando, e si azzera con "Azzera stati dispositivi".
- RF10.6 Ricerca IR come l'app: id comando tolleranti (maiuscole, spazi, `_`, `-`), nomi modello con o senza " (Harmony)", riparazione dei codici Pronto spezzati tra `pronto`/`pronto_repeat`, `repeats` con il burst di ripetizione (max 1,9 s).
- RF10.7 Esecuzione reale di `stopActivity` (stop composto o PowerOff Harmony dell'hub tracciato; `*` = tutte le stanze attive) e dell'`event` delle hotkey (`astrion_button` sul bus di HA con remote_id, remote_name, event, key, long, page).
- RF10.8 Interruttore "Sulla base" nel simulatore: anteprima dello schermo dock (charging = attenuato quasi a zero, dashboard = attenuato a `brightness`, clock = orologio con data, meteo, batteria e in riproduzione; notte = `night_brightness`, ambra).
- RF10.9 Identità del telecomando da `GET /info` (nome, modello, versione app), sola lettura, mostrata nell'elenco; due voci per lo stesso telecomando fisico sono segnalate.
- RF10.10 L'add-on non cambia il nome del telecomando.
- RF10.11 Eliminando un'icona si può eliminarla anche sui telecomandi che la contengono (`DELETE /icons/<nome>`); i telecomandi la cui testa la usa ancora non sono selezionabili.
- RF10.12 Il banner di disallineamento elenca le chiavi cambiate; se sono cambiate solo chiavi scritte dalle Impostazioni del telecomando (`dock.mode`, `power.screen_timeout_seconds`) lo segnala.

### RF11 — Allineamento a upstream 1.2.8–1.2.9-beta, sincronizzazione rapida

- RF11.1 Hotkey `pageMode: "popup"` accanto a `page`: menu "page / popup"; il simulatore apre la pagina come popup e lo stesso tasto la richiude. Altri valori = avviso.
- RF11.2 `monitor`: `layout: "vertical"` (valore sotto il nome) e `marquee` (valore lungo su una riga che scorre) in editor e simulatore.
- RF11.3 `nowPlayingEntity` su Activity composte, tile `track` e hotkey tracciate (validato come entità) e `dock.room` (menu delle stanze; stanza sconosciuta = avviso). L'orologio dock del simulatore mostra il player dell'Activity attiva in quella stanza (senza stanza: dell'unica Activity attiva; un'Activity composta con Apple TV abbinato direttamente lo usa in automatico), altrimenti `media_entities` con un player in riproduzione prima di uno in pausa, altrimenti qualsiasi player in riproduzione.
- RF11.4 `select`: `layout: "dropdown"` (solo menu, larghezza piena) e `font_size` (10–32, avviso fuori intervallo).
- RF11.5 `tv_remote`: riga volume (− / muto / +) verso `mute_entity`, altrimenti la TV, nascosta con `show_volume: false`; pulsanti app su `media_entity`, predefinito `media_player.<nome di remote_entity>`; app predefinite Netflix, YouTube, Prime Video, Plex.
- RF11.6 Icone: `source_select.icon`, icone PNG su `switch` e sugli elementi di `picture_elements`, `on_color` per elemento (tavolozza).
- RF11.7 Simulatore: una pressione lunga su MAIN apre le Impostazioni quando nessuna hotkey della dashboard le apre e MAIN non ha una hotkey lunga.
- RF11.8 Pulsanti Pull e Push anche su ogni telecomando dell'elenco e nell'intestazione del telecomando aperto (tutte le schede), con lo stesso flusso di Sincronizzazione (validazione, verifica, messaggi); da lì un push su un telecomando disallineato chiede conferma.

### RF12 — Integrazione con la cronologia versioni del telecomando (app 1.3.0)

Dalla 1.3.0 il telecomando conserva una propria cronologia di `dashboard.json` (`DashboardHistory.kt`): ogni salvataggio dal builder o dalla sua pagina web, e ogni `POST /dashboard.json`, è conservato come copia completa con una nota facoltativa; un contenuto modificato fuori dalla pagina web viene conservato prima (`outside`), un ripristino è una nuova versione (`restore`); restano le ultime 30 versioni più quelle fissate. Rotte: `GET /history`, `GET /history/<id>`, `POST /history/{restore,pin,note,delete}`; `POST /dashboard.json` accetta `note`.

Confronto tra le due cronologie:

| | Add-on | Telecomando 1.3.0 |
| --- | --- | --- |
| Conservazione | Tutto, per sempre (nei backup di HA) | 30 + fissate |
| Archiviazione | Differenze tra versioni | Copie complete |
| Etichette | Nomi univoci per telecomando | Note libere, versioni fissate |
| Ambito | Tutti i telecomandi, copia tra di essi | Solo quel telecomando |
| Registra le modifiche fatte sul telecomando | Solo quando emergono come disallineamento | Sì, ogni salvataggio |

Principio: la cronologia dell'add-on (RF2) resta quella principale; la cronologia del telecomando è una rete di sicurezza e un registro di ciò che è avvenuto sul dispositivo, che l'add-on legge ed etichetta.

- RF12.1 Ogni push invia `note` = `ACM v<testa>`, seguito da `· "<nome>"` se la testa è una versione con nome (max 200 caratteri). L'add-on riconosce le proprie versioni nell'elenco del telecomando da quel prefisso.
- RF12.2 Opzione per telecomando "Fissa le versioni con nome sul telecomando" (disattivata per impostazione predefinita): dopo il push di una versione con nome, la versione corrispondente sul telecomando (stessa nota) viene fissata così il telecomando non la elimina mai. Un errore nel fissarla viene registrato nel log e non fa fallire il push.
- RF12.3 Quando viene rilevato un disallineamento, la voce più recente della cronologia del telecomando lo spiega nel banner: ripristinata dalla versione X, modificata fuori dalla pagina web (es. Impostazioni), salvata dal builder con la sua nota, oppure salvata per ultimo dall'add-on e poi modificata.
- RF12.4 Scheda Storico, pannello "Cronologia del telecomando" (sola lettura): ora, motivo, nota, fissata, pagine/card, e se la versione è stata inviata dall'add-on (con la sua versione dell'add-on) o creata sul telecomando. Azioni: **Confronta con la testa** (percorsi diversi), **Scarica**, **Importa come versione** (nuova versione `sync-import` che riporta la sua origine; se è il file attuale del telecomando, questo torna allineato come dopo un pull).
- RF12.5 L'add-on non ripristina, elimina né modifica le note delle versioni sul telecomando: per tornare indietro si importa (o si ripristina nell'add-on) e si invia.
- RF12.6 Nessuna copia automatica della cronologia del telecomando in quella dell'add-on.
- RF12.7 App precedenti alla 1.3.0 (`/history` 404): il pannello indica che non è disponibile, le note vengono ignorate, nient'altro cambia.

### RF13 — Mappa di navigazione

- RF13.1 Pannello "Mappa di navigazione" sopra **Editor** e **Simulatore**: si mostra o nasconde con ▴/▾, altezza ridimensionabile trascinando (entrambi ricordati dal browser). Zoom con rotella o pinch, spostamento trascinando, pulsanti zoom ± e "adatta"; si apre su "adatta".
- RF13.2 Ogni pagina è un'**anteprima live in miniatura** disegnata dal renderer del simulatore (colori del tema, stati HA aggiornati al massimo ogni 3 s), solo visualizzazione. Badge: ⭐ pagina iniziale; 👁 visibile solo mentre la sua Activity è attiva (`hiddenUnlessActivity`), barrato con `hideMode: full`.
- RF13.3 Il layout segue il telecomando: upstream mantiene **un unico pager continuo sull'elenco piatto delle pagine in ordine di file** (la gerarchia cambia solo i pallini e Indietro), quindi tutte le pagine stanno su una riga in ordine di file con 👋 tra le vicine di swipe. I ritorni al genitore sono archi sotto la riga, ogni altro collegamento un arco sopra. Riquadri speciali in una riga sotto: "Qualsiasi pagina (tasti globali)", "Home Assistant", "Overlay Activity", "Impostazioni"; un collegamento a un nome di pagina inesistente punta a un riquadro ⚠ rosso.
- RF13.4 Collegamenti, uno per ogni modo di raggiungere una pagina: 👋 swipe; ☝️ swipe in alto (`linkedPage`); 👆 tocco su tile/pulsante (`page`); ✋ pressione lunga (`long_press.page`); 🎛 tasto fisico con il suo nome (hotkey di pagina da quella pagina, globali da "Qualsiasi pagina"; `openOverlay`; `openCurrentActivityRoom` verso le pagine delle Activity di quella stanza; Menu lungo verso Impostazioni quando nessuna hotkey le apre); 🎬 Activity avviata → la sua pagina (scena `activity`, overlay Activity); 👇 swipe in basso → overlay Activity; 🏠 `openWhenEntity` (entità = stato); ↩ figlia → genitore con il suo tasto. Linea tratteggiata + ▣ = si apre come popup. Una legenda li spiega.
- RF13.5 Clic — Editor: pagina → impostazioni della pagina; card dentro un'anteprima → il form di quella card; collegamento → l'elemento che lo crea (tile, hotkey, Activity, impostazione di pagina), aperto ed evidenziato. La selezione dell'editor è evidenziata sulla mappa. Simulatore: pagina o collegamento → lo schermo simulato salta lì.
- RF13.6 Ridisegnata a ogni nuova versione mantenendo lo zoom; nessuna libreria esterna (funziona offline).
- RF13.7 Non disegnabili: pagine aperte dal selettore pagina di Home Assistant o da chiamate al server web del telecomando (non sono in `dashboard.json`).
- RF13.8 Correzione di fedeltà del simulatore emersa con la mappa: lo swipe orizzontale ora scorre tutte le pagine in ordine di file (saltando le pagine `hideMode: full` con Activity spenta); i pallini mostrano ancora solo le pagine sorelle.

### RF14 — Libreria temi

- RF14.1 Libreria di temi condivisa nei dati dell'add-on (nei backup HA). Un tema = nome + il blocco `theme` del telecomando salvato esattamente com'è (chiavi assenti = predefinito del telecomando). Nomi univoci, senza distinzione maiuscole/minuscole.
- RF14.2 Temi predefiniti in sola lettura (duplicabili): **Default** (blocco vuoto = tema integrato del telecomando), **Light**, **OLED black**, **High contrast**.
- RF14.3 Barra in Editor → Globale → Tema: **Carica** (selettore con campioni e anteprima; sostituisce il blocco `theme` = una versione, annullabile), **Salva come…** (sovrascrivere un tema salvato chiede conferma; un predefinito non viene mai sovrascritto), **Elimina** (solo temi salvati).
- RF14.4 Scheda "Temi" nella schermata principale: elenco con campioni e anteprima; anteprima, rinomina, duplica, elimina, **Esporta** in `.json`, **Applica ai telecomandi…** (una versione per ogni telecomando spuntato, nulla viene inviato), **Importa da file** (il nostro export, un blocco tema o un intero dashboard.json; colori non validi e chiavi sconosciute segnalati e ignorati; un nome già usato chiede un nuovo nome).
- RF14.5 Anteprima prima di applicare: schermo in miniatura della prima pagina del telecomando aperto (o di quello scelto nella scheda Temi) con il tema applicato.

### RF15 — Mappa di navigazione modificabile

Solo nella scheda Editor (la mappa del Simulatore resta in sola lettura). Ogni modifica è una versione (annullabile) ed è validata come sempre.

- RF15.1 Ogni schermo ha quattro ancore: sinistra/destra = ordine di swipe, alto = arrivo dei collegamenti dalle tile, basso = arrivo delle hotkey. I bersagli validi si illuminano durante il trascinamento. Un clic breve mantiene RF13.5; trascinare su uno spazio vuoto sposta la vista.
- RF15.2 Swipe: trascinare l'ancora destra di A sull'ancora sinistra di B sposta B subito dopo A (sinistra di A su destra di B: prima di A). Le pagine sono riferite per nome, quindi i collegamenti restano validi; `startPage` segue la sua pagina. Un collegamento di swipe non si può rimuovere (il telecomando scorre sempre tutte le pagine): tenerlo premuto lo spiega.
- RF15.3 Tasti fisici sotto la mappa su due righe: tasti della pagina selezionata nell'editor e tasti globali; i tasti assegnati partono dal loro riquadro. Trascinare l'ancora di un tasto sull'ancora inferiore di uno schermo chiede pressione breve/lunga e pagina/popup, poi scrive `{key, page, pageMode}` nelle `hotkeys`/`longHotkeys` di quella pagina (o globali); un'assegnazione esistente di quel tasto chiede se sostituirla.
- RF15.4 Trascinare una tile di `button_grid`/`scene_grid` di un'anteprima (anche dentro card `row`) sull'ancora superiore di uno schermo chiede tocco/tocco lungo e pagina/popup e scrive `page`/`pageMode` sulla tile o nel suo blocco `long_press`; una destinazione esistente chiede se sostituirla; una tile di scena che avvia un'Activity avvisa che il tocco mostra la pagina dell'Activity.
- RF15.5 Pressione prolungata (600 ms, mouse o touch) su un collegamento, poi conferma: tocco → rimuove `page`/`pageMode`; tocco lungo → lo stesso in `long_press` (eliminato se vuoto); hotkey → l'assegnazione; swipe in alto → `linkedPage`/`linkedPageMode`; indietro → `parent`/`parentKey`; HA → `openWhenEntity`/`openWhenState`/`closeWhenState`/`openMode`. I collegamenti di Activity e overlay sono in sola lettura (si modificano nei form).

### RF16 — Upstream 1.3.1–1.3.2-beta, disposizione mappa, builder del telecomando

- RF16.1 Il push legge `X-Astrion-Version-Id` (app 1.3.1+) per fissare/etichettare la versione creata sul telecomando; con la 1.3.0 la versione si trova dalla nota.
- RF16.2 Meteo integrato (1.3.2-beta): sezione Globale "Meteo integrato" (`name`, `latitude`, `longitude`, `model` auto/meteofrance, `unit` celsius/fahrenheit) con **Cerca una località**, ricerca fatta dal telecomando (`GET /weather-search`). Latitudine/longitudine obbligatorie e nell'intervallo, altrimenti il telecomando ignora il blocco (avviso); model/unit sconosciuti segnalati. `weather.astrion` conta come entità esistente quando il blocco è valido ed è proposta nei campi entità; il simulatore la mostra come "integrato, solo sul telecomando".
- RF16.3 Mappa: schermi trascinabili dalla barra del titolo, collegamenti che seguono in tempo reale; posizioni salvate per telecomando nell'add-on (per nome pagina; nei backup HA, mai in `dashboard.json`), **Ripristina disposizione**; il trascinamento non cambia mai l'ordine di swipe. Interruttori **Tasti pagina**, **Tasti globali**, **Collegamenti** (tutti) e uno per tipo nella legenda (ricordati dal browser). I tasti usano le icone del simulatore.
- RF16.4 Modalità per telecomando "Modifica con il builder del telecomando" (opzione del telecomando): il telecomando è l'editor, l'add-on il backup. Se attiva: editor, modifiche sulla mappa, annulla/ripeti e caricamento temi in sola lettura, un banner offre **Modifica nel builder**, **Fatto**, **Disattiva modalità**. Prima di aprire: modifiche dell'add-on non inviate → **Invia** / **Scarta** (versione `restore` dell'ultima sincronizzata) / Annulla. Al ritorno sulla scheda (di nuovo visibile, o Fatto): pull; le modifiche sono importate come versione `sync-import` con nota/motivo della voce più recente della cronologia del telecomando; se è cambiato anche l'add-on → l'utente tiene il file del telecomando (importa) o quello dell'add-on (invia); mai uniti.
- RF16.5 **Apri nel builder ↗** / **Cronologia ↗** nell'intestazione: `http://<ip>:<porta>/builder/` in una nuova scheda (mai un iframe: HA è HTTPS, il builder HTTP in rete locale), sulla selezione dell'editor con i deep link 1.3.1-beta (`#page=<nome>`, `&card=<i>`, `#activity=<id>`, `#hotkeys`, `#history`). Disattivati con il motivo quando il telecomando non è raggiungibile. Fuori dalla modalità, al ritorno si ricontrolla il disallineamento.

## 6. Requisiti non funzionali

- RNF1 Add-on con pannello Ingress, accessibile solo agli amministratori HA.
- RNF2 Dati persistiti nel volume dati dell'add-on, sopravvivono a riavvii e aggiornamenti e rientrano nei backup HA.
- RNF3 Interfaccia in italiano e inglese secondo la lingua dell'utente HA; fallback inglese.
- RNF4 Scritture delle versioni atomiche: una versione è creata per intero o per nulla.
- RNF5 L'add-on deve raggiungere via rete locale i telecomandi e gli Hub Harmony.

## 7. Criteri di accettazione

1. Registrare due telecomandi: ciascuno ha versione 1 e storia separata.
2. Modificare un campo e uscire dal campo: nasce una versione con solo il delta; due undo creano due versioni `undo` e riportano lo stato di prima; un redo ripristina; una nuova modifica azzera il redo.
3. Ripristinare la versione 3 con testa a 8: lo stato coincide con la 3 e la testa diventa la 9, tutte le versioni 1–8 restano.
4. File con card sconosciuta: dopo modifiche e push, la card è invariata sul dispositivo.
5. Modifica del file sul dispositivo con l'editor online: all'apertura del pannello compare la deriva e nessuna azione automatica.
6. Entità HA inesistente nella testa: push rifiutato con elenco errori. Attività Harmony inesistente: push consentito.
7. Pressione di un'icona luce nel simulatore: la luce reale cambia stato e la card si aggiorna.
8. Pressione di un'azione Harmony con IP Hub configurato: il comando arriva all'Hub; senza IP: azione disabilitata con motivo.
9. Pressione di un'azione IR con entità emettitore configurata: l'entità riceve `send_command` con codici convertiti; senza entità: azione disabilitata con motivo.
10. Rimozione di un telecomando: sparisce dall'elenco, compare in «Archiviati» con tutta la storia.
11. Assegnare il nome «A» alla versione 3 con testa a 8, fare altre modifiche, ripristinare «A»: lo stato coincide con la versione 3 e nasce una nuova versione `restore`. L'assegnazione del nome non ha creato versioni. Un secondo nome «a» sullo stesso telecomando è rifiutato.
