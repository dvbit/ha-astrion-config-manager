# Requisito — Astrion Config Manager (add-on HA) v1.2

Stato: approvato dal richiedente. Sostituisce la v1.0: Harmony e IR rientrano nell'ambito; aggiunte le versioni con nome (RF2.11–RF2.13). Lingua del documento: italiano.

## 1. Scopo

Add-on di Home Assistant con pannello Ingress che gestisce le configurazioni (`dashboard.json`) di uno o più telecomandi Sanytron Astrion HA100 con app *Astrion Custom Dashboard* (repo `dckiller51/astrion-custom-dashboard`). Fornisce: editor a form, storico versioni a delta con undo/redo, sincronizzazione con i telecomandi, simulatore che riproduce il comportamento del telecomando ed esegue le azioni reali (Home Assistant, Hub Harmony, emettitore IR).

## 2. Ambito

**Incluso:** gestione telecomandi, editor (inclusi Harmony e IR), versioni, validazione, pull/push, rilevamento modifiche esterne, simulatore. **Escluso:** impostazioni di connessione del telecomando verso HA e Hub (restano sul dispositivo); aggiornamento dell'app del telecomando; scoperta automatica dei telecomandi; eliminazione definitiva di dati.

## 3. Riferimenti

- Schema di riferimento: `dashboard.json` secondo la release più recente del repo al momento dello sviluppo (ultima osservata: 1.1.5-beta). Comportamento di card e azioni: sorgenti Kotlin (`cards/impl/`, `config/DashboardLoader.kt`) e editor web (`docs/index.html`, `cards.js`).
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

### RF3 — Editor

- RF3.1 Editor a form per pagine, card e hotkey, per tutti i tipi di card, campi e azioni presenti nello schema di riferimento (§3), comprese card e azioni Harmony e IR (inclusi i dispositivi IR e i relativi codici).
- RF3.2 Round-trip senza perdite: card, campi e azioni sconosciuti restano intatti nel file salvato e sono modificabili come JSON grezzo. L'ordine delle chiavi non è garantito; il contenuto è semanticamente identico.
- RF3.3 Copia di pagine e card da un telecomando a un altro: crea una sola versione nel telecomando di destinazione. Le collisioni di chiavi/id nella destinazione si risolvono con suffisso numerico, aggiornando i riferimenti interni agli elementi copiati.
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
- RF6.11 Il simulatore riproduce il comportamento che l'app ha sul telecomando (visibilità condizionale di pagine e card, pagine collegate, overlay, popup, risposta ai tasti fisici), non soltanto l'invio dei comandi. L'editor serve a progettare la configurazione; la prova avviene solo nel simulatore.

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
