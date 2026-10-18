<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

**App (add-on)** per Home Assistant che gestisce il `dashboard.json` di uno o
più telecomandi **Astrion HA100** con
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
editor a form, storico completo con undo/redo e versioni con nome (integrato
con la cronologia del telecomando dall'app 1.3.0), validazione sulle entità HA,
push/pull con rilevamento della deriva, simulatore live.

🇬🇧 [English version](README.md) · 📄 Specifica: [Italiano](SPEC.md) · [English](SPEC.en.md)

> La v2.0 implementa l'intera specifica (RF1–RF6), simulatore incluso.

## Installazione

1. **Impostazioni → App (Add-on) → Store → ⋮ → Repository**
2. Aggiungi `https://github.com/dvbit/ha-astrion-config-manager`
3. Installa **Astrion Config Manager**, avvialo e apri **Astrion** nella barra laterale.

Su ogni telecomando abilita il **config server** dell'app (porta 8080, pagina impostazioni).
Schema seguito: release upstream **1.3.0** ( campi delle card rigenerati con `tools/extract_card_schema.py`). Le chiavi aggiunte dalle beta sono ignorate dalle app più vecchie.

## Funzioni

| Area | Cosa offre |
| --- | --- |
| Telecomandi | Più telecomandi (nome, IP, porta, risoluzione, orientamento, IP Harmony, entità IR). Archiviazione al posto della cancellazione. |
| Storico | Ogni modifica è una versione salvata come delta JSON Patch; snapshot ogni 50. Anche undo/redo sono versioni. Ripristino di qualsiasi versione in un passo. |
| Versioni con nome | Etichette per le tappe ("Prima del cambio TV"), filtro, ripristino. I nomi non alterano la storia. |
| Editor | Menu per i valori fissi, tavolozze colore (card e tema). Form per pagine, card (21 tipi, campi ricavati dai renderer upstream), hotkey, dispositivi IR, Attività, tema; JSON grezzo per tutto. Card e campi sconosciuti restano intatti. |
| Validazione | Struttura + esistenza in HA di ogni entità citata. Push bloccato in caso di errori. |
| Sync | Pull e Push dalla scheda Sincronizzazione, dall'elenco o dall'intestazione del telecomando; push con verifica tramite rilettura, deriva via SHA-256 canonico. La deriva è solo segnalata. |
| Icone | Libreria condivisa (nei backup), selettore con anteprime, caricamento automatico delle icone mancanti al push, importazione da un telecomando. |
| Catalogo entità | Form per `haDevices` (entità con nome usate dal web builder del telecomando), validato su HA. |
| Simulatore | La testa resa alla risoluzione del telecomando con stati HA live; tocchi e tasti HA100 eseguono **realmente** su HA, Hub Harmony ed emettitore IR Broadlink. |
| Dock e standby (1.2.7) | Sezioni "Schermo dock" e "Standby e batteria"; pagine nascoste del tutto (`hideMode: full`); pulsanti Off (`stopActivity`); eventi hotkey verso HA; layout Apple TV compact/full con scorciatoie app; identità del telecomando e rilevamento duplicati; eliminazione icone sui telecomandi. |
| Cronologia telecomando (1.3.0) | Le versioni conservate dal telecomando elencate nello Storico: push etichettati `ACM v<n>`, versioni con nome fissabili, disallineamento spiegato, ogni versione confrontabile e importabile. |
| Mappa di navigazione | Sopra Editor e Simulatore: ogni pagina come anteprima live, un'icona per ogni modo di raggiungerla (swipe, tocco, pressione lunga, tasto, Activity, stato HA, popup, indietro); zoom, spostamento, clic per modificare. |
| Temi | Libreria di temi condivisa con predefiniti: carica / salva / elimina nell'Editor, scheda Temi per anteprima, esporta, importa e applica a più telecomandi. |
| Lingue | Inglese, italiano, francese, spagnolo, tedesco (segue la lingua di HA). |

## Esempi d'uso

### 1. Registrare un telecomando

**+ Aggiungi telecomando** → `Salotto`, `192.168.2.50`, porta `8080`,
`480`×`800`, verticale. Il pull iniziale crea la **v1** (`import`). Se il
telecomando non risponde o non ha `dashboard.json`, non viene registrato nulla.

### 2. Modificare e annullare

Cambia il `name` di una card e premi Invio → **v2** (`edit`). **Annulla
ultima** → **v3** (`undo`) con lo stato precedente. **Ripeti** → **v4**
(`redo`). Una nuova modifica azzera i ripeti.

### 3. Dare un nome a una tappa e tornarci

Storico → v12 → **Nome…** → `Prima del cambio TV`. Settimane dopo:
**Ripristina** sulla versione con nome → nuova versione `restore` con
esattamente quello stato.

### 4. Copiare una pagina su un altro telecomando

Editor → pagina → **Copia su telecomando…** → `Camera`. Sulla destinazione
nasce una sola versione; i nomi in conflitto ricevono un suffisso (`Home 2`),
collegamenti e dispositivi IR usati dalla pagina vengono copiati e riallineati.

### 5. Deriva

Qualcuno ha modificato il telecomando dal suo web builder. L'elenco mostra
**Modificato sul dispositivo**; nel telecomando scegli **Importa come
versione** (`sync-import`), **Sovrascrivi con la testa** (push) o **Ignora**.

### 6. Push bloccato da un'entità mancante

```json
{ "type": "light", "options": { "entity_id": "light.vecchia_lampada" } }
```

`light.vecchia_lampada` non esiste più in HA → *Entità inesistente in Home
Assistant* sul campo; **Invia** resta disabilitato finché non si corregge.

### 7. Simulatore

Apri la scheda **Simulatore**. Lo schermo mostra la testa con gli stati live.
Tocca una luce → `light.toggle` viene eseguito su HA e la card si aggiorna. Una
scena con `"activity": "guarda_tv"` esegue l'Attività composta (accensioni,
ingressi, ritardi) e passa alla sua pagina. Scorri di lato per le pagine, in
alto per la pagina collegata; tieni premuto un tasto HA100 per l'hotkey lungo. Attiva **Solo navigazione**
per provare il flusso senza agire sui dispositivi: le azioni vengono elencate,
non eseguite.

I campi opzionali del telecomando abilitano le altre azioni:

| Campo | Esempio | Abilita |
| --- | --- | --- |
| Hub letti dal telecomando | *Hub Salotto*, *Hub Camera* | `harmonyCommand`, `activityId`, card Apple TV, instradati da `hub` |
| IP Hub Harmony (riserva) | `192.168.2.30` | gli stessi, se il telecomando non ha hub |
| Extender letti dal telecomando | *Ext TV* | dispositivi IR con `target: {"extender": ...}` |
| Entità emettitore IR | `remote.broadlink_salotto` | dispositivi IR con destinazione `local` (codici inline o ir-database) |

Senza questi campi i pulsanti appaiono disabilitati con il motivo. I codici IR
sono convertiti in pacchetti Broadlink `b64:`; la portante è fissata dal
dispositivo Broadlink (~38 kHz).

### 8. Icone e catalogo entità

Scheda **Icone** → carica `disco.png`. In una `button_grid` metti il cursore
dentro `"icon": ""` di un pulsante e premi **🖼 Inserisci icona** → `disco.png`:

```json
{ "name": "Disco", "icon": "/sdcard/astrion/icons/disco.png", "service": "scene.turn_on", "entity_id": "scene.disco" }
```

Al **push** l'add-on carica `disco.png` sul telecomando se manca. Hai già icone
su un telecomando? **Sincronizzazione → Importa nella libreria**.

**Editor → Dispositivi HA (catalogo)** → aggiungi `TV Salotto`, tipo *Media
Player*, entità `media_player.tv`. La voce finisce in `haDevices` ed è proposta
con ★ in tutti i campi entità.

### 9. Novità con l'app 1.2.7-beta

**Schermo dock** — *Editor → Globale → Schermo dock*: modalità `clock`, meteo
`weather.home`. Salvato come:

```json
"dock": { "mode": "clock", "weather_entity": "weather.home", "time_format": 24 },
"power": { "screen_timeout_seconds": 60, "screen_off_entities": ["binary_sensor.tv_on"] }
```

Nel **Simulatore** spunta **Sulla base** per vederne l'anteprima (tocca lo schermo per uscire).

**Pulsante Off stile Harmony** — una tile scena con `"stopActivity": "Salotto"`
(o `"*"` per tutte le stanze) ferma l'Activity della stanza: stop composto o
PowerOff Harmony. La stanza si sceglie dal menu.

**Pagina visibile solo durante la sua Activity** — pagina *TV*:
`hiddenUnlessActivity` `guarda_tv`, `hideMode` `full`: gli swipe la saltano a
Activity spenta e il telecomando la lascia quando l'Activity si ferma.

**Evento da hotkey per le automazioni** — hotkey `VOICE (Microfono)` con
`"event": "voice"`; un'automazione lo intercetta:

```yaml
triggers:
  - trigger: event
    event_type: astrion_button
    event_data:
      event: voice
actions:
  - action: assist_satellite.start_conversation
    target:
      entity_id: assist_satellite.cucina
```

**Telecomando Apple TV compatto con app**:

```json
{ "type": "apple_tv_remote", "options": { "deviceId": "62846050", "layout": "compact",
  "entity": "media_player.apple_tv", "apps": [ { "source": "Netflix", "color": "#B3261E" } ] } }
```

**Stati dei dispositivi** — i dispositivi IR con profilo si avviano stile
Harmony; il simulatore ricorda quali dispositivi ritiene accesi (pannello sotto
lo schermo). Se un dispositivo è stato acceso o spento a mano, premi **Azzera
stati dispositivi**.

### 10. Push / pull rapidi e opzioni 1.2.8–1.2.9

**Push / Pull** sono su ogni telecomando dell'elenco e nell'intestazione del
telecomando aperto: una modifica fatta nell'Editor o provata nel Simulatore si
invia senza aprire Sincronizzazione. Un push su un telecomando modificato dal
suo lato chiede prima conferma.

**Popup da hotkey** (il tasto blu apre la pagina AV sopra quella corrente; ripremi per chiudere):

```json
{ "key": "BLUE_BUTTON", "page": "AV", "pageMode": "popup" }
```

**L'orologio dock segue la stanza** — `dock.room` "Salotto" e, sull'Activity,
`"nowPlayingEntity": "media_player.apple_tv"`: mentre quell'Activity è attiva,
l'orologio sulla base mostra solo quel player.

**Monitor con valori lunghi** e **select come semplice menu**:

```json
{ "type": "monitor", "options": { "layout": "vertical", "marquee": true,
  "entities": [ { "entity_id": "sensor.avr_audio", "name": "Audio" } ] } }
{ "type": "select", "options": { "entity_id": "input_select.scena", "layout": "dropdown", "font_size": 18 } }
```

### 11. Due cronologie: add-on e telecomando (app 1.3.0)

Dalla 1.3.0 il telecomando conserva una propria cronologia di `dashboard.json`.
La cronologia dell'add-on resta il riferimento; quella del telecomando è una
rete di sicurezza che l'add-on legge ed etichetta.

| | Add-on | Telecomando 1.3.0 |
| --- | --- | --- |
| Conservazione | Tutto, per sempre (nei backup di HA) | 30 + fissate |
| Archiviazione | Differenze tra versioni | Copie complete |
| Etichette | Nomi univoci per telecomando | Note libere, versioni fissate |
| Ambito | Tutti i telecomandi, copia tra di essi | Solo quel telecomando |
| Registra le modifiche fatte sul telecomando | Solo quando emergono come disallineamento | Sì, ogni salvataggio |

- Ogni push viene etichettato sul telecomando: `ACM v42 · "Prima del cambio TV"`.
- **Modifica telecomando → Fissa le versioni con nome sul telecomando**: le
  versioni con nome inviate vengono fissate lì, così il limite di 30 versioni
  del telecomando non le elimina mai.
- Banner di disallineamento: *"Salvata dal builder o dalla pagina web: nuove luci"*,
  *"Ripristinata sul telecomando dalla versione 20261017-101500"*, …
- **Storico → Cronologia del telecomando**: confronta qualsiasi versione del
  telecomando con la testa, scaricala o **Importa come versione** (poi invia).
  L'add-on non ripristina né elimina nulla nella cronologia del telecomando.

### 12. Mappa di navigazione

Apri un telecomando: la **🗺 Mappa di navigazione** sta sopra l'Editor. Tutte le
pagine sono su una riga nell'ordine in cui il telecomando le scorre, ognuna
disegnata come schermo live in miniatura. Le icone sulle linee dicono come si
raggiunge una pagina: 👋 swipe, ☝️ swipe in alto, 👆 tocco, ✋ pressione lunga,
🎛 tasto ("Menu ⏱" = pressione lunga di Menu), 🎬 Activity, 🏠 stato di Home
Assistant, ↩ indietro; una linea tratteggiata con ▣ apre un popup. Clic su una
card in anteprima per modificarla, o su una linea per aprire la tile o la
hotkey che la crea. Nel Simulatore il clic su una pagina la mostra. ▴ nasconde
la mappa; trascina il bordo inferiore per ridimensionarla.

**Modifiche sulla mappa** (scheda Editor):

- trascina il ● destro di *Home* sul ● sinistro di *TV* → *TV* diventa la vicina di swipe di *Home*;
- trascina il tasto **Play / Pausa** (riga globale) sul ● inferiore di *TV* → scegli
  *Lunga* + *Popup* → `{"key": "PLAY", "page": "TV", "pageMode": "popup"}` in `longHotkeys`;
- trascina la tile *Film* di una scene grid sul ● superiore di *Cinema* → scegli *Tocco* →
  la tile riceve `"page": "Cinema"`;
- tieni premuta l'icona di un collegamento → conferma → il collegamento è rimosso.

Ogni modifica è una versione: **Annulla** la ripristina.

### 13. Temi

**Editor → Globale → Tema → 📂 Carica tema** → scegli *OLED black* (anteprima a
destra) → una nuova versione, Annulla riporta i colori precedenti. **💾 Salva
come…** salva i colori attuali come *Salotto*. Nella schermata principale,
**Temi** → *Salotto* → **Applica ai telecomandi…** → spunta *Cucina* e *Camera*
→ ognuno riceve una versione, pronta da inviare. **Esporta** produce un file come:

```json
{ "name": "Salotto", "theme": { "background": "#000000", "accent": "#4DA3FF" } }
```

che **Importa da file** rilegge (va bene anche un intero `dashboard.json`).

## Dati e backup

Tutto risiede nel volume `/data` dell'app (incluso nei backup HA). Scritture
atomiche (file temporaneo + fsync + rename): una versione esiste per intero o
non esiste. Gli stati dispositivi del simulatore sono in `/data/sim_state/`, i temi salvati in `/data/themes/`. Struttura dei file: vedi [README inglese](README.md#data-and-backups).

## Log

Opzione `log_level` (`trace`…`error`). INFO: versioni, push/pull, archivio.
WARNING: deriva, push bloccati, commit rifiutati, HA non raggiungibile.
ERROR: verifica push fallita. DEBUG: chiamate HTTP, ricostruzioni di stato.

## Sviluppo

```bash
pip install -r astrion_config_manager/requirements.txt pytest pytest-aiohttp ruff
pytest -q && ruff check .
cd astrion_config_manager/app && ACM_ALLOW_ANY=1 ACM_DATA_DIR=/tmp/acm python3 -m acm
```

I workflow CI sono in `ci/` (da spostare in `.github/workflows/`).

## Licenza

GPL-3.0, come il progetto upstream da cui deriva lo schema dell'editor.
