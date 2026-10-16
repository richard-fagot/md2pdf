/*
 * rfa-pdf-export – Plugin Obsidian
 * Exporte la note active en PDF via Pandoc + Typst.
 *
 * Propriétés frontmatter attendues dans la note :
 *   titre      : Titre principal  (défaut : nom du fichier)
 *   sous_titre : Sous-titre       (défaut : "")
 *   version    : Version          (défaut : "1.0")
 *
 * La date est toujours celle du jour (format JJ/MM/AAAA).
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require("obsidian");
const path  = require("path");
const fs    = require("fs");
const os    = require("os");
const cp    = require("child_process");

// ─── Paramètres par défaut ────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  pandocPath : "",          // vide = exécutable embarqué dans le répertoire du plugin
  typstPath  : "",          // vide = exécutable embarqué dans le répertoire du plugin
  templateDir: "",          // vide = sous-dossier « modele/ » du plugin (sinon répertoire de la note)
  outputDir  : "",          // vide = même répertoire que la note
  openAfter  : true,
  pdfViewer  : "",          // vide = application par défaut du système
};

// ─── Rétroliens de section (« Référencé par … ») ───────────────────────────────
// Recrée dans le PDF ce que le plugin « Section Backlinks » affiche à l'écran :
// à la fin de chaque section portant une ancre de bloc (## Titre ^id), la liste
// des sections qui la référencent.
//
// Le PDF ne contient qu'UNE note. Les renvois sont donc traités ainsi :
//   • Renvoi depuis la MÊME note   → SAUT INTERNE cliquable vers la section, dans
//                                    le PDF (via une étiquette invisible posée
//                                    sous le titre source).
//   • Renvoi depuis une AUTRE note → la section cible n'est pas dans ce PDF : rien
//                                    à atteindre. Affiché en TEXTE simple (aucun
//                                    lien mort), ou masqué (BACKLINK_INCLUDE_EXTERNAL).
const INJECT_SECTION_BACKLINKS   = true;       // false → désactive complètement.
const BACKLINK_INCLUDE_EXTERNAL  = true;       // false → n'affiche QUE les renvois de la même note.
const BACKLINK_LINK_COLOR        = "#1a5fb4";  // "" → pas de couleur.

// ─── Registre des types de notes ───────────────────────────────────────────────
// Associe la valeur de la propriété frontmatter `type` à :
//   - model : le fichier modèle Typst (que VOUS créez, déposé dans modele/)
//   - fn    : la fonction Typst appelée (définie dans ce modèle)
//   - props : la liste ORDONNÉE des propriétés frontmatter passées en arguments
//             positionnels, dans l'ordre attendu par la fonction Typst.
//   - titleProps (facultatif) : propriétés utilisées pour nommer le PDF de sortie
//             (par défaut : `props`).
//
// Le plugin génère alors automatiquement l'appel :
//     #show: doc => fn(prop1, prop2, …, doc)
//
// Ce registre n'est PAS exposé dans les réglages : il est figé dans le plugin.
// Pour ajouter un type, ajoutez une entrée ci-dessous (clé = valeur de `type`,
// en minuscules) et créez le fichier modèle correspondant dans modele/.
const NOTE_TYPES = {
  // Compte rendu → compte_rendu(projet, titre, sous_titre, version, statut, date, doc)
  // L'ordre de `props` doit correspondre EXACTEMENT à l'ordre des paramètres
  // de la fonction Typst, et chaque nom doit correspondre à une propriété du
  // frontmatter de la note.
  compte_rendu: {
    model     : "compte_rendu.typ",
    fn        : "compte_rendu",
    props     : ["projet", "sujet", "type", "version", "statut", "date_de_la_réunion"],
    titleProps: ["type", "sujet", "version", "statut"],
  },

  // Type par défaut : note sans propriété `type` (ou `type` inconnu).
  // obsidian.typ ne fournit plus de fonction de rendu « clé en main » (c'est
  // désormais une bibliothèque de blocs : setTemplate, project, subtitle…), donc
  // le défaut se rabat sur le modèle « compte_rendu » pour rester fonctionnel.
  // Pour un vrai gabarit par défaut, créez un modele/defaut.typ (sur le modèle
  // de compte_rendu.typ) et faites pointer `_default` dessus.
  _default: {
    model     : "compte_rendu.typ",
    fn        : "compte_rendu",
    props     : ["projet", "titre", "sous_titre", "version", "statut", "date"],
    titleProps: ["titre", "version"],
  },

  specifications_generales: {
    model     : "specifications_generales.typ",
    fn        : "specifications_generales",
    props     : ["projet", "sujet", "titre", "sous_titre", "version", "statut", "date"],
    titleProps: ["titre", "version"],
  },
  
  // ───── À COMPLÉTER : ajoutez ici vos autres types de notes ─────
  // Exemple (adaptez fn, props et le nom du fichier modèle à votre convention).
  // Rappel : `props` = paramètres de la fonction Typst, dans le même ordre.
  //
  //
  // specifications_detaillees: {
  //   model     : "specifications_detaillees.typ",
  //   fn        : "specifications_detaillees",
  //   props     : ["projet", "titre", "sous_titre", "version", "statut", "date"],
  //   titleProps: ["titre", "version"],
  // },
};

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/** Retourne la date du jour au format JJ/MM/AAAA */
function todayFR() {
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Noms candidats pour un exécutable selon la plateforme.
 *  Sous Windows on essaie .exe / .cmd / .bat puis le nom nu. */
function exeCandidates(base) {
  if (process.platform === "win32") {
    return [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base];
  }
  return [base];
}

/** Recherche récursive (profondeur limitée) d'un exécutable nommé `base`
 *  dans `rootDir`. Permet de trouver pandoc/typst dans un sous-dossier
 *  versionné (p. ex. « typst-3.14.2/ », « pandoc-3.10/ ») sans coder en
 *  dur le nom du dossier. Retourne le chemin absolu ou null. */
function findExecutable(rootDir, base, maxDepth = 4) {
  const wanted = new Set(exeCandidates(base).map(c => c.toLowerCase()));

  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return null; }

    // 1. Fichiers de ce niveau (priorité au niveau le moins profond)
    for (const e of entries) {
      if (e.isFile() && wanted.has(e.name.toLowerCase())) {
        return path.join(dir, e.name);
      }
    }
    // 2. Sous-répertoires
    if (depth >= maxDepth) return null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const found = walk(path.join(dir, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(rootDir, 0);
}

/** Nettoie un titre de section pour l'affichage dans un rétrolien :
 *  retire l'ancre de bloc en fin de titre (« ^id ») et tronque après un
 *  éventuel séparateur « — ». Doit rester identique au plugin Section
 *  Backlinks pour que les chemins de section soient affichés à l'identique. */
function cleanHeadingTitle(raw) {
  let t = String(raw).replace(/\s*\^[A-Za-z0-9_-]+\s*$/, "");
  const dashMatch = /^(.*?)\s+—\s+.*$/.exec(t);
  if (dashMatch) t = dashMatch[1];
  return t.trim();
}

// ─── Plugin principal ─────────────────────────────────────────────────────────
class PandocTypstExportPlugin extends Plugin {

  async onload() {
    await this.loadSettings();

    // Commande via palette
    this.addCommand({
      id   : "export-pdf-pandoc-typst",
      name : "Exporter en PDF (Pandoc + Typst)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === "md") {
          if (!checking) this.exportCurrentFile();
          return true;
        }
        return false;
      },
    });

    // Entrée dans le menu contextuel (clic droit sur un fichier .md)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Exporter en PDF (Pandoc + Typst)")
              .setIcon("file-down")
              .onClick(() => this.exportFile(file));
          });
        }
      })
    );

    // Onglet de paramètres
    this.addSettingTab(new PandocTypstSettingTab(this.app, this));
  }

  // ── Export du fichier actif ──────────────────────────────────────────────
  async exportCurrentFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Aucun fichier actif.");
      return;
    }
    await this.exportFile(file);
  }

  // ── Cœur de l'export ────────────────────────────────────────────────────
  async exportFile(file) {
    // ── 1. Lire le contenu brut de la note ──────────────────────────────
    const rawContent = await this.app.vault.read(file);

    // ── 2. Extraire le frontmatter ───────────────────────────────────────
    // On utilise d'abord le parseur YAML natif d'Obsidian (metadataCache),
    // qui gère correctement guillemets, accents, types, listes, etc.
    // Repli sur le parseur maison si le cache n'est pas (encore) disponible.
    const cache = this.app.metadataCache.getFileCache(file);
    const rawFront = (cache && cache.frontmatter)
      ? cache.frontmatter
      : this.parseFrontmatter(rawContent);

    // Normaliser les CLÉS du frontmatter : minuscules + espaces remplacés
    // par « _ » (même traitement que pour la valeur de `type`). Ainsi une
    // propriété notée « Sous titre », « Projet » ou « SOUS TITRE » dans la
    // note correspond aux clés attendues (sous_titre, projet, …).
    const normKey = (k) => String(k).trim().toLowerCase().replace(/\s+/g, "_");
    const meta = {};
    for (const [k, v] of Object.entries(rawFront)) {
      meta[normKey(k)] = v;
    }

    // Chemin absolu de la note
    const vaultPath  = this.app.vault.adapter.basePath;
    const notePath   = path.join(vaultPath, file.path);
    const noteDir    = path.dirname(notePath);
    const baseName   = file.basename;   // sans extension

    // Répertoire de sortie du PDF. Calculé tôt car il sert aussi de point de
    // référence pour les liens RELATIFS vers les annexes (cf. §5c) : ces liens
    // doivent rester valides quand le PDF et les annexes sont livrés ensemble
    // en conservant la même arborescence.
    const outputDir = this.settings.outputDir
      ? this.settings.outputDir
      : noteDir;

    // ── 3. Dictionnaire de valeurs (frontmatter + valeurs calculées) ─────
    const vars = Object.assign({}, meta);
    vars.titre = meta.titre || baseName;        // défaut = nom du fichier
    if (!vars.date)    vars.date    = todayFR(); // défaut = date du jour
    if (!vars.version) vars.version = "1.0";     // défaut historique

    // ── 3a. Déterminer le type de note et le modèle Typst associé ────────
    // Normalisation : minuscules + espaces remplacés par « _ »
    // (ainsi « Compte rendu » dans le frontmatter correspond à la clé « compte_rendu »).
    const typeKey = String(meta.type || "").trim().toLowerCase().replace(/\s+/g, "_");
    const spec    = NOTE_TYPES[typeKey] || NOTE_TYPES._default;

    // ── 3b. Supprimer le frontmatter du contenu passé à Pandoc ──────────
    // Pandoc injecte automatiquement title/subtitle/date dans $body$ quand
    // il trouve des métadonnées YAML, ce qui double la page de titre et le
    // sommaire générés par obsidian.typ. On passe donc à Pandoc un fichier
    // dont le frontmatter est entièrement supprimé.
    const bodyOnly = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

    // ── 3c. Largeur des colonnes des tableaux ───────────────────────────
    // Le calcul est désormais fait par obs-table() dans obsidian.typ, à partir
    // des métriques RÉELLES de la fonte (measure() côté Typst). L'ancien hack
    // qui réécrivait la ligne de tirets « |---|---| » pour piloter les largeurs
    // émises par Pandoc est donc supprimé : ces largeurs sont ignorées, seul
    // leur NOMBRE (= nombre de colonnes) est utilisé.
    //
    // Injection des rétroliens de section (« Référencé par … »). Non bloquant :
    // en cas d'échec, on exporte sans les rétroliens plutôt que de faire échouer
    // toute la conversion.
    let bodyNorm = bodyOnly;
    try {
      bodyNorm = this.injectSectionBacklinks(bodyOnly, file, rawContent);
    } catch (e) {
      console.error("[rfa-pdf-export] Injection des rétroliens impossible :", e);
    }

    // ── 4. Répertoire du template ────────────────────────────────────────
    // Réglage explicite > sous-dossier « modele/ » embarqué > répertoire de la note.
    const pluginDir = this.getPluginDir();
    const embeddedModele = path.join(pluginDir, "modele");
    let templateDir;
    if (this.settings.templateDir) {
      templateDir = this.settings.templateDir;
    } else if (fs.existsSync(embeddedModele)) {
      templateDir = embeddedModele;
    } else {
      templateDir = noteDir;
    }

    // Le fichier modèle dépend du type de note (cf. registre NOTE_TYPES).
    const modelFile = path.join(templateDir, spec.model);
    if (!fs.existsSync(modelFile)) {
      new Notice(
        `Modèle Typst introuvable : ${spec.model}\n` +
        `(type de note : « ${typeKey || "défaut"} »)\n` +
        `attendu dans : ${templateDir}`,
        9000
      );
      return;
    }

    // ── 5. Générer le template.typ qui appelle la fonction du modèle ─────
    // Forme générée :
    //   #import "obsidian.typ": callout      (si présent — pour les callouts du corps)
    //   #import "<model>": <fn>
    //   #show: doc => <fn>(prop1, prop2, …, doc)
    //   $body$
    const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // Une propriété vide d'Obsidian vaut `null` (pas `undefined`) : on traite
    // null comme undefined → chaîne vide, pour ne pas écrire « null » dans le PDF.
    const argValues = spec.props.map(p => {
      const v = vars[p];
      return `"${esc(v === undefined || v === null ? "" : v)}"`;
    });
    const argList   = [...argValues, "doc"].join(", ");
	console.log(argList);
    // callout() et horizontalrule sont définis dans obsidian.typ et utilisés
    // par le corps : callout() via callouts.lua, et #horizontalrule émis par
    // Pandoc pour chaque séparateur « --- ».
    // obsidian.typ fournit callout(), horizontalrule et obs-table(). S'il est
    // absent, on n'importe rien — et la substitution des tableaux du § 10 est
    // désactivée, faute de quoi le document appellerait une fonction inconnue.
    const hasObsidianLib = fs.existsSync(path.join(templateDir, "obsidian.typ"));
    const calloutImport = hasObsidianLib
      ? `#import "obsidian.typ": callout, horizontalrule, obs-table\n`
      : "";

    // obs-image : image redimensionnée « à la Obsidian » (![[img.png|300]],
    // ![[img.png|300x200]]). Les dimensions sont des PLAFONDS : l'image est
    // mise à l'échelle (ratio conservé) pour tenir dans la boîte w × h, et
    // jamais plus large que la largeur disponible (colonne, cellule…).
    // Défini ici (et non dans obsidian.typ) pour ne pas dépendre du modèle,
    // et parce que les chemins d'image sont résolus par rapport au fichier
    // qui appelle image() : document.typ, à la racine de tmpDir.
    // ATTENTION : template Pandoc → aucun « $ » dans ce code.
    const obsImageDef =
      `#let obs-image(path, w: none, h: none, alt: none) = layout(size => {\n` +
      `  let nat = measure(image(path))\n` +
      `  let ratios = (size.width / nat.width,)\n` +
      `  if w != none { ratios.push(w / nat.width) }\n` +
      `  if h != none { ratios.push(h / nat.height) }\n` +
      `  image(path, width: nat.width * calc.min(..ratios), alt: alt)\n` +
      `})\n`;

    const templateContent =
      calloutImport +
      obsImageDef +
      `#import "${spec.model}": ${spec.fn}\n` +
      `#show: doc => ${spec.fn}(${argList})\n` +
      `$body$\n`;

    // ── 6. Écrire le template temporaire dans un répertoire temp ─────────
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-typst-"));

    // Copier tous les fichiers .typ du templateDir dans tmpDir
    // (obsidian.typ, template.typ, et tout autre fichier requis)
    try {
      const typFiles = fs.readdirSync(templateDir).filter(f => f.endsWith(".typ"));
      for (const f of typFiles) {
        fs.copyFileSync(path.join(templateDir, f), path.join(tmpDir, f));
      }
      // Copier les ressources (logo, etc.) vers tmpDir/assets.
      // Les modèles Typst référencent image("assets/logo.webp") : les fichiers
      // doivent donc atterrir dans tmpDir/assets. On accepte plusieurs sources,
      // ce qui permet un dossier d'assets PARTAGÉ à la racine du plugin :
      //   - <pluginDir>/asset  ou  <pluginDir>/assets   (partagé, racine du plugin)
      //   - <templateDir>/assets                         (spécifique ; surcharge)
      // Quel que soit le nom de la source, le contenu est copié dans .../assets.
      const assetsDest = path.join(tmpDir, "assets");
      const assetSources = [
        path.join(pluginDir, "asset"),
        path.join(pluginDir, "assets"),
        path.join(templateDir, "assets"),
      ];
      const copyDirInto = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const e of fs.readdirSync(src, { withFileTypes: true })) {
          const s = path.join(src, e.name);
          const d = path.join(dest, e.name);
          if (e.isDirectory()) copyDirInto(s, d);
          else fs.copyFileSync(s, d);
        }
      };
      for (const src of assetSources) {
        if (fs.existsSync(src)) copyDirInto(src, assetsDest);
      }
    } catch (e) {
      new Notice(`Erreur lors de la copie des ressources Typst :\n${e.message}`);
      this.cleanTmp(tmpDir);
      return;
    }

    // Écraser template.typ avec notre version patchée
    const tmpTemplate = path.join(tmpDir, "template.typ");
    try {
      fs.writeFileSync(tmpTemplate, templateContent, "utf8");
    } catch (e) {
      new Notice(`Impossible d'écrire le template temporaire :\n${e.message}`);
      this.cleanTmp(tmpDir);
      return;
    }

    // ── 6-bis. Mise en scène des images dans le dossier temporaire ───────
    // Typst n'accepte PAS de chemin absolu du système de fichiers : toute
    // chaîne passée à image() est résolue par rapport à la RACINE du projet
    // (ici tmpDir, le cwd de Pandoc). Un chemin « C:/RFA/... » est donc
    // interprété comme « <tmpDir>/RFA/... » → « file not found ».
    // Solution : copier chaque image effectivement utilisée dans
    // <tmpDir>/images/ et n'émettre qu'un chemin RELATIF. Le nom de
    // destination est neutralisé (ni espace ni accent) et préfixé d'un
    // compteur, ce qui garantit l'unicité entre dossiers homonymes.
    const imagesDir = path.join(tmpDir, "images");
    const stagedImages = new Map();   // source absolue (clé normalisée) → chemin relatif
    const stageImage = (absPath) => {
      const key = path.resolve(absPath).toLowerCase();
      if (stagedImages.has(key)) return stagedImages.get(key);
      try {
        fs.mkdirSync(imagesDir, { recursive: true });
        const ext  = path.extname(absPath).toLowerCase();
        const base = path.basename(absPath, path.extname(absPath))
          .replace(/[^A-Za-z0-9_-]+/g, "_")
          .slice(0, 40);
        const name = `img${stagedImages.size}_${base}${ext}`;
        fs.copyFileSync(absPath, path.join(imagesDir, name));
        const rel = `images/${name}`;
        stagedImages.set(key, rel);
        return rel;
      } catch (e) {
        console.error("[rfa-pdf-export] Copie d'image impossible :", absPath, e);
        return null;
      }
    };
	
    // ── 5a-bis. Références de bloc Obsidian (ancres + renvois cliquables) ─
    // Convention utilisée dans les notes (syntaxe Obsidian native) :
    //   • Une ANCRE de bloc s'écrit  ^identifiant  — soit SEULE sur sa ligne,
    //     soit à la FIN d'une ligne (précédée d'une espace). Elle ne doit PAS
    //     apparaître dans le PDF. (La forme *^identifiant* est aussi acceptée.)
    //   • Un RENVOI vers cette ancre s'écrit comme un wikilink pointant sur le
    //     bloc :  [[#^identifiant|texte]]  ou  [[note#^identifiant|texte]].
    //
    // Traitement :
    //   • l'ancre devient un `metadata` Typst ÉTIQUETÉ, invisible et neutre en
    //     mise en page :  #metadata(none)<obsref-identifiant> ;
    //   • le renvoi devient un vrai lien cliquable  #link(<obsref-identifiant>)…,
    //     coloré pour être identifiable.
    //
    // Garde-fou : Typst échoue à la compilation si l'on pointe vers un label
    // inexistant. On ne génère donc un lien QUE si l'ancre correspondante est
    // définie dans CETTE note. Un renvoi vers l'ancre d'une AUTRE note (absente
    // du PDF mono-fichier) retombe sur l'ancien comportement (texte en italique).

    // Nom de label Typst dérivé d'un identifiant de bloc (préfixe = espace de
    // noms pour éviter toute collision avec les labels générés par Pandoc).
    const refSlug = (s) =>
      "obsref-" + String(s).toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    // Échappement pour une chaîne littérale Typst ("…").
    const typstStr = (s) =>
      '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    // Couleur des renvois internes (modifiable). "" pour ne pas colorer.
    const REF_LINK_COLOR = "#1a5fb4";
    // Couleur des liens vers une annexe (fichier du vault livré à côté du PDF).
    // "" pour ne pas colorer.
    const ANNEXE_LINK_COLOR = "#1a5fb4";

    // Encode un chemin RELATIF (déjà normalisé en « / ») en URI : les espaces
    // et les caractères non-ASCII sont percent-encodés (%20, %C3%A9…), les « / »
    // sont conservés. C'est la forme conforme aux URI, décodée par les lecteurs
    // PDF courants (Acrobat, SumatraPDF, Edge…). Si votre lecteur n'ouvre pas
    // les chemins encodés, remplacez `encodeURI(p)` par `p` (chemin brut).
    const encodeRelPath = (p) => encodeURI(p);

    // Résout une cible de wikilink (le linkpath, SANS le sous-chemin #…) en
    // TFile du vault, exactement comme le fait Obsidian (résolution par nom /
    // chemin le plus court). Retourne le TFile ou null.
    const resolveVaultFile = (linkpath) =>
      linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path) : null;

    // Table des titres de section portant une ancre de bloc DANS CETTE note :
    //   anchorId → titre nettoyé de ses décorateurs (« … — [XXXX] », « ^id »),
    // via cleanHeadingTitle() (même normalisation que les rétroliens).
    // Sert à nommer un renvoi [[#^id]] SANS alias par le NOM de la section
    // référencée plutôt que par l'identifiant brut de l'ancre.
    const anchorHeadingTitles = new Map();
    try {
      for (const h of this.getAnchoredHeadings(file)) {
        anchorHeadingTitles.set(h.anchorId, cleanHeadingTitle(h.heading));
      }
    } catch (e) {
      console.error("[rfa-pdf-export] Titres d'ancres de section indisponibles :", e);
    }

    // ── Redimensionnement des images (syntaxe Obsidian) ───────────────────
    //   ![[img.png|300]]              largeur max 300 px
    //   ![[img.png|300x200]]          boîte max 300 × 200 px (ratio conservé)
    //   ![[img.png|Légende|300]]      légende/alt + taille (ordre indifférent)
    // Le premier segment qui ressemble à une taille est la taille ; les autres
    // forment le texte alternatif / la légende. Dans un tableau, Obsidian
    // échappe le séparateur (« \| ») : on le normalise d'abord.
    const RE_IMG_SIZE = /^(\d+)(?:\s*x\s*(\d+))?$/i;
    const parseImageEmbed = (rawName) => {
      const parts = String(rawName).replace(/\\\|/g, "|").split("|").map(s => s.trim());
      const filename = parts.shift();
      let w = null, h = null;
      const altParts = [];
      for (const p of parts) {
        const sm = w === null && h === null ? p.match(RE_IMG_SIZE) : null;
        if (sm) { w = Number(sm[1]); h = sm[2] ? Number(sm[2]) : null; }
        else altParts.push(p);
      }
      return { filename, alt: altParts.join("|"), w, h };
    };
    // px CSS (unité d'Obsidian) → pt Typst : 1 px = 0,75 pt (96 dpi).
    const pxToPt = (px) => `${+(px * 0.75).toFixed(2)}pt`;
    // Appel Typst à obs-image() (défini dans le template généré, cf. § 5).
    const obsImageCall = (rel, w, h, alt) =>
      `obs-image(${typstStr(rel)}` +
      (w !== null ? `, w: ${pxToPt(w)}` : "") +
      (h !== null ? `, h: ${pxToPt(h)}` : "") +
      (alt ? `, alt: ${typstStr(alt)}` : "") +
      `)`;

    // Motifs d'ancre reconnus :
    //   1. ^id  seul sur sa ligne, ou en fin de ligne précédé d'une espace.
    //      Le caret DOIT être en début de ligne ou précédé d'une espace : cela
    //      évite les faux positifs de type exposant (« x^2 » n'est pas capté).
    //   2. *^id*  (forme italique explicite, tolérée).
    const RE_ANCHOR_NATIVE = /(^[ \t]*|[ \t]+)\^([A-Za-z0-9_-]+)[ \t]*$/gm;
    const RE_ANCHOR_ITALIC = /\*\^([A-Za-z0-9_-]+)\*/g;

    // ── 5a-ter. Images avec ancre de bloc → figures Typst étiquetées ─────
    // Convention dans la note (syntaxe Obsidian native) :
    //   ![[schema.png|Légende de la figure]] ^fig-archi
    // devient, pour Pandoc :
    //   ![Légende de la figure](chemin/absolu/schema.png){#fig-archi}
    // Pandoc émet alors  #figure(image(…), caption: […]) <fig-archi>, que
    // Typst NUMÉROTE automatiquement (« Fig. 1 – Légende… »). Un renvoi
    // [[#^fig-archi]] dans le texte devient @fig-archi (→ « Fig. 1 »,
    // cliquable) — voir le gestionnaire de wikilinks plus bas.
    //
    // Contraintes :
    //   • l'image doit être SEULE sur sa ligne (avec l'ancre en fin de
    //     ligne), entourée de lignes vides : Pandoc ne crée une figure
    //     implicite que pour une image seule dans son paragraphe ;
    //   • identifiants sans « : » (fig-archi, pas fig:archi) : Obsidian
    //     ne l'accepte pas dans les ancres de bloc.
    // Cette passe DOIT précéder le recensement des ancres obsref ci-dessous,
    // sinon l'ancre serait aussi convertie en #metadata (doublon inutile).
    const figureLabels = new Set();
    const RE_IMG_FIG = /^([ \t]*)!\[\[([^\]]+)\]\][ \t]+\^([A-Za-z0-9_-]+)[ \t]*$/gm;
    const bodyFig = bodyNorm.replace(RE_IMG_FIG, (m, lead, rawName, id) => {
      const { filename, alt, w, h } = parseImageEmbed(rawName);
      const found = this.findImageInVault(vaultPath, filename);
      if (!found) {
        new Notice(`Image introuvable dans le vault : ${filename}`, 6000);
        return `${lead}*(image introuvable : ${filename})*`;
      }
      // La copie doit précéder l'enregistrement du label : si elle échoue,
      // aucune figure n'est émise et un renvoi @id ferait échouer Typst.
      const rel = stageImage(found);
      if (!rel) {
        new Notice(`Image illisible : ${filename}`, 6000);
        return `${lead}*(image illisible : ${filename})*`;
      }
      figureLabels.add(id);
      // Pandoc n'émet un #figure <label> QUE si la légende est non vide :
      // repli sur le nom de fichier si l'utilisateur n'en a pas fourni.
      let caption = alt;
      if (!caption) {
        caption = filename.replace(/\.[^.]+$/, "");
        new Notice(
          `Figure ^${id} : légende manquante, repli sur « ${caption} ».`,
          6000
        );
      }
      // Image redimensionnée → figure émise directement en Typst brut, car
      // Pandoc ne sait que FORCER une taille (et en pouces), pas la plafonner.
      // `kind: image` est explicite : le corps (layout) empêche la détection
      // automatique du type de figure, nécessaire à la numérotation « Fig. N ».
      // La légende est passée en texte brut (pas de mise en forme Markdown).
      if (w !== null || h !== null) {
        return (
          `\n${lead}\`\`\`{=typst}\n` +
          `${lead}#figure(${obsImageCall(rel, w, h, caption)}, kind: image, ` +
          `caption: [#${typstStr(caption)}]) <${id}>\n` +
          `${lead}\`\`\`\n`
        );
      }
      // Lignes vides autour : Pandoc exige que l'image soit SEULE dans son
      // paragraphe pour la promouvoir en figure (sinon le label n'existe pas
      // et tout renvoi @${id} ferait échouer la compilation Typst).
      return `\n${lead}![${caption}](${rel}){#${id}}\n`;
    });

    // Recenser les ancres réellement définies dans la note (les deux formes),
    // afin de ne créer un lien que vers une cible présente dans le document.
    const definedRefs = new Set();
    for (const m of bodyFig.matchAll(RE_ANCHOR_NATIVE)) definedRefs.add(refSlug(m[2]));
    for (const m of bodyFig.matchAll(RE_ANCHOR_ITALIC)) definedRefs.add(refSlug(m[1]));

    // Labels déjà émis (Typst refuse les labels dupliqués : si la même ancre
    // apparaît deux fois, seule la première porte le label).
    const emittedRefs = new Set();
    // Émet une ancre invisible (metadata étiqueté) pour l'identifiant donné.
    const emitAnchor = (id) => {
      const slug = refSlug(id);
      if (emittedRefs.has(slug)) {
        // Ancre en double : pas de second label identique (Typst refuse),
        // mais on reste invisible.
        return "`#metadata(none)`{=typst}";
      }
      emittedRefs.add(slug);
      return `\`#metadata(none)<${slug}>\`{=typst}`;
    };

    // ── 5b. Résoudre les images wiki-link ![[...]] ───────────────────────
    // Obsidian utilise ![[image.png]] ; Pandoc ne comprend que ![](chemin).
    // On cherche chaque image dans le vault et on substitue le chemin absolu.
    const bodyResolved = bodyFig
      .replace(
        /!\[\[([^\]]+)\]\]/g,
        (match, rawName) => {
          const { filename, alt, w, h } = parseImageEmbed(rawName);
          const found = this.findImageInVault(vaultPath, filename);
          if (found) {
            const rel = stageImage(found);
            if (rel) {
              // Image redimensionnée → appel Typst brut (taille plafonnée).
              if (w !== null || h !== null) {
                return `\`#box(${obsImageCall(rel, w, h, alt)})\`{=typst}`;
              }
              return `![${alt}](${rel})`;
            }
            new Notice(`Image illisible : ${filename}`, 6000);
            return `*(image illisible : ${filename})*`;
          }
          new Notice(`Image introuvable dans le vault : ${filename}`, 6000);
          return `*(image introuvable : ${filename})*`;
        }
      )
      // ── 5b-bis. Ancres de bloc  → metadata Typst étiqueté (invisible) ────
      // Émis en Typst brut (`…`{=typst}) : Pandoc le transmet tel quel au
      // moteur Typst. `metadata(none)` ne produit aucun contenu ni espacement.
      // Deux formes reconnues : ^id (native, ligne seule ou fin de ligne) et
      // *^id* (italique explicite). La forme native préserve l'espace/indentation
      // capturée avant le caret pour ne pas coller au texte précédent.
      .replace(RE_ANCHOR_NATIVE, (match, lead, id) => lead + emitAnchor(id))
      .replace(RE_ANCHOR_ITALIC, (match, id) => emitAnchor(id))
      // ── 5c. Résoudre les liens internes [[…]] ────────────────────────────
      // Les images ![[...]] ayant déjà été traitées ci-dessus, il ne reste que
      // les vrais liens wiki.
      //   • Renvoi vers une ancre de bloc de CETTE note  → lien cliquable.
      //   • Tout autre wikilink                          → texte d'affichage
      //     en italique (comportement historique).
      //   [[note|alias]]        → *alias*
      //   [[note]]              → *note*
      //   [[note#titre]]        → *note*            (ancre retirée, faute d'alias)
      //   [[note#titre|alias]]  → *alias*
      //   [[#^id|texte]]        → #link(<obsref-id>)[texte]   (si ancre définie)
      //   [[note#^id|texte]]    → #link(<obsref-id>)[texte]   (si ancre définie)
      .replace(
        /\[\[([^\]\n]+)\]\]/g,
        (match, rawInner) => {
          // Dans une cellule de tableau Markdown, Obsidian ÉCHAPPE le séparateur
          // du wikilink : [[cible\|alias]]. Sans cette normalisation, `targetPart`
          // se termine par « \ », le motif d'ancre #^id ne correspond plus et le
          // renvoi retombe en simple texte italique (le lien est perdu).
          const inner = rawInner.replace(/\\\|/g, "|");
          const pipe = inner.indexOf("|");
          const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
          const aliasPart  = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";

          // Renvoi vers une ancre de bloc : la cible se termine par #^identifiant
          const blockMatch = targetPart.match(/#\^([A-Za-z0-9_-]+)$/);
          if (blockMatch) {
            // Renvoi vers une FIGURE étiquetée (cf. passe 5a-ter) :
            //   • sans alias → @fig-id : Typst génère « Fig. N » (numéro
            //     automatique, lien cliquable, localisé par le modèle) ;
            //   • avec alias → lien cliquable au texte choisi.
            if (figureLabels.has(blockMatch[1])) {
              if (!aliasPart) return `\`@${blockMatch[1]}\`{=typst}`;
              const figLink = `#link(<${blockMatch[1]}>, ${typstStr(aliasPart)})`;
              const figExpr = REF_LINK_COLOR
                ? `#text(fill: rgb(${typstStr(REF_LINK_COLOR)}))[${figLink}]`
                : figLink;
              return `\`${figExpr}\`{=typst}`;
            }
            const slug = refSlug(blockMatch[1]);
            // Texte affiché : alias explicite, sinon — si l'ancre est posée sur
            // un TITRE de cette note — le NOM de la section (décorateurs retirés),
            // sinon nom de note, sinon id brut.
            let display = aliasPart;
            if (!display) {
              const hash      = targetPart.indexOf("#");
              const linkpath  = (hash > 0 ? targetPart.slice(0, hash) : "").trim();
              // L'ancre ne peut désigner une section de CETTE note que si le
              // renvoi la vise ([[#^id]]) ou nomme explicitement la note courante.
              const targetsThisNote =
                !linkpath || resolveVaultFile(linkpath)?.path === file.path;
              const headingTitle = targetsThisNote
                ? anchorHeadingTitles.get(blockMatch[1])
                : null;
              display = headingTitle || linkpath || blockMatch[1];
            }
            // Lien cliquable seulement si l'ancre existe dans ce document.
            if (definedRefs.has(slug)) {
              const linkExpr = `#link(<${slug}>, ${typstStr(display)})`;
              const expr = REF_LINK_COLOR
                ? `#text(fill: rgb(${typstStr(REF_LINK_COLOR)}))[${linkExpr}]`
                : linkExpr;
              return `\`${expr}\`{=typst}`;
            }
            // Ancre absente (renvoi vers une autre note) : repli en italique.
            return display ? `*${display}*` : match;
          }

          // ── Renvoi vers une ANNEXE (fichier du vault, extension ≠ .md) ───
          // [[annexe.bpmn]] · [[dossier/annexe.bpmn|alias]] · [[annexe.pdf]] …
          // Si la cible se résout, dans le vault, vers un fichier qui n'est PAS
          // une note (.md), on émet un LIEN CLIQUABLE dont la destination est le
          // chemin RELATIF de l'annexe depuis le répertoire du PDF. Livrés
          // ensemble en conservant l'arborescence, un clic ouvre le fichier avec
          // l'application associée — ou, à défaut, l'explorateur dans son dossier.
          {
            const subHash  = targetPart.indexOf("#");
            const linkpath = (subHash >= 0 ? targetPart.slice(0, subHash) : targetPart).trim();
            const dest     = resolveVaultFile(linkpath);
            if (dest && String(dest.extension).toLowerCase() !== "md") {
              const annexeAbs = path.join(vaultPath, dest.path);
              // Chemin relatif PDF → annexe, en séparateurs « / » (URI).
              const rel  = path.relative(outputDir, annexeAbs).split(path.sep).join("/");
              const uri  = encodeRelPath(rel);
              const text = aliasPart || linkpath || dest.name;
              const linkExpr = `#link(${typstStr(uri)}, ${typstStr(text)})`;
              const expr = ANNEXE_LINK_COLOR
                ? `#text(fill: rgb(${typstStr(ANNEXE_LINK_COLOR)}))[${linkExpr}]`
                : linkExpr;
              return `\`${expr}\`{=typst}`;
            }
          }

          // Wikilink ordinaire → texte d'affichage en italique.
          let display;
          if (pipe >= 0) {
            display = inner.slice(pipe + 1).trim();
          } else {
            const target = inner.trim();
            const hash = target.indexOf("#");
            display = (hash >= 0 ? target.slice(0, hash) : target).trim();
            // Lien interne pur vers une ancre ([[#titre]]) : garder le titre
            if (display === "" && hash >= 0) {
              display = target.slice(hash + 1).replace(/^\^/, "").trim();
            }
          }
          if (display === "") return match; // structure inattendue : on n'altère pas
          return `*${display}*`;
        }
      );
    // Écrire le fichier .md temporaire SANS frontmatter
    // (pour éviter que Pandoc injecte un bloc titre dans $body$)
    const tmpMd = path.join(tmpDir, `${baseName}.md`);
    try {
      fs.writeFileSync(tmpMd, bodyResolved, "utf8");
    } catch (e) {
      new Notice(`Impossible d'écrire le fichier source temporaire :\n${e.message}`);
      this.cleanTmp(tmpDir);
      return;
    }

    // ── 7. Déterminer le fichier de sortie ───────────────────────────────
    // (outputDir est désormais calculé plus haut, cf. §3.)

    // Construire le nom de fichier à partir des propriétés du type
    const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, "_").trim();
    const titleProps = spec.titleProps || spec.props;
    const outputName =
      titleProps.map(p => vars[p]).filter(Boolean).map(sanitize).join(" - ")
      || sanitize(baseName);
    const outputFile = path.join(outputDir, `${outputName}.pdf`);

    // ── 8. Construire la commande Pandoc ─────────────────────────────────
    // Filtres Lua : callouts.lua (callouts Obsidian) + checkbox-preserve.lua (cases à cocher)
    // Recherchés dans le templateDir puis dans le sous-dossier « script/ » embarqué.
    const luaFilters = ["callouts.lua", "checkbox-preserve.lua"];
    const luaSearchDirs = [templateDir, path.join(pluginDir, "script")];
    const luaArgs = luaFilters
      .map(f => {
        for (const d of luaSearchDirs) {
          const p = path.join(d, f);
          if (fs.existsSync(p)) return p;
        }
        return null;
      })
      .filter(Boolean)
      .map(p => `--lua-filter=${p}`);

    // Fichier Typst intermédiaire. La chaîne est en DEUX temps
    //   (pandoc -t typst → document.typ → typst compile → PDF)
    // au lieu de « --pdf-engine=typst », afin de pouvoir post-traiter le Typst
    // généré (cf. § 10 : surcharge des tableaux par obs-table). Effet de bord
    // appréciable : le .typ reste dans tmpDir et devient un artefact de débogage.
    const tmpTyp = path.join(tmpDir, "document.typ");

    const pandocArgs = [
      tmpMd,                   // fichier source SANS frontmatter
      "--wrap=none",
	   // markdown-citations : @ref non traité comme citation.
	   // -yaml_metadata_block : les « --- » du corps (séparateurs) ne sont pas
	   //   interprétés comme des blocs de métadonnées YAML (le frontmatter est
	   //   de toute façon déjà retiré en amont).
	   // -auto_identifiers : Pandoc n'ajoute plus de label Typst automatique
	   //   après chaque titre (= Titre … <slug>). Ces labels entraient en
	   //   collision avec les ancres de bloc *^id* placées en fin de titre
	   //   (Typst « perdait » alors notre label). Aucune fonctionnalité du
	   //   plugin ne dépend de ces identifiants de titre.
	   "--from", "markdown-citations-yaml_metadata_block-auto_identifiers",
      "-t", "typst",
      `--template=${tmpTemplate}`,
      ...luaArgs,
      "-o", tmpTyp,
    ];

    // Arguments de la seconde étape (compilation Typst → PDF).
    const typstArgs = ["compile", "--root", tmpDir, tmpTyp, outputFile];

    new Notice(`Génération du PDF en cours…`);

    // ── 9. Lancer Pandoc ─────────────────────────────────────────────────
    // Exécutables résolus : réglage explicite, sinon binaire embarqué du plugin.
    const pandocExe = this.resolveBinary("pandoc", this.settings.pandocPath);
    const typstExe  = this.resolveBinary("typst",  this.settings.typstPath);

    // PATH enrichi avec les répertoires de pandoc ET typst.
    // (Pandoc invoque typst via --pdf-engine=typst : son dossier doit être sur le PATH.)
    const extraPaths = this.buildExtraPath(pandocExe, typstExe);

    // ── 9b. Journaliser la commande exacte (debug) ───────────────────────
    // Visible dans la console développeur (Ctrl+Maj+I → onglet Console).
    // Permet de rejouer la conversion dans un terminal et de voir les logs
    // complets de Pandoc/Typst.
    const binDirs = [pandocExe, typstExe]
      .filter(e => e && (e.includes("/") || e.includes("\\")))
      .map(e => path.dirname(e));
    const q = (s) => `"${s}"`;
    const replayBlock =
      `cd /d ${q(tmpDir)}\r\n` +
      (binDirs.length ? `set "PATH=${binDirs.join(";")};%PATH%"\r\n` : "") +
      [q(pandocExe), ...pandocArgs.map(q)].join(" ") + "\r\n" +
      [q(typstExe), ...typstArgs.map(q)].join(" ");
    console.log("[rfa-pdf-export] Dossier de travail :", tmpDir);
    console.log("[rfa-pdf-export] Commande (à coller dans un terminal) :\n" + replayBlock);

    cp.execFile(
      pandocExe,
      pandocArgs,
      {
        cwd: tmpDir,
        env: { ...process.env, PATH: extraPaths },
        timeout: 60000,
      },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[rfa-pdf-export] STDERR:", stderr);
          console.error("[rfa-pdf-export] ERROR:", err.message);
          console.error("[rfa-pdf-export] Fichiers conservés pour debug :", tmpDir);
          // On NE nettoie PAS le dossier temporaire en cas d'erreur :
          // il contient le template, le .md source et les modèles .typ, ce qui
          // permet de rejouer la commande ci-dessus dans un terminal.
          new Notice(
            `Erreur de conversion. Détails dans la console (Ctrl+Maj+I).\n` +
            `Fichiers de debug conservés dans :\n${tmpDir}`,
            15000
          );
          return;
        }

        // ── 10. Surcharger les tableaux par obs-table() ─────────────────
        // Pandoc écrit des largeurs de colonnes explicites, dérivées du seul
        // signal dont il dispose (le nombre de tirets), donc aveugles aux
        // métriques de la fonte. On remplace le constructeur `#table(` par
        // `#obs-table(` (défini dans obsidian.typ), qui recalcule les largeurs
        // en mesurant réellement le texte.
        //   • `#table(`        → constructeur : c'est la seule occurrence
        //                        préfixée de « # » dans la sortie de Pandoc ;
        //   • `table.header(`, `table.hline()` s'écrivent SANS « # » et ne sont
        //     donc jamais touchés par la substitution.
        try {
          if (hasObsidianLib) {
            const typSrc = fs.readFileSync(tmpTyp, "utf8");
            fs.writeFileSync(tmpTyp, typSrc.replace(/#table\(/g, "#obs-table("), "utf8");
          }
        } catch (e) {
          console.error("[rfa-pdf-export] Post-traitement du Typst impossible :", e);
          // Non bloquant : on compile le Typst tel que Pandoc l'a produit.
        }

        // ── 11. Compiler le Typst en PDF ────────────────────────────────
        cp.execFile(
          typstExe,
          typstArgs,
          {
            cwd: tmpDir,
            env: { ...process.env, PATH: extraPaths },
            timeout: 60000,
          },
          (err2, stdout2, stderr2) => {
            if (err2) {
              console.error("[rfa-pdf-export] TYPST STDERR:", stderr2);
              console.error("[rfa-pdf-export] TYPST ERROR:", err2.message);
              console.error("[rfa-pdf-export] Fichiers conservés pour debug :", tmpDir);
              // Comme pour Pandoc : on conserve le dossier temporaire, qui
              // contient maintenant AUSSI le document.typ fautif.
              new Notice(
                `Erreur de compilation Typst. Détails dans la console (Ctrl+Maj+I).\n` +
                `Fichiers de debug conservés dans :\n${tmpDir}`,
                15000
              );
              return;
            }

            // Succès : on peut nettoyer.
            this.cleanTmp(tmpDir);
            new Notice(`PDF généré :\n${outputFile}`);

            if (this.settings.openAfter) {
              this.openPdf(outputFile);
            }
          }
        );
      }
    );
  }

  // ── Rétroliens de section : index vault-wide ────────────────────────────
  // Reproduit la logique du plugin « Section Backlinks ».
  //   Clé   : "cheminNote.md#^idAncre"
  //   Valeur: [{ sourcePath, sectionPath, sectionLine }, …]
  // sectionPath = fil d'Ariane des titres menant au renvoi ; sectionLine = ligne
  // du titre immédiat contenant le renvoi (coordonnées du fichier SOURCE).
  buildSectionReferenceIndex() {
    const referencesByKey = new Map();
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache || !cache.links) continue;
      const headings = (cache.headings ?? [])
        .slice()
        .sort((a, b) => a.position.start.line - b.position.start.line);
      for (const link of cache.links) {
        const raw = link.link;
        const hashIdx = raw.indexOf("#");
        if (hashIdx === -1) continue;
        const sub = raw.substring(hashIdx + 1);
        if (!sub.startsWith("^")) continue;                 // seulement #^bloc
        const anchorId = sub.substring(1);
        const linkpath = raw.substring(0, hashIdx);
        const targetFile = linkpath
          ? this.app.metadataCache.getFirstLinkpathDest(linkpath, f.path)
          : f;                                              // [[#^id]] = cette note
        if (!targetFile) continue;

        const linkLine = link.position.start.line;
        let immediateIdx = -1;
        for (let i = 0; i < headings.length; i++) {
          if (headings[i].position.start.line <= linkLine) immediateIdx = i;
          else break;
        }

        let sectionPath = f.basename;
        let sectionLine = 0;
        if (immediateIdx !== -1) {
          const chain = [{
            title: cleanHeadingTitle(headings[immediateIdx].heading),
            line: headings[immediateIdx].position.start.line,
          }];
          let currentLevel = headings[immediateIdx].level;
          for (let i = immediateIdx - 1; i >= 0; i--) {
            if (headings[i].level < currentLevel) {
              chain.unshift({
                title: cleanHeadingTitle(headings[i].heading),
                line: headings[i].position.start.line,
              });
              currentLevel = headings[i].level;
              if (currentLevel === 1) break;
            }
          }
          sectionPath = chain.map((c) => c.title).join(" > ");
          sectionLine = chain[chain.length - 1].line;
        }

        const key = `${targetFile.path}#^${anchorId}`;
        const list = referencesByKey.get(key) ?? [];
        list.push({ sourcePath: f.path, sectionPath, sectionLine });
        referencesByKey.set(key, list);
      }
    }
    return referencesByKey;
  }

  // Titres d'un fichier portant une ancre de bloc sur leur propre ligne
  // (## Titre ^id). Retourne [{ anchorId, heading, level, line }, …].
  getAnchoredHeadings(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache || !cache.headings || !cache.blocks) return [];
    const anchors = [];
    for (const h of cache.headings) {
      const line = h.position.start.line;
      for (const [id, block] of Object.entries(cache.blocks)) {
        if (block.position.start.line === line) {
          anchors.push({ anchorId: id, heading: h.heading, level: h.level, line });
        }
      }
    }
    return anchors;
  }

  // ── Injection des blocs de rétroliens dans le corps Markdown ─────────────
  // Renvoie `bodyOnly` enrichi de blocs Typst bruts (```{=typst}…```). Opère
  // sur bodyOnly (frontmatter déjà retiré) : les numéros de ligne du cache sont
  // traduits via l'offset du frontmatter. Cette passe DOIT précéder les passes
  // figures/ancres/wikilinks (qui décalent les lignes) — d'où l'appel au §3c.
  injectSectionBacklinks(bodyOnly, file, rawContent) {
    if (!INJECT_SECTION_BACKLINKS) return bodyOnly;

    const anchored = this.getAnchoredHeadings(file);
    if (!anchored.length) return bodyOnly;                 // rien à annoter

    const index = this.buildSectionReferenceIndex();

    const cache = this.app.metadataCache.getFileCache(file);
    const headingLines = (cache?.headings ?? [])
      .map((h) => h.position.start.line)
      .sort((a, b) => a - b);

    // Offset frontmatter : nb de lignes retirées en tête (cache → bodyOnly).
    const fmMatch = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const fmOffset = fmMatch ? (fmMatch[0].match(/\n/g) || []).length : 0;

    // Helpers Typst locaux (cette passe s'exécute avant ceux de exportFile).
    const typstStr = (s) =>
      '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const secSlug = (src, line) =>
      "sec-" + String(`${src}:${line}`).toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    const lines = bodyOnly.split("\n");
    const inserts = new Map();                             // idx → { before:[], after:[] }
    const addInsert = (idx, text, where) => {
      idx = Math.max(0, Math.min(idx, lines.length));
      const cur = inserts.get(idx) || { before: [], after: [] };
      cur[where].push(text);
      inserts.set(idx, cur);
    };

    // Labels de section (même note) émis à la demande, dédupliqués.
    const labeled = new Set();
    const ensureSameNoteLabel = (targetLine) => {
      const slug = secSlug(file.path, targetLine);
      if (labeled.has(slug)) return slug;
      labeled.add(slug);
      const bodyIdx = targetLine - fmOffset;
      const raw = "```{=typst}\n#metadata(none)<" + slug + ">\n```";
      if (targetLine === 0 || bodyIdx < 0) addInsert(0, raw, "before");
      else addInsert(bodyIdx, raw, "after");              // juste sous le titre cible
      return slug;
    };

    for (const h of anchored) {
      const key = `${file.path}#^${h.anchorId}`;
      let refs = index.get(key);
      if (!refs || !refs.length) continue;

      // Dédupliquer (source, ligne) puis trier pour un rendu stable.
      const seen = new Set();
      refs = refs
        .filter((r) => {
          const k = `${r.sourcePath}::${r.sectionLine}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        // Renvois d'une AUTRE note : leur cible n'est pas dans ce PDF. Selon le
        // réglage, on les affiche en texte (informatif) ou on les masque.
        .filter((r) => BACKLINK_INCLUDE_EXTERNAL || r.sourcePath === file.path)
        .sort((a, b) =>
          a.sourcePath.localeCompare(b.sourcePath) || a.sectionLine - b.sectionLine);

      if (!refs.length) continue;

      const items = refs.map((r) => {
        const noteName = r.sourcePath.split("/").pop().replace(/\.md$/i, "");
        const titleStr = typstStr(r.sectionPath || noteName);
        const noteStr = typstStr(noteName);

        let entry;
        if (r.sourcePath === file.path) {
          // Même note → SAUT INTERNE cliquable vers la section source.
          const slug = ensureSameNoteLabel(r.sectionLine);
          const linkExpr = `#link(<${slug}>, ${titleStr})`;
          const colored = BACKLINK_LINK_COLOR
            ? `#text(fill: rgb(${typstStr(BACKLINK_LINK_COLOR)}))[${linkExpr}]`
            : linkExpr;
          entry = colored;
        } else {
          // Autre note → texte simple (aucun lien : la cible n'est pas ici).
          entry = `#text(${titleStr})`;
        }
        return `[${entry} #text(fill: luma(55%))[— #emph(${noteStr})]]`;
      });

      const label =
        refs.length > 1
          ? `↩ Référencé par ${refs.length} sections`
          : "↩ Référencé par 1 section";

      const block =
        "```{=typst}\n" +
        "#block(above: 1.2em, below: 0.6em, width: 100%, inset: (left: 8pt), " +
        "stroke: (left: 2pt + luma(75%)))[\n" +
        "  #set text(size: 8.5pt, fill: luma(45%))\n" +
        "  #set par(first-line-indent: 0pt, justify: false)\n" +
        "  #emph[" + label + "]\n" +
        "  #list(indent: 0.4em, spacing: 0.4em, " + items.join(", ") + ")\n" +
        "]\n" +
        "```";

      // À la fin de la section : juste avant le prochain titre (tous niveaux),
      // ou en fin de document — comme le fait le plugin à l'écran.
      const next = headingLines.find((l) => l > h.line);
      if (next === undefined) addInsert(lines.length, block, "before");
      else addInsert(next - fmOffset, block, "before");
    }

    if (!inserts.size) return bodyOnly;

    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const ins = inserts.get(i);
      if (ins) for (const t of ins.before) out.push("", t, "");
      out.push(lines[i]);
      if (ins) for (const t of ins.after) out.push("", t, "");
    }
    const tail = inserts.get(lines.length);
    if (tail) for (const t of tail.before) out.push("", t, "");
    return out.join("\n");
  }

  // ── Ouverture du PDF ────────────────────────────────────────────────────
  openPdf(pdfPath) {
    const viewer = (this.settings.pdfViewer || "").trim().replace(/^"(.*)"$/, "$1");

    if (!viewer) {
      this.openWithDefaultApp(pdfPath);
      return;
    }

    if (!fs.existsSync(viewer)) {
      console.error(`[md2pdf] Lecteur PDF introuvable : ${viewer}`);
      new Notice(
        `Lecteur PDF introuvable :\n${viewer}\nOuverture avec l'application par défaut.`,
        8000
      );
      this.openWithDefaultApp(pdfPath);
      return;
    }

    try {
      // macOS : un bundle .app doit être lancé via `open -a`
      const isMacBundle = process.platform === "darwin" && viewer.endsWith(".app");
      const cmd  = isMacBundle ? "open" : viewer;
      const args = isMacBundle ? ["-a", viewer, pdfPath] : [pdfPath];

      const child = cp.spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        console.error(`[md2pdf] Échec du lancement de ${viewer} :`, err);
        new Notice(
          `Impossible de lancer :\n${viewer}\nOuverture avec l'application par défaut.`,
          8000
        );
        this.openWithDefaultApp(pdfPath);
      });
      child.unref();
    } catch (err) {
      console.error(`[md2pdf] Échec du lancement de ${viewer} :`, err);
      new Notice(
        `Impossible de lancer :\n${viewer}\nOuverture avec l'application par défaut.`,
        8000
      );
      this.openWithDefaultApp(pdfPath);
    }
  }

  openWithDefaultApp(pdfPath) {
    if (process.platform === "win32") {
      cp.exec(`start "" "${pdfPath}"`);
    } else {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      cp.execFile(opener, [pdfPath]);
    }
  }

  // ── Extraction du frontmatter YAML ──────────────────────────────────────
  parseFrontmatter(content) {
    const result = {};
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return result;

    const yaml = match[1];
    for (const line of yaml.split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        const key = m[1].trim();
        let   val = m[2].trim();
        // Retirer les guillemets entourants éventuels
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
    return result;
  }

  // ── Répertoire absolu du plugin ─────────────────────────────────────────
  // C'est là que se trouvent les exécutables embarqués (pandoc/typst),
  // ainsi que les sous-dossiers modele/ et script/.
  getPluginDir() {
    const vaultPath = this.app.vault.adapter.basePath;
    // manifest.dir = chemin relatif du plugin dans le vault
    // (p. ex. « .obsidian/plugins/rfa-pdf-export »)
    if (this.manifest && this.manifest.dir) {
      return path.join(vaultPath, this.manifest.dir);
    }
    // Repli : reconstruire à partir du dossier de config et de l'id
    const configDir = this.app.vault.configDir || ".obsidian";
    return path.join(vaultPath, configDir, "plugins", this.manifest.id);
  }

  // ── Résolution d'un exécutable (pandoc / typst) ─────────────────────────
  // Priorité :
  //   1. chemin explicite saisi dans les réglages (contient un séparateur) ;
  //   2. exécutable embarqué détecté dans le répertoire du plugin ;
  //   3. repli : le nom nu (laisse le PATH système résoudre).
  resolveBinary(base, userSetting) {
    const setting = (userSetting || "").trim();

    // 1. Surcharge utilisateur explicite
    if (setting && (setting.includes("/") || setting.includes("\\"))) {
      return setting;
    }

    // 2. Exécutable embarqué dans le répertoire du plugin
    const found = findExecutable(this.getPluginDir(), base);
    if (found) return found;

    // 3. Repli
    return setting || base;
  }

  // ── Construction d'un PATH enrichi ──────────────────────────────────────
  // On ajoute au PATH les répertoires des exécutables résolus. Indispensable
  // pour que Pandoc (--pdf-engine=typst) retrouve l'exécutable Typst embarqué.
  buildExtraPath(...exePaths) {
    const parts = [process.env.PATH || ""];

    for (const exe of exePaths) {
      if (exe && (exe.includes("/") || exe.includes("\\"))) {
        parts.push(path.dirname(exe));
      }
    }

    const sep = process.platform === "win32" ? ";" : ":";
    return parts.join(sep);
  }

 // ── Recherche d'une image dans le vault ─────────────────────────────────
  // Parcourt récursivement le vault pour trouver un fichier par son nom.
  // Retourne le chemin absolu ou null si introuvable.
  findImageInVault(vaultPath, filename) {
    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".tiff"]);
    const ext = path.extname(filename).toLowerCase();

    // Si l'extension n'est pas une image connue, on tente quand même
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return null; }

      for (const entry of entries) {
        // Ignorer .obsidian et node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = walk(fullPath);
          if (found) return found;
        } else if (entry.name === filename) {
          return fullPath;
        }
      }
      return null;
    };

    return walk(vaultPath);
  }
  // ── Nettoyage du répertoire temporaire ──────────────────────────────────
  cleanTmp(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  // ── Persistance des paramètres ───────────────────────────────────────────
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Onglet Paramètres ────────────────────────────────────────────────────────
class PandocTypstSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("pandoc-typst-modal");

    containerEl.createEl("h2", { text: "Pandoc Typst Export – Paramètres" });

    // ── Chemin Pandoc ──────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Chemin de Pandoc (facultatif)")
      .setDesc("Laissez vide pour utiliser l'exécutable Pandoc embarqué dans le répertoire du plugin. Indiquez un chemin complet uniquement pour forcer un autre exécutable.")
      .addText(text =>
        text
          .setPlaceholder("(embarqué)  ou  C:\\RFA\\Apps\\pandoc-3.8.2.1\\pandoc.exe")
          .setValue(this.plugin.settings.pandocPath)
          .onChange(async (v) => {
            this.plugin.settings.pandocPath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Chemin Typst ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Chemin de Typst (facultatif)")
      .setDesc("Laissez vide pour utiliser l'exécutable Typst embarqué dans le répertoire du plugin. Indiquez un chemin complet uniquement pour forcer un autre exécutable.")
      .addText(text =>
        text
          .setPlaceholder("(embarqué)  ou  C:\\RFA\\Apps\\typst-0.14.0\\typst.exe")
          .setValue(this.plugin.settings.typstPath)
          .onChange(async (v) => {
            this.plugin.settings.typstPath = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Répertoire du template ─────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Répertoire du template Typst (facultatif)")
      .setDesc(
        "Répertoire contenant template.typ, obsidian.typ et les ressources. " +
        "Laissez vide pour utiliser le dossier « modele/ » embarqué dans le plugin."
      )
      .addText(text =>
        text
          .setPlaceholder("C:\\Users\\moi\\Documents\\typst-templates")
          .setValue(this.plugin.settings.templateDir)
          .onChange(async (v) => {
            this.plugin.settings.templateDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Répertoire de sortie ───────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Répertoire de sortie")
      .setDesc("Où enregistrer le PDF généré. Laissez vide pour utiliser le même répertoire que la note.")
      .addText(text =>
        text
          .setPlaceholder("C:\\Users\\moi\\Documents\\pdf")
          .setValue(this.plugin.settings.outputDir)
          .onChange(async (v) => {
            this.plugin.settings.outputDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Ouvrir après génération ────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Ouvrir le PDF après génération")
      .setDesc("Ouvre automatiquement le PDF avec l'application par défaut.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.openAfter)
          .onChange(async (v) => {
            this.plugin.settings.openAfter = v;
            await this.plugin.saveSettings();
          })
      );

    // ── Application de lecture ─────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Application d'ouverture du PDF")
      .setDesc(
        "Chemin complet de l'exécutable utilisé pour ouvrir le PDF. " +
        "Laissez vide pour utiliser l'application par défaut du système."
      )
      .addText(text =>
        text
          .setPlaceholder("C:\\Program Files\\SumatraPDF\\SumatraPDF.exe")
          .setValue(this.plugin.settings.pdfViewer)
          .onChange(async (v) => {
            this.plugin.settings.pdfViewer = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // ── Bloc d'aide ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Utilisation" });
    const help = containerEl.createEl("div");
    help.innerHTML = `
      <p>Ajoutez ces propriétés dans le frontmatter de votre note :</p>
      <pre>---
titre: Mon document
sous_titre: Description courte
version: "1.2"
---</pre>
      <p>Puis clic droit sur la note → <strong>Exporter en PDF (Pandoc + Typst)</strong>,
      ou utilisez la palette de commandes.</p>
      <p>La date est toujours remplacée par la date du jour.</p>
    `;
  }
}

module.exports = PandocTypstExportPlugin;