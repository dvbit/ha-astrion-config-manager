<img src="astrion_config_manager/logo.png" alt="Astrion Config Manager" width="250">

# Astrion Config Manager

**App (add-on)** di Home Assistant per i telecomandi **Astrion HA100** con
[astrion-custom-dashboard](https://github.com/dckiller51/astrion-custom-dashboard):
**mappa delle pagine** a schermo intero, **collegamento delle pagine** con il
trascinamento, **test di navigazione** a schermo intero e il **builder** del
telecomando integrato in Home Assistant.

🇬🇧 [English version](README.md) · 📄 Specifica: [Italiano](SPEC.md) · [English](SPEC.en.md)

> **3.0 — cambio di ambito.** Il builder dell'app Astrion ora gestisce molto bene la
> modifica delle singole schermate, quindi l'add-on non lo duplica più. L'editor a
> form e la cronologia delle versioni dell'add-on sono stati tolti: ogni schermata si
> modifica nel builder (integrato nella scheda **Builder**) e la cronologia la tiene il
> telecomando (app 1.3.0+). Qui resta ciò che il builder non fa: tutta la navigazione
> a colpo d'occhio, il collegamento delle pagine e il test della navigazione. Vedi
> [cosa cambia](#cosa-cambia-nella-30).

## Installazione

1. **Impostazioni → App (Componenti aggiuntivi) → Store → ⋮ → Repository**
2. Aggiungi `https://github.com/dvbit/ha-astrion-config-manager`
3. Installa **Astrion Config Manager**, avvialo, apri **Astrion** nella barra laterale.

Su ogni telecomando abilita il **config server** dell'app (porta 8080, pagina impostazioni).
Segue la **1.5.8-beta** (funziona con le 1.5.x; le schermate sono disegnate dal builder
installato su ciascun telecomando, quindi i nuovi tipi di card compaiono da soli).

## Funzioni

| Area | Cosa offre |
| --- | --- |
| Mappa | Ogni pagina disegnata dal renderer del builder del telecomando, un'icona per ogni modo di raggiungerla (👋 swipe, ☝️ swipe in alto, 👆 tocco, ✋ pressione lunga, 🎛 tasto, 🎬 Activity, 🏠 stato HA, 🧩 pagina di una card, ↩ indietro; tratteggio ▣ = popup). Zoom, spostamento, schermi trascinabili, ⇅ disposizione gerarchica, bande dei gruppi, ordine di swipe ①②③. |
| Collegamento | Trascina uno schermo su un altro: una finestra chiede quale elemento lo apre — un tile/pulsante (tocco o pressione lunga), un tasto fisico (questa pagina o globale, breve o lungo), lo swipe in alto o il genitore (Indietro) — come pagina o popup, e mostra cosa sostituisce. |
| Taglio | Tieni premuta l'icona di un collegamento per toglierlo (anche quelli di una card, come la pagina ⋯ del media remote). |
| Scritture | Direttamente sul telecomando con una nota (`ACM: Home → TV · Tocco "TV"`); rifiutate se il telecomando è cambiato dopo il caricamento. Annulla = cronologia del telecomando (Builder → 🕘 Cronologia). |
| Simula | Test di navigazione a schermo intero: tocca / tieni premuti i tile, scorri sullo schermo, tasti HA100, popup alla loro dimensione e posizione, overlay Activity. Nulla viene inviato ai dispositivi. |
| Builder | Il builder del telecomando dentro l'add-on (funziona in HTTPS). Salvando lì, mappa e simulazione si aggiornano subito. |
| Temi | Libreria condivisa di temi con preset: anteprima sul tuo telecomando, esporta, importa, applica a più telecomandi. |
| Icone | Libreria condivisa di icone (inclusa nei backup). |
| Lingue | Inglese, italiano, francese, spagnolo, tedesco (segue la lingua di HA). |

## Esempi d'uso

### 1. Registra un telecomando

**＋ Aggiungi telecomando** → nome *Soggiorno*, IP `192.168.2.50`, porta `8080`,
dimensione `480×800`, verticale → **Registra**. Il telecomando deve essere raggiungibile.

### 2. Leggi la navigazione

**🗺 Apri** → tutte le pagine nell'ordine di swipe. *Home* → 👆 *TV* significa che un
tile di Home apre TV; una linea tratteggiata con ▣ apre un popup. **⇅ Disponi per
gerarchia** mette le figlie sotto il genitore (⟲ torna a una riga).

### 3. Collega due pagine

Trascina lo schermo *Home* su *TV* → scegli:

- **Tile / pulsante** *TV* · *Tocco* · apri come *Pagina* → il tile riceve `"page": "TV"`;
- oppure **Tasto fisico** *Play / Pausa* · *Lungo* · *Globale* · *Popup* →
  `{"key": "PLAY", "page": "TV", "pageMode": "popup"}` in `longHotkeys`;
- oppure **Swipe in alto** → `"linkedPage": "TV"` su Home;
- oppure **Genitore** → Home diventa figlia di TV (tasto Indietro, gruppo di pallini).

**Collega** → scritto sul telecomando con la nota `ACM: Home → TV · …`. Trascinando da un
tile, quel tile è già selezionato. Le ancore ● laterali cambiano ancora l'ordine di swipe.

### 4. Taglia un collegamento

Tieni premuta l'icona del collegamento → **Rimuovi** → scritto sul telecomando.

### 5. Prova la navigazione

**▶ Simula** → lo schermo del telecomando a grandezza piena. Tocca *TV*, tieni premuto un
tile per la pressione lunga, scorri a sinistra / destra / in alto (pagina collegata) / in
basso (Activity), premi **↩**. Le azioni che non cambiano pagina sono solo indicate
(*non eseguito*).

### 6. Modifica una schermata

**🛠 Builder** → il builder del telecomando si apre sulla pagina selezionata nella mappa.
Salva: mappa e simulazione si aggiornano subito. **🕘 Cronologia** apre la cronologia del
telecomando (lì si annulla un collegamento scritto dall'add-on).

### 7. Temi

**Temi** → *OLED black* → **Applica ai telecomandi…** → spunta *Cucina* → scritto sul
telecomando (`ACM: theme OLED black`). **Esporta** produce:

```json
{ "name": "Soggiorno", "theme": { "background": "#000000", "accent": "#4DA3FF" } }
```

## Cosa cambia nella 3.0

| Rimosso | Al suo posto |
| --- | --- |
| Editor a form, anteprima grande, copia card | Il builder del telecomando (scheda **Builder**) |
| Versioni dell'add-on, annulla/ripeti, versioni con nome, ripristino | La cronologia del telecomando (Builder → 🕘 Cronologia) |
| Push / pull, disallineamento, modalità "modifica con il builder" | Ogni modifica è scritta direttamente sul telecomando |
| "Simula ed esegui" (azioni reali sui dispositivi) | Test di sola navigazione |

I dati esistenti in `/data` (vecchie versioni) non vengono toccati.

## Dati e backup

`/data` (incluso nei backup di HA): `remotes/<id>/meta.json` (telecomando, disposizione
della mappa), `icons/` (libreria icone), `themes/` (temi salvati). Le versioni scritte
dalla 2.x restano su disco, inutilizzate.

## Log

Opzione `log_level` (`trace`…`error`). INFO: scritture sui telecomandi (con nota),
salvataggi del builder visti dal proxy, registrazione. WARNING: scrittura rifiutata
(telecomando cambiato), telecomando non raggiungibile, errori del proxy. DEBUG:
richieste inoltrate, letture.

## Sviluppo

```bash
pip install -r astrion_config_manager/requirements.txt pytest pytest-aiohttp ruff
pytest -q && ruff check .
cd astrion_config_manager/app && ACM_ALLOW_ANY=1 ACM_DATA_DIR=/tmp/acm python3 -m acm
```

I workflow CI sono in `ci/` (da spostare in `.github/workflows/`).

## Licenza

GPL-3.0, come il progetto upstream.
