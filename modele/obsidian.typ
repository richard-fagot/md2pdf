#import "@preview/cheq:0.3.0": checklist

// ═══════════════════════════════════════════════════════════════════════════════
//  obsidian.typ — Mise en page commune, modularisée.
//
//  Principe (idiomatique Typst) : chaque bloc de configuration est une
//  TRANSFORMATION `doc => { …set/show… ; doc }`. On les compose ensuite avec des
//  règles `show:` dans setTemplate(). Les set/show ne « fuient » pas hors d'une
//  fonction : il faut donc qu'une config reçoive le contenu et le renvoie.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Constantes ────────────────────────────────────────────────────────────────
// Niveaux de gris (lisibilité écran, valeurs empiriques).
#let mainTextColor = luma(15%)
#let secondartyTextColor = luma(35%)
#let terTextColor = luma(50%)

// Configuration des callouts (couleur / icône / libellé par type).
#let callout-config = (
  "note":      (color: rgb("#448aff"), icon: "ℹ",  label: "Note"),
  "tip":       (color: rgb("#00c853"), icon: "💡", label: "Conseil"),
  "important": (color: rgb("#5c5c6e"), icon: "★",  label: "Important"),
  "warning":   (color: rgb("#ff6d00"), icon: "⚠",  label: "Attention"),
  "caution":   (color: rgb("#d50000"), icon: "⛔", label: "Attention"),
  "question":  (color: rgb("#ec7500"), icon: "❔", label: "Question"),
  "check":     (color: rgb("#08b94e"), icon: "✓",  label: "Check"),
)

// ─── Éléments réutilisables (renvoient du contenu) ──────────────────────────────
#let horizontalrule = {
  v(1em, weak: true)
  line(length: 100%, stroke: 0.5pt)
  v(1em, weak: true)
}

// Sous-titre de la page de titre.
#let project(body) = {
  v(3cm)
  set align(center)
  set text(size: 2.4em, weight: "semibold", fill: mainTextColor)
  smallcaps[#underline()[#body]]
  v(1cm, weak: true)
}

// Titre du document (page de titre).
#let configure-title(doc) = {
  show title: set align(center)
  show title: smallcaps
  show title: set text(size: 1.2em, fill: mainTextColor)
  show title: it => {
    v(1cm, weak: true)
    it
  }
  doc
}

// Sous-titre de la page de titre.
#let subtitle(body) = {
  v(1cm, weak: true)
  set align(center)
  set text(size: 1.8em, weight: "semibold", fill: secondartyTextColor)
  smallcaps[#body]
  v(5cm, weak: true)
}

// Contenu de l'en-tête (logo à gauche, métadonnées à droite).
#let header-content(projet, titre, sous_titre, version, statut, date) = {
  set align(left + bottom)
  grid(
    columns: (0.5fr, 1fr),
    align(left, image("assets/logo.webp", height: 2cm)),
    align(right + top)[
      #smallcaps[*#projet*] \
      #smallcaps[#text(size: 0.9em)[#titre]] \
      #text(size: 0.9em)[#version - #statut] \
      #text(size: 0.9em)[#date]
    ],
  )
}

// Callout Obsidian (généré par le filtre callouts.lua via Pandoc).
#let callout(type, title, body) = {
  let cfg = callout-config.at(type, default: callout-config.at("note"))
  let col = cfg.color
  let lbl = if title != none { title } else { cfg.label }
  let ico = cfg.icon

  let body-empty = body == none
  block(
    width: 100%,
    breakable: true,
    stroke: (left: 3pt + col),
    radius: 4pt,
    clip: true,
    {
      // Bandeau titre
      block(
        width: 100%,
        fill: col,
        inset: (x: 8pt, y: 6pt),
        below: 0pt,
        {
          set text(fill: white, weight: "bold", size: 10pt)
          [#ico #h(4pt) #lbl]
        },
      )
      // Corps — affiché uniquement si non vide
      if not body-empty {
        block(
          width: 100%,
          fill: col.lighten(88%),
          inset: (x: 10pt, y: 8pt),
          above: 0pt,
          {
            set par(first-line-indent: (amount: 0pt, all: false), spacing: 0.55em)
            set list(spacing: 0.4em, indent: 0.8em)
            body
          },
        )
      }
    },
  )
  v(0.5em)
}

// ─── Dimensionnement automatique des colonnes de tableau ───────────────────────
//  obs-table() se substitue à #table(…) dans le document généré par Pandoc — la
//  substitution est faite par main.js sur le .typ intermédiaire. Les largeurs
//  émises par Pandoc sont IGNORÉES : elles ne dérivent que du nombre de tirets
//  de la ligne « |---|---| », signal aveugle aux métriques de la fonte. Seul
//  leur NOMBRE (= le nombre de colonnes) est conservé.
//
//  Pour chaque colonne, on mesure dans la fonte réelle (measure()) :
//    • la largeur naturelle de chaque cellule, sur une seule ligne ;
//    • la largeur du mot le plus long   → PLANCHER (jamais de coupure de mot) ;
//    • la largeur du titre              → largeur réclamée, plafonnée (head-cap) ;
//    • le quantile 90 des cellules      → largeur IDÉALE ;
//    • le maximum des cellules          → PLAFOND (inutile d'aller au-delà).
//  Puis :
//    • si Σ idéales > budget : on rabote la part FLEXIBLE (idéale − plancher)
//      d'un facteur uniforme. Un seul passage suffit, et aucune colonne ne peut
//      franchir son plancher : sous contrainte, ce sont les titres qui passent
//      à la ligne, pas les colonnes de texte qui sont écrasées ;
//    • sinon : on distribue le reste jusqu'aux largeurs naturelles, puis, s'il
//      reste de la place, au prorata du VOLUME de texte de chaque colonne.
//
//  Repli : cellules fusionnées, nombre de colonnes inconnu ou structure
//  inattendue → le tableau d'origine est renvoyé tel quel, plutôt qu'un calcul
//  faux.
//
//  Réglages :
//    • pad       : espace horizontal consommé par cellule. `auto` = déduit de
//                  l'`inset` du tableau (Pandoc émet `inset: 6pt` → 12pt) ;
//    • head-bold : vrai tant que `show table.cell.where(y: 0): strong` est actif
//                  dans configure-tables() — sinon les titres seraient mesurés
//                  trop étroits ;
//    • stretch   : à passer à `false` pour laisser les petits tableaux à leur
//                  largeur naturelle au lieu d'occuper toute la justification.
//  Selon sa version, Pandoc émet ou non un `table.header(…)` ; à défaut, la
//  première ligne est traitée comme l'en-tête.
// ───────────────────────────────────────────────────────────────────────────────

// Texte brut d'un contenu (pour le découpage en mots).
// ATTENTION : renvoie TOUJOURS une chaîne. On utilise fold() et non join(),
// car `().join("")` vaut `none` en Typst — ce que produit toute cellule vide.
#let _txt(c) = {
  if c == none { "" }
  else if type(c) == str { c }
  else if type(c) != content { "" }
  else if c.has("text") and type(c.text) == str { c.text }
  else if c.has("children") { c.children.map(_txt).fold("", (a, b) => a + b) }
  else if c.has("body") { _txt(c.body) }
  else { " " }
}

// Quantile d'un tableau de nombres (0 ≤ p ≤ 1).
#let _quantile(arr, p) = {
  if arr.len() == 0 { 0.0 }
  else {
    let s = arr.sorted()
    s.at(calc.clamp(int(calc.round(p * (s.len() - 1))), 0, s.len() - 1))
  }
}

// Longueur → points, dans le style courant (résout aussi les « em »).
#let _pt(v) = if type(v) == length { measure(box(width: v)).width.pt() } else { 0.0 }

// Espace horizontal total consommé par une cellule, d'après l'`inset` du tableau.
#let _pad-of(v, fallback) = {
  if type(v) == length { 2.0 * _pt(v) }
  else if type(v) == dictionary {
    let side = (k) => {
      let s = v.at(k, default: v.at("x", default: v.at("rest", default: none)))
      if type(s) == length { _pt(s) } else { fallback / 2 }
    }
    side("left") + side("right")
  }
  else { fallback }
}

// Normalise un enfant de table en (body, head) ; signale les fusions.
#let _one(ch, head) = {
  if type(ch) != content { return (skip: true, ok: true) }
  let f = ch.func()
  if f == table.hline or f == table.vline { return (skip: true, ok: true) }
  if f == table.cell {
    if ch.at("colspan", default: 1) != 1 or ch.at("rowspan", default: 1) != 1 {
      return (skip: true, ok: false)   // fusion : on renonce au calcul
    }
    return (skip: false, ok: true, body: ch.body, head: head)
  }
  (skip: false, ok: true, body: ch, head: head)
}

#let _collect(children) = {
  let cells = ()
  let ok = true
  let has-head = false
  for ch in children {
    let is-group = (type(ch) == content
      and (ch.func() == table.header or ch.func() == table.footer))
    let items = if is-group { ch.children } else { (ch,) }
    let head = is-group and ch.func() == table.header
    if head { has-head = true }
    for c in items {
      let r = _one(c, head)
      if not r.ok { ok = false }
      if not r.skip { cells.push(r) }
    }
  }
  (cells: cells, ok: ok, has-head: has-head)
}

#let obs-table(
  columns:   auto,
  quantile:  0.90,
  min-rows:  5,
  min-col:   22pt,
  pad:       auto,
  head-bold: true,
  head-cap:  0.30,
  stretch:   true,
  ..args
) = layout(size => {
  let children = args.pos()
  let ncols = if type(columns) == int { columns }
              else if type(columns) == array { columns.len() }
              else { 0 }
  let r = _collect(children)
  let ins = _pad-of(args.named().at("inset", default: none),
                    if pad == auto { 10.0 } else { _pt(pad) })
  let budget = size.width.pt() - ncols * ins

  if ncols <= 0 or not r.ok or r.cells.len() == 0 or budget <= 0 {
    return if columns == auto { table(..args) } else { table(columns: columns, ..args) }
  }

  let ws = range(ncols).map(_ => ())
  let words = range(ncols).map(_ => 0.0)
  let heads = range(ncols).map(_ => 0.0)
  let i = 0
  for c in r.cells {
    let col = calc.rem(i, ncols)
    let head = c.head or (not r.has-head and i < ncols)
    let bold = head and head-bold
    let w = measure(if bold { strong(c.body) } else { c.body }).width.pt()
    ws.at(col).push(w)
    if head and w > heads.at(col) { heads.at(col) = w }
    for word in _txt(c.body).split(regex("\\s+")) {
      if word != "" {
        let ww = measure(if bold { strong(word) } else { word }).width.pt()
        if ww > words.at(col) { words.at(col) = ww }
      }
    }
    i += 1
  }

  let floors = range(ncols).map(c => calc.max(words.at(c), _pt(min-col)))
  let caps = range(ncols).map(c =>
      if ws.at(c).len() == 0 { _pt(min-col) } else { calc.max(..ws.at(c)) })
  let w = range(ncols).map(c => {
    let q = if ws.at(c).len() >= min-rows { _quantile(ws.at(c), quantile) } else { caps.at(c) }
    calc.max(floors.at(c),
             calc.min(q, caps.at(c)),
             calc.min(heads.at(c), head-cap * budget))
  })

  let total = w.sum(default: 0.0)

  if total > budget {
    let pool = range(ncols).map(c => w.at(c) - floors.at(c)).sum(default: 0.0)
    let excess = total - budget
    if pool > 0 and excess < pool {
      let k = 1.0 - excess / pool
      w = range(ncols).map(c => floors.at(c) + (w.at(c) - floors.at(c)) * k)
    } else {
      let tf = floors.sum(default: 0.0)
      w = if tf > 0 { floors.map(x => x * budget / tf) }
          else { range(ncols).map(_ => budget / ncols) }
    }
  } else if stretch and total < budget {
    let slack = budget - total
    let pot = range(ncols).map(c => calc.max(0.0, caps.at(c) - w.at(c)))
    let sp = pot.sum(default: 0.0)
    if sp > 0 {
      let k = calc.min(1.0, slack / sp)
      w = range(ncols).map(c => w.at(c) + pot.at(c) * k)
      slack = slack - sp * k
    }
    if slack > 0.5 {
      let vol = range(ncols).map(c => ws.at(c).sum(default: 0.0))
      let tv = vol.sum(default: 0.0)
      w = if tv > 0 { range(ncols).map(c => w.at(c) + slack * vol.at(c) / tv) }
          else { w.map(x => x + slack / ncols) }
    }
  }

  table(columns: w.map(x => (x + ins) * 1pt), ..args)
})

// ─── Modules de configuration (transformations doc => doc) ───────────────────────

// Texte : langue, police, taille, couleur.
#let configure-text(doc) = {
  set text(lang: "fr", region: "FR")
  set text(font: "TeX Gyre Pagella", size: 11pt)
  set text(fill: mainTextColor)
  doc
}

// Page : format, marges, reliure, en-tête, numérotation.
#let configure-page(projet, titre, sous_titre, version, statut, date, doc) = {
  set page(
    paper: "a4",
    margin: (left: 2.5cm, right: 2.5cm, top: 4cm, bottom: 2.5cm),
    binding: right,
    header-ascent: 1cm,
    header: header-content(projet, titre, sous_titre, version, statut, date),
    numbering: "1/1",
  )
  doc
}

// Paragraphes.
#let configure-paragraphs(doc) = {
  set par(
    first-line-indent: (amount: 2em, all: false),
    spacing: 1.5em,
    justify: true,
  )
  doc
}

// Titres de section.
#let configure-headings(doc) = {
  set heading(numbering: "1.")
  show heading.where(level: 1): set text(size: 14pt)
  show heading.where(level: 2): set text(size: 14pt)
  show heading.where(level: 3): set text(size: 14pt)
  show heading.where(level: 4): set text(size: 14pt)
  show heading: it => {
    let contenu = smallcaps[#it]
    v(1em)
    if it.level == 1 {
      contenu
      v(-0.5em)
      line(length: 100%, stroke: 0.5pt)
    } else {
      if it.level >= 4 {
        emph(contenu)
      } else {
        contenu
      }
      v(-0.5em)
      line(length: 100%, stroke: 0.5pt)
    }
    v(0.5em)
  }
  doc
}

// Listes.
#let configure-lists(doc) = {
  set list(indent: 1em, spacing: 1em, marker: [–])
  show list: it => {
    it
    v(1cm, weak: true)
  }
  doc
}



// Tableaux.
// Plus aucune règle `show table:` ne touche aux colonnes. L'ancienne
// (`set table(columns: ncols * (auto,))`) était de toute façon sans effet —
// Pandoc écrit des largeurs EXPLICITES, qu'un `set` ne peut pas écraser — et
// elle écraserait désormais le calcul de obs-table(). Le dimensionnement se
// fait entièrement dans obs-table(), en amont de la construction du tableau.
#let configure-tables(doc) = {
  show table.cell: set align(left)
  show table.cell.where(y: 0): strong
  set table(
    stroke: 0.5pt,
    fill: (_, y) => if y == 0 { gray.lighten(60%) } else { gray.lighten(90%) },
  )
  doc
}

#let configure-figure(doc) = {
  show figure.where(kind: image): set figure(supplement: [Fig.])
  set figure(numbering: "1")
  // séparateur de légende : « Fig. 1 – légende »
  show figure.caption: it => {
    set text(size: 9pt)
    it
  }
  set figure.caption(separator: [ – ])
  doc
}


// Blocs de code / texte délimités par ```.
#let configure-code(doc) = {
  show raw.where(block: true): it => block(
    width: 100%,
    align(
      center,
      block(
        fill: gray.lighten(85%),
        stroke: 0.5pt + gray,
        radius: 3pt,
        inset: 0.8em,
        it,
      ),
    ),
  )
  doc
}

// ─── Template : composition des modules ──────────────────────────────────────────
// Renvoie une fonction `doc => …` : à utiliser via `show: setTemplate(...)`.
#let setTemplate(projet, titre, sous_titre, version, statut, date) = doc => {
  show: configure-text
  show: configure-page.with(projet, titre, sous_titre, version, statut, date)
  show: configure-paragraphs
  show: configure-headings
  show: configure-lists
  show: configure-title
  show: configure-tables
  show: configure-code
  show: checklist
  show: configure-figure
  doc
}
