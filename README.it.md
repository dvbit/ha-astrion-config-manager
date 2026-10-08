<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

**App (add-on)** per Home Assistant che gestisce il `dashboard.json` di uno o
più telecomandi **Astrion HA100** con
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
editor a form, storico completo con undo/redo e versioni con nome, validazione
sulle entità HA, push/pull con rilevamento della deriva.

🇬🇧 [English version](README.md) · 📄 Specifica: [Italiano](SPEC.md) · [English](SPEC.en.md)

> La v2.0 implementa l'intera specifica (RF1–RF6), simulatore incluso.

## Installazione

1. **Impostazioni → App (Add-on) → Store → ⋮ → Repository**
2. Aggiungi `https://github.com/dvbit/ha-astrion-config-manager`
3. Installa **Astrion Config Manager**, avvialo e apri **Astrion** nella barra laterale.

Su ogni telecomando abilita il **config server** dell'app (porta 8080, pagina impostazioni).
Schema seguito: release upstream **1.2.0** e beta **1.2.1-beta** (campi delle card rigenerati con `tools/extract_card_schema.py`).

## Funzioni

| Area | Cosa offre |
| --- | --- |
| Telecomandi | Più telecomandi (nome, IP, porta, risoluzione, orientamento, IP Harmony, entità IR). Archiviazione al posto della cancellazione. |
| Storico | Ogni modifica è una versione salvata come delta JSON Patch; snapshot ogni 50. Anche undo/redo sono versioni. Ripristino di qualsiasi versione in un passo. |
| Versioni con nome | Etichette per le tappe ("Prima del cambio TV"), filtro, ripristino. I nomi non alterano la storia. |
| Editor | Menu per i valori fissi, tavolozze colore (card e tema). Form per pagine, card (21 tipi, campi ricavati dai renderer upstream), hotkey, dispositivi IR, Attività, tema; JSON grezzo per tutto. Card e campi sconosciuti restano intatti. |
| Validazione | Struttura + esistenza in HA di ogni entità citata. Push bloccato in caso di errori. |
| Sync | Pull, push con verifica tramite rilettura, deriva via SHA-256 canonico. La deriva è solo segnalata. |
| Icone | Libreria condivisa (nei backup), selettore con anteprime, caricamento automatico delle icone mancanti al push, importazione da un telecomando. |
| Catalogo entità | Form per `haDevices` (entità con nome usate dal web builder del telecomando), validato su HA. |
| Simulatore | La testa resa alla risoluzione del telecomando con stati HA live; tocchi e tasti HA100 eseguono **realmente** su HA, Hub Harmony ed emettitore IR Broadlink. |
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

## Dati e backup

Tutto risiede nel volume `/data` dell'app (incluso nei backup HA). Scritture
atomiche (file temporaneo + fsync + rename): una versione esiste per intero o
non esiste. Struttura dei file: vedi [README inglese](README.md#data-and-backups).

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
